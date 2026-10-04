import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import type { OutboundItem, PressCampaign, PressContact, PressPitch, PressReply, PressStory } from "../../drizzle/schema";
import { afterSent, postNow } from "../social";
import { employeeFor, systemPromptFor, working } from "./tasks";
import { zonedToUtc } from "./schedule";
import { contactFor, contactsFor, coolingFor, crisisCheck, fitOf, fmtDay, newsroomOrgs, norm, parse, scout, settingsOf, wordsIn, type Article, type Profile } from "./newsroom";

/**
 * Campaigns, pitches and replies. A campaign starts with a plan and five story
 * angles, then the right reporters, then one pitch per reporter written to
 * their recent work and graded on an 8-part check: under 85 it's rewritten
 * before the owner sees it. Every pitch and reply goes out through Approvals
 * from Taylor's sending address.
 */

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: unknown): JsonSchema => ({ type: "array", items });
const DAY = 86_400_000;

export const RUBRIC: [string, number][] = [
  ["Clear reason this reporter was picked", 20],
  ["Strong why now", 20],
  ["Story bigger than the company", 15],
  ["Evidence or access offered", 15],
  ["Subject line sounds human", 10],
  ["Right length", 10],
  ["No unsupported claims", 5],
  ["No fake personalization", 5],
];
export const PASS = 85;

export type Plan = { goal: string; audience: string; story: string; founderAngle: string; proof: string; beats: string[]; neverSay: string; order: string };
export type Angle = { text: string; use: boolean };

// ==========================================
// Campaigns
// ==========================================

const PLAN_JOB = `Your job now: you are the publicist, planning a media campaign before any reporter is contacted.
- Find the story bigger than the company: why anyone outside it would care, and why now. A feature is not news; a trend with the owner as the example is.
- The plan: the goal, the audience, the main story in one sentence, the founder angle, the proof we can offer (only what the Brain supports), the beats to target, what never to say (claims we can't back up, AI replacing clinicians, clinical decisions by AI, anything about clients), and the order (an exclusive first when it matters, then an embargoed list, then everyone, then podcasts), with dates as Mon D, YYYY.
- Five story angles, each one sentence a reporter could write as a headline. No "excited to announce".`;

export async function planCampaign(orgId: number, brief: string, opts: { storyId?: number; startsOn?: string; title?: string } = {}) {
  const emp = await employeeFor(orgId, "speaking");
  return working(emp, async () => {
    const { system } = await systemPromptFor(emp, PLAN_JOB);
    const story = opts.storyId ? db.press.stories.get(opts.storyId, orgId) : null;
    const r = await generateJson<Plan & { title: string; angles: string[] }>({
      system,
      prompt: `${story ? `Built from this story: ${story.title}. Angle so far: ${story.angle}\n` : ""}What the owner wants: ${brief}${opts.startsOn ? `\nPitching starts ${opts.startsOn}.` : ""}`,
      schemaName: "press_campaign",
      schema: obj({ title: str, goal: str, audience: str, story: str, founderAngle: str, proof: str, beats: arr(str), neverSay: str, order: str, angles: arr(str) }),
      maxTokens: 3000,
    });
    const plan: Plan = { goal: r.goal ?? "", audience: r.audience ?? "", story: r.story ?? "", founderAngle: r.founderAngle ?? "", proof: r.proof ?? "", beats: (r.beats ?? []).slice(0, 10), neverSay: r.neverSay ?? "", order: r.order ?? "" };
    const angles: Angle[] = (r.angles ?? []).slice(0, 5).map((text, i) => ({ text, use: i < 2 }));
    return db.press.campaigns.create({
      organizationId: orgId,
      title: (opts.title || r.title || brief).slice(0, 200),
      status: opts.startsOn && Date.parse(opts.startsOn) > Date.now() + DAY ? "scheduled" : "planning",
      startsOn: opts.startsOn ?? null,
      plan: JSON.stringify(plan),
      angles: JSON.stringify(angles),
      storyId: story?.id ?? null,
    });
  });
}

