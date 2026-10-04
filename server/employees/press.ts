import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { decryptJson, encryptJson } from "../_core/crypto";
import { generateJson, type JsonSchema } from "../_core/llm";
import type { Opportunity } from "../../drizzle/schema";
import { htmlToText } from "./files";
import { addOpportunityFromText, enqueue, oppCardFor, startApplication } from "./apply";
import { employeeFor, systemPromptFor, working } from "./tasks";

/**
 * Taylor's press inbox: the free reporter request services, read the moment
 * their emails arrive.
 *
 * HARO, Source of Sources, Qwoted and Featured all email their requests and
 * none of them has an API. The owner signs up for them with one email address
 * and connects that inbox here with an app password (stored encrypted, never
 * shown to the AI). Every few minutes Taylor reads only the emails from those
 * services, keeps the requests the owner can credibly answer, adds each one as
 * a media opportunity, and starts a pitch for the good fits. Nothing is sent
 * until the owner approves it: HARO and Source of Sources answers go by email
 * from Taylor's sending address, Qwoted and Featured answers through the saved
 * website login.
 */

export const SERVICES = [
  { key: "haro", name: "HARO", from: ["helpareporter"], words: /helpareporter|\bHARO\b|help a reporter/i, signup: "https://www.helpareporter.com/sources" },
  { key: "sos", name: "Source of Sources", from: ["sourceofsources"], words: /source ?of ?sources|\bSOS\b/i, signup: "https://www.sourceofsources.com/" },
  { key: "qwoted", name: "Qwoted", from: ["qwoted"], words: /qwoted/i, signup: "https://www.qwoted.com/" },
  { key: "featured", name: "Featured", from: ["featured.com"], words: /featured\.com/i, signup: "https://featured.com/" },
] as const;
export type Service = (typeof SERVICES)[number];

type Secrets = { host: string; port: number; user: string; pass: string };
type Sync = { lastUid?: number; checkedAt?: string; found?: number; pitched?: number; seen?: string[]; lastFound?: number };

export type MailMessage = { uid: number; messageId: string; from: string; subject: string; text: string };
export type Mailbox = {
  /** Signs in and out, to check the password. */
  test(cfg: Secrets): Promise<void>;
  /** Emails from the press services newer than `afterUid`, received since `since`. */
  fetch(cfg: Secrets, afterUid: number, since: Date): Promise<MailMessage[]>;
};

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** The inbox's mail server, from the address (Google Workspace and other domains type it in). */
export function guessHost(email: string) {
  const d = (email.split("@")[1] ?? "").toLowerCase();
  if (/^(gmail|googlemail)\.com$/.test(d)) return "imap.gmail.com";
  if (/^(outlook|hotmail|live|msn)\.com$/.test(d)) return "outlook.office365.com";
  if (/^(yahoo|ymail)\.com$/.test(d)) return "imap.mail.yahoo.com";
  if (/^(icloud|me|mac)\.com$/.test(d)) return "imap.mail.me.com";
  if (/^aol\.com$/.test(d)) return "imap.aol.com";
  return "";
}

/** A sign-in error in words the owner can act on. */
function friendly(err: unknown) {
  const m = err instanceof Error ? err.message : String(err);
  const anyErr = err as { authenticationFailed?: boolean; responseText?: string; code?: string };
  if (anyErr?.authenticationFailed || /auth|credential|invalid|login|password/i.test(`${m} ${anyErr?.responseText ?? ""}`)) {
    return "The inbox didn't accept that app password. Make a new app password and paste it again.";
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(`${m} ${anyErr?.code ?? ""}`)) return "That mail server name wasn't found. Check the server name.";
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(`${m} ${anyErr?.code ?? ""}`)) return "The mail server didn't answer. Check the server name, then try again.";
  return `The inbox couldn't be read: ${m.slice(0, 160)}`;
}

