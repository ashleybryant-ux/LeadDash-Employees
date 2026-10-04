import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import type { ColdLead, ColdReply } from "../../drizzle/schema";
import { notify } from "../notify";
import { HUMAN_EMAIL, findTells } from "./human";
import type { IEmail } from "./instantly";
import { api, campaignView, doNotContact, fmtDay, leadView, parse, pricingText, researchOne, settingsOf, type Step } from "./cold";
import { employeeFor, systemPromptFor } from "./tasks";

/**
 * Jada reads every reply to a cold email, sorts it, and drafts the answer.
 *
 * What she sends on her own depends on the level the owner set:
 * 1: nothing; every answer waits for the owner.
 * 2: not interested, unsubscribes, out of office, wrong person, referrals, not now, basic questions.
 * 3: also standard objections answered from the playbook.
 * 4: also interested leads, with open times.
 * Opt-outs are honored right away at every level. Hot leads reach the owner the moment they land.
 * Anything matching "always needs you" waits for her.
 */

const str = { type: "string" } as const;
const bool = { type: "boolean" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

export const KIND_LABEL: Record<ColdReply["kind"], string> = {
  hot: "Hot lead",
  interested: "Interested",
  demo: "Wants a demo",
  objection: "Objection",
  question: "Question",
  wrong_person: "Wrong person",
  referral: "Referral",
  not_now: "Not now",
  negative: "Not interested",
  unsubscribe: "Unsubscribe",
  ooo: "Out of office",
  other: "Other",
};

const CLASSIFY: JsonSchema = obj({
  kind: { type: "string", enum: ["hot", "interested", "demo", "objection", "question", "wrong_person", "referral", "not_now", "negative", "unsubscribe", "ooo", "other"], description: "hot: a strong buying signal (leaving their EHR, asking about migration, pricing for their team, a demo for the whole team). demo: asks for a call or time. interested: tell me more, send info. unsubscribe: remove me or stop. negative: not interested." },
  topic: { type: "string", description: "objection: price, competitor, timing, switching, team, budget, happy, other. question: the topic. Otherwise ''" },
  followUpDate: { type: "string", description: "not_now: the date to follow up as YYYY-MM-DD, worked out from what they said. ooo: the return date. Otherwise ''" },
  followUpNote: { type: "string", description: "not_now: why later, in their words (\"plan renews in January\"). Otherwise ''" },
  referralName: str,
  referralEmail: { type: "string", description: "Only an email address written in the reply, else ''" },
  summary: { type: "string", description: "What they said, in one short sentence" },
  safe: { type: "boolean", description: "true only if every fact in the draft comes from the playbook, the website pricing or the Brain, and nothing needs the owner's judgment" },
  needsYou: { type: "string", description: "Why the owner should see it before it goes, or ''" },
  draft: { type: "string", description: "The answer, ready to send, signed with the owner's first name. '' for unsubscribe and out of office" },
});

type Classified = { kind: ColdReply["kind"]; topic: string; followUpDate: string; followUpNote: string; referralName: string; referralEmail: string; summary: string; safe: boolean; needsYou: string; draft: string };

const LADDER = `The next step only, never a jump from stranger to demo: cold → "worth sending a comparison?" → interested → "which system are you using now?" → qualified → "how many clinicians?" → problem found → "that's where LeadDash tends to help" → demo → "want to look at it together?"`;

function playbookFor(orgId: number) {
  const plays = db.cold.playbook.list(orgId);
  const objections = plays.filter((p) => p.kind === "objection").map((p) => {
    const b = parse<Record<string, string>>(p.body, {});
    return `- "${p.title}": means ${b.meaning}. Goal: ${b.goal}${b.facts ? ` Facts: ${b.facts}` : ""}${b.never ? ` Never: ${b.never}` : ""}${b.escalate ? ` Send to the owner when: ${b.escalate}` : ""}${b.example ? ` Example: "${b.example}"` : ""}`;
  });
  const battles = plays.filter((p) => p.kind === "battle").map((p) => {
    const b = parse<Record<string, string>>(p.body, {});
    return `- ${p.title}: does well: ${b.doesWell} Where LeadDash differs: ${b.differs} Don't claim: ${b.dontClaim}`;
  });
  const facts = plays.filter((p) => p.kind === "fact").map((p) => `- ${p.title}: ${parse<{ text?: string }>(p.body, {}).text ?? ""}`);
  const never = plays.filter((p) => p.kind === "never").map((p) => `- ${p.title}`);
  const examples = plays.filter((p) => p.kind === "example").slice(-8).map((p) => {
    const b = parse<Record<string, string>>(p.body, {});
    return `- They said: "${b.said}" The owner's answer: "${b.better}"`;
  });
  return `Objection playbook:\n${objections.join("\n")}\nBattle cards:\n${battles.join("\n")}\nApproved facts:\n${facts.join("\n") || "- (none: use only the Brain)"}\nNever say:\n${never.join("\n")}\nHow the owner answered before (match her voice):\n${examples.join("\n") || "- (none yet)"}`;
}

/** The variant a reply answered, from its subject. */
function variantOf(subject: string, steps: Step[]) {
  const s = subject.replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase();
  const a = (steps[0]?.subject ?? "").toLowerCase();
  const b = (steps[0]?.subjectB ?? "").toLowerCase();
  if (b && s.includes(b.replace(/\{\{[^}]+\}\}|\[[^\]]+\]/g, "").trim().slice(0, 20))) return "b";
  if (a) return "a";
  return null;
}