export function saveCampaign(orgId: number, id: number, input: { title: string; plan: Plan; angles: Angle[] }) {
  if (!db.press.campaigns.get(id, orgId)) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't on this desk." });
  return db.press.campaigns.update(id, orgId, { title: input.title.trim().slice(0, 200), plan: JSON.stringify(input.plan), angles: JSON.stringify(input.angles.slice(0, 5)) })!;
}

export function finishCampaign(orgId: number, id: number) {
  if (!db.press.campaigns.get(id, orgId)) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't on this desk." });
  return db.press.campaigns.update(id, orgId, { status: "done" })!;
}

const contactLine = (orgId: number, c: PressContact) => {
  const arts = parse<Article[]>(c.articles, []).slice(0, 3).map((a) => `"${a.title}" (${a.date})`).join("; ");
  return `id ${c.id}: ${c.name}, ${c.title ? `${c.title}, ` : ""}${c.outlet}. Beats: ${parse<string[]>(c.beats, []).join(", ")}. Fit ${fitOf(c, orgId)}. Recent: ${arts}. ${c.why}`;
};

/** Picks the right reporters for a campaign (scouting for more when the list is thin) and writes each a pitch. */
export async function addReporters(orgId: number, campaignId: number, opts: { max?: number } = {}) {
  const camp = db.press.campaigns.get(campaignId, orgId);
  if (!camp) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't on this desk." });
  if (settingsOf(orgId).paused) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This desk is paused. Resume it in Press settings first." });
  const plan = parse<Plan>(camp.plan, {} as Plan);
  const angles = parse<Angle[]>(camp.angles, []).filter((a) => a.use);
  if (!angles.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one story angle first." });
  const taken = new Set(db.press.pitches.list(orgId).filter((p) => p.campaignId === campaignId).map((p) => p.contactId));
  const pool = () => contactsFor(orgId).filter((c) => !c.doNotContact && !taken.has(c.id) && fitOf(c, orgId) >= 50);
  if (pool().length < 4) await scout(orgId, { focus: `${camp.title}. Beats: ${plan.beats?.join(", ")}`, quiet: true }).catch(() => null);
  const candidates = pool();
  if (!candidates.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No reporters with recent articles on these beats yet. Press Scout now on the Newsroom tab, then try again." });
  const emp = await employeeFor(orgId, "speaking");
  const picks = await working(emp, async () => {
    const { system } = await systemPromptFor(emp, "Your job now: you are the publicist, matching reporters to a campaign. Pick only reporters whose recent work shows the story genuinely fits their coverage; a reporter who covers funding rounds is wrong for a bootstrapped launch. For each, pick the angle that fits their work best.");
    const r = await generateJson<{ picks: { contactId: number; angle: number; why: string }[] }>({
      system,
      prompt: `Campaign: ${camp.title}\nMain story: ${plan.story}\nAudience: ${plan.audience}\nAngles:\n${angles.map((a, i) => `${i + 1}. ${a.text}`).join("\n")}\n\nReporters:\n${candidates.slice(0, 60).map((c) => contactLine(orgId, c)).join("\n")}\n\nPick up to ${opts.max ?? 12}, best fit first.`,
      schemaName: "press_picks",
      schema: obj({ picks: arr(obj({ contactId: int, angle: int, why: str })) }),
      maxTokens: 3000,
    });
    return (r.picks ?? []).filter((p) => candidates.some((c) => c.id === p.contactId)).slice(0, opts.max ?? 12);
  });
  db.press.campaigns.update(campaignId, orgId, { status: "pitching" });
  const made: PressPitch[] = [];
  for (const p of picks) made.push(await writePitch(orgId, p.contactId, { campaignId, angle: angles[Math.max(0, Math.min(angles.length - 1, (p.angle || 1) - 1))].text }));
  return made;
}

// ==========================================
// Writing and checking a pitch
// ==========================================

const PITCH_JOB = `Your job now: you are the publicist, writing one pitch to one reporter. You think like a journalist before a marketer.
Every pitch answers: why this story, why now, why this reporter, why the owner, and what we can offer that makes the reporter's story stronger.
- Under 200 words. A plain, specific subject line under 60 characters that sounds like a person wrote it.
- Open with their actual recent work: name the piece and what it covered or left open, then connect. Never fake familiarity ("I loved your recent article", "big fan").
- The story is bigger than the company; the company or the owner is the example or the access.
- Offer something concrete: an interview, a look inside a working practice, a demo, data only if the Brain has it.
- Use only facts in the Brain. Never invent statistics, customers, results, quotes or relationships. Quote the owner only with an approved quote below, word for word.
- Sign with the owner's name and credentials from the Brain. No attachments.`;

const GRADE_JOB = `Your job now: you are a senior publicist checking a junior's pitch before it goes to the owner. Be strict. Score each test; a test with any problem loses points. Then list the exact fixes.`;

type Ctx = { campaignId?: number; storyId?: number; angle?: string; followUp?: boolean; previous?: PressPitch };

async function pitchContext(orgId: number, c: PressContact, ctx: Ctx) {
  const camp = ctx.campaignId ? db.press.campaigns.get(ctx.campaignId, orgId) : null;
  const story = ctx.storyId ? db.press.stories.get(ctx.storyId, orgId) : null;
  const plan = camp ? parse<Plan>(camp.plan, {} as Plan) : null;
  const quotes = db.press.library.list(orgId).filter((q) => q.kind === "quote" && q.approved);
  const org = await db.getOrganizationById(orgId);
  const prof = parse<Profile>(c.profile, {});
  return `Reporter: ${c.name}${c.title ? `, ${c.title}` : ""}, ${c.outlet}
Why them: ${c.why}
How they work: ${[prof.storyType, prof.sources && `quotes ${prof.sources}`, prof.launches && `launches: ${prof.launches}`, prof.strongest && `strongest angle: ${prof.strongest}`, prof.likes && `likes ${prof.likes}`].filter(Boolean).join("; ")}
Their recent articles:\n${parse<Article[]>(c.articles, []).slice(0, 4).map((a) => `- "${a.title}" (${a.date}) ${a.url}${a.topics ? ` about ${a.topics}` : ""}`).join("\n")}
${c.asks ? `They told us before: "${c.asks}". Only pitch if we now have it.\n` : ""}${c.lastPitch ? `Last pitch from us: ${c.lastPitch}\n` : ""}
${camp ? `Campaign: ${camp.title}\nMain story: ${plan?.story}\nFounder angle: ${plan?.founderAngle}\nProof we can offer: ${plan?.proof}\nNever say: ${plan?.neverSay}\n` : ""}${story ? `News hook: ${story.title} (${story.source}${story.windowEnds ? `, window ends ${story.windowEnds}` : ""})\nAngle: ${story.angle}\nWhat we offer: ${story.offer}\n` : ""}${ctx.angle ? `Use this angle: ${ctx.angle}\n` : ""}${ctx.followUp && ctx.previous ? `This is a short follow-up (3 to 5 sentences) to the pitch below, sent ${ctx.previous.sentAt ? fmtDay(new Date(ctx.previous.sentAt)) : "last week"} with no reply. Add something new (a fresh fact, a new hook, a specific offer); never "just bumping this".\nSubject: ${ctx.previous.subject}\n${ctx.previous.body}\n` : ""}
Approved quotes from the owner (use word for word or not at all):\n${quotes.map((q) => `- ${q.topic}: "${q.text}"`).join("\n") || "- none yet"}
Sign as: ${org?.signerName ?? "the owner"}${org?.signerTitle ? `, ${org.signerTitle}` : ""}`;
}

/** Writes a pitch, grades it, and rewrites it until it passes (or three tries). Cooling or Do not contact skips writing. */
export async function writePitch(orgId: number, contactId: number, ctx: Ctx) {
  const c = contactFor(orgId, contactId);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That reporter isn't in this newsroom." });
  const base = { organizationId: orgId, contactId, campaignId: ctx.campaignId ?? null, storyId: ctx.storyId ?? null, followUp: Boolean(ctx.followUp) };
  if (c.doNotContact) return db.press.pitches.create({ ...base, status: "skipped" });
  const cool = coolingFor(orgId, c, ctx.followUp);
  if (cool.until) return db.press.pitches.create({ ...base, status: "cooling", coolingUntil: cool.until });
  const emp = await employeeFor(orgId, "speaking");
  return working(emp, async () => {
    const context = await pitchContext(orgId, c, ctx);
    const { system } = await systemPromptFor(emp, PITCH_JOB);
    const { system: gradeSystem } = await systemPromptFor(emp, GRADE_JOB);
    let draft = { subject: "", body: "" };
    let rubric: { name: string; points: number; max: number }[] = [];
    let fixes = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      draft = await generateJson<{ subject: string; body: string }>({
        system,
        prompt: `${context}${attempt ? `\n\nRewrite this pitch. It scored ${rubric.reduce((t, x) => t + x.points, 0)} of 100. Fix: ${fixes}\nSubject: ${draft.subject}\n${draft.body}` : ""}`,
        schemaName: "press_pitch",
        schema: obj({ subject: str, body: str }),
        maxTokens: 1500,
      });
      const g = await generateJson<{ scores: number[]; fixes: string }>({
        system: gradeSystem,
        prompt: `Tests, in order, with the most points each can earn:\n${RUBRIC.map(([n, m], i) => `${i + 1}. ${n} (${m})`).join("\n")}\n\nWhat the writer knew:\n${context}\n\nThe pitch:\nSubject: ${draft.subject}\n${draft.body}\n\nReturn 8 scores in order and the fixes.`,
        schemaName: "press_grade",
        schema: obj({ scores: arr(int), fixes: str }),
        maxTokens: 1200,
      });
      rubric = RUBRIC.map(([name, max], i) => ({ name, max, points: Math.max(0, Math.min(max, Math.round(Number(g.scores?.[i] ?? 0)))) }));
      fixes = g.fixes ?? "";
      if (rubric.reduce((t, x) => t + x.points, 0) >= PASS) break;
    }
    const score = rubric.reduce((t, x) => t + x.points, 0);
    const pitch = db.press.pitches.create({ ...base, subject: (draft.subject ?? "").slice(0, 200), body: (draft.body ?? "").slice(0, 4000), score, rubric: JSON.stringify(rubric), status: score >= PASS ? "ready" : "weak" });
    if (pitch.status === "ready" && c.email) {
      const item = await ensureItem(orgId, pitch, c, emp.id);
      // At level 4 and up, a strong pitch on a safe topic goes out on its own.
      const st = settingsOf(orgId);
      const sensitive = wordsIn(st.alwaysNeedsYou, `${pitch.subject} ${pitch.body}`).length > 0;
      if (st.level >= 4 && score >= (st.level >= 5 ? PASS : 90) && !sensitive && !st.paused) await postNow(item, `${emp.name} (on her own, level ${st.level})`, "system", "Sent on its own", { approvedBy: `${emp.name} (level ${st.level})`, approvedAt: new Date() });
    }
    return db.press.pitches.get(pitch.id, orgId)!;
  });
}

/** The Approvals item that sends a pitch, made once. */
async function ensureItem(orgId: number, p: PressPitch, c: PressContact, employeeId: number): Promise<OutboundItem> {
  if (p.itemId) {
    const existing = await db.getOutboundItemForOrg(p.itemId, orgId);
    if (existing) return existing;
  }
  const item = await db.createOutboundItem({
    organizationId: orgId,
    employeeId,
    kind: "email_draft",
    status: "pending_approval",
    title: p.subject,
    body: p.body,
    targetChannels: JSON.stringify(["Gmail"]),
    metadata: JSON.stringify({ email: c.email, pressPitchId: p.id, recipientName: c.name, outlet: c.outlet }),
  });
  db.press.pitches.update(p.id, orgId, { itemId: item.id, status: p.status === "weak" ? "weak" : "ready" });
  return item;
}

export async function editPitch(orgId: number, pitchId: number, input: { subject: string; body: string }) {
  const p = db.press.pitches.get(pitchId, orgId);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That pitch isn't on this desk." });
  if (p.status === "sent") throw new TRPCError({ code: "BAD_REQUEST", message: "That pitch was already sent." });
  const next = db.press.pitches.update(pitchId, orgId, { subject: input.subject.trim().slice(0, 200), body: input.body.trim().slice(0, 4000) })!;
  if (p.itemId) await db.updateOutboundItem(p.itemId, orgId, { title: next.subject, body: next.body });
  return next;
}

/** The owner approves a pitch (a weak one too, on her say): it goes out now from Taylor's address. */
export async function approvePitch(orgId: number, pitchId: number, reviewer: string) {
  const p = db.press.pitches.get(pitchId, orgId);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That pitch isn't on this desk." });
  if (!["ready", "weak", "pending"].includes(p.status)) throw new TRPCError({ code: "BAD_REQUEST", message: p.status === "sent" ? "That pitch was already sent." : p.status === "cooling" ? "That reporter is cooling off from another desk's pitch." : "That pitch can't be sent." });
  if (settingsOf(orgId).paused) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This desk is paused. Resume it in Press settings first." });
  const c = contactFor(orgId, p.contactId);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That reporter isn't in this newsroom." });
  if (c.doNotContact) throw new TRPCError({ code: "BAD_REQUEST", message: `${c.name} asked not to be contacted.` });
  if (!c.email) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `There's no public email for ${c.name} yet. Add one with Edit on the Media list.` });
  const emp = await employeeFor(orgId, "speaking");
  const item = await ensureItem(orgId, p, c, emp.id);
  db.press.pitches.update(pitchId, orgId, { status: "pending" });
  await postNow(item, reviewer, "human_user", "Approved", { approvedBy: reviewer, approvedAt: new Date() });
  return db.press.pitches.get(pitchId, orgId)!;
}