const realMailbox: Mailbox = {
  async test(cfg) {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false, connectionTimeout: 30_000, greetingTimeout: 20_000, socketTimeout: 60_000 });
    await client.connect();
    await client.logout().catch(() => null);
  },
  async fetch(cfg, afterUid, since) {
    const { ImapFlow } = await import("imapflow");
    const { simpleParser } = await import("mailparser");
    const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false, connectionTimeout: 30_000, greetingTimeout: 20_000, socketTimeout: 120_000 });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const or = SERVICES.flatMap((s) => s.from.map((f) => ({ from: f })));
      const found = (await client.search({ since, or }, { uid: true })) || [];
      const uids = found.filter((u) => u > afterUid).slice(-20);
      const out: MailMessage[] = [];
      if (!uids.length) return out;
      for await (const m of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
        if (!m.source) continue;
        const p = await simpleParser(m.source);
        out.push({ uid: m.uid, messageId: p.messageId || `uid-${m.uid}`, from: p.from?.text ?? "", subject: p.subject ?? "", text: (p.text || htmlToText(typeof p.html === "string" ? p.html : "")).slice(0, 120_000) });
      }
      return out;
    } finally {
      lock.release();
      await client.logout().catch(() => null);
    }
  },
};

let mailbox: Mailbox = realMailbox;
/** For tests: a fake inbox. */
export function setMailbox(m: Mailbox | null) {
  mailbox = m ?? realMailbox;
}

export function pressLink(orgId: number) {
  return db.listAccountLinks(orgId, "press")[0] ?? null;
}

export function pressView(orgId: number) {
  const l = pressLink(orgId);
  if (!l) return { connected: false as const, services: SERVICES.map((s) => ({ name: s.name, signup: s.signup })) };
  const cfg = decryptJson<Secrets>(l.secretsEncrypted);
  const sync = parse<Sync>(l.sync, {});
  return {
    connected: true as const,
    id: l.id,
    email: l.email ?? cfg?.user ?? "",
    host: cfg?.host ?? "",
    status: l.status,
    error: l.error,
    checkedAt: sync.checkedAt ?? null,
    found: sync.found ?? 0,
    pitched: sync.pitched ?? 0,
    services: SERVICES.map((s) => ({ name: s.name, signup: s.signup })),
  };
}

/** Connect (or change) the press inbox. The password is checked by signing in, then stored encrypted. */
export async function savePressInbox(orgId: number, input: { email: string; password?: string; host?: string }) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the inbox's email address." });
  const existing = pressLink(orgId);
  const old = existing ? decryptJson<Secrets>(existing.secretsEncrypted) : null;
  const pass = (input.password ?? "").replace(/\s+/g, "") || (old && old.user === email ? old.pass : "");
  if (!pass) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste the inbox's app password." });
  const host = (input.host ?? "").trim().toLowerCase() || guessHost(email);
  if (!host) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the mail server. For Google Workspace it's imap.gmail.com." });
  const cfg: Secrets = { host, port: 993, user: email, pass };
  try {
    await mailbox.test(cfg);
  } catch (err) {
    throw new TRPCError({ code: "BAD_REQUEST", message: friendly(err) });
  }
  const row = { email, name: "Press inbox", secretsEncrypted: encryptJson(cfg), status: "connected" as const, error: null };
  // A different inbox starts fresh; the same inbox keeps its place.
  const sync = existing && old?.user === email ? existing.sync : JSON.stringify({});
  const link = existing ? db.updateAccountLink(existing.id, orgId, { ...row, sync }) : db.createAccountLink({ organizationId: orgId, purpose: "press", kind: "link", ...row });
  return pressView(link!.organizationId);
}

export function removePressInbox(orgId: number) {
  const l = pressLink(orgId);
  if (l) db.deleteAccountLink(l.id, orgId);
}

/** Which service an email came from. */
export function serviceOf(m: Pick<MailMessage, "from" | "subject" | "text">): Service | null {
  const head = `${m.from} ${m.subject}`;
  return SERVICES.find((s) => s.from.some((f) => head.toLowerCase().includes(f)) || s.words.test(head)) ?? SERVICES.find((s) => s.from.some((f) => m.text.slice(0, 3000).toLowerCase().includes(f))) ?? null;
}

