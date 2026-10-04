import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { decryptJson, encryptJson } from "../_core/crypto";
import { extractJson } from "../_core/llm";
import * as integrations from "../integrations";
import { uploadsRoot } from "../storage";
import type { Application, Opportunity, PortalLogin } from "../../drizzle/schema";
import { liveStart, runBrowserTask, tempFiles, type BrowserResult, type Download } from "./browser";
import { addOpportunityFromText, enqueue, markSubmitted, oppCardFor, parse, type Attachment, type Requirements } from "./apply";
import { employeeFor } from "./tasks";
import { partsIn } from "./schedule";
import { withUsage } from "../usage";

/**
 * BidPrime and bid submission.
 *
 * Morgan signs in to BidPrime with the saved email and password, reads the
 * leads inbox and saved bids, opens each new bid, downloads its documents and
 * adds it to Opportunities with a fit score. After the person approves a
 * response, Morgan submits it: by email from the workspace's Gmail, or
 * through the agency's portal with a saved sign-in.
 */

const BIDPRIME_HOME = "https://www.bidprime.com/";
const MAX_DETAILS = 6;

type BidPrimeSecrets = { email: string; password: string; storageState?: string | null };
type BidPrimeSettings = { hints?: string[]; startUrl?: string; lastCheckedAt?: string | null; lastAttemptAt?: string | null; lastFound?: number; waitingCode?: boolean; lastError?: string | null; checking?: boolean };
type ListedBid = { title: string; agency: string; refnum?: string; location?: string; due?: string; detailUrl?: string; sourceUrl?: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Sign-in codes are kept in memory for 10 minutes only, never written to the database.
const codes = new Map<string, { code: string; until: number }>();
function takeCode(key: string) {
  const c = codes.get(key);
  if (!c || c.until < Date.now()) return undefined;
  return c.code;
}

// ==========================================
// The BidPrime connection
// ==========================================

async function connection(orgId: number) {
  const conn = await db.getConnectionByProvider(orgId, "bidprime");
  if (!conn) return null;
  return { conn, secrets: decryptJson<BidPrimeSecrets>(conn.secretsEncrypted), settings: parse<BidPrimeSettings>(conn.settings, {}) };
}

export async function bidprimeView(orgId: number) {
  const c = await connection(orgId);
  if (!c || c.conn.status === "disconnected") return { connected: false as const };
  return {
    connected: true as const,
    email: c.secrets?.email ?? c.conn.accountHandle ?? "",
    status: c.conn.status,
    lastCheckedAt: c.settings.lastCheckedAt ?? null,
    lastFound: c.settings.lastFound ?? 0,
    waitingCode: Boolean(c.settings.waitingCode),
    checking: isChecking(orgId),
    lastError: c.settings.lastError ?? null,
  };
}

export async function saveBidPrime(orgId: number, email: string, password: string | undefined) {
  const c = await connection(orgId);
  const pw = password?.trim() || c?.secrets?.password;
  if (!pw) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter your BidPrime password." });
  const sameAccount = c?.secrets?.email === email.trim();
  await db.upsertExternalConnection({
    organizationId: orgId,
    provider: "bidprime",
    accountLabel: "BidPrime",
    accountHandle: email.trim(),
    status: "pending",
    settings: JSON.stringify({ ...(c?.settings ?? {}), lastError: null, waitingCode: false, checking: false }),
    // A new account or password starts a fresh browser session.
    secretsEncrypted: encryptJson({ email: email.trim(), password: pw, storageState: sameAccount && !password ? c?.secrets?.storageState ?? null : null }),
    connectedAt: new Date(),
  });
  return bidprimeView(orgId);
}

export async function disconnectBidPrime(orgId: number) {
  const c = await connection(orgId);
  if (!c) return { success: true };
  await db.upsertExternalConnection({ organizationId: orgId, provider: "bidprime", accountLabel: "BidPrime", accountHandle: null, status: "disconnected", settings: "{}", secretsEncrypted: null, connectedAt: null });
  return { success: true };
}

async function saveSettings(orgId: number, patch: Partial<BidPrimeSettings>, extra: { status?: "connected" | "pending" | "error"; storageState?: string | null } = {}) {
  const c = await connection(orgId);
  if (!c) return;
  await db.upsertExternalConnection({
    organizationId: orgId,
    provider: "bidprime",
    accountLabel: "BidPrime",
    accountHandle: c.conn.accountHandle,
    status: extra.status ?? c.conn.status,
    settings: JSON.stringify({ ...c.settings, ...patch }),
    secretsEncrypted: extra.storageState !== undefined && c.secrets ? encryptJson({ ...c.secrets, storageState: extra.storageState }) : c.conn.secretsEncrypted,
    lastCheckedAt: new Date(),
  });
}

/** The person typed the code BidPrime emailed them: check again right away with it. */
export async function submitBidPrimeCode(orgId: number, code: string) {
  const clean = code.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9-]{4,12}$/.test(clean)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the code exactly as BidPrime sent it." });
  codes.set(`bidprime-${orgId}`, { code: clean, until: Date.now() + 10 * 60_000 });
  await saveSettings(orgId, { waitingCode: false });
  queueCheck(orgId, true);
  return { success: true };
}