async function bookingBits(orgId: number) {
  const sales = await import("./sales");
  const { settings, tz } = await sales.salesSettings(orgId);
  const link = sales.salesLinks(settings.token).booking;
  const open = await sales.openTimes(orgId, 20).catch(() => ({ ready: false as const, times: [] as Date[] }));
  const times: string[] = [];
  const days = new Set<string>();
  for (const t of open.times) {
    const k = t.toLocaleDateString("en-US", { timeZone: tz });
    if (days.has(k)) continue;
    days.add(k);
    times.push(sales.whenText(t, tz));
    if (times.length === 3) break;
  }
  return { link, times };
}

const sameThread = (subject: string) => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`);
const wantsOwner = (text: string, words: string) =>
  words
    .split(/[,;\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 2)
    .some((w) => text.toLowerCase().includes(w.replace(/^anything about /, "")));

/** Sorts one reply, drafts the answer, and does what the level allows. */
export async function handleEmail(orgId: number, e: IEmail) {
  if (db.cold.replyByEmailId(orgId, e.id)) return null;
  const from = (e.from_address_email || e.lead || "").toLowerCase();
  const lead = db.cold.leadByEmail(orgId, from);
  if (!lead) return null;
  const s = settingsOf(orgId);
  const camp = lead.campaignId ? db.cold.campaigns.get(lead.campaignId, orgId) : null;
  const steps = camp ? campaignView(camp).steps : [];
  const text = (e.body?.text || (e.body?.html ?? "").replace(/<[^>]+>/g, " ")).replace(/\nOn [^\n]{5,200}wrote:[\s\S]*$/, "").replace(/\n>[\s\S]*$/, "").trim().slice(0, 8000);
  const emp = await employeeFor(orgId, "outreach");
  const org = await db.getOrganizationById(orgId);
  const first = (s.signature.trim() || "").split(/[\s,]+/)[0] || "the owner";
  const { link, times } = await bookingBits(orgId);
  const lv = leadView(lead);
  const { system } = await systemPromptFor(
    emp,
    `Your job now: a therapist answered one of your cold emails for ${org?.name ?? "the business"}. Sort the reply and write the answer.
