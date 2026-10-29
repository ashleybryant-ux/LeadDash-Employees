/**
 * The Full Caseload Playbook: the gift for staying to the end of The Business
 * of Healing webinar.
 *
 * 1. An attendee fills in the "Full Caseload Playbook" form in the LeadDash
 *    sub-account. Its workflow posts the contact id to
 *    POST /api/playbook/hook/<PLAYBOOK_WEBHOOK_SECRET>.
 * 2. Here: the answers are read from the contact's custom fields, the math is
 *    done in code, their website and Psychology Today page are read, and the
 *    model writes the steps and the ready-to-use words.
 * 3. The playbook is kept as a private page at /playbook/<token>. The link,
 *    the weakest step and the monthly leak go back on the contact, with the
 *    tag "playbook ready", which starts the delivery email and the nurture
 *    sequence in the LeadDash platform.
 *
 * Business data only. The form asks nothing about clients, and nothing about
 * a client is ever sent to the model.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { ENV } from "./_core/env";
import { anthropicHeaders, extractJson } from "./_core/llm";
import { fetchWebpage } from "./employees/files";
import { tokenCost } from "./usage";

// ==========================================
// The form's fields (contact custom field keys in the LeadDash sub-account)
// ==========================================

export const INPUT_KEYS = {
  practice: "playbook_practice_name",
  place: "playbook_city_state",
  stage: "playbook_stage",
  clinicians: "playbook_clinicians",
  specialty: "playbook_specialty",
  payment: "playbook_payment",
  panels: "playbook_panels",
  inquiries: "playbook_inquiries",
  booked: "playbook_booked",
  fee: "playbook_fee",
  sessions: "playbook_sessions",
  channels: "playbook_channels",
  response: "playbook_response_time",
  source: "playbook_top_source",
  scoreFound: "playbook_score_found",
  scoreBooked: "playbook_score_booked",
  scoreKeep: "playbook_score_keep",
  manualSteps: "playbook_manual_steps",
  lost: "playbook_lost_clients",
  website: "playbook_website",
  profile: "playbook_profile_url",
  change: "playbook_change",
} as const;

export const OUTPUT_KEYS = {
  link: "playbook_link",
  weakest: "playbook_weakest_step",
  leak: "playbook_monthly_leak",
  focus: "playbook_focus",
} as const;

export const READY_TAG = "playbook ready";
const WEBINAR_START_KEY = "webinar_start_time";

export type Step = "found" | "booked" | "keep";
export const STEP_NAME: Record<Step, string> = { found: "Get found", booked: "Get booked", keep: "Keep them" };

export type Answers = {
  firstName: string;
  lastName: string;
  practice: string;
  place: string;
  stage: string;
  clinicians: number | null;
  specialty: string;
  payment: string;
  panels: number | null;
  inquiries: number | null;
  booked: number | null;
  fee: number | null;
  sessions: number | null;
  channels: string;
  response: string;
  source: string;
  scores: { found: number | null; booked: number | null; keep: number | null };
  manualSteps: number | null;
  lost: number | null;
  website: string;
  profile: string;
  change: string;
};

const text = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : v == null ? "" : String(v)).replace(/\s+/g, " ").trim();

/** "$150", "about 10", "8-10" (the middle), "1,200" -> a number; anything else -> null. */
export function num(v: unknown): number | null {
  const s = text(v).replace(/,/g, "");
  const range = s.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/i);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const m = s.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** A 1 to 5 score from "3" or "3 (sometimes)". */
export function score(v: unknown): number | null {
  const n = num(v);
  return n != null && n >= 1 && n <= 5 ? Math.round(n) : null;
}

/** The answers, from a { key: value } map of the contact's custom fields. */
export function answersFrom(fields: Record<string, unknown>, contact: { firstName?: string; lastName?: string } = {}): Answers {
  const f = (k: keyof typeof INPUT_KEYS) => fields[INPUT_KEYS[k]];
  const steps = num(f("manualSteps"));
  return {
    firstName: text(contact.firstName) || "there",
    lastName: text(contact.lastName),
    practice: text(f("practice")),
    place: text(f("place")),
    stage: text(f("stage")),
    clinicians: num(f("clinicians")),
    specialty: text(f("specialty")),
    payment: text(f("payment")),
    panels: num(f("panels")),
    inquiries: num(f("inquiries")),
    booked: num(f("booked")),
    fee: num(f("fee")),
    sessions: num(f("sessions")),
    channels: text(f("channels")),
    response: text(f("response")),
    source: text(f("source")),
    scores: { found: score(f("scoreFound")), booked: score(f("scoreBooked")), keep: score(f("scoreKeep")) },
    manualSteps: steps != null && steps >= 0 && steps <= 5 ? Math.round(steps) : null,
    lost: num(f("lost")),
    website: text(f("website")),
    profile: text(f("profile")),
    change: text(f("change")).slice(0, 500),
  };
}