/** Clears an unanswered code request so a fresh sign-in can run. */
export async function clearWaiting(orgId: number) {
  await saveSettings(orgId, { waitingCode: false });
}

// Checks queued or running right now. Kept in memory, so a restart never leaves a check that looks stuck.
const activeChecks = new Set<number>();
export function isChecking(orgId: number) {
  return activeChecks.has(orgId);
}

export function queueCheck(orgId: number, manual = false, now = new Date(), liveId = newLiveId()) {
  if (activeChecks.has(orgId)) return false;
  activeChecks.add(orgId);
  liveStart(orgId, liveId);
  const queued = enqueue(`bidprime-${orgId}`, () => withUsage({ orgId, kind: "grants" }, () => checkBidPrime(orgId, manual, now, liveId)).finally(() => activeChecks.delete(orgId)));
  if (!queued) activeChecks.delete(orgId);
  return queued;
}

export function newLiveId() {
  return Math.random().toString(36).slice(2, 12);
}

/** The chat card that shows the browser live, with Take over. */
export function liveCard(liveId: string, title = "Morgan's browser") {
  return { type: "browser_live", id: 0, title, url: liveId };
}

/** When the browser is stuck: a message with the live card, waiting for the person. */
function stuckPoster(orgId: number, liveId: string, what: string) {
  return async (reason: string) => {
    const emp = await employeeFor(orgId, "grants");
    await post(orgId, `I'm stuck ${what}: ${reason.replace(/\.$/, "")}. Take over and get me past it, then press Hand back and I'll keep going. I'll wait 10 minutes.`, [liveCard(liveId, `${emp.name}'s browser`)]);
  };
}

// ==========================================
// Reading BidPrime
// ==========================================

async function post(orgId: number, content: string, cards: unknown[] = [], kind: "grants" | "speaking" = "grants") {
  const emp = await employeeFor(orgId, kind);
  await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content, cards: cards.length ? JSON.stringify(cards) : null });
}

function parseList(result: string): ListedBid[] {
  const data = extractJson(result) as { bids?: ListedBid[] } | ListedBid[] | undefined;
  const list = Array.isArray(data) ? data : data?.bids ?? [];
  return list.filter((b) => b && typeof b.title === "string" && b.title.trim()).slice(0, 15);
}

function isKnown(opps: Opportunity[], b: ListedBid) {
  const t = norm(b.title);
  return opps.some((o) => (b.sourceUrl && o.sourceUrl === b.sourceUrl) || (norm(o.title) === t && (!b.agency || norm(o.host).includes(norm(b.agency).slice(0, 12)) || norm(b.agency).includes(norm(o.host).slice(0, 12)))));
}