- Write like one practice owner answering another: short, plain, one thought. Sign with "${first}". No signature block (it's added).
- ${LADDER}
- Pricing questions get the price from the website, then the offer to compare against their whole stack. Never hide the price behind a call.
- Never argue with a no. Never invent a fact, price, offer, timeline, statistic or customer. Never mention anything personal about them. Never insult a competitor.
- When offering a time: ${times.length ? `offer these: ${times.join("; ")}, or this link: ${link}` : `offer this link: ${link}`}.
${pricingText(s)}

${playbookFor(orgId)}

${HUMAN_EMAIL}`
  );
  const prompt = `The lead: ${lv.name}, ${lv.license || "therapist"}${lv.practice ? `, ${lv.practice}` : ""}${lv.city ? `, ${lv.city}` : ""}${lv.state ? ` ${lv.state}` : ""}. Fit ${lv.fit ?? "not scored"}. ${lv.segments.map((x) => x.label).join(", ")}.
${camp ? `Campaign: ${camp.name}. The email they got:\nSubject: ${steps[0]?.subject ?? ""}\n${steps[0]?.body ?? ""}` : ""}

Their reply (subject "${e.subject}"):
${text}`;
  let c = await generateJson<Classified>({ system, prompt, schemaName: "cold_reply", schema: CLASSIFY, maxTokens: 2000 });
  if (c.draft && findTells(c.draft).length) {
    c = { ...c, draft: (await generateJson<Classified>({ system, prompt: `${prompt}\n\nYour draft gave itself away as AI (${findTells(c.draft).join(", ")}). Write it again without those.`, schemaName: "cold_reply", schema: CLASSIFY, maxTokens: 2000 })).draft || c.draft };
  }
  if (e.is_auto_reply && c.kind !== "unsubscribe") c.kind = "ooo";
  const reply = db.cold.replies.create({
    organizationId: orgId,
    leadId: lead.id,
    campaignId: lead.campaignId,
    emailId: e.id,
    inbox: e.eaccount,
    subject: e.subject ?? "",
    text,
    kind: c.kind,
    topic: c.topic ?? "",
    variant: variantOf(e.subject ?? "", steps),
    draft: c.draft || null,
    status: "open",
    receivedAt: e.timestamp_created ? new Date(e.timestamp_created) : new Date(),
  });
  return act(orgId, reply, lead, c);
}

/** What happens after sorting: opt-outs at once, routine answers by level, hot leads to the owner now. */
async function act(orgId: number, reply: ColdReply, lead: ColdLead, c: Classified) {
  const s = settingsOf(orgId);
  const level = s.level;
  const needsYou = !!c.needsYou?.trim() || wantsOwner(reply.text, s.alwaysNeedsYou);
  const canSend = (min: number, needSafe = true) => level >= min && !needsYou && (!needSafe || c.safe) && !!reply.draft;
  const done = (handled: string) => db.cold.replies.update(reply.id, orgId, { status: "done", handled });
  db.cold.updateLead(lead.id, orgId, { stage: lead.stage === "booked" ? "booked" : "replied", lastReplyKind: reply.kind });

  switch (reply.kind) {
    case "unsubscribe":
      await doNotContact(orgId, lead.email, "Asked to be removed");
      done("Added to do not contact, here and in Instantly. No reply sent.");
      return reply;
    case "negative":
      await doNotContact(orgId, lead.email, "Not interested");
      if (canSend(2, false)) await send(orgId, reply.id, null, "Jada", "Closed the loop and added to do not contact.");
      else db.cold.replies.update(reply.id, orgId, { handled: "Added to do not contact. The one-line close waits for you." });
      return reply;
    case "ooo": {
      const back = c.followUpDate && !Number.isNaN(new Date(`${c.followUpDate}T12:00:00Z`).getTime()) ? fmtDay(`${c.followUpDate}T12:00:00Z`) : "";
      done(`Out of office${back ? ` until ${back}` : ""}. The sequence carries on.`);
      return reply;
    }
    case "not_now": {
      const at = c.followUpDate ? new Date(`${c.followUpDate}T15:00:00Z`) : null;
      if (at && !Number.isNaN(at.getTime()) && at.getTime() > Date.now()) db.cold.updateLead(lead.id, orgId, { followUpAt: at, followUpNote: c.followUpNote || c.summary });
      if (canSend(2)) await send(orgId, reply.id, null, "Jada", `Thanked them. Follow-up set for ${at ? fmtDay(at) : "later"}.`);
      else db.cold.replies.update(reply.id, orgId, { handled: at ? `Follow-up set for ${fmtDay(at)}.` : null });
      return reply;
    }
    case "wrong_person":
    case "referral": {
      let note = "";
      const email = (c.referralEmail || "").trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) && !db.cold.leadByEmail(orgId, email) && !db.cold.isSuppressed(orgId, email)) {
        const [firstName, ...rest] = (c.referralName || "").trim().split(/\s+/);
        db.cold.insertLeads([{ organizationId: orgId, email, firstName: firstName ?? "", lastName: rest.join(" "), practice: lead.practice, website: lead.website, city: lead.city, state: lead.state, source: `Referral from ${lead.firstName} ${lead.lastName}`.trim(), fit: lead.fit, segments: lead.segments, fitWhy: lead.fitWhy, stage: "new" }]);
        note = ` Added ${c.referralName || email} to the list.`;
      }
      if (canSend(2)) await send(orgId, reply.id, null, "Jada", `Thanked them.${note}`);
      else db.cold.replies.update(reply.id, orgId, { handled: note.trim() || null });
      return reply;
    }
    case "question":
      if (canSend(2)) await send(orgId, reply.id, null, "Jada", "Answered from your playbook.");
      return reply;
    case "objection":
      if (canSend(3)) await send(orgId, reply.id, null, "Jada", "Answered from your playbook.");
      return reply;
    case "hot":
    case "demo":
    case "interested": {
      void researchOne(orgId, lead.id).catch(() => null);
      if (canSend(4)) await send(orgId, reply.id, null, "Jada", "Answered with open times.");
      await alertHot(orgId, db.cold.replies.get(reply.id, orgId)!, lead, c.summary);
      return reply;
    }
    default:
      return reply;
  }
}

async function alertHot(orgId: number, reply: ColdReply, lead: ColdLead, summary: string) {
  const emp = await employeeFor(orgId, "outreach");
  const lv = leadView(lead);
  const sent = reply.status === "sent";
  const label = reply.kind === "hot" ? "Hot lead just came in" : reply.kind === "demo" ? "Someone wants a demo" : "Interested reply";
  await db.createChatMessage({
    organizationId: orgId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content: `${label}: ${summary || "they want to know more"}. ${sent ? "At your level I answered with open times." : "My answer is ready, or take it yourself."}`,
    cards: JSON.stringify([{ type: "cold_hot", id: reply.id, title: lv.name }]),
  });
  const initials = lv.name.split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").join(". ") + ".";
  await notify(orgId, "report", { title: label, body: `${initials}${lv.practice ? ` (${lv.practice})` : ""}, fit ${lv.fit ?? "not scored"}. Open Jada to answer.`, url: "/chats/outreach", tag: `cold-${reply.id}` }).catch(() => {});
}

/** Sends an answer in Instantly, on the same thread from the same inbox. */
export async function send(orgId: number, id: number, text: string | null, who: string, handled?: string) {
  const r = db.cold.replies.get(id, orgId);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That reply isn't here." });
  if (r.status === "sent") return r;
  const body = (text ?? r.draft ?? "").trim();
  if (!body) throw new TRPCError({ code: "BAD_REQUEST", message: "Write the answer first." });
  const lead = db.cold.getLead(r.leadId, orgId);
  if (lead && db.cold.isSuppressed(orgId, lead.email) && r.kind !== "negative") throw new TRPCError({ code: "BAD_REQUEST", message: "They're on do not contact, so nothing goes to them." });
  await api(orgId).reply({ emailId: r.emailId.split("#")[0], inbox: r.inbox, subject: sameThread(r.subject || "your email"), text: body });
  // The owner's own wording becomes a real example in the playbook.
  if (text && r.draft && text.trim() !== r.draft.trim() && who !== "Jada") {
    db.cold.playbook.create({ organizationId: orgId, kind: "example", title: (r.text.split("\n")[0] || r.kind).slice(0, 200), body: JSON.stringify({ said: r.text.slice(0, 600), draft: r.draft, better: body, tag: KIND_LABEL[r.kind] }) });
  }
  await db.logAction({ organizationId: orgId, actorType: who === "Jada" ? "employee" : "human_user", actorName: who, action: "Answered a cold email reply", details: `${KIND_LABEL[r.kind]}${lead ? ` from ${lead.email}` : ""}` }).catch(() => null);
  return db.cold.replies.update(id, orgId, { status: "sent", sentAt: new Date(), draft: body, ...(handled ? { handled } : {}) })!;
}

export function saveDraft(orgId: number, id: number, text: string) {
  const r = db.cold.replies.get(id, orgId);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That reply isn't here." });
  return db.cold.replies.update(id, orgId, { draft: text.slice(0, 6000) })!;
}

/** The owner takes it herself: it leaves Jada's list. */
export function takeOver(orgId: number, id: number) {
  return db.cold.replies.update(id, orgId, { status: "done", handled: "You're answering this one yourself." });
}

const busy = new Set<number>();

/** Reads new replies from Instantly. Runs every few minutes, and right away when Instantly's webhook calls. */
export async function checkReplies(orgId: number) {
  if (busy.has(orgId)) return { read: 0 };
  const s = settingsOf(orgId);
  if (!s.keyEncrypted) return { read: 0 };
  busy.add(orgId);
  try {
    const since = s.lastReplyCheckAt ? new Date(s.lastReplyCheckAt.getTime() - 10 * 60_000) : new Date(Date.now() - 3 * 86_400_000);
    const started = new Date();
    let emails: IEmail[];
    try {
      emails = await api(orgId).received(since);
    } catch (err) {
      db.cold.saveSettings(orgId, { keyError: err instanceof Error ? err.message : String(err) });
      return { read: 0 };
    }
    let read = 0;
    for (const e of emails) {
      try {
        if (await handleEmail(orgId, e)) read++;
      } catch (err) {
        console.warn("[cold] reply skipped:", err instanceof Error ? err.message : err);
      }
    }
    db.cold.saveSettings(orgId, { lastReplyCheckAt: started, keyError: null });
    return { read };
  } finally {
    busy.delete(orgId);
  }
}

/** Not-now leads whose date came: a short follow-up that remembers what they said. */
export async function followUpsDue(orgId: number, now = new Date()) {
  const due = db.cold.followUpsDue(orgId, now);
  if (!due.length) return 0;
  const s = settingsOf(orgId);
  const emp = await employeeFor(orgId, "outreach");
  let n = 0;
  for (const l of due) {
    db.cold.updateLead(l.id, orgId, { followUpAt: null });
    if (db.cold.isSuppressed(orgId, l.email)) continue;
    const last = db.cold.replies.list(orgId).find((r) => r.leadId === l.id && !r.emailId.includes("#"));
    if (!last) continue;
    const first = (s.signature.trim() || "").split(/[\s,]+/)[0] || "";
    const { system } = await systemPromptFor(emp, `Your job now: write a short follow-up to a therapist who told you to check back later. Remind them in a few words of what they said and when, and ask one question. Under 60 words. Sign "${first}".\n${HUMAN_EMAIL}`);
    const r = await generateJson<{ draft: string }>({ system, prompt: `On ${fmtDay(last.receivedAt ?? last.createdAt)} ${l.firstName} wrote: "${last.text.slice(0, 1200)}"\nWhy later: ${l.followUpNote ?? ""}`, schemaName: "cold_followup", schema: obj({ draft: str }), maxTokens: 800 });
    const row = db.cold.replies.create({ organizationId: orgId, leadId: l.id, campaignId: l.campaignId, emailId: `${last.emailId}#follow-${now.getTime()}`, inbox: last.inbox, subject: last.subject, text: `Follow-up you asked for: ${l.followUpNote ?? last.text.slice(0, 200)}`, kind: "not_now", topic: "follow-up", draft: r.draft, status: "open", receivedAt: now });
    n++;
    if (s.level >= 3 && !wantsOwner(last.text, s.alwaysNeedsYou)) await send(orgId, row.id, null, "Jada", "Followed up on the date they gave.").catch(() => null);
  }
  return n;
}