type Request = { title: string; outlet: string; reporter: string; deadline: string; query: string; respondBy: "email" | "platform"; replyTo: string; link: string; fitReason: string };

const str = { type: "string" } as const;
const REQUESTS: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requests"],
  properties: {
    requests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "outlet", "reporter", "deadline", "query", "respondBy", "replyTo", "link", "fitReason"],
        properties: {
          title: { type: "string", description: "The request's headline or summary, as written" },
          outlet: { type: "string", description: "The publication, show or site, or 'Anonymous' when withheld" },
          reporter: { type: "string", description: "The reporter's name, or ''" },
          deadline: { type: "string", description: "The deadline as written, with the date as Mon D, YYYY when given" },
          query: { type: "string", description: "The full request word for word, including every requirement" },
          respondBy: { type: "string", enum: ["email", "platform"], description: "email: answer by emailing the reporter's address. platform: answer on the service's site" },
          replyTo: { type: "string", description: "The email address to answer to, exactly as written, or ''" },
          link: { type: "string", description: "The link to answer on the service's site, or ''" },
          fitReason: str,
        },
      },
    },
  },
};

const PICK_JOB = (service: string) => `Your job now: you are the publicist. Below is an email from ${service}, a free service that sends reporters' requests for expert sources.
- List only the requests this expert can credibly answer from her credentials, work and topics in the Brain. A request outside her expertise, or one asking for a type of person she isn't, is left out. Reporters remove sources who answer off-topic.
- Leave out requests whose deadline has passed, and anything that asks for a client's or patient's story or details.
- At most 8, best fit first. If none fit, return none.
- Copy each request word for word, with its requirements, the outlet, the deadline and exactly how to answer (the reporter's email address, or the link on the service's site).`;

/** The requests in one email that fit the owner, as media opportunities. */
async function readEmail(orgId: number, service: Service, m: MailMessage) {
  const emp = await employeeFor(orgId, "speaking");
  const { system } = await systemPromptFor(emp, PICK_JOB(service.name));
  const { requests } = await generateJson<{ requests: Request[] }>({ system, prompt: `Subject: ${m.subject}\nFrom: ${m.from}\n\n${m.text.slice(0, 80_000)}`, schemaName: "press_requests", schema: REQUESTS, maxTokens: 8000, timeoutMs: 240_000 });
  const existing = await db.listOpps(orgId, ["media"]);
  const made: Opportunity[] = [];
  for (const r of (requests ?? []).slice(0, 8)) {
    if (!r.query?.trim() || !r.title?.trim()) continue;
    const link = /^https?:\/\//i.test(r.link) ? r.link : "";
    const how = r.respondBy === "email" && r.replyTo ? `Answer by email to ${r.replyTo}` : link ? `Answer on ${service.name}: ${link}` : `Answer on ${service.name}`;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (existing.some((o) => norm(o.title) === norm(r.title))) continue;
    const text = `Reporter request from ${service.name}\nTitle: ${r.title}\nOutlet: ${r.outlet || "Not named"}\nReporter: ${r.reporter || "Not named"}\nDeadline: ${r.deadline || "Not given"}\nHow to respond: ${how}\n\nThe request, word for word:\n${r.query}`;
    const opp = await addOpportunityFromText(
      orgId,
      "speaking",
      { text, sourceUrl: link || null, source: service.name, files: [{ name: `${service.name} request.txt`, buf: Buffer.from(text, "utf8"), mime: "text/plain", url: link }], kind: "media" },
      emp.name
    );
    made.push(opp);
  }
  return made;
}

const busy = new Set<number>();