export async function approveReady(orgId: number, campaignId: number, reviewer: string) {
  let sent = 0;
  for (const p of db.press.pitches.list(orgId).filter((x) => x.campaignId === campaignId && x.status === "ready")) {
    const c = contactFor(orgId, p.contactId);
    if (!c?.email) continue;
    await approvePitch(orgId, p.id, reviewer);
    sent++;
  }
  return { sent };
}

// After a pitch or a reply goes out: record it on the reporter so every desk sees it.
afterSent.push(async (item, status) => {
  const meta = parse<{ pressPitchId?: number; pressReplyId?: number }>(item.metadata, {});
  if (meta.pressPitchId) {
    const p = db.press.pitches.get(meta.pressPitchId, item.organizationId);
    if (!p) return;
    if (status !== "published") {
      db.press.pitches.update(p.id, item.organizationId, { status: "ready" });
      return;
    }
    db.press.pitches.update(p.id, item.organizationId, { status: "sent", sentAt: new Date() });
    const c = contactFor(item.organizationId, p.contactId);
    if (c) db.press.contacts.update(c.id, c.organizationId, { lastContactAt: new Date(), lastContactOrgId: item.organizationId, lastPitch: p.subject, ...(c.relationship === "prospect" ? { relationship: "contacted" as const } : {}) });
  }
  if (meta.pressReplyId && status === "published") db.press.replies.update(meta.pressReplyId, item.organizationId, { status: "sent" });
});

