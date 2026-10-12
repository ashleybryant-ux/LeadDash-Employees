/**
 * Each workspace's public careers page, where Quinn's published jobs live:
 * - /careers/:org              open jobs
 * - /careers/:org/:job         the job page (Google's JobPosting markup) with the Apply form
 * - /careers/:org/:job/apply   the form posts here; the applicant lands in Candidates
 * - /careers/sitemap.xml       every published job page, for search engines
 * - /careers/indeed.xml        every published job, in the XML feed Indeed reads
 * Client-facing pages: the workspace's own name, logo and brand color.
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import * as db from "./db";
import type { HrRole, Organization } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { storagePut } from "./storage";
import { readFile } from "./employees/docs";
import { acceptApplication, jobHtml, jobUrl, lines, listPublished, payNumbers, readJd } from "./employees/jobs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const RESUME_MAX = 10_000_000;

// A few applications per visitor per hour keeps bots out of Candidates.
const hits = new Map<string, number[]>();
function limited(req: Request, max = 8) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) hits.forEach((v, k) => v.every((t) => now - t > 3600_000) && hits.delete(k));
  return list.length > max;
}

// ==========================================
// Facts about a job, as applicants and search engines see them
// ==========================================

/** "Oklahoma City, OK" or "Oklahoma" from the workspace's location. */
export function placeOf(org: Pick<Organization, "state">) {
  const raw = (org.state ?? "").trim();
  const m = raw.match(/^(.+?),\s*([A-Za-z .]+?)(?:\s+(\d{5}))?$/);
  if (m) return { city: m[1].trim(), region: m[2].trim(), postal: m[3] ?? "" };
  return { city: "", region: raw, postal: "" };
}

function payText(role: Pick<HrRole, "payFrom" | "payTo">) {
  const a = (role.payFrom ?? "").trim();
  const b = (role.payTo ?? "").trim();
  if (!a || !b) return a || b;
  const unit = (s: string) => s.replace(/^[$\d,.\sk]+/i, "").trim();
  return unit(a) && unit(a) === unit(b) ? `${a.slice(0, a.length - unit(a).length).trim()} to ${b}` : `${a} to ${b}`;
}

function metaLine(org: Organization, role: HrRole) {
  const p = placeOf(org);
  const where = role.place === "telehealth" ? "Remote" : [p.city, p.region].filter(Boolean).join(", ");
  return [where, role.employment === "1099" ? "Contract" : role.hours === "full" ? "Full time" : "Part time", payText(role)].filter(Boolean).join(" · ");
}