/** Reads new emails from the press services and turns the fitting requests into pitches. */
export async function checkPress(orgId: number) {
  const link = pressLink(orgId);
  if (!link || busy.has(orgId)) return { found: 0, pitched: 0 };
  const cfg = decryptJson<Secrets>(link.secretsEncrypted);
  if (!cfg?.pass) return { found: 0, pitched: 0 };
  busy.add(orgId);
  const sync = parse<Sync>(link.sync, {});
  const emp = await employeeFor(orgId, "speaking");
  try {
    let msgs: MailMessage[];
    try {
      msgs = await mailbox.fetch(cfg, sync.lastUid ?? 0, new Date(Date.now() - 3 * 86_400_000));
    } catch (err) {
      db.updateAccountLink(link.id, orgId, { status: "error", error: friendly(err), sync: JSON.stringify({ ...sync, checkedAt: new Date().toISOString() }) });
      return { found: 0, pitched: 0 };
    }
    const seen = new Set(sync.seen ?? []);
    const made: { service: Service; opp: Opportunity }[] = [];
    let lastUid = sync.lastUid ?? 0;
    await working(emp, async () => {
      for (const m of msgs.sort((a, b) => a.uid - b.uid)) {
        lastUid = Math.max(lastUid, m.uid);
        if (seen.has(m.messageId)) continue;
        seen.add(m.messageId);
        const service = serviceOf(m);
        if (!service) continue;
        try {
          for (const opp of await readEmail(orgId, service, m)) made.push({ service, opp });
        } catch (err) {
          console.warn(`[press] ${service.name} email skipped:`, err instanceof Error ? err.message : err);
        }
      }
    });
    // Pitches start for the good fits; each waits in Approvals until the owner sends it.
    const good = made.filter((x) => x.opp.fitCall === "apply");
    for (const x of good) await startApplication(orgId, x.opp.id, null);
    const next: Sync = { ...sync, lastUid, checkedAt: new Date().toISOString(), seen: Array.from(seen).slice(-300), found: (sync.found ?? 0) + made.length, pitched: (sync.pitched ?? 0) + good.length, lastFound: made.length };
    db.updateAccountLink(link.id, orgId, { status: "connected", error: null, sync: JSON.stringify(next) });
    if (made.length) {
      const from = Array.from(new Set(made.map((x) => x.service.name))).join(" and ");
      const n = made.length;
      await db.createChatMessage({
        organizationId: orgId,
        employeeId: emp.id,
        role: "employee",
        authorName: emp.name,
        content: `${n} new reporter ${n === 1 ? "request" : "requests"} from ${from} ${n === 1 ? "fits" : "fit"} you.${good.length ? ` I'm writing ${good.length === 1 ? "a pitch for the best one" : `pitches for the ${good.length} best`}. Each will wait in Approvals until you send it, and reporters' deadlines are short, so look today.` : " None are strong enough to pitch on their own; open one to start a pitch."}`,
        cards: JSON.stringify(made.slice(0, 8).map((x) => oppCardFor(x.opp))),
      });
    }
    return { found: made.length, pitched: good.length };
  } finally {
    busy.delete(orgId);
  }
}

let lastTick = 0;
/** Every 15 minutes: each workspace with a press inbox is checked. */
export async function pressTicks(now = Date.now()) {
  if (now - lastTick < 15 * 60_000) return;
  lastTick = now;
  for (const orgId of await db.listAllOrganizationIds()) {
    if (!pressLink(orgId)) continue;
    enqueue(`press-${orgId}`, () => checkPress(orgId));
  }
}

export function pressFacts(orgId: number) {
  const v = pressView(orgId);
  if (!v.connected) return "\nPress inbox: not connected. The owner connects it on Integrations, then signs up free for HARO, Source of Sources, Qwoted and Featured with that address, and Taylor reads their reporter requests as they arrive.";
  return `\nPress inbox: ${v.email}, ${v.status === "error" ? `not working (${v.error})` : "connected"}. Reporter requests found so far: ${v.found}; pitches started: ${v.pitched}.${v.checkedAt ? ` Last checked ${new Date(v.checkedAt).toISOString()}.` : ""}`;
}