// ==========================================
// Rapid response and follow-ups
// ==========================================

/** A strong story with a short window: the best approved quote and pitches to the best reporters, posted in chat. */
export async function rapidResponse(story: PressStory) {
  const orgId = story.organizationId;
  const emp = await employeeFor(orgId, "speaking");
  const quotes = db.press.library.list(orgId).filter((q) => q.kind === "quote" && q.approved);
  let quote: string | null = null;
  if (quotes.length) {
    const { system } = await systemPromptFor(emp, "Your job now: pick the owner's approved quote that fits this news best, or none.");
    const r = await generateJson<{ index: number }>({ system, prompt: `News: ${story.title}. Angle: ${story.angle}\nQuotes:\n${quotes.map((q, i) => `${i + 1}. ${q.text}`).join("\n")}\nReturn the number, or 0 for none.`, schemaName: "press_quote_pick", schema: obj({ index: int }), maxTokens: 200 });
    quote = r.index > 0 ? quotes[r.index - 1]?.text ?? null : null;
  }
  db.press.stories.update(story.id, orgId, { quote });
  const ids = parse<number[]>(story.contactIds, []);
  const skipped = new Set(parse<{ contactId: number }[]>(story.skipped, []).map((s) => s.contactId));
  const best = ids.map((id) => contactFor(orgId, id)).filter((c): c is PressContact => Boolean(c) && !skipped.has(c!.id) && !c!.doNotContact).sort((a, b) => fitOf(b, orgId) - fitOf(a, orgId)).slice(0, 6);
  const made: PressPitch[] = [];
  for (const c of best) made.push(await writePitch(orgId, c.id, { storyId: story.id, angle: story.angle }));
  const ready = made.filter((p) => p.status === "ready").length;
  const skippedNames = parse<{ contactId: number; reason: string }[]>(story.skipped, []).map((s) => `${contactFor(orgId, s.contactId)?.name ?? "a reporter"} (${s.reason})`);
  await db.createChatMessage({
    organizationId: orgId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content: `${story.title}${story.source ? ` (${story.source})` : ""}: ${ids.length} ${ids.length === 1 ? "reporter is" : "reporters are"} on it and it belongs to this desk. I drafted pitches for the ${made.length} best fits; ${ready} passed the pitch check. The window ends ${story.windowEnds || "soon"}.${skippedNames.length ? ` Skipped: ${skippedNames.join("; ")}.` : ""}`,
    cards: JSON.stringify([{ type: "press_story", id: story.id, title: story.title }]),
  });
  return made;
}

