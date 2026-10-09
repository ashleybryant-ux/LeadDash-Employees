import dns from "node:dns/promises";
import net from "node:net";
import { TRPCError } from "@trpc/server";
import { storagePut } from "../storage";

/**
 * Brain inputs that are not typed facts: a webpage fetched from a link, an
 * uploaded image, or an uploaded document whose text employees can read.
 */

// ---------- Webpages ----------

function isPrivateAddress(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) || // includes the EC2 metadata service
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
}

/** Refuses links that point at this server, its private network, or the cloud metadata service. */
export async function assertPublicUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That link is not a valid web address." });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Only http and https links can be added." });
  }
  if (url.username || url.password) throw new TRPCError({ code: "BAD_REQUEST", message: "Links with passwords cannot be added." });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "That website could not be found." });
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That link points to a private address and cannot be added." });
  }
  return url;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

export function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? " ";
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchWebpage(raw: string): Promise<{ title: string; text: string; url: string; html: string }> {
  let url = await assertPublicUrl(raw);
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "LeadDash-Employees/1.0 (+https://leaddash.io)", accept: "text/html,text/plain" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    break;
  }
  if (!res || !res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `That page could not be read (status ${res?.status ?? "none"}).` });
  const type = res.headers.get("content-type") || "";
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That link is not a web page. Upload files under Documents instead." });
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2_000_000) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const html = Buffer.concat(chunks).toString("utf8");
  const title = htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 200) || url.hostname;
  const text = type.includes("text/plain") ? html : htmlToText(html);
  return { title, text: text.slice(0, 20_000), url: url.toString(), html: html.slice(0, 1_000_000) };
}

// ---------- Uploads ----------

const IMAGE_TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const DOC_TYPES: Record<string, string> = { "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv" };

function decode(base64: string, maxBytes: number) {
  const clean = base64.replace(/^data:[^;]+;base64,/, "");
  const buf = Buffer.from(clean, "base64");
  if (buf.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "The file was empty." });
  if (buf.length > maxBytes) throw new TRPCError({ code: "BAD_REQUEST", message: `Files must be under ${Math.round(maxBytes / 1_000_000)} MB.` });
  return buf;
}

function sniffImage(buf: Buffer) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.subarray(0, 3).toString() === "GIF") return "image/gif";
  return null;
}

export async function saveImage(orgId: number, base64: string, folder = "brain") {
  const buf = decode(base64, 8_000_000);
  const type = sniffImage(buf);
  if (!type) throw new TRPCError({ code: "BAD_REQUEST", message: "Images must be PNG, JPG, WebP or GIF." });
  return storagePut(`org-${orgId}/${folder}/image${IMAGE_TYPES[type]}`, buf, type);
}

/** A person's own photo (My account). */
/** A roster employee's portrait for every workspace, chosen by LeadDash staff. */
export async function saveRosterPortrait(kind: string, base64: string) {
  const buf = decode(base64, 8_000_000);
  const type = sniffImage(buf);
  if (!type) throw new TRPCError({ code: "BAD_REQUEST", message: "Portraits must be PNG, JPG, WebP or GIF." });
  return storagePut(`roster/${kind.replace(/[^a-z0-9_-]/gi, "")}/portrait-${Date.now()}${IMAGE_TYPES[type]}`, buf, type);
}

export async function savePhoto(userId: number, base64: string) {
  const buf = decode(base64, 8_000_000);
  const type = sniffImage(buf);
  if (!type) throw new TRPCError({ code: "BAD_REQUEST", message: "Photos must be PNG, JPG, WebP or GIF." });
  return storagePut(`user-${userId}/photo/image${IMAGE_TYPES[type]}`, buf, type);
}

export async function saveDocument(orgId: number, base64: string, fileName: string, mimeType: string) {
  const buf = decode(base64, 12_000_000);
  const { readFile, unsupportedNote } = await import("./docs");
  const old = unsupportedNote(fileName);
  if (old) throw new TRPCError({ code: "BAD_REQUEST", message: old });
  let read;
  try {
    read = await readFile(buf, fileName, mimeType);
  } catch (err) {
    throw new TRPCError({ code: "BAD_REQUEST", message: (err as Error).message });
  }
  const saved = await storagePut(`org-${orgId}/documents/${fileName}`, buf, mimeType);
  return { url: saved.url, text: read.text.slice(0, 3_000_000), pages: read.pages, unit: read.unit, note: read.note };
}

// ---------- Raw downloads (host pages and the files they link to) ----------

export type Download = { url: string; contentType: string; buf: Buffer; fileName: string };

/** Downloads a public page or file (redirects re-checked), up to maxBytes. */
export async function download(raw: string, maxBytes = 20_000_000, timeoutMs = 30_000): Promise<Download> {
  let url = await assertPublicUrl(raw);
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; LeadDash-Employees/1.0; +https://leaddash.io)", accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    break;
  }
  if (!res || !res.ok) throw new Error(`could not be downloaded (status ${res?.status ?? "none"})`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(`is larger than ${Math.round(maxBytes / 1_000_000)} MB`);
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`is larger than ${Math.round(maxBytes / 1_000_000)} MB`);
    }
    chunks.push(value);
  }
  const disposition = res.headers.get("content-disposition") || "";
  const fromHeader = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  const fromPath = decodeURIComponent(url.pathname.split("/").pop() || "") || url.hostname;
  return {
    url: url.toString(),
    contentType: (res.headers.get("content-type") || "").toLowerCase(),
    buf: Buffer.concat(chunks),
    fileName: (fromHeader ? decodeURIComponent(fromHeader) : fromPath).slice(0, 180),
  };
}

const FILE_LINK = /\.(pdf|docx?|xlsx?|pptx?)(\?|#|$)/i;
const HELPFUL_PAGE = /(rfp|nofo|guideline|guidance|request[-_ ]for|call[-_ ]for|apply|application|how[-_ ]to[-_ ]apply|eligib|submission|speaker|proposal|criteria|faq)/i;

/** Links on a page that look like the host's documents, and pages worth one more look. */
export function packageLinks(html: string, base: string) {
  const files = new Map<string, string>();
  const pages = new Map<string, string>();
  const baseHost = new URL(base).hostname.replace(/^www\./, "");
  for (const m of Array.from(html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi))) {
    let href: URL;
    try {
      href = new URL(m[1].replace(/&amp;/g, "&"), base);
    } catch {
      continue;
    }
    if (href.protocol !== "https:" && href.protocol !== "http:") continue;
    const label = htmlToText(m[2]).replace(/\s+/g, " ").trim().slice(0, 140);
    const url = href.toString();
    if (FILE_LINK.test(href.pathname)) {
      if (!files.has(url)) files.set(url, label);
    } else if (href.hostname.replace(/^www\./, "") === baseHost && HELPFUL_PAGE.test(href.pathname + " " + label) && url !== base) {
      if (!pages.has(url)) pages.set(url, label);
    }
  }
  return {
    files: Array.from(files, ([url, label]) => ({ url, label })),
    pages: Array.from(pages, ([url, label]) => ({ url, label })),
  };
}