// ==========================================
// The math (never left to the model)
// ==========================================

export type Numbers = {
  missed: number;
  sessions: number;
  sessionsAssumed: boolean;
  monthly: number;
  yearly: number;
  recoverCount: number;
  recovery: number;
  retention: number;
  ready: boolean;
};

export function numbersFor(a: Answers): Numbers {
  const sessionsAssumed = !(a.sessions && a.sessions > 0);
  const sessions = sessionsAssumed ? 8 : a.sessions!;
  const ready = a.inquiries != null && a.booked != null && a.fee != null && a.fee > 0;
  const missed = ready ? Math.max(0, Math.round(a.inquiries! - a.booked!)) : 0;
  const fee = a.fee ?? 0;
  const monthly = Math.round(missed * fee * sessions);
  const recoverCount = Math.min(2, missed);
  return {
    missed,
    sessions,
    sessionsAssumed,
    monthly,
    yearly: monthly * 12,
    recoverCount,
    recovery: Math.round(recoverCount * fee * sessions),
    retention: Math.round(2 * 4 * fee),
    ready,
  };
}

const SLOW = /next day|longer|day or two|days|week/i;

/**
 * The step to start on: the lowest score (ties go Get booked, then Keep them,
 * then Get found). When the answers say booking is slow or done by hand but
 * Get booked was scored high, the answers win.
 */
export function weakestStep(a: Answers): { step: Step; overridden: boolean } {
  const order: Step[] = ["booked", "keep", "found"];
  const known = order.filter((s) => a.scores[s] != null);
  let step: Step = "booked";
  if (known.length) {
    const low = Math.min(...known.map((s) => a.scores[s]!));
    step = known.find((s) => a.scores[s] === low)!;
  }
  const bookingSlow = SLOW.test(a.response) || (a.manualSteps != null && a.manualSteps >= 4);
  if (step !== "booked" && bookingSlow && (a.scores.booked ?? 5) >= 4) return { step: "booked", overridden: true };
  return { step, overridden: false };
}

export const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ==========================================
// What the model writes
// ==========================================

export type Written = {
  where: string;
  steps: { title: string; when: "Tonight" | "This week" | "Before your next billing cycle"; body: string }[];
  words: { bestWith: string; referralNote: string; replyTitle: string; reply: string };
  fit: string;
  focus: string;
};

const WHENS = ["Tonight", "This week", "Before your next billing cycle"] as const;

/** No em or en dashes in anything an attendee reads. */
export function clean(s: string) {
  return s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/ ,/g, ",")
    .replace(/,\s*,/g, ",")
    .trim();
}

function cleanWritten(w: Written): Written {
  return {
    where: clean(w.where),
    steps: w.steps.map((s) => ({ title: clean(s.title), when: s.when, body: clean(s.body) })),
    words: { bestWith: clean(w.words.bestWith), referralNote: clean(w.words.referralNote), replyTitle: clean(w.words.replyTitle), reply: clean(w.words.reply) },
    fit: clean(w.fit),
    focus: clean(w.focus),
  };
}

/** True when the model's answer has everything the page needs. */
export function validWritten(v: unknown): v is Written {
  const w = v as Written;
  if (!w || typeof w.where !== "string" || !Array.isArray(w.steps) || w.steps.length < 3 || w.steps.length > 5) return false;
  if (!w.steps.every((s) => s && typeof s.title === "string" && typeof s.body === "string" && WHENS.includes(s.when))) return false;
  if (w.steps[0].when !== "Tonight") return false;
  const words = w.words;
  if (!words || !["bestWith", "referralNote", "replyTitle", "reply"].every((k) => typeof (words as any)[k] === "string" && (words as any)[k].trim())) return false;
  return typeof w.fit === "string" && typeof w.focus === "string";
}