/** From level 2, pitches sent five days ago with no answer get a short follow-up with something new; at level 3 and up it sends itself. */
export async function followUpsDue(orgId: number) {
  const st = settingsOf(orgId);
  if (st.paused || st.level < 2) return 0;
  const all = db.press.pitches.list(orgId);
  const due = all.filter((p) => p.status === "sent" && !p.followUp && p.sentAt && new Date(p.sentAt).getTime() < Date.now() - 5 * DAY && new Date(p.sentAt).getTime() > Date.now() - 21 * DAY && !all.some((f) => f.followUp && f.contactId === p.contactId && f.campaignId === p.campaignId && f.storyId === p.storyId));
  let n = 0;
  for (const p of due.slice(0, 5)) {
    const f = await writePitch(orgId, p.contactId, { campaignId: p.campaignId ?? undefined, storyId: p.storyId ?? undefined, followUp: true, previous: p });
    if (f.status === "ready" && st.level >= 3) {
      const item = f.itemId ? await db.getOutboundItemForOrg(f.itemId, orgId) : null;
      if (item) await postNow(item, `Taylor (follow-up, level ${st.level})`, "system", "Sent on its own", { approvedBy: `Taylor (level ${st.level})`, approvedAt: new Date() });
    }
    n++;
  }
  return n;
}