/** Someone from the list booked a meeting: the pre-call report runs. */
export async function onBooked(orgId: number, email: string, at: Date | null) {
  const l = db.cold.leadByEmail(orgId, email);
  if (!l) return null;
  if (l.stage === "booked" && (!at || (l.bookedFor && l.bookedFor.getTime() === at.getTime()))) return null;
  db.cold.updateLead(l.id, orgId, { stage: "booked", bookedFor: at ?? l.bookedFor });
  const { startPrecall } = await import("./precall");
  return startPrecall(orgId, { leadId: l.id, meetingAt: at, runBy: "Jada, when they booked" });
}

export function replyView(orgId: number, r: ColdReply) {
  const l = db.cold.getLead(r.leadId, orgId);
  return {
    id: r.id,
    kind: r.kind,
    label: r.kind === "not_now" && l?.followUpAt ? `Not now: ${fmtDay(l.followUpAt)}` : r.kind === "objection" && r.topic ? `Objection: ${r.topic}` : KIND_LABEL[r.kind],
    topic: r.topic,
    subject: r.subject,
    text: r.text,
    draft: r.draft,
    handled: r.handled,
    status: r.status,
    receivedAt: r.receivedAt,
    sentAt: r.sentAt,
    variant: r.variant,
    lead: l ? leadView(l) : null,
    campaign: r.campaignId ? (db.cold.campaigns.get(r.campaignId, orgId)?.name ?? "") : "",
  };
}

export function repliesView(orgId: number) {
  const rank = (r: ColdReply) => (r.status === "open" ? (r.kind === "hot" || r.kind === "demo" ? 0 : 1) : 2);
  return db.cold.replies.list(orgId).sort((a, b) => rank(a) - rank(b) || b.id - a.id).slice(0, 300).map((r) => replyView(orgId, r));
}