const FRAMEWORK = `THE FRAMEWORK (from The Business of Healing webinar by Ashley R. Bryant, LPC, CRC)
The promise: build a full caseload without joining another insurance panel. Practices lose clients in three places, and each is fixable.

Get found
- Clients search for their problem, not a modality. The first line of a profile or website should describe the person the clinician is best with and the problem they bring, not the training.
- The largest source of new clients is usually people: clients sending clients, and clinicians who know what you are good at. Then the profile, then the site.
- Referral partners: pick five clinicians or clinics who see your population and cannot take everyone. Send a short note with your specialty, your fee or insurance status, and your current openings. Send it again each quarter.
- Ethics: never ask current clients for reviews or testimonials (NASW Code of Ethics 4.07, ACA Code of Ethics C.3.b). Claim only training and specialties you actually have (NASW 4.06, ACA C.4.a).

Get booked (where most practices lose the most)
- The five steps every practice has: answer, book, paperwork, remind, confirm. Every step done by hand happens late, and late is where people leave.
- An inquiry answered inside the hour books most of the time. Answered the next day, fewer than half book.
- Intake paperwork goes out the moment someone books and can be signed on a phone. Clients who finish paperwork show up.
- Three reminders, and from any of them the client can confirm or move the appointment with one tap.

Keep them
- The client who leaves does not call to say so: she reschedules, then cancels, then stops.
- A cancellation message carries a reschedule link in the same message. A missed session gets a check-in from the clinician the next day.
- Copay and balance are shown before the visit, so there are no surprise bills.
- If building, Get booked is the whole year. If full, Keep them stops rebuilding every quarter. If adding clinicians, the leak is each clinician running the five steps a different way; the fix is one system for all of them.`;

const RULES = `WRITING RULES
- Write to the attendee by first name, as a clinician and practice owner talking to a peer. Warm, plain, specific.
- Every step must use something from their answers or their pages (city, specialty, payment type, how inquiries arrive, how fast they answer). If a step could be pasted into anyone's playbook unchanged, rewrite it.
- Never use em dashes or en dashes. Use periods, commas, colons or parentheses.
- Never write "you're not here because", "you don't only", "it's not X, it's Y" or "we won't do X, we will do Y" constructions. State the point plainly.
- Never announce how important something is. Just say it.
- No sentence fragments. American English.
- Never recommend joining an insurance panel. Never suggest asking clients for reviews or testimonials.
- No guarantees of results. No legal or billing advice beyond the ethics codes named above.
- Do not repeat the dollar figures; the page shows the math. Do not invent numbers, names of people, or facts about their practice.
- Name kinds of referral partners (pediatric offices, school counselors, psychiatrists, OB practices, group practices with waitlists), never a private individual.`;

const SHAPE = `Answer with JSON only, in this shape:
{
  "where": "One or two sentences naming where their practice loses clients, tied to their own answers.",
  "steps": [
    { "title": "Short action title", "when": "Tonight", "body": "Two to four sentences written for their practice." }
  ],
  "words": {
    "bestWith": "One sentence for the top of their profile or site, written around the client's problem.",
    "referralNote": "A short note to send five referral partners: specialty, fee or insurance status, openings (write [your openings] if unknown), and a friendly close signed with their first name.",
    "replyTitle": "Reply to a new inquiry" or "When a client cancels" or "First line for your profile",
    "reply": "Ready-to-send words for their weakest step: an inquiry reply text if Get booked, a cancel message with a reschedule line if Keep them, a rewritten profile opening if Get found."
  },
  "fit": "Two or three sentences on how LeadDash handles their weakest step for them: it answers, books, sends paperwork, reminds and confirms automatically, so nothing waits on them between sessions. Plain, no hype.",
  "focus": "One sentence for their delivery email that names their weakest step and the first thing to do tonight."
}
Rules for steps: three to five steps in order. Step 1 has "when": "Tonight" and takes under 30 minutes. Each later step is "Tonight", "This week" or "Before your next billing cycle".`;

function factsFor(a: Answers, n: Numbers, weakest: { step: Step; overridden: boolean }) {
  const lines = [
    `First name: ${a.firstName}`,
    `Practice: ${a.practice || "(not given)"}`,
    `City and state: ${a.place || "(not given)"}`,
    `Stage: ${a.stage || "(not given)"}${a.clinicians ? `, ${plural(a.clinicians, "clinician", "clinicians")}` : ""}`,
    `Best with: ${a.specialty || "(not given)"}`,
    `Payment: ${a.payment || "(not given)"}${a.panels ? `, on ${plural(a.panels, "panel", "panels")}` : ""}`,
    `Inquiries a month: ${a.inquiries ?? "(not given)"}; become first sessions: ${a.booked ?? "(not given)"}; fee: ${a.fee != null ? money(a.fee) : "(not given)"}; sessions a client stays: ${a.sessions ?? "8 (assumed)"}`,
    `People who reached out and did not book, each month: ${n.missed}`,
    `How inquiries arrive: ${a.channels || "(not given)"}`,
    `How fast a new inquiry is answered: ${a.response || "(not given)"}`,
    `Booking steps done by hand (of answer, book, paperwork, remind, confirm): ${a.manualSteps ?? "(not given)"}`,
    `Biggest source of new clients: ${a.source || "(not given)"}`,
    `Scores (1 = luck, 5 = every time without them): Get found ${a.scores.found ?? "?"}, Get booked ${a.scores.booked ?? "?"}, Keep them ${a.scores.keep ?? "?"}`,
    `Clients lost to reschedule, cancel, gone in the last three months: ${a.lost ?? "(not given)"}`,
    `What they said they would change: ${a.change || "(nothing written)"}`,
    `START HERE: ${STEP_NAME[weakest.step]}${weakest.overridden ? " (their answers point here even though they scored it higher)" : ""}`,
  ];
  return lines.join("\n");
}