// ==========================================
// Replies from reporters
// ==========================================

const REPLY_KINDS = ["interview", "not_now", "questions", "dnc", "referral", "moved", "ooo", "other"] as const;

/** Three open times in the next week (10:00 AM and 2:00 PM on weekdays) from Avery's view of the calendars. */
async function openTimes(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const { freeAt } = await import("./calendars");
  const out: string[] = [];
  for (let d = 1; d <= 9 && out.length < 3; d++) {
    const day = new Date(Date.now() + d * DAY);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(day).map((x) => [x.type, x.value]));
    if (parts.weekday === "Sat" || parts.weekday === "Sun") continue;
    for (const h of [10, 14]) {
      if (out.length >= 3) break;
      const at = zonedToUtc(Number(parts.year), Number(parts.month), Number(parts.day), h, 0, tz);
      const f = await freeAt(orgId, at, 30).catch(() => ({ open: true }));
      if (f.open) out.push(`${parts.weekday}, ${fmtDay(at)} at ${h === 10 ? "10:00 AM" : "2:00 PM"}`);
    }
  }
  return { times: out, tz };
}

/** A reporter's email: crisis words stop the desk; otherwise it's sorted, the reporter's record is updated, and a reply is drafted. */
export async function handleReply(inboxOrg: number, msg: { messageId: string; fromEmail: string; fromName: string; subject: string; text: string; date?: Date }) {
  const contacts = contactsFor(inboxOrg);
  const c = contacts.find((x) => x.email && x.email.toLowerCase() === msg.fromEmail.toLowerCase()) ?? null;
  const desk = c?.lastContactOrgId && newsroomOrgs(inboxOrg).includes(c.lastContactOrgId) ? c.lastContactOrgId : inboxOrg;
  if (db.press.replies.list(desk).some((r) => r.messageId === msg.messageId)) return null;
  const who = c?.name ?? msg.fromName ?? msg.fromEmail;
  const pitch = c ? db.press.pitches.list(desk).filter((p) => p.contactId === c.id && p.status === "sent").sort((a, b) => b.id - a.id)[0] ?? null : null;
  const base = { organizationId: desk, contactId: c?.id ?? null, pitchId: pitch?.id ?? null, messageId: msg.messageId, fromEmail: msg.fromEmail, fromName: msg.fromName || who, subject: msg.subject.slice(0, 255), text: msg.text.slice(0, 8000), receivedAt: msg.date ?? new Date() };
  if (await crisisCheck(desk, `${msg.subject}\n${msg.text}`, who)) return db.press.replies.create({ ...base, kind: "crisis" });
  const emp = await employeeFor(desk, "speaking");
  const { times, tz } = await openTimes(desk);
  const r = await working(emp, async () => {
    const { system } = await systemPromptFor(emp, `Your job now: you are the publicist, sorting a reporter's reply and drafting the answer.
Sorts: interview (they want to talk), not_now (not now, or they need something first), questions (they sent questions to answer), dnc (take me off your list), referral (not their beat; they named a colleague), moved (they changed outlets), ooo (out of office), other.
The draft: short, warm, specific, signed as the owner's team. For interview, offer the open times given. For questions, draft answers only from the Brain and approved quotes, marked for the owner to check. For dnc and ooo, no draft.`);
    return generateJson<{ kind: string; askedFor: string; referralName: string; referralOutlet: string; referralEmail: string; newOutlet: string; proposedTime: string; draft: string }>({
      system,
      prompt: `From: ${who}${c ? ` (${c.outlet})` : ""} <${msg.fromEmail}>\nSubject: ${msg.subject}\n\n${msg.text.slice(0, 6000)}\n\n${pitch ? `Our pitch they're answering:\nSubject: ${pitch.subject}\n${pitch.body}\n\n` : ""}Open times (${tz}): ${times.join("; ") || "none found; ask what works for them"}\nproposedTime: a specific time they proposed, as an ISO date-time, or "".`,
      schemaName: "press_reply",
      schema: obj({ kind: { type: "string", enum: REPLY_KINDS as unknown as string[] }, askedFor: str, referralName: str, referralOutlet: str, referralEmail: str, newOutlet: str, proposedTime: str, draft: str }),
      maxTokens: 2000,
    });
  });
  const kind = (REPLY_KINDS as readonly string[]).includes(r.kind) ? (r.kind as PressReply["kind"]) : "other";
  const reply = db.press.replies.create({ ...base, kind, draft: kind === "dnc" || kind === "ooo" ? null : (r.draft ?? "").slice(0, 4000) || null, status: kind === "ooo" ? "done" : "open" });
  if (pitch) db.press.pitches.update(pitch.id, desk, { status: "replied" });
  if (c) {
    const patch: Partial<PressContact> = {};
    if (kind === "dnc") patch.doNotContact = true;
    if (kind === "not_now" && r.askedFor) patch.asks = r.askedFor.slice(0, 400);
    if (kind === "moved" && r.newOutlet) Object.assign(patch, { movedFrom: c.outlet, outlet: r.newOutlet.slice(0, 160) });
    if (["interview", "questions", "not_now", "referral"].includes(kind) && (c.relationship === "prospect" || c.relationship === "contacted")) patch.relationship = "engaged";
    if (Object.keys(patch).length) db.press.contacts.update(c.id, c.organizationId, patch as never);
  }
  if (kind === "referral" && r.referralName && !contacts.some((x) => norm(x.name) === norm(r.referralName))) {
    db.press.contacts.create({ organizationId: desk, name: r.referralName.slice(0, 120), outlet: (r.referralOutlet || c?.outlet || "").slice(0, 160), email: /@/.test(r.referralEmail) ? r.referralEmail.trim().toLowerCase() : null, emailSource: /@/.test(r.referralEmail) ? `Referred by ${who}` : null, why: `Referred by ${who}, who said this is their beat. Taylor checks their recent articles before any pitch.` });
  }
  if (kind === "interview" && r.proposedTime && Number.isFinite(Date.parse(r.proposedTime))) {
    await (await import("./presslib")).createInterview(desk, { contactId: c?.id ?? null, title: `${who}${c?.outlet ? `, ${c.outlet}` : ""}`, at: new Date(r.proposedTime), place: "" }).catch(() => null);
  }
  return reply;
}