/** schema.org JobPosting for Google's job search. */
export function jobPostingLd(org: Organization, role: HrRole) {
  const p = placeOf(org);
  const pay = payNumbers(role.payFrom, role.payTo);
  const remote = role.place === "telehealth";
  const address = { "@type": "PostalAddress", ...(p.city ? { addressLocality: p.city } : {}), ...(p.region ? { addressRegion: p.region } : {}), ...(p.postal ? { postalCode: p.postal } : {}), addressCountry: "US" };
  return {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: role.title,
    description: jobHtml(role, readJd(role)),
    identifier: { "@type": "PropertyValue", name: org.name, value: String(role.id) },
    datePosted: (role.publishedAt ?? new Date()).toISOString().slice(0, 10),
    employmentType: role.employment === "1099" ? ["CONTRACTOR", role.hours === "full" ? "FULL_TIME" : "PART_TIME"] : role.hours === "full" ? "FULL_TIME" : "PART_TIME",
    hiringOrganization: { "@type": "Organization", name: org.name, ...(org.website ? { sameAs: /^https?:\/\//.test(org.website) ? org.website : `https://${org.website}` } : {}) },
    ...(remote
      ? { jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { "@type": "State", name: p.region || "United States" } }
      : { jobLocation: { "@type": "Place", address } }),
    ...(pay ? { baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: pay.min, maxValue: pay.max, unitText: pay.unit } } } : {}),
    directApply: true,
    url: jobUrl(org, role),
  };
}

// ==========================================
// Pages
// ==========================================

function accent(org: Organization) {
  const m = (org.brandColors ?? "").match(/#[0-9a-f]{6}\b/i);
  return m ? m[0] : "#1b6b4a";
}

async function logo(org: Organization) {
  if (!org.logoUrl) return "";
  try {
    const url = /^https:\/\//.test(org.logoUrl) ? org.logoUrl : org.logoUrl.startsWith("/files/") ? (await import("./employees/pages")).publicLink(org.id, org.logoUrl) : "";
    return url ? `<img class="logo" src="${esc(url)}" alt="${esc(org.name)}">` : "";
  } catch {
    return "";
  }
}

function css(color: string) {
  return `*{box-sizing:border-box}body{margin:0;background:#F8FAFB;font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;color:#14221c}
a{color:${color}}.wrap{max-width:760px;margin:0 auto;padding:36px 16px 56px}.top{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.logo{max-height:44px;max-width:180px;display:block}.org{font-weight:800;font-size:16px;color:#14221c;text-decoration:none}
h1{font-size:28px;line-height:1.2;margin:0 0 6px;font-weight:800}h2{font-size:17px;margin:22px 0 8px}h3{font-size:16px;margin:20px 0 6px}
p,li{font-size:15px;line-height:1.65;color:#2a3a33}ul{padding-left:22px;margin:0 0 10px}
.muted{color:#5b6b64;font-size:14px}.card{background:#fff;border:1px solid #e3e9e6;border-radius:14px;padding:20px 22px}
.jobs{display:flex;flex-direction:column;gap:12px;margin-top:16px}.job{display:block;text-decoration:none;color:#14221c}.job b{font-size:16px}.job:hover{border-color:${color}}
form{display:flex;flex-direction:column;gap:6px;margin-top:8px}label{font-size:12px;font-weight:700;color:#5b6b64;text-transform:uppercase;letter-spacing:.06em;margin-top:10px}
input{width:100%;border:1px solid #cfd9d4;border-radius:8px;padding:10px 12px;font:inherit;font-size:16px;background:#fff;color:#14221c}
button{align-self:flex-start;height:44px;padding:0 26px;border-radius:10px;border:0;background:${color};color:#fff;font:inherit;font-weight:700;font-size:15px;cursor:pointer;margin-top:16px}
.err{color:#b42318;font-weight:600;font-size:14px}.hp{position:absolute;left:-9999px}.apply{margin-top:26px}`;
}

async function shell(org: Organization, title: string, body: string, opts: { description?: string; ld?: unknown; canonical?: string; noindex?: boolean } = {}) {
  const ld = opts.ld ? `<script type="application/ld+json">${JSON.stringify(opts.ld).replace(/</g, "\\u003c")}</script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${opts.description ? `<meta name="description" content="${esc(opts.description)}">` : ""}${opts.canonical ? `<link rel="canonical" href="${esc(opts.canonical)}">` : ""}${opts.noindex ? '<meta name="robots" content="noindex">' : ""}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap"><style>${css(accent(org))}</style>${ld}</head>
<body><div class="wrap"><div class="top">${await logo(org)}<a class="org" href="/careers/${esc(org.slug)}">${esc(org.name)}</a></div>${body}</div></body></html>`;
}

const notFound = () =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title></head><body style="font-family:system-ui;padding:40px 16px"><h1>Not found</h1><p>This job is not open.</p></body></html>`;

async function jobFor(orgSlug: string, roleSlug?: string) {
  const org = await db.getOrganizationBySlug(String(orgSlug || ""));
  if (!org) return null;
  const roles = (await db.listHrRoles(org.id)).filter((r) => r.publishedAt && r.status === "open" && r.slug);
  const role = roleSlug === undefined ? null : roles.find((r) => r.slug === roleSlug) ?? null;
  return { org, roles, role };
}

export async function careersPage(org: Organization, roles: HrRole[]) {
  const list = roles.length
    ? `<div class="jobs">${roles.map((r) => `<a class="card job" href="/careers/${esc(org.slug)}/${esc(r.slug!)}"><b>${esc(r.title)}</b><br><span class="muted">${esc(metaLine(org, r))}</span></a>`).join("")}</div>`
    : `<p class="muted">No open jobs right now.</p>`;
  return shell(org, `Careers at ${org.name}`, `<h1>Careers at ${esc(org.name)}</h1>${list}`, { description: `Open jobs at ${org.name}.`, canonical: `${ENV.appUrl}/careers/${org.slug}` });
}

function applyForm(action: string, error = "", v: Record<string, string> = {}) {
  return `<div class="apply card"><h2 style="margin-top:0">Apply</h2>${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="${esc(action)}" enctype="multipart/form-data"><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<label for="a-name">Name</label><input id="a-name" name="name" required autocomplete="name" value="${esc(v.name ?? "")}">
<label for="a-email">Email</label><input id="a-email" name="email" type="email" required autocomplete="email" value="${esc(v.email ?? "")}">
<label for="a-phone">Phone</label><input id="a-phone" name="phone" type="tel" autocomplete="tel" value="${esc(v.phone ?? "")}">
<label for="a-resume">Resume</label><input id="a-resume" name="resume" type="file" required accept=".pdf,.doc,.docx,.txt,.rtf">
<button type="submit">Apply</button></form></div>`;
}

export async function jobPage(org: Organization, role: HrRole, error = "", v: Record<string, string> = {}) {
  const jd = readJd(role);
  const url = jobUrl(org, role);
  return shell(org, `${role.title} at ${org.name}`, `<h1>${esc(role.title)}</h1><p class="muted">${esc(metaLine(org, role))}</p>${jobHtml(role, jd)}${applyForm(`/careers/${org.slug}/${role.slug}/apply`, error, v)}`, {
    description: (jd?.about || lines(jd?.duties).slice(0, 2).join(". ")).slice(0, 300),
    ld: jobPostingLd(org, role),
    canonical: url,
  });
}

// ==========================================
// Sitemap and the Indeed feed
// ==========================================

const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
/** Indeed reads values in CDATA (with literal HTML, no entities). */
const cdata = (s: string | number | null | undefined) => `<![CDATA[${String(s ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

export async function sitemapXml() {
  const jobs = await listPublished();
  const orgs = new Map(jobs.map((j) => [j.org.id, j.org]));
  const urls = [
    ...Array.from(orgs.values()).map((o) => ({ loc: `${ENV.appUrl}/careers/${o.slug}`, at: null as Date | null })),
    ...jobs.map((j) => ({ loc: jobUrl(j.org, j.role), at: j.role.updatedAt })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${xmlEsc(u.loc)}</loc>${u.at ? `<lastmod>${u.at.toISOString().slice(0, 10)}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`;
}

/** Indeed's Job Sync XML feed. Every element is in every job, blank when unknown. */
export async function indeedXml() {
  const jobs = await listPublished();
  const job = ({ org, role }: { org: Organization; role: HrRole }) => {
    const p = placeOf(org);
    const pay = payNumbers(role.payFrom, role.payTo);
    const remote = role.place === "telehealth";
    const per = pay?.unit === "HOUR" ? "per hour" : "per year";
    const salary = pay ? `$${pay.min.toLocaleString("en-US")}${pay.max !== pay.min ? ` - $${pay.max.toLocaleString("en-US")}` : ""} ${per}` : "";
    const fields: [string, string | number][] = [
      ["title", role.title],
      ["date", (role.publishedAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z")],
      ["referencenumber", `ld-${org.id}-${role.id}`],
      ["requisitionid", role.id],
      ["url", `${jobUrl(org, role)}?source=Indeed`],
      ["company", org.name],
      ["sourcename", org.name],
      ["city", remote ? "Remote" : p.city],
      ["state", p.region],
      ["country", "US"],
      ["postalcode", p.postal],
      ["streetaddress", ""],
      // The workspace has no email of its own on file; Indeed ties the feed to the employer's account email.
      ["email", ""],
      ["description", jobHtml(role, readJd(role))],
      ["salary", salary],
      ["education", ""],
      ["jobtype", role.hours === "full" ? "fulltime" : "parttime"],
      ["category", ""],
      ["experience", ""],
      ["expirationdate", ""],
      ["remotetype", remote ? "Fully remote" : ""],
    ];
    return `  <job>\n${fields.map(([k, v]) => `    <${k}>${cdata(v)}</${k}>`).join("\n")}\n  </job>`;
  };
  return `<?xml version="1.0" encoding="utf-8"?>
<source>
  <publisher>LeadDash Employees</publisher>
  <publisherurl>${xmlEsc(ENV.appUrl)}</publisherurl>
${jobs.map(job).join("\n")}
</source>
`;
}

// ==========================================
// The Apply form (multipart: name, email, phone, resume)
// ==========================================

type Part = { field: string; name: string; mime: string; data: Buffer };

export function parseMultipart(body: Buffer, contentType: string) {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields: Record<string, string> = {};
  const files: Part[] = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, Math.max(start + 2, next - 2));
    const sep = part.indexOf("\r\n\r\n");
    if (sep !== -1) {
      const head = part.subarray(0, sep).toString("utf8");
      const data = part.subarray(sep + 4);
      const name = /\bname="([^"]*)"/i.exec(head)?.[1];
      const filename = /\bfilename="([^"]*)"/i.exec(head)?.[1];
      const mime = /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim() ?? "application/octet-stream";
      if (name !== undefined) {
        if (filename !== undefined) {
          if (data.length) files.push({ field: name, name: filename, mime, data: Buffer.from(data) });
        } else fields[name] = data.toString("utf8");
      }
    }
    pos = next;
  }
  return { fields, files };
}

function readBody(req: Request, max: number) {
  return new Promise<Buffer | null>((resolve, reject) => {
    if (Number(req.headers["content-length"] || 0) > max) return resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function confirmation(org: Organization, role: HrRole) {
  return shell(org, `Thank you`, `<div class="card"><h1>Thank you</h1><p>We got your application for ${esc(role.title)}. ${esc(org.name)} will reach out by email.</p><p><a href="/careers/${esc(org.slug)}">See all jobs</a></p></div>`, { noindex: true });
}

export function registerCareers(app: Express) {
  app.get("/careers/sitemap.xml", async (_req, res) => {
    res.type("application/xml").send(await sitemapXml());
  });
  app.get("/careers/indeed.xml", async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=900");
    res.type("application/xml").send(await indeedXml());
  });
  app.get("/careers/:org", async (req, res) => {
    const f = await jobFor(req.params.org);
    if (!f) return res.status(404).send(notFound());
    res.send(await careersPage(f.org, f.roles));
  });
  app.get("/careers/:org/:job", async (req, res) => {
    const f = await jobFor(req.params.org, req.params.job);
    if (!f?.role) return res.status(404).send(notFound());
    res.send(await jobPage(f.org, f.role));
  });
  app.post("/careers/:org/:job/apply", async (req: Request, res: Response) => {
    const f = await jobFor(req.params.org, req.params.job);
    if (!f?.role) return res.status(404).send(notFound());
    const { org, role } = f;
    const body = await readBody(req, RESUME_MAX + 200_000).catch(() => null);
    if (!body) return res.status(413).send(await jobPage(org, role, "That file is too big. Upload a resume under 10 MB."));
    const form = parseMultipart(body, String(req.headers["content-type"] || ""));
    if (!form) return res.status(400).send(await jobPage(org, role, "Fill in the form and try again."));
    // Bots fill the hidden field; they get the thank-you and nothing is saved.
    if (form.fields.website) return res.send(await confirmation(org, role));
    if (limited(req)) return res.status(429).send(await jobPage(org, role, "Too many applications from this connection. Try again in an hour."));
    const v = { name: (form.fields.name ?? "").trim().slice(0, 160), email: (form.fields.email ?? "").trim().slice(0, 200), phone: (form.fields.phone ?? "").trim().slice(0, 40) };
    if (!v.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return res.status(400).send(await jobPage(org, role, "Enter your name and a valid email.", v));
    const file = form.files.find((x) => x.field === "resume");
    if (!file) return res.status(400).send(await jobPage(org, role, "Attach your resume.", v));
    let text = "";
    try {
      text = (await readFile(file.data, file.name, file.mime)).text;
    } catch {
      return res.status(400).send(await jobPage(org, role, "That file can't be read. Upload a PDF or Word file.", v));
    }
    const safe = file.name.replace(/[^\w.-]+/g, "_").slice(-80) || "resume";
    const saved = await storagePut(`org-${org.id}/resumes/${crypto.randomBytes(6).toString("hex")}-${safe}`, file.data, file.mime);
    await acceptApplication(org.id, role.id, { ...v, text, resumeUrl: saved.url, fileName: safe });
    res.send(await confirmation(org, role));
  });
}