async function readUrl(raw: string, chars = 3500) {
  const s = raw.trim();
  if (!s) return "";
  try {
    const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const page = await fetchWebpage(url);
    return `${page.title ? page.title + "\n" : ""}${page.text}`.replace(/\s+/g, " ").slice(0, chars);
  } catch {
    return "";
  }
}

async function callModel(system: string, prompt: string) {
  if (!ENV.anthropicKey) throw new Error("ANTHROPIC_API_KEY is missing");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({ model: ENV.playbookModel, max_tokens: 3000, temperature: 0.5, system, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`model error ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  const u = data?.usage ?? {};
  const cost = tokenCost(ENV.playbookModel, Number(u.input_tokens) || 0, Number(u.output_tokens) || 0);
  console.log(`[playbook] ${ENV.playbookModel}: ${u.input_tokens ?? 0} in, ${u.output_tokens ?? 0} out, $${cost.toFixed(4)}`);
  return (data?.content ?? []).map((p: any) => (p?.type === "text" ? p.text : "")).join("");
}

/** The words for one attendee, from the model, or the built-in version if it can't answer well. */
export async function writePlaybook(a: Answers, n: Numbers, weakest: { step: Step; overridden: boolean }, call = callModel): Promise<{ written: Written; byModel: boolean }> {
  const [site, profile] = await Promise.all([readUrl(a.website), readUrl(a.profile)]);
  const system = `You write the Full Caseload Playbook: a practice-specific plan for a therapist who attended The Business of Healing webinar. They should be able to start on step 1 tonight.\n\n${FRAMEWORK}\n\n${RULES}\n\n${SHAPE}`;
  const prompt = [
    "THEIR ANSWERS",
    factsFor(a, n, weakest),
    site ? `\nTHEIR WEBSITE (as read today)\n${site}` : a.website ? "\nTHEIR WEBSITE: could not be opened. Work from the answers." : "",
    profile ? `\nTHEIR PSYCHOLOGY TODAY OR DIRECTORY PROFILE (as read today)\n${profile}` : a.profile ? "\nTHEIR PROFILE: could not be opened. Work from the answers." : "",
    "\nWrite their playbook now. JSON only.",
  ].join("\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = extractJson(await call(system, prompt));
      if (validWritten(out)) return { written: cleanWritten(out), byModel: true };
      console.warn("[playbook] model answer was missing parts; trying again");
    } catch (err) {
      console.warn("[playbook] model call failed:", err instanceof Error ? err.message : err);
    }
  }
  return { written: cleanWritten(fallbackWritten(a, weakest.step)), byModel: false };
}

/** Used only when the model can't answer: still built from their own answers. */
export function fallbackWritten(a: Answers, step: Step): Written {
  const who = a.specialty || "the clients you do your best work with";
  const where = a.place ? ` in ${a.place}` : "";
  const pay = /insur/i.test(a.payment) ? "the insurance you take" : "your fee";
  const first = a.firstName;
  const byStep: Record<Step, Written["steps"]> = {
    booked: [
      { title: "Write your one-hour reply", when: "Tonight", body: `Write the text you will send every new inquiry, so answering takes ten seconds between sessions. Name ${who}, offer two times this week, and ask which works.` },
      { title: "Send paperwork the moment they book", when: "This week", body: `Move your intake forms to something a client can sign on a phone and send it with the booking confirmation, not the day before the session.` },
      { title: "Add one-tap reminders", when: "This week", body: `Set three reminders for every first session, and make sure each one lets the client confirm or move the time without calling the office.` },
      { title: "Count your hand steps", when: "Before your next billing cycle", body: `Answer, book, paperwork, remind, confirm: write down which of the five still wait on you, and take the next one off your plate.` },
    ],
    keep: [
      { title: "Add a reschedule line to cancellations", when: "Tonight", body: `Write the reply you send when a client cancels, with a way to pick a new time in the same message, so a cancellation does not turn into a goodbye.` },
      { title: "Check in after a missed session", when: "This week", body: `The day after a no-show, send a short personal check-in. Clients who hear from you the next day come back far more often than clients who hear nothing.` },
      { title: "Show the balance before the visit", when: "This week", body: `Make sure every client sees their copay or balance before the session. A surprise bill ends more therapy than a hard session does.` },
      { title: "Watch the slide", when: "Before your next billing cycle", body: `List the clients who have rescheduled twice in the last month and reach out to each one before the third.` },
    ],
    found: [
      { title: "Rewrite your first line", when: "Tonight", body: `Change the first sentence of your profile so it describes ${who} and what they are struggling with, in their words, before it mentions your training.` },
      { title: "Pick five referral partners", when: "This week", body: `Choose five clinicians or clinics${where} who see your population and cannot take everyone, and send each one the note below.` },
      { title: "Say what you take and when you have room", when: "This week", body: `Put ${pay} and your current openings on your profile and site, so the right person knows in one read that you can see them.` },
      { title: "Put the note on your calendar", when: "Before your next billing cycle", body: `Schedule the referral note again for next quarter. Referrals come from the person who remembers you the week they need someone.` },
    ],
  };
  const reply: Record<Step, [string, string]> = {
    booked: ["Reply to a new inquiry", `Hi, this is ${first}. Thank you for reaching out. I have openings this week on [day] at [time] and [day] at [time]. Which works better for you?`],
    keep: ["When a client cancels", `Thank you for letting me know. You can pick a new time here: [link]. I'm holding a spot for you this week.`],
    found: ["First line for your profile", `If you're looking for help with ${who}, you're in the right place.`],
  };
  return {
    where: `Your answers point to ${STEP_NAME[step]} as the place your practice loses the most clients right now.`,
    steps: byStep[step],
    words: {
      bestWith: `I work with ${who}${where}.`,
      referralNote: `Hi, this is ${first}${a.practice ? ` with ${a.practice}` : ""}. I work with ${who} and take ${/insur/i.test(a.payment) ? "insurance" : "self-pay clients"}. I have [your openings] right now, so if you have someone on a waitlist who fits, I would be glad to help. Thank you, ${first}`,
      replyTitle: reply[step][0],
      reply: reply[step][1],
    },
    fit: `LeadDash answers, books, sends paperwork, reminds and confirms for you automatically, so ${STEP_NAME[step].toLowerCase()} no longer waits on you between sessions.`,
    focus: `Your playbook starts with ${STEP_NAME[step]}, and step 1 takes under 30 minutes tonight.`,
  };
}

// ==========================================
// Kept playbooks (one JSON file each, beside the database)
// ==========================================

export type Playbook = {
  token: string;
  contactId: string;
  createdAt: string;
  answersHash: string;
  answers: Answers;
  numbers: Numbers;
  weakest: { step: Step; overridden: boolean };
  written: Written;
  byModel: boolean;
  /** When the webinar started, for the offer window; the creation time when not known. */
  webinarStart: string;
};

const dir = () => path.resolve(path.dirname(path.resolve(ENV.databasePath)), "playbooks");
const isToken = (t: string) => /^[a-f0-9]{32}$/.test(t);

export function savePlaybook(p: Playbook) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${p.token}.json`), JSON.stringify(p));
  const idx = readIndex();
  idx[p.contactId] = p.token;
  fs.writeFileSync(path.join(dir(), "index.json"), JSON.stringify(idx));
}

export function loadPlaybook(token: string): Playbook | null {
  if (!isToken(token)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), `${token}.json`), "utf8"));
  } catch {
    return null;
  }
}

function readIndex(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), "index.json"), "utf8"));
  } catch {
    return {};
  }
}

export const playbookUrl = (token: string) => `${ENV.appUrl}/playbook/${token}`;

// ==========================================
// The offer window
// ==========================================

function centralParts(t: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23", weekday: "short" })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value])
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), wd: parts.weekday as string };
}

/** Midnight Central at the end of the webinar's day: the $299 rate ends then. */
export function offerEnds(webinarStart: string) {
  const start = Date.parse(webinarStart) || Date.now();
  const { y, m, d } = centralParts(start);
  for (const h of [5, 6]) {
    const t = Date.UTC(y, m - 1, d + 1, h);
    if (centralParts(t).h === 0) return t;
  }
  return Date.UTC(y, m - 1, d + 1, 6);
}

/** The next Tuesday 7:00 PM Central after `now`. */
export function nextSession(now = Date.now()) {
  for (let day = 0; day < 9; day++) {
    const { y, m, d } = centralParts(now + day * 86400_000);
    for (const h of [0, 1]) {
      const t = Date.UTC(y, m - 1, d, 19 + 5 + h);
      const p = centralParts(t);
      if (p.h === 19 && p.wd === "Tue" && t > now) return t;
    }
  }
  return now + 7 * 86400_000;
}

const dayText = (t: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long", month: "short", day: "numeric", year: "numeric" }).format(new Date(t));

// ==========================================
// The page
// ==========================================

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const para = (s: string) => esc(s).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");

export function numberLines(a: Answers, n: Numbers): string[] {
  if (!n.ready) return ["We could not run your numbers because inquiries, first sessions or your fee were missing from the form. Your steps below still start where your answers point."];
  const lines: string[] = [];
  if (n.missed === 0) {
    lines.push(`Every inquiry you get becomes a first session, so your numbers point to keeping clients and getting found, not to booking.`);
  } else {
    lines.push(`${plural(n.missed, "person reaches", "people reach")} out each month and ${n.missed === 1 ? "does" : "do"} not book.`);
    lines.push(`${n.missed} x ${money(a.fee!)} x ${n.sessions} sessions = ${money(n.monthly)} a month, or ${money(n.yearly)} a year.`);
    lines.push(`Book ${n.recoverCount} more of them this month and that is ${money(n.recovery)}.`);
  }
  lines.push(`Keep two more clients for four more sessions each: 2 x 4 x ${money(a.fee!)} = ${money(n.retention)} a month.`);
  if (n.sessionsAssumed) lines.push(`We used 8 sessions a client, the number from the webinar example, because the form did not have yours.`);
  return lines;
}

function offerBlock(p: Playbook, now: number) {
  const ends = offerEnds(p.webinarStart);
  if (ENV.playbookCheckoutUrl && now < ends) {
    return `<section class="offer">
  <div class="eyebrow">Tonight only</div>
  <h2>LeadDash Complete at $299 a month, locked</h2>
  <p>The rate from the webinar (normally $449 a month) is yours until midnight Central tonight.</p>
  <p class="count">Ends in <b id="cd" data-ends="${ends}">--</b></p>
  <a class="btn" href="${esc(ENV.playbookCheckoutUrl)}">Start LeadDash at $299</a>
</section>
<script>(function(){var el=document.getElementById('cd');if(!el)return;var end=+el.dataset.ends;function t(){var s=Math.max(0,Math.floor((end-Date.now())/1000));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;el.textContent=s?h+'h '+m+'m '+x+'s':'now';if(!s)location.reload();}t();setInterval(t,1000);})();</script>`;
  }
  const next = nextSession(now);
  return `<section class="offer">
  <div class="eyebrow">Next live session</div>
  <h2>See LeadDash run a real practice</h2>
  <p>Join The Business of Healing live on ${esc(dayText(next))} at 7:00 PM Central. The $299 Complete rate is open again to everyone who attends.</p>
  <a class="btn" href="${esc(ENV.playbookRegisterUrl)}">Save my seat</a>
</section>`;
}

export function pageHtml(p: Playbook, now = Date.now()) {
  const { answers: a, numbers: n, written: w, weakest } = p;
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ");
  const sub = [a.practice, a.place].filter(Boolean).join(" · ");
  const steps = w.steps
    .map((s, i) => `<div class="step"><div class="num">${i + 1}</div><div><div class="when">${esc(s.when)}</div><h3>${esc(s.title)}</h3><p>${para(s.body)}</p></div></div>`)
    .join("\n");
  const word = (title: string, body: string, id: string) =>
    `<div class="word"><div class="wordhead"><h3>${esc(title)}</h3><button type="button" data-copy="${id}">Copy</button></div><p id="${id}">${para(body)}</p></div>`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Your Full Caseload Playbook${a.firstName !== "there" ? `, ${esc(a.firstName)}` : ""}</title>
<style>
:root{--g:#0C3522;--g2:#0F4A2E;--gs:#E3F0E8;--o:#ff914c;--ink:#0C1F15;--mut:#33493D;--line:#D5E2DA;--bg:#F8FAFB}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 60px}
.logo{height:40px;display:block;margin-bottom:22px}
header{background:var(--g);color:#fff;border-radius:16px;padding:26px 26px 24px;margin-bottom:22px}
header .eyebrow{color:var(--o)}header h1{margin:6px 0 4px;font-size:30px;line-height:1.2}header p{margin:0;color:#E8F1EC}
.eyebrow{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--g2)}
section{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin-bottom:18px}
h2{font-size:21px;margin:4px 0 10px;color:var(--g)}h3{font-size:17px;margin:0 0 4px;color:var(--g)}p{margin:0 0 8px}
.nums p{font-weight:600}.nums .big{font-size:26px;font-weight:800;color:var(--g2);margin-bottom:6px}
.start{display:inline-block;background:var(--gs);color:var(--g);font-weight:800;border-radius:999px;padding:4px 12px;margin-bottom:8px}
.step{display:flex;gap:14px;padding:14px 0;border-top:1px solid var(--line)}.step:first-of-type{border-top:0;padding-top:4px}
.num{flex:none;width:34px;height:34px;border-radius:50%;background:var(--o);color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center}
.when{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#B4541A}
.word{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-top:12px;background:#FBFDFC}
.wordhead{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}
.wordhead button{font:inherit;font-size:13px;font-weight:700;border:1px solid var(--g2);color:var(--g2);background:#fff;border-radius:8px;padding:4px 12px;cursor:pointer}
.check li{margin-bottom:4px}
.offer{background:var(--g);color:#fff;border:0}.offer h2{color:#fff}.offer .eyebrow{color:var(--o)}.offer p{color:#E8F1EC}
.count b{color:var(--o)}
.btn{display:inline-block;margin-top:8px;background:var(--o);color:#0C1F15;font-weight:800;text-decoration:none;border-radius:10px;padding:13px 22px}
footer{font-size:13px;color:var(--mut);text-align:center;margin-top:24px}
@media print{.btn,.wordhead button{display:none}body{background:#fff}}
</style></head><body><div class="wrap">
<img class="logo" src="/brand/leaddash-logo.svg" alt="LeadDash">
<header>
  <div class="eyebrow">From The Business of Healing with Ashley R. Bryant, LPC, CRC</div>
  <h1>Your Full Caseload Playbook</h1>
  <p>${esc(name || "Your practice")}${sub ? ` · ${esc(sub)}` : ""}</p>
</header>
<section class="nums">
  <div class="eyebrow">Your numbers</div>
  ${n.ready && n.missed > 0 ? `<div class="big">${money(n.monthly)} a month</div>` : ""}
  ${numberLines(a, n).map((l) => `<p>${esc(l)}</p>`).join("\n  ")}
</section>
<section>
  <div class="eyebrow">Where your practice is losing clients</div>
  <div class="start">Start with ${esc(STEP_NAME[weakest.step])}</div>
  <p>${para(w.where)}</p>
</section>
<section>
  <div class="eyebrow">Your next steps, in order</div>
  ${steps}
</section>
<section>
  <div class="eyebrow">Your words, ready to use</div>
  ${word("Who you are best with", w.words.bestWith, "w1")}
  ${word("Note to five referral partners", w.words.referralNote, "w2")}
  ${word(w.words.replyTitle, w.words.reply, "w3")}
</section>
<section>
  <div class="eyebrow">Your 30-day check</div>
  <p>Write these three numbers down a month from today and compare them with the ones you gave us:</p>
  <ul class="check"><li>New inquiries this month</li><li>How many became first sessions</li><li>Clients who stopped coming</li></ul>
</section>
<section>
  <div class="eyebrow">Where LeadDash fits</div>
  <p>${para(w.fit)}</p>
</section>
${offerBlock(p, now)}
<footer>&copy; ${new Date(now).getFullYear()} LeadDash Marketing LLC. This playbook is educational and does not replace consultation with your licensing board.</footer>
</div>
<script>document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById(b.dataset.copy).innerText;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)},function(){});});});</script>
</body></html>`;
}