/** Signs in, reads new bids, opens up to six, and adds them to Opportunities. */
export async function checkBidPrime(orgId: number, manual = false, now = new Date(), liveId = newLiveId()) {
  const c = await connection(orgId);
  if (!c?.secrets?.email || !c.secrets.password) return { added: 0, status: "not_connected" as const };
  const emp = await employeeFor(orgId, "grants");
  // Every attempt counts toward "once a day", so a failing sign-in is not retried every minute.
  await saveSettings(orgId, { checking: true, lastError: null, lastAttemptAt: now.toISOString() });
  const secrets = { email: c.secrets.email, password: c.secrets.password, code: takeCode(`bidprime-${orgId}`) };
  let res: BrowserResult;
  try {
    res = await runBrowserTask({
      orgId,
      actor: `${emp.name}, the grants and bids employee`,
      startUrl: c.settings.startUrl || BIDPRIME_HOME,
      secrets,
      storageState: c.secrets.storageState ?? null,
      maxSteps: 45,
      live: { id: liveId, onStuck: stuckPoster(orgId, liveId, "in BidPrime") },
      goal: `${(c.settings.hints ?? []).length ? `Last time the person helped you past these pages: ${(c.settings.hints ?? []).join(". ")}. Do the same if you see them.\n` : ""}Sign in to BidPrime with the saved email and password (skip this if already signed in). Open the INBOX (its Notifications tab lists new bid leads).
As soon as that list is on the screen, read it from the page text and use done right away. Do not open bids, do not page through, do not search, do not change filters.
Return JSON exactly like {"bids":[{"title":"","agency":"","refnum":"","location":"","due":"","detailUrl":"","sourceUrl":""}]} with up to 15 of the newest rows: title from Title, agency from Entity, refnum from Refnum, location from State, due from Expires. detailUrl only if the row is a link with an address, else "". sourceUrl "".`,
    });
  } catch (err) {
    const message = (err as Error).message;
    await saveSettings(orgId, { checking: false, lastError: message }, { status: "error" });
    if (manual) await post(orgId, `I couldn't open BidPrime: ${message}`);
    return { added: 0, status: "failed" as const };
  }

  // What the person did to get past a page is remembered for next time.
  if (res.helped?.length) await saveSettings(orgId, { hints: [...(c.settings.hints ?? []), ...res.helped].slice(-6) });

  if (res.status === "need_code") {
    await saveSettings(orgId, { checking: false, waitingCode: true }, { storageState: res.storageState });
    await post(orgId, `BidPrime asked for a sign-in code, so I paused before reading your leads.${res.note ? ` The page says: "${res.note}"` : ""}`, [{ type: "bidprime_code", id: 0, title: "BidPrime sign-in code", subtitle: `Check ${c.secrets.email}. Codes usually expire in about 10 minutes.`, imageUrl: res.screenshotUrl }]);
    return { added: 0, status: "need_code" as const };
  }
  if (res.status === "failed") {
    await saveSettings(orgId, { checking: false, lastError: res.note }, { status: "error", storageState: res.storageState });
    await post(orgId, `I couldn't finish reading BidPrime: ${res.note}`, res.screenshotUrl ? [{ type: "bidprime_screen", id: 0, title: "What BidPrime showed", imageUrl: res.screenshotUrl }] : []);
    return { added: 0, status: "failed" as const };
  }

  const listed = parseList(res.result);
  // Rows without their own address are opened from the list page.
  const listUrl = [...res.log].reverse().find((l) => /bidprime\.com\/member/.test(l.url))?.url ?? null;
  const existing = await db.listOpps(orgId);
  const fresh = listed.filter((b) => !isKnown(existing, b));
  const created: Opportunity[] = [];
  let state = res.storageState;
  for (const b of fresh.slice(0, MAX_DETAILS)) {
    let text = [b.title, b.agency && `Agency: ${b.agency}`, b.location && `Location: ${b.location}`, b.due && `Due: ${b.due}`, b.sourceUrl && `Agency posting: ${b.sourceUrl}`].filter(Boolean).join("\n");
    let files: Download[] = [];
    const opened = b.detailUrl && /^https?:\/\//.test(b.detailUrl);
    if (opened || listUrl) {
      const d = await runBrowserTask({
        orgId,
        actor: `${emp.name}, the grants and bids employee`,
        startUrl: opened ? b.detailUrl! : listUrl!,
        secrets,
        storageState: state,
        maxSteps: 20,
        live: { id: liveId, holdMs: 0 },
        goal: `${opened ? `This is the BidPrime page for the bid "${b.title}".` : `This is the BidPrime inbox. Click the row titled "${b.title}"${b.refnum ? ` (Refnum ${b.refnum})` : ""} to open it.`} Sign in again with the saved email and password only if asked. Download every bid document offered (the RFP, attachments, forms, addenda). Then use done and put in result the full bid details as plain text: scope, requirements, due date and time, how responses are submitted (portal, email address or mail), the deadline and address for questions, the agency contact, and the agency's own posting link.`,
      }).catch(() => null);
      if (d?.status === "done") {
        text += `\n\n${d.result}`;
        files = d.downloads;
        state = d.storageState ?? state;
      }
    }
    try {
      created.push(await addOpportunityFromText(orgId, "grants", { text, sourceUrl: b.sourceUrl && /^https?:\/\//.test(b.sourceUrl) ? b.sourceUrl : null, source: "BidPrime", files, kind: "bid" }, emp.name));
    } catch (err) {
      console.warn("[bidprime] could not add a bid:", (err as Error).message);
    }
  }

  await saveSettings(orgId, { checking: false, waitingCode: false, lastError: null, lastCheckedAt: new Date().toISOString(), lastFound: created.length }, { status: "connected", storageState: state });
  if (created.length || manual) {
    const strong = created.filter((o) => o.fitCall === "apply" && o.fitScore >= 75);
    const skipped = created.filter((o) => o.fitCall === "skip");
    const more = fresh.length > MAX_DETAILS ? ` ${fresh.length - MAX_DETAILS} more are waiting; I'll open them next time.` : "";
    const content = created.length
      ? `Signed in to BidPrime. ${created.length} new ${created.length === 1 ? "bid" : "bids"}: ${strong.length} strong ${strong.length === 1 ? "fit" : "fits"}${skipped.length ? `, ${skipped.length} I'd skip` : ""}. They're on Opportunities with the documents downloaded.${more}`
      : "Signed in to BidPrime. Nothing new since my last check.";
    const cards = created.map((o) => oppCardFor(o));
    await post(orgId, content, cards);
  }
  return { added: created.length, status: "done" as const };
}

/** Every morning at 7:00 in the workspace's time zone, once a day. */
export async function bidsTick(now = new Date()) {
  for (const orgId of await db.listAllOrganizationIds()) {
    const c = await connection(orgId).catch(() => null);
    if (!c || c.conn.status === "disconnected" || !c.secrets?.password || isChecking(orgId)) continue;
    const org = await db.getOrganizationById(orgId);
    const tz = org?.timezone || "America/Chicago";
    const p = partsIn(now, tz);
    if (p.h < 7) continue;
    const stamp = c.settings.lastAttemptAt ?? c.settings.lastCheckedAt;
    const last = stamp ? partsIn(new Date(stamp), tz) : null;
    if (last && last.y === p.y && last.m === p.m && last.d === p.d) continue;
    queueCheck(orgId, false, now);
  }
}

// ==========================================
// Submitting an approved response
// ==========================================

function localPath(fileUrl: string | null | undefined) {
  if (!fileUrl || !fileUrl.startsWith("/files/")) return null;
  const full = path.resolve(uploadsRoot(), fileUrl.slice("/files/".length));
  return full.startsWith(uploadsRoot()) && fs.existsSync(full) ? full : null;
}

function hostOf(url: string | null | undefined) {
  try {
    return url ? new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The saved portal sign-in for this opportunity: same web address, or the portal's name in the submission details. */
export function portalFor(logins: PortalLogin[], opp: Opportunity | null, app: Application) {
  const hosts = [hostOf(app.channelDetail), hostOf(opp?.sourceUrl)].filter(Boolean) as string[];
  const words = norm(`${app.channelDetail ?? ""} ${opp?.host ?? ""}`);
  return (
    logins.find((l) => {
      const h = hostOf(l.url);
      return h && hosts.some((x) => x === h || x.endsWith(`.${h}`) || h.endsWith(`.${x}`));
    }) ??
    logins.find((l) => norm(l.name).length > 3 && words.includes(norm(l.name))) ??
    null
  );
}

const emailOf = (s: string | null | undefined) => (s ?? "").match(/[^\s<>"',;]+@[^\s<>"',;]+\.[a-z]{2,}/i)?.[0] ?? null;

/** What a response still needs before Morgan can send it, shown as the "Before it goes in" list. */
export async function readiness(orgId: number, app: Application) {
  const opp = await db.getOpp(app.opportunityId, orgId);
  const reqs = parse<Partial<Requirements>>(opp?.requirements, {});
  const conns = await db.listConnectionsByOrg(orgId);
  const google = conns.some((x) => x.provider === "google_workspace" && x.status === "connected");
  const login = portalFor(await db.listPortalLogins(orgId), opp, app);
  const to = emailOf(app.channelDetail) ?? emailOf(reqs.channelDetail);
  // A pitch to a reporter can go from Taylor's own sending address.
  const sender = opp?.kind === "media" ? db.listAccountLinks(orgId, "send").find((l) => parse<string[]>(l.sendsFor, []).includes("speaking") && l.status === "connected") : undefined;
  const canSend = google || Boolean(sender);
  let route: { how: "email" | "portal" | "manual"; label: string; ready: boolean; detail: string };
  if (app.channel === "email") route = { how: "email", label: to ? `Sends by email to ${to}` : "Goes in by email", ready: Boolean(to && canSend), detail: !to ? "No email address found for submissions" : sender ? `From ${sender.email ?? "Taylor's sending address"}` : google ? "From your connected Google account" : "Connect Google on Integrations to send it" };
  else if (app.channel === "grants_gov") route = { how: "manual", label: "Goes in through Grants.gov", ready: false, detail: "Grants.gov needs your authorized representative to submit" };
  else route = { how: "portal", label: login ? `${login.name} sign-in saved` : `No saved sign-in for ${app.channelDetail || opp?.host || "this portal"}`, ready: Boolean(login), detail: login ? "Morgan signs in, uploads every file and submits" : "Add it on Integrations under Website logins" };
  return { route, portalId: login?.id ?? null };
}

/** After Approve: send it, or say plainly what still needs a person. */
export async function autoSubmit(orgId: number, appId: number) {
  const app = await db.getApplication(appId, orgId);
  if (!app || app.status !== "approved") return;
  const opp = await db.getOpp(app.opportunityId, orgId);
  const who = opp?.kind === "media" || opp?.kind === "speaking" ? "speaking" : "grants";
  const emp = await employeeFor(orgId, who);
  const org = await db.getOrganizationById(orgId);
  const { route } = await readiness(orgId, app);
  if (!route.ready) {
    await post(orgId, `${app.title} is approved. ${route.detail}, so it's ready for you to send: download it from the application and submit it, then press Mark sent.`, [], who);
    return;
  }

  // A pitch to a reporter is the email itself: short, in the body, no attachments.
  if (opp?.kind === "media" && route.how === "email") {
    const reqs = parse<Partial<Requirements>>(opp.requirements, {});
    const to = emailOf(app.channelDetail) ?? emailOf(reqs.channelDetail)!;
    const qs = parse<{ text: string; answer: string }[]>(app.questions, []);
    const subjectQ = qs.find((q) => /subject/i.test(q.text));
    const subject = (subjectQ?.answer.trim() || `Re: ${opp.title}`).replace(/\s+/g, " ").slice(0, 120);
    const body = [
      ...qs.filter((q) => q !== subjectQ && q.answer.trim()).map((q) => q.answer.trim()),
      [org?.signerName, org?.signerTitle, org?.name].filter(Boolean).join("\n"),
    ].join("\n\n");
    try {
      const link = await integrations.sendGmail(orgId, to, subject, body, "speaking");
      await db.updateApplication(appId, orgId, { receiptUrl: link });
      await markSubmitted(orgId, appId, `Emailed to ${to}`, emp.name);
    } catch (err) {
      await post(orgId, `I couldn't email the pitch for ${app.title}: ${(err as Error).message}. It's still approved; try again from the pitch or send it yourself.`, [], who);
    }
    return;
  }

  // The response and every attachment on file.
  const { applicationDocx } = await import("./exports");
  const docx = await applicationDocx(orgId, appId);
  const files: { name: string; buf: Buffer; mime: string }[] = [];
  const dp = localPath(docx.url);
  if (dp) files.push({ name: docx.name, buf: fs.readFileSync(dp), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  for (const a of parse<Attachment[]>(app.attachments, [])) {
    const p = localPath(a.fileUrl);
    if (p) files.push({ name: `${a.name.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80)}${path.extname(p)}`, buf: fs.readFileSync(p), mime: "application/octet-stream" });
  }

  if (route.how === "email") {
    const reqs = parse<Partial<Requirements>>(opp?.requirements, {});
    const to = emailOf(app.channelDetail) ?? emailOf(reqs.channelDetail)!;
    try {
      const link = await integrations.sendGmailWithFiles(
        orgId,
        to,
        `${opp?.title ?? app.title}: response from ${org?.name ?? "our organization"}`,
        `Hello,\n\nAttached is ${org?.name ?? "our"} response to ${opp?.title ?? app.title}${opp?.host ? ` (${opp.host})` : ""}, with ${files.length} ${files.length === 1 ? "file" : "files"}.\n\nPlease confirm you received it.\n\n${org?.signerName ?? ""}${org?.signerTitle ? `, ${org.signerTitle}` : ""}\n${org?.name ?? ""}`.trim(),
        files
      );
      await db.updateApplication(appId, orgId, { receiptUrl: link });
      await markSubmitted(orgId, appId, `Emailed to ${to}`, emp.name);
    } catch (err) {
      await post(orgId, `I couldn't email ${app.title}: ${(err as Error).message}. It's still approved; try again from the application or send it yourself.`, [], who);
    }
    return;
  }

  // Through the agency's portal.
  const login = portalFor(await db.listPortalLogins(orgId), opp, app);
  if (!login) return;
  const secrets = decryptJson<{ password: string }>(login.secretEncrypted);
  const upload = tempFiles(files);
  const liveId = newLiveId();
  const qs = parse<{ text: string; answer: string }[]>(app.questions, []);
  const res = await runBrowserTask({
    orgId,
    actor: `${emp.name}, submitting an approved bid response`,
    startUrl: login.url || opp?.sourceUrl || "",
    secrets: { email: login.username, password: secrets?.password, code: takeCode(`portal-${login.id}`) },
    allowSubmit: true,
    files: upload,
    maxSteps: 60,
    live: { id: liveId, onStuck: stuckPoster(orgId, liveId, `submitting ${app.title} on ${login.name}`) },
    goal: opp?.kind === "media"
      ? `Sign in to ${login.name} with the saved email and password. Open the reporter's request "${opp.title}"${opp.sourceUrl ? ` (${opp.sourceUrl})` : ""} and start a pitch or answer to it.
Put this answer in the pitch or answer box, exactly as written (no files are needed):
${qs.filter((q) => !/subject/i.test(q.text) && q.answer.trim()).map((q) => q.answer.trim()).join("\n\n").slice(0, 6000)}
Expert: ${org?.signerName ?? ""}${org?.signerTitle ? `, ${org.signerTitle}` : ""}, ${org?.name ?? ""}.
Then submit the pitch. Return JSON {"confirmation":"the confirmation message shown"}. If the request is closed or the site asks for something not given here, stop with fail and say what.`
      : `Sign in to ${login.name} with the saved email and password. Find the opportunity "${opp?.title ?? app.title}"${opp?.sourceUrl ? ` (${opp.sourceUrl})` : ""} and start a response or submission.
Upload each file from the file list to the matching upload field (the response document goes where the proposal or response is asked for; attachments to their named fields).
Fill required text fields using these answers when a field matches:
${qs.map((q) => `- ${q.text}: ${q.answer.slice(0, 600)}`).join("\n").slice(0, 6000)}
Company: ${org?.name ?? ""}. Contact: ${org?.signerName ?? ""}${org?.signerTitle ? `, ${org.signerTitle}` : ""}.
When every required file and field is done, submit. Then return JSON {"confirmation":"the confirmation number or message shown"}.
If a field needs something not given here (a price, a signature, a notarized form, a fee), stop with fail and name it.`,
  }).catch((err) => ({ status: "failed", note: (err as Error).message, result: "", screenshotUrl: null }) as Pick<BrowserResult, "status" | "note" | "result" | "screenshotUrl">);
  for (const f of upload) fs.rmSync(path.dirname(f.path), { recursive: true, force: true });

  if (res.status === "done") {
    const conf = (extractJson(res.result) as { confirmation?: string } | undefined)?.confirmation || res.result.slice(0, 120) || "Submitted";
    await db.updateApplication(appId, orgId, { receiptUrl: res.screenshotUrl });
    await markSubmitted(orgId, appId, String(conf).slice(0, 120), emp.name);
    return;
  }
  if (res.status === "need_code") {
    await post(orgId, `${login.name} asked for a sign-in code before I could submit ${app.title}.`, [{ type: "portal_code", id: login.id, title: `${login.name} sign-in code`, subtitle: `For ${app.title}. Paste it and I'll submit right away.`, url: String(appId) }], who);
    return;
  }
  await post(orgId, `I stopped before submitting ${app.title}: ${res.note}. It's still approved; fix that and press Send now on the application, or send it yourself.`, [], who);
}

/** A code for an agency portal, then retry the submission. */
export async function submitPortalCode(orgId: number, portalId: number, appId: number, code: string) {
  const clean = code.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9-]{4,12}$/.test(clean)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the code exactly as the portal sent it." });
  codes.set(`portal-${portalId}`, { code: clean, until: Date.now() + 10 * 60_000 });
  enqueue(`submit-${appId}`, () => withUsage({ orgId, kind: "grants" }, () => autoSubmit(orgId, appId)));
  return { success: true };
}

/** A question for the buyer, drafted as an email that waits in Approvals. */
export async function askQuestion(orgId: number, oppId: number, question: string) {
  const opp = await db.getOpp(oppId, orgId);
  if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "That opportunity is not in this workspace." });
  const reqs = parse<Partial<Requirements>>(opp.requirements, {});
  const to = emailOf(reqs.questionsTo) ?? emailOf(reqs.contact?.email) ?? emailOf(reqs.channelDetail);
  if (!to) throw new TRPCError({ code: "BAD_REQUEST", message: "The documents don't list an email address for questions." });
  const emp = await employeeFor(orgId, "grants");
  const org = await db.getOrganizationById(orgId);
  const item = await db.createOutboundItem({
    organizationId: orgId,
    employeeId: emp.id,
    kind: "email_draft",
    status: "pending_approval",
    title: `Question: ${opp.title}`.slice(0, 250),
    body: `Hello,\n\n${org?.name ?? "We"} plan${org?.name ? "s" : ""} to respond to ${opp.title}. We have a question:\n\n${question.trim()}\n\nThank you,\n${org?.signerName ?? ""}${org?.signerTitle ? `, ${org.signerTitle}` : ""}\n${org?.name ?? ""}`.trim(),
    targetChannels: JSON.stringify(["Gmail"]),
    metadata: JSON.stringify({ recipient: to, email: to, whatTheyWant: `Answer a question about ${opp.title}`, urgency: "today", newEmail: true }),
  });
  await db.logAction({ organizationId: orgId, actorType: "employee", actorName: emp.name, action: "Drafted a question for the buyer", details: `${opp.title}: waiting in Approvals` });
  return item;
}