export async function editReply(orgId: number, id: number, draft: string) {
  if (!db.press.replies.get(id, orgId)) throw new TRPCError({ code: "NOT_FOUND", message: "That reply isn't on this desk." });
  return db.press.replies.update(id, orgId, { draft: draft.trim().slice(0, 4000) })!;
}

export async function approveReply(orgId: number, id: number, reviewer: string) {
  const r = db.press.replies.get(id, orgId);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That reply isn't on this desk." });
  if (r.kind === "crisis") throw new TRPCError({ code: "BAD_REQUEST", message: "Answer a crisis question yourself, with counsel if it's needed. Taylor won't send it." });
  if (!r.draft?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "There's no reply to send." });
  const emp = await employeeFor(orgId, "speaking");
  const item = await db.createOutboundItem({
    organizationId: orgId,
    employeeId: emp.id,
    kind: "email_draft",
    status: "pending_approval",
    title: /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`,
    body: r.draft,
    targetChannels: JSON.stringify(["Gmail"]),
    metadata: JSON.stringify({ email: r.fromEmail, pressReplyId: r.id }),
  });
  db.press.replies.update(id, orgId, { itemId: item.id, status: "pending" });
  await postNow(item, reviewer, "human_user", "Approved", { approvedBy: reviewer, approvedAt: new Date() });
  return db.press.replies.get(id, orgId)!;
}

export function doneReply(orgId: number, id: number) {
  if (!db.press.replies.get(id, orgId)) throw new TRPCError({ code: "NOT_FOUND", message: "That reply isn't on this desk." });
  return db.press.replies.update(id, orgId, { status: "done" })!;
}

// ==========================================
// Views
// ==========================================

export function pitchView(orgId: number, p: PressPitch) {
  const c = contactFor(orgId, p.contactId);
  return { id: p.id, contactId: p.contactId, name: c?.name ?? "Reporter", outlet: c?.outlet ?? "", email: c?.email ?? null, fit: c ? fitOf(c, orgId) : 0, subject: p.subject, body: p.body, score: p.score, rubric: parse<{ name: string; points: number; max: number }[]>(p.rubric, []), status: p.status, coolingUntil: p.coolingUntil, followUp: p.followUp, sentAt: p.sentAt, campaignId: p.campaignId, storyId: p.storyId };
}

export function campaignView(orgId: number, c: PressCampaign) {
  const pitches = db.press.pitches.list(orgId).filter((p) => p.campaignId === c.id);
  return { id: c.id, title: c.title, status: c.status, startsOn: c.startsOn, plan: parse<Plan>(c.plan, {} as Plan), angles: parse<Angle[]>(c.angles, []), storyId: c.storyId, reporters: new Set(pitches.map((p) => p.contactId)).size, pitches: pitches.map((p) => pitchView(orgId, p)).sort((a, b) => b.fit - a.fit), createdAt: c.createdAt };
}

export function replyView(orgId: number, r: PressReply) {
  const c = r.contactId ? contactFor(orgId, r.contactId) : null;
  return { id: r.id, name: c?.name ?? r.fromName, outlet: c?.outlet ?? "", fromEmail: r.fromEmail, subject: r.subject, text: r.text, kind: r.kind, draft: r.draft, status: r.status, receivedAt: r.receivedAt };
}