// ==========================================
// The LeadDash platform (LeadDash sub-account only)
// ==========================================

const API = "https://services.leadconnectorhq.com";

async function platform(pathname: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${ENV.playbookPlatformToken}`, version: "2021-07-28", accept: "application/json", "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LeadDash platform ${init.method ?? "GET"} ${pathname.split("?")[0]} answered ${res.status}: ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : {};
}

let fieldCache: { at: number; byId: Map<string, string>; byKey: Map<string, string> } | null = null;
async function fieldMaps() {
  if (fieldCache && Date.now() - fieldCache.at < 10 * 60_000) return fieldCache;
  const data = await platform(`/locations/${ENV.playbookLocationId}/customFields?model=contact`);
  const byId = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const f of data?.customFields ?? []) {
    const key = String(f.fieldKey ?? "").replace(/^contact\./, "");
    if (f.id && key) {
      byId.set(f.id, key);
      byKey.set(key, f.id);
    }
  }
  fieldCache = { at: Date.now(), byId, byKey };
  return fieldCache;
}

/** The contact and its custom fields as { key: value }. */
async function readContact(contactId: string) {
  const data = await platform(`/contacts/${encodeURIComponent(contactId)}`);
  const c = data?.contact;
  if (!c) throw new Error("contact not found");
  if (c.locationId && c.locationId !== ENV.playbookLocationId) throw new Error("contact is not in the LeadDash sub-account");
  const { byId } = await fieldMaps();
  const fields: Record<string, unknown> = {};
  for (const cf of c.customFields ?? []) {
    const key = byId.get(cf.id);
    if (key) fields[key] = cf.value ?? cf.fieldValue ?? cf.field_value;
  }
  return { contact: c as { id: string; firstName?: string; lastName?: string }, fields };
}

async function writeBack(contactId: string, values: Record<string, string>) {
  const { byKey } = await fieldMaps();
  const customFields = Object.entries(values)
    .map(([key, value]) => ({ id: byKey.get(key), field_value: value }))
    .filter((f): f is { id: string; field_value: string } => Boolean(f.id));
  const missing = Object.keys(values).filter((k) => !byKey.has(k));
  if (missing.length) console.warn(`[playbook] custom fields missing in the sub-account: ${missing.join(", ")}`);
  if (customFields.length) await platform(`/contacts/${encodeURIComponent(contactId)}`, { method: "PUT", body: JSON.stringify({ customFields }) });
  await platform(`/contacts/${encodeURIComponent(contactId)}/tags`, { method: "POST", body: JSON.stringify({ tags: [READY_TAG] }) });
}

// ==========================================
// One attendee, start to finish
// ==========================================

export function hashAnswers(a: Answers) {
  return crypto.createHash("sha256").update(JSON.stringify(a)).digest("hex").slice(0, 16);
}

export async function buildPlaybook(contactId: string, fields: Record<string, unknown>, contact: { firstName?: string; lastName?: string }, opts: { webinarStart?: string; call?: typeof callModel } = {}): Promise<Playbook> {
  const answers = answersFrom(fields, contact);
  const answersHash = hashAnswers(answers);
  const existing = readIndex()[contactId];
  const old = existing ? loadPlaybook(existing) : null;
  if (old && old.answersHash === answersHash) return old;
  const numbers = numbersFor(answers);
  const weakest = weakestStep(answers);
  const { written, byModel } = await writePlaybook(answers, numbers, weakest, opts.call);
  const start = opts.webinarStart && !Number.isNaN(Date.parse(opts.webinarStart)) ? new Date(opts.webinarStart).toISOString() : new Date().toISOString();
  const p: Playbook = { token: old?.token ?? crypto.randomBytes(16).toString("hex"), contactId, createdAt: new Date().toISOString(), answersHash, answers, numbers, weakest, written, byModel, webinarStart: start };
  savePlaybook(p);
  return p;
}

function webinarStartOf(v: unknown) {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e11) return new Date(n).toISOString();
  return String(v);
}

async function runFor(contactId: string) {
  const { contact, fields } = await readContact(contactId);
  const p = await buildPlaybook(contactId, fields, contact, { webinarStart: webinarStartOf(fields[WEBINAR_START_KEY]) });
  await writeBack(contactId, {
    [OUTPUT_KEYS.link]: playbookUrl(p.token),
    [OUTPUT_KEYS.weakest]: STEP_NAME[p.weakest.step],
    [OUTPUT_KEYS.leak]: p.numbers.ready && p.numbers.missed > 0 ? money(p.numbers.monthly) : "",
    [OUTPUT_KEYS.focus]: p.written.focus,
  });
  console.log(`[playbook] ready for contact ${contactId}: ${STEP_NAME[p.weakest.step]}${p.byModel ? "" : " (built-in wording)"}`);
}

// ==========================================
// Routes
// ==========================================

const recent: number[] = [];
const working = new Set<string>();

function secretOk(given: string) {
  if (!ENV.playbookSecret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ENV.playbookSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The contact id from a LeadDash platform webhook body, whichever shape it came in. */
export function contactIdOf(body: any): string {
  const id = body?.contact_id ?? body?.contactId ?? body?.customData?.contact_id ?? body?.customData?.contactId ?? body?.contact?.id ?? body?.id;
  return typeof id === "string" && /^[A-Za-z0-9]{8,40}$/.test(id) ? id : "";
}

export function registerPlaybook(app: Express) {
  app.post("/api/playbook/hook/:secret", (req: Request, res: Response) => {
    if (!secretOk(String(req.params.secret))) return res.status(404).json({ ok: false });
    if (!ENV.playbookPlatformToken) return res.status(503).json({ ok: false, error: "PLAYBOOK_PLATFORM_TOKEN is not set" });
    const contactId = contactIdOf(req.body);
    if (!contactId) return res.status(400).json({ ok: false, error: "no contact id" });
    const now = Date.now();
    while (recent.length && now - recent[0] > 3600_000) recent.shift();
    if (recent.length >= ENV.playbookMaxPerHour) return res.status(429).json({ ok: false, error: "too many playbooks this hour" });
    if (working.has(contactId)) return res.json({ ok: true, already: true });
    recent.push(now);
    working.add(contactId);
    res.json({ ok: true });
    void runFor(contactId)
      .catch((err) => console.error(`[playbook] contact ${contactId} failed:`, err instanceof Error ? err.message : err))
      .finally(() => working.delete(contactId));
  });

  app.get("/playbook/:token", (req: Request, res: Response) => {
    const p = loadPlaybook(String(req.params.token));
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-store");
    if (!p) return res.status(404).send("<!DOCTYPE html><p style=\"font-family:system-ui;padding:40px\">This playbook link is not valid. Check the link in your email.</p>");
    res.send(pageHtml(p));
  });
}
