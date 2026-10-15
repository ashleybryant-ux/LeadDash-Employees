import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import * as db from "../db";
import * as hours from "../workHours";
import { ENV } from "../_core/env";
import { generateJson, type JsonSchema } from "../_core/llm";
import { storagePut } from "../storage";
import { demoVideos, type AIEmployee, type DemoVideo } from "../../drizzle/schema";
import { withUsage } from "../usage";
import * as avatar from "./avatar";
import * as broll from "./broll";
import * as presenters from "./presenters";
import * as vg from "./videoGuides";
import { editAss } from "./editCaptions";
import { editLookOf, spreadWords, type CutLine } from "./editLook";
import { cardSeconds, clipFromFrames, renderDemo, stepTiming, type DemoRenderInput, type Part } from "./demoRender";
import type { BrowserResult, BrowserTask } from "./browser";
import { putCode, takeCode } from "./web";
import { systemPromptFor } from "./tasks";

/**
 * Simone's demo and training videos of a website or app (and "Come with me" social videos).
 * 1. Plan: from the playbook, the app's guide (LeadDash's own apps, in LeadDash's own workspace),
 *    an SOP, or a practice run when there's nothing else. Every step has what she does, what she
 *    says and what should appear; the plan says where it starts and when it's done. If the ask
 *    could mean more than one thing, she asks first with fixed choices. Nothing is recorded until
 *    the owner presses Record it.
 * 2. Record: her browser does the plan while the screen is recorded, noting where each click lands.
 *    A screen that doesn't match the plan stops the take instead of improvising.
 * 3. Make: each line is read in the voice (and said by the avatar where the presenter needs one),
 *    and the cut zooms in on each click with a ring, speeds through waits, captions every line,
 *    adds title cards and the logo, in every size. The written SOP comes from the same steps.
 * Work hours: 2 for each minute of finished video, once; avatar time 8 a minute, by the half minute.
 * Editing a line or the look re-cuts it with no screen hours.
 */

const run = promisify(execFile);

export type Kind = "training" | "social";
export type PresenterMode = "screen" | "corner" | "bookends";
export type Size = "wide" | "vertical" | "square";
export const SIZES: Record<Size, { w: number; h: number; ratio: string }> = { wide: { w: 1920, h: 1080, ratio: "16:9" }, vertical: { w: 1080, h: 1920, ratio: "9:16" }, square: { w: 1080, h: 1080, ratio: "1:1" } };
export const SOCIAL_STYLES = { come: "Come with me", tip: "Hey guys, quick tip", pov: "POV: you're the front desk" } as const;
export type SocialStyle = keyof typeof SOCIAL_STYLES;
export const PRESENTER_LABEL: Record<PresenterMode, string> = { screen: "Screen only", corner: "Avatar in the corner", bookends: "Avatar opens and closes" };

export type PlanStep = { do: string; say: string; expect: string };
export type Plan = { startsOn: string; needs: string[]; doneWhen: string; intro: string; outro: string; steps: PlanStep[]; question?: { text: string; options: string[] } | null; app?: string | null };
export type TakeStep = { clip: string; seconds: number; clicks: { at: number; x: number; y: number; w: number; h: number }[]; shot: string | null };
export type Take = { steps: TakeStep[]; screen: { w: number; h: number }; at?: string };
export type PartFile = { text: string; voiceId: string; voice: string; tenths: number; avatar?: string | null; avatarFor?: string | null };
export type DemoLook = { zoom: boolean; captions: { on: boolean; position: "bottom" | "top" }; cards: boolean; logo: boolean; music: { track: broll.TrackKey | "none"; volume: number } };
export const DEFAULT_LOOK: DemoLook = { zoom: true, captions: { on: true, position: "bottom" }, cards: true, logo: true, music: { track: "none", volume: 12 } };

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
export const planOf = (d: Pick<DemoVideo, "plan">) => {
  const p = parse<Partial<Plan>>(d.plan, {});
  return { startsOn: p.startsOn ?? "", needs: Array.isArray(p.needs) ? p.needs : [], doneWhen: p.doneWhen ?? "", intro: p.intro ?? "", outro: p.outro ?? "", steps: Array.isArray(p.steps) ? p.steps : [], question: p.question ?? null, app: p.app ?? null } as Plan;
};
export const takeOf = (d: Pick<DemoVideo, "take">): Take => {
  const t = parse<Partial<Take>>(d.take, {});
  return { steps: Array.isArray(t.steps) ? t.steps : [], screen: t.screen?.w ? t.screen : { w: 1280, h: 900 }, ...(t.at ? { at: t.at } : {}) };
};
export const partsOf = (d: Pick<DemoVideo, "parts">) => parse<Record<string, PartFile>>(d.parts, {});
export const lookOf = (d: Pick<DemoVideo, "look">): DemoLook => {
  const l = parse<Partial<DemoLook>>(d.look, {});
  return { ...DEFAULT_LOOK, ...l, captions: { ...DEFAULT_LOOK.captions, ...(l.captions ?? {}) }, music: { ...DEFAULT_LOOK.music, ...(l.music ?? {}) } };
};
export const sizesOf = (d: Pick<DemoVideo, "sizes">): Size[] => {
  const s = parse<string[]>(d.sizes, []).filter((x): x is Size => x in SIZES);
  return s.length ? Array.from(new Set(s)) : ["wide"];
};
const urlsOf = (d: Pick<DemoVideo, "videoUrls">) => parse<Partial<Record<Size, string>>>(d.videoUrls, {});
export const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// ==========================================
// Rows
// ==========================================

export function get(orgId: number, id: number) {
  return db.getDb().select().from(demoVideos).where(and(eq(demoVideos.id, id), eq(demoVideos.organizationId, orgId))).get() ?? null;
}
export function list(orgId: number) {
  const rows = db.getDb().select().from(demoVideos).where(eq(demoVideos.organizationId, orgId)).orderBy(desc(demoVideos.id)).all();
  for (const r of rows) {
    const stale = Date.now() - new Date(r.updatedAt).getTime() > 60 * 60_000;
    if ((r.status === "planning" || r.status === "recording" || r.status === "making") && !jobs.has(r.id) && stale) {
      Object.assign(r, update(orgId, r.id, { status: r.status === "planning" ? "failed" : Object.keys(urlsOf(r)).length ? "ready" : planOf(r).steps.length ? "plan" : "failed", step: null, error: "It stopped before it finished. Try again." }));
    }
  }
  return rows;
}
export function forSop(orgId: number, sopId: number) {
  return list(orgId).filter((d) => d.sopId === sopId || d.fromSopId === sopId);
}
function update(orgId: number, id: number, data: Partial<typeof demoVideos.$inferInsert>) {
  db.getDb().update(demoVideos).set({ ...data, updatedAt: new Date() }).where(and(eq(demoVideos.id, id), eq(demoVideos.organizationId, orgId))).run();
  return get(orgId, id)!;
}
function must(orgId: number, id: number) {
  const d = get(orgId, id);
  if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  return d;
}
function idle(d: DemoVideo) {
  if (["planning", "recording", "making"].includes(d.status) || jobs.has(d.id)) throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes." });
}
export function remove(orgId: number, id: number) {
  idle(must(orgId, id));
  db.getDb().delete(demoVideos).where(and(eq(demoVideos.id, id), eq(demoVideos.organizationId, orgId))).run();
}

async function simone(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "coo");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Simone is not in this workspace." });
  return emp;
}
async function say(orgId: number, content: string, cards: unknown[] = []) {
  const emp = await db.getEmployeeByKind(orgId, "coo");
  if (emp) await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content, cards: JSON.stringify(cards) });
}
async function chargeNow(orgId: number, emp: { id: number; kind: AIEmployee["kind"] }, job: hours.JobKey, count: number, label: string) {
  if (count <= 0) return;
  await withUsage({ orgId, employeeId: emp.id, kind: emp.kind }, async () => {
    const minutes = await hours.charge(orgId, emp.id, job, count, label);
    if (minutes > 0) await db.recordEmployeeTask(emp.id, orgId, minutes);
  });
}

const jobs = new Map<number, Promise<unknown>>();
export const jobFor = (id: number) => jobs.get(id) ?? null;
function background(orgId: number, id: number, fn: () => Promise<void>, failStatus: DemoVideo["status"] = "failed") {
  const p = fn()
    .catch((err) => {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      const d = get(orgId, id);
      if (d) update(orgId, id, { status: failStatus === "failed" && Object.keys(urlsOf(d)).length ? "ready" : failStatus, step: null, error: msg });
    })
    .finally(() => jobs.delete(id));
  jobs.set(id, p);
  return p;
}

// ==========================================
// Starting one
// ==========================================

export type CreateInput = {
  ask: string;
  kind: Kind;
  presenter: PresenterMode;
  avatar?: presenters.Presenter | null;
  voiceId?: string | null;
  audience?: string;
  socialStyle?: SocialStyle;
  loginName?: string | null;
  url?: string | null;
  fromSopId?: number | null;
  sizes?: Size[];
  makeSop?: boolean;
  /** The email she signs in with when there's no saved Website login. */
  signInEmail?: string | null;
  by: string;
};

/** A web address as the browser needs it ("demo.leaddash.io" becomes "https://demo.leaddash.io"). */
export function fullUrl(url: string | null | undefined) {
  const u = (url ?? "").trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u.replace(/^\/+/, "")}`;
}

/** The fictional practice LeadDash EHR videos are recorded in: the browser demo, and the Demo Account practice in the live app. */
export const DEMO_PRACTICE = "Maple Crest Counseling";
export const EHR_DEMO_HOST = "demo.leaddash.io";
export const EHR_LIVE_HOST = "ehr.leaddash.io";

/**
 * Where it's recorded must be safe: LeadDash EHR only in its demo practice, and only real web addresses.
 * The demo practice is in two places: demo.leaddash.io (the browser demo, signs itself in) and the
 * Demo Account practice in the live app (ehr.leaddash.io), which needs a sign-in as one of its team.
 * Any other practice in the live app is refused; the browser also checks the practice name once it's in.
 */
export function checkWhere(url: string | null | undefined, signIn?: { loginName?: string | null; email?: string | null }) {
  if (!url) return;
  let host = "";
  try {
    host = new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That web address isn't valid." });
  }
  if (vg.appFor(url) !== "ehr") return;
  if (host === EHR_DEMO_HOST) return;
  if (host !== EHR_LIVE_HOST) throw new TRPCError({ code: "BAD_REQUEST", message: `LeadDash EHR videos are recorded in the demo practice only (${EHR_DEMO_HOST}, or ${DEMO_PRACTICE} at ${EHR_LIVE_HOST}), so no client information is ever in a video.` });
  if (signIn && !(signIn.loginName?.trim() || signIn.email?.trim())) throw new TRPCError({ code: "BAD_REQUEST", message: `At ${EHR_LIVE_HOST}, sign in as someone on the ${DEMO_PRACTICE} team (the demo practice): pick its saved Website login or enter the sign-in email.` });
}
/**
 * The demo's team link: demo.leaddash.io opens with a sign-up card (a real sales lead form) unless
 * ?team=<code> is on the address. With the code saved on the server (EHR_DEMO_TEAM_CODE), Simone's
 * browser opens every demo recording through it, so nobody has to send her the link or sign her in.
 * Only the first address carries the code; the demo drops it from the address bar right away.
 */
export function demoTeamLink(url: string) {
  const code = ENV.ehrDemoTeamCode;
  if (!code) return null;
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== EHR_DEMO_HOST) return null;
    u.searchParams.set("team", code);
    return u.toString();
  } catch {
    return null;
  }
}
/** The browser's own check once it's signed in: the demo practice, or stop. */
export const demoPracticeRule = (url: string) => {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  return host === EHR_LIVE_HOST ? `\n- This is the live LeadDash EHR app. Right after signing in, read the practice name at the bottom of the left menu (under "Signed in as"). It must say "${DEMO_PRACTICE}", the demo practice. If it says anything else, use fail at once with "Signed in to <that practice>, not the demo practice" and do nothing on the page.` : "";
};

/** The popups the browser demo shows, and what to do with each. */
const demoPopupRule = (url: string) => {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (host !== EHR_DEMO_HOST) return "";
  return `
- In this demo, DashNotes' Start recording opens a recorder window over the note: click Start recording, use wait twice, click End and draft note, use wait until it says "Your draft is written", then click Close. The note's fields behind it are filled in.
- A dark message box that starts "In your own account this would" is the demo explaining what a real account does: press_escape to close it and go on; the step still counted.
- If the demo's sign-up card ("Open the demo") shows, never fill it in: use fail and say the team link is missing.`;
};

const cleanEmail = (e: string | null | undefined) => {
  const v = (e ?? "").trim().toLowerCase();
  if (!v) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new TRPCError({ code: "BAD_REQUEST", message: "That email doesn't look right." });
  return v.slice(0, 200);
};

export async function create(orgId: number, input: CreateInput) {
  /* A full brief (2026-10-15): up to 4,000 characters, line breaks kept, so
     a list of what to show reaches the planner as a list. */
  const ask = input.ask.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!ask) throw new TRPCError({ code: "BAD_REQUEST", message: "Say what the video should show." });
  await simone(orgId);
  const logins = await db.listPortalLogins(orgId);
  const { findLogin, startIn } = await import("./logins");
  const login = input.loginName ? findLogin(logins, input.loginName, input.url ?? "") : null;
  const sop = input.fromSopId ? db.sops.get(orgId, input.fromSopId) : null;
  if (input.fromSopId && !sop) throw new TRPCError({ code: "NOT_FOUND", message: "That SOP is not in this workspace." });
  const url = fullUrl(input.url) || (login ? startIn(login) : "") || (sop ? sopSite(sop) : "") || "";
  if (!url && !login) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick where to record: a saved Website login or a web address." });
  checkWhere(url, { loginName: login?.name ?? null, email: input.signInEmail ?? null });
  if (input.presenter !== "screen" && !input.avatar) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the avatar." });
  if (input.kind === "social" && !input.avatar) throw new TRPCError({ code: "BAD_REQUEST", message: "A social video needs an avatar for the hook. Pick one." });
  const presenter = input.kind === "social" ? null : input.presenter === "screen" ? null : input.avatar ?? null;
  const av = input.kind === "social" ? input.avatar ?? null : presenter;
  const voice = await presenters.voiceFor(orgId, av, input.voiceId);
  const sizes = input.sizes?.length ? input.sizes : input.kind === "social" ? (["vertical"] as Size[]) : (["wide"] as Size[]);
  const row = db
    .getDb()
    .insert(demoVideos)
    .values({
      organizationId: orgId,
      title: ask.split("\n")[0].slice(0, 80),
      kind: input.kind,
      presenter: input.kind === "social" ? "bookends" : input.presenter,
      avatar: JSON.stringify(av ?? {}),
      voiceId: voice.id,
      voiceName: voice.name,
      ask: ask.slice(0, 4000),
      audience: (input.audience ?? "").slice(0, 80),
      socialStyle: input.socialStyle ?? "come",
      loginName: login?.name ?? null,
      url: url || null,
      signInEmail: login ? null : cleanEmail(input.signInEmail),
      fromSopId: sop?.id ?? null,
      sopId: sop?.id ?? null,
      makeSop: input.makeSop !== false && !sop,
      sizes: JSON.stringify(sizes),
      look: JSON.stringify({ ...DEFAULT_LOOK, cards: input.kind !== "social" }),
      status: "planning",
      step: "Planning the steps",
      createdBy: input.by,
    })
    .returning()
    .get();
  void background(orgId, row.id, () => plan(orgId, row.id));
  return row;
}

/** Where an SOP's video can be recorded: the site it was walked on (a screen recording has no site). */
export function sopSite(s: { sourceKind: string; sourceUrl: string | null }) {
  return s.sourceKind === "site" && s.sourceUrl && /^https?:/i.test(s.sourceUrl) ? s.sourceUrl : null;
}

/** An SOP's Make video: a training video of its steps, screen only, planned from the SOP. */
export function fromSop(orgId: number, sopId: number, by: string, where: { loginName?: string | null; url?: string | null } = {}) {
  const s = db.sops.get(orgId, sopId);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "That SOP is not in this workspace." });
  const url = where.url?.trim() || (where.loginName ? null : sopSite(s));
  return create(orgId, { ask: s.title, kind: "training", presenter: "screen", fromSopId: s.id, url, loginName: where.loginName ?? null, audience: s.follows, by });
}

// ==========================================
// 1. The plan
// ==========================================

const PLAN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "questionText", "questionOptions", "startsOn", "needs", "doneWhen", "intro", "outro", "steps"],
  properties: {
    title: { type: "string", description: "The task in plain words, at most 8 words, like Booking outside a clinician's availability." },
    questionText: { type: "string", description: "Only when the words could mean two different things and the plan would be wrong for one of them: the question to ask first. Otherwise '' (take the fuller reading and say so in the intro)." },
    questionOptions: { type: "array", items: { type: "string" }, description: "2 or 3 short fixed choices for the question (at most 5 words each), the last may be 'Both, as two videos'. [] when there's no question." },
    startsOn: { type: "string", description: "The exact screen and state the video opens on." },
    needs: { type: "array", items: { type: "string" }, description: "Sample data or settings that must exist first." },
    doneWhen: { type: "string", description: "The visible result that proves it worked; the video ends on this screen." },
    intro: { type: "string", description: "The opening line (one or two short sentences)." },
    outro: { type: "string", description: "The closing line: what they did, one thing to watch for (social: a short call to follow)." },
    steps: {
      type: "array",
      description: "One action each, in order. Empty when asking a question.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["do", "say", "expect"],
        properties: {
          do: { type: "string", description: "What you click or type, using the screen's exact labels and the value you type." },
          say: { type: "string", description: "What the viewer hears for this step: one or two short sentences, the label named as the screen shows it." },
          expect: { type: "string", description: "What appears on screen after it." },
        },
      },
    },
  },
};

const SOCIAL_HOW: Record<SocialStyle, string> = {
  come: `A "Come with me" video: the intro is the hook, said to camera like a friend ("Hey guys, come with me while I..."), the steps are quick and casual, the outro is a short call to follow for more.`,
  tip: `A "Hey guys, quick tip" video: the intro opens with "Hey guys, quick tip" and names the problem, the steps are fast, the outro is a short call to follow.`,
  pov: `A "POV" video: the intro sets the scene in one line ("POV: you're the front desk and..."), the steps show the fix, the outro is a short call to follow.`,
};

/** Her browser for one run, watched live: stuck or signing in, she asks in chat and the person can take over. */
async function runLive(orgId: number, d: DemoVideo, emp: AIEmployee, task: BrowserTask, label: string) {
  const { runBrowserTask, liveStart } = await import("./browser");
  const web = await import("./web");
  const liveId = web.newLiveId();
  liveStart(orgId, liveId);
  task.live = { id: liveId, label, holdMs: 10 * 60_000, onStuck: web.stuckPoster(emp, liveId, `on "${d.title}"`) };
  live.set(d.id, { liveId });
  try {
    return await web.inLine(orgId, () => runBrowserTask(task));
  } finally {
    live.delete(d.id);
    const now = get(orgId, d.id);
    if (now?.asking) update(orgId, d.id, { asking: null });
  }
}

/** What the practice run looks for: the screens the ask covers, every part of each, every option on each. */
function surveyGoal(ask: string, guide: string | null) {
  return `${guide ? `Background on this app (its labels, where things are, its Never list):\n${guide}\n\n` : ""}You are about to record a training video: "${ask}". First look at the real screens it covers, so the plan comes from what is on them today and not from memory.
Go to the screen or screens the ask is about, the way a person would from the menu. On each one, look at every part from top to bottom: each card and section and its heading, each tab, each button, each field, and every option in every dropdown or format list (open it, read the options, close it). Open anything that reveals choices (a tab, a menu, a row's details) and close it again. Fill in nothing, save nothing, change nothing; stop before any button that saves, sends, signs, submits or deletes.
Use done when every part has been seen, with result as JSON: {"answer":"the screens in order; for each, every section top to bottom with its exact heading, the buttons and fields in it, and every option each choice offers with what it is for, as the screen describes it","pending":"the final button you stopped before, or ''"}`;
}

async function explore(orgId: number, d: DemoVideo, emp: AIEmployee, guide: string | null) {
  const { task, login } = await browserTask(orgId, d, emp, surveyGoal(d.ask, guide), false);
  const web = await import("./web");
  const res = await runLive(orgId, d, emp, task, `${d.title} (practice run)`);
  if (login) await (await import("./logins")).keepSession(orgId, login, res.storageState).catch(() => null);
  const walked = res.log.filter((l) => !["person", "blocked"].includes(l.action)).map((l) => `${l.step}. ${l.detail}${l.title ? ` (page: ${l.title})` : ""}`).join("\n");
  return `${walked}\n\nWhat I found: ${web.readResult(res.result).answer}`.slice(0, 12_000);
}

async function plan(orgId: number, id: number, extra = "") {
  const d = must(orgId, id);
  const emp = await simone(orgId);
  const org = await db.getOrganizationById(orgId);
  const guide = vg.guideFor(org, { title: d.ask, url: d.url, login: d.loginName });
  const sop = d.fromSopId ? db.sops.get(orgId, d.fromSopId) : null;
  const sopText = sop ? (await import("./sops")).stepsOf(sop).map((s, i) => `${i + 1}. ${s.title}${s.detail ? `: ${s.detail}` : ""}`).join("\n") : "";
  let notes = "";
  // She looks at the real screens before every plan, guide or not (2026-10-15): the guide says where things are, the
  // screen says what is on it today, every card and every option, and the plan is written from the screen.
  if (d.url || d.loginName) {
    update(orgId, id, { step: "Looking at the screens (a practice run)" });
    notes = await explore(orgId, d, emp, guide?.text ?? null).catch(() => "");
  }
  update(orgId, id, { step: "Writing the plan" });
  const { system } = await systemPromptFor(emp, `Plan a ${d.kind === "social" ? "social video" : "training video"} of a task on a website, following this playbook:\n\n${vg.playbook()}`);
  const prompt = [
    `What to show: ${d.ask}${extra ? `\nThey chose: ${extra}` : ""}`,
    d.audience ? `Who will watch: ${d.audience}` : "",
    d.kind === "social" ? SOCIAL_HOW[(d.socialStyle as SocialStyle) in SOCIAL_HOW ? (d.socialStyle as SocialStyle) : "come"] : "A training video: clear and calm. A task is shown end to end; a screen or feature is walked through whole, every part and every option, the way a trainer would show a new hire.",
    `Where: ${d.url ?? ""}${d.loginName ? ` (saved login: ${d.loginName})` : ""}`,
    guide ? `\n${guide.text}` : "",
    sopText ? `\nThe SOP for this task:\n${sopText}` : "",
    notes ? `\nWhat the screens hold today (from the practice run; this is what the viewer will see, so every part and option listed here that belongs to the ask gets its step):\n${notes}` : "",
    extra ? "\nThey answered the question, so do not ask again: write the plan." : "",
  ]
    .filter(Boolean)
    .join("\n");
  const out = await generateJson<{ title: string; questionText: string; questionOptions: string[]; startsOn: string; needs: string[]; doneWhen: string; intro: string; outro: string; steps: PlanStep[] }>({ system, prompt, schemaName: "demo_plan", schema: PLAN_SCHEMA, maxTokens: 6000, timeoutMs: 4 * 60_000 });
  const asking = !extra && out.questionText?.trim() && (out.questionOptions ?? []).filter(Boolean).length >= 2;
  const steps = (out.steps ?? []).filter((s) => s?.do?.trim()).slice(0, 40).map((s) => ({ do: s.do.trim().slice(0, 300), say: (s.say ?? "").trim().slice(0, 400), expect: (s.expect ?? "").trim().slice(0, 300) }));
  if (!asking && !steps.length) throw new Error("I couldn't work out the steps. Add an SOP for it, or say more about what to show.");
  const p: Plan = {
    startsOn: (out.startsOn ?? "").slice(0, 300),
    needs: (out.needs ?? []).map((n) => String(n).slice(0, 200)).slice(0, 8),
    doneWhen: (out.doneWhen ?? "").slice(0, 300),
    intro: (out.intro ?? "").slice(0, 400),
    outro: (out.outro ?? "").slice(0, 400),
    steps,
    question: asking ? { text: out.questionText.trim().slice(0, 200), options: out.questionOptions.map((o) => o.trim().slice(0, 60)).filter(Boolean).slice(0, 3) } : null,
    app: guide?.label ?? null,
  };
  update(orgId, id, { title: (out.title || d.title).trim().slice(0, 80), plan: JSON.stringify(p), status: asking ? "asking" : "plan", step: null, error: null });
}

/** The answer to her question: the plan is written with that choice. */
export function answer(orgId: number, id: number, option: string) {
  const d = must(orgId, id);
  if (d.status !== "asking") throw new TRPCError({ code: "BAD_REQUEST", message: "There's no question waiting." });
  const choice = option.trim().slice(0, 80);
  if (!choice) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick one." });
  const started = update(orgId, id, { status: "planning", step: "Writing the plan", error: null });
  void background(orgId, id, () => plan(orgId, id, choice));
  return started;
}

/** Start over: a fresh plan from the same ask. */
export function replan(orgId: number, id: number) {
  const d = must(orgId, id);
  idle(d);
  const started = update(orgId, id, { status: "planning", step: "Planning the steps", error: null });
  void background(orgId, id, () => plan(orgId, id));
  return started;
}

export function saveStep(orgId: number, id: number, n: number, input: { do: string; say: string; expect?: string }) {
  const d = must(orgId, id);
  idle(d);
  const p = planOf(d);
  if (!p.steps[n]) throw new TRPCError({ code: "NOT_FOUND", message: "That step is not in this plan." });
  if (!input.do.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Say what she does in this step." });
  p.steps[n] = { do: input.do.trim().slice(0, 300), say: input.say.trim().slice(0, 400), expect: (input.expect ?? p.steps[n].expect).trim().slice(0, 300) };
  return update(orgId, id, { plan: JSON.stringify(p) });
}

export function savePlanInfo(orgId: number, id: number, input: { startsOn?: string; doneWhen?: string; intro?: string; outro?: string }) {
  const d = must(orgId, id);
  idle(d);
  const p = planOf(d);
  for (const k of ["startsOn", "doneWhen", "intro", "outro"] as const) if (input[k] != null) p[k] = input[k]!.trim().slice(0, 400);
  return update(orgId, id, { plan: JSON.stringify(p) });
}

// ==========================================
// Hours
// ==========================================

const WPS = 2.5;
const secsOf = (text: string) => Math.max(1.5, text.trim().split(/\s+/).filter(Boolean).length / WPS);
/** Which parts the avatar says, by presenter. */
function avatarKeys(d: DemoVideo, p: Plan) {
  if (d.kind === "social" || d.presenter === "bookends") return ["intro", "outro"];
  if (d.presenter === "corner") return ["intro", ...p.steps.map((_, i) => `s${i}`), "outro"];
  return [];
}
const lineOf = (p: Plan, key: string) => (key === "intro" ? p.intro : key === "outro" ? p.outro : p.steps[Number(key.slice(1))]?.say ?? "");
/** Avatar time: 8 work hours a minute, counted by the half minute. */
const avatarMinutes = (secs: number) => (secs > 0 ? Math.ceil(secs / 30) * (hours.JOBS.video.minutes / 2) : 0);
const screenMinutes = (secs: number) => Math.max(1, Math.ceil(secs / 60)) * hours.JOBS.edit.minutes;

/** About how long it runs and what it uses, before it's recorded. */
export function estimate(d: DemoVideo) {
  const p = planOf(d);
  const take = takeOf(d);
  const lines = ["intro", ...p.steps.map((_, i) => `s${i}`), "outro"];
  const secs = lines.reduce((n, k, i) => {
    const say = secsOf(lineOf(p, k));
    if (k.startsWith("s")) return n + stepTiming(take.steps[i - 1]?.seconds ?? say + 2, say).seconds;
    return n + cardSeconds(say, avatarKeys(d, p).includes(k));
  }, 0);
  const avatarSecs = avatarKeys(d, p).reduce((n, k) => n + secsOf(lineOf(p, k)), 0);
  const minutes = Math.max(0, screenMinutes(secs) - d.paidMinutes) + Math.max(0, avatarMinutes(avatarSecs) - d.paidAvatar);
  return { seconds: secs, minutes };
}
const hoursText = (m: number) => {
  const h = hours.hoursNum(m);
  return `${h} work ${h === "1" ? "hour" : "hours"}`;
};

// ==========================================
// 2. Recording
// ==========================================

const withEmail = <T extends { secrets?: Record<string, string | undefined> }>(parts: T, email: string | null) => (email ? { ...parts, secrets: { ...parts.secrets, email } } : parts);

/**
 * Signing in while she works: the site's code, or the email to sign in as, asked for in Simone's chat
 * and on the Videos tab, and typed in on the same page when it comes. The person can also take over.
 */
function signInAsk(orgId: number, id: number, emp: AIEmployee): NonNullable<BrowserTask["ask"]> {
  return {
    post: async (what, note) => {
      const d = update(orgId, id, { asking: what, step: what === "code" ? "Waiting for the sign-in code" : "Waiting for the email to sign in with" });
      const site = d.loginName ?? (() => {
        try {
          return new URL(fullUrl(d.url)).host;
        } catch {
          return "The site";
        }
      })();
      const text = what === "code" ? `${site} sent a sign-in code for "${d.title}". Paste it here and I'll type it in. You can also take over and sign in yourself.` : `${site} needs an email to sign in for "${d.title}". Send it here (or a code if it sends one), or take over and sign in yourself.`;
      const { liveId } = live.get(id) ?? {};
      await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content: text, cards: JSON.stringify([{ type: "demo_signin", id, title: what === "code" ? `${site} sign-in code` : `Email for ${site}`, subtitle: note.slice(0, 200) }, ...(liveId ? [{ type: "browser_live", id: 0, title: `${emp.name}'s browser`, url: liveId }] : [])]) });
    },
    take: (what) => (what === "code" ? takeCode(codeKey(id)) ?? null : get(orgId, id)?.signInEmail ?? null),
    done: () => {
      const d = get(orgId, id);
      if (d?.asking) update(orgId, id, { asking: null, step: d.status === "planning" ? "Finding how it's done (a practice run)" : "Recording the steps" });
    },
  };
}
const codeKey = (id: number) => `demo-${id}`;
/** The live browser for each video while it runs (for the chat card). */
const live = new Map<number, { liveId: string }>();

/** A sign-in code or the email to sign in with, from the Videos tab or chat, for the run that's waiting. */
export async function signIn(orgId: number, id: number, input: { code?: string | null; email?: string | null }) {
  const d = must(orgId, id);
  if (!input.code?.trim() && !input.email?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the code or the email." });
  if (input.email?.trim()) update(orgId, id, { signInEmail: cleanEmail(input.email) });
  if (input.code?.trim()) putCode(codeKey(id), input.code);
  return get(orgId, id)!;
}
/** The newest video waiting on a sign-in (for a code or email typed in Simone's chat). */
export function waitingSignIn(orgId: number) {
  return list(orgId).find((d) => !!d.asking) ?? null;
}

async function browserTask(orgId: number, d: DemoVideo, emp: AIEmployee, goal: string, record: boolean) {
  const { findLogin, startIn } = await import("./logins");
  const web = await import("./web");
  const login = d.loginName ? findLogin(await db.listPortalLogins(orgId), d.loginName, d.url ?? "") : null;
  const startUrl = fullUrl(d.url) || (login ? startIn(login) : "");
  checkWhere(startUrl, { loginName: login?.name ?? null, email: d.signInEmail });
  const demoSite = vg.appFor(startUrl) === "ehr";
  const teamLink = demoTeamLink(startUrl);
  const task: BrowserTask = {
    orgId,
    employeeId: emp.id,
    actor: `${emp.name}, the owner's ${emp.roleTitle}, recording a ${d.kind === "social" ? "social" : "training"} video`,
    goal,
    startUrl,
    ...(teamLink ? { openUrl: teamLink } : {}),
    ...withEmail(web.loginParts(login, `demo-${d.id}`), login ? null : d.signInEmail),
    ask: signInAsk(orgId, d.id, emp),
    // Pressing a plan's buttons is allowed only in a demo that saves nothing (LeadDash EHR's demo resets).
    allowSubmit: record && demoSite,
    submitWords: web.CHANGE_WORDS,
    neverWords: web.NEVER_WORDS,
    maxSteps: 160,
    record,
    job: null,
    rules: `- This is ${record ? "a recording" : "a practice run"} for a video. Move like a person showing a colleague: no wandering, no extra pages.
- Never type a real person's details, a password into a visible box, or anything private.
- A popup that is not part of the step (a notice, a tip, a message box) is closed first (its Close, Got it, OK or X button, or press_escape) with planStep 0, then the step goes on. A popup the step opens on purpose (a form, a recorder) is finished inside and closed with its own button before the next step.${demoPracticeRule(startUrl)}${demoSite ? demoPopupRule(startUrl) : "\n- If a button you need is refused, the step is shown up to that button: use wait once so the screen is seen, then go on."}`,
  };
  return { task, login };
}

function recordGoal(d: DemoVideo, p: Plan, upTo?: number, from = 0) {
  const steps = p.steps.slice(0, upTo ?? p.steps.length);
  return `Record this video plan. Do the steps in order, one action at a time, and set planStep on every action to the number of the step it belongs to (0 for signing in or getting to the start).
Starts on: ${p.startsOn || "the site's first page after signing in"}
${steps.map((s, i) => `${i + 1}. Do: ${s.do}\n   Then you should see: ${s.expect}`).join("\n")}
${from > 0 ? `Steps 1 to ${from} are recorded already: do them again exactly as written (the site starts over), without pausing, then carry on from step ${from + 1}.\n` : ""}${upTo ? `Stop after step ${upTo}.` : `Done when: ${p.doneWhen}`}
Before each step, check the screen shows what the step before it expects. A small difference is handled and the step goes on: a label worded a little differently, a notice or tip in the way (close it), a section further down than expected (show or scroll to it), a value already filled in (leave it). Use fail only when the step cannot be done on this screen at all, or the screen is a different one from the plan; say exactly what you see. When the last step's result is on screen, use done with result {"answer":"recorded"}.`;
}

/** A recording that stopped (by the person, or a screen that didn't match) with some steps finished: they're kept. */
class StoppedEarly extends Error {
  constructor(public take: Take, public why: string) {
    super(why);
  }
}
/** How many plan steps finished before a run stopped: the last step counts only if its result was on screen for a moment. */
export function stepsDone(res: Pick<BrowserResult, "log" | "frames">, total: number) {
  const acts = res.log.filter((l) => typeof l.at === "number" && (l.plan ?? 0) > 0);
  if (!acts.length || !res.frames?.length) return 0;
  const max = Math.max(...acts.map((a) => a.plan!));
  const last = acts.filter((a) => a.plan === max).sort((a, b) => a.at! - b.at!).pop()!;
  const lastEnd = last.end ?? last.at! + 1;
  const seen = res.frames[res.frames.length - 1].t - lastEnd >= 1;
  return Math.min(total, seen ? max : max - 1);
}

/** The take with steps 1 to `from` kept from before and the rest from the new run. */
const mergeTake = (old: Take, fresh: Take, from: number): Take => ({ ...fresh, steps: [...old.steps.slice(0, from), ...fresh.steps.slice(from)] });
const stoppedMessage = (n: number, total: number, why: string) => `${why.replace(/\.?$/, ".")} Steps 1 to ${n} of ${total} are recorded. Keep going from step ${n + 1}, or stop and build the video from what's recorded.`;

/**
 * Record it: the browser does the plan while the screen is recorded, then the video is made.
 * Keep going (from > 0): steps already recorded are kept; the browser redoes them quickly and
 * records from the next one. A stop with finished steps keeps them and asks what to do next.
 */
export async function record(orgId: number, id: number, by: string, opts: { from?: number } = {}) {
  const d = must(orgId, id);
  idle(d);
  if (d.status === "asking") throw new TRPCError({ code: "BAD_REQUEST", message: "Answer the question first." });
  const p = planOf(d);
  if (!p.steps.length) throw new TRPCError({ code: "BAD_REQUEST", message: "The plan has no steps yet." });
  const have = takeOf(d).steps.length;
  const from = opts.from ? Math.min(opts.from, have, p.steps.length - 1) : 0;
  if (opts.from && from < 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing is recorded yet. Press Record it." });
  const e = estimate(d);
  if (e.minutes > 0) await hours.gate(orgId);
  const started = update(orgId, id, { status: "recording", step: "Signing in", error: null });
  void background(orgId, id, async () => {
    const old = takeOf(get(orgId, id)!);
    try {
      const take = await doRecord(orgId, id, undefined, from);
      // A new recording: every size is cut again from it.
      update(orgId, id, { take: JSON.stringify(from ? mergeTake(old, take, from) : take), videoUrls: "{}" });
    } catch (err) {
      if (!(err instanceof StoppedEarly)) throw err;
      const kept = from ? mergeTake(old, err.take, from) : err.take;
      update(orgId, id, { status: "plan", step: null, take: JSON.stringify(kept), videoUrls: "{}", error: stoppedMessage(kept.steps.length, p.steps.length, err.why) });
      return;
    }
    await make(orgId, id, by);
  }, "plan");
  return started;
}

/** Stop and build: the video is made from the steps recorded so far; the plan is cut to them. */
export async function buildRecorded(orgId: number, id: number, by: string) {
  const d = must(orgId, id);
  idle(d);
  const p = planOf(d);
  const n = takeOf(d).steps.length;
  if (!n) throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing is recorded yet. Press Record it." });
  if (n < p.steps.length) {
    const steps = p.steps.slice(0, n);
    update(orgId, id, { plan: JSON.stringify({ ...p, steps, doneWhen: steps[n - 1].expect }), parts: JSON.stringify(Object.fromEntries(Object.entries(partsOf(d)).filter(([k]) => !/^s\d+$/.test(k) || Number(k.slice(1)) < n))) });
  }
  const started = update(orgId, id, { status: "making", step: "Reading the lines", error: null });
  void background(orgId, id, () => make(orgId, id, by), "plan");
  return started;
}

/** Runs the plan in the browser with the screen recorded; returns each step's clip. */
async function doRecord(orgId: number, id: number, upTo?: number, from = 0): Promise<Take> {
  const d = must(orgId, id);
  const emp = await simone(orgId);
  const p = planOf(d);
  const { task, login } = await browserTask(orgId, d, emp, recordGoal(d, p, upTo, from), true);
  update(orgId, id, { step: "Recording the steps" });
  const res: BrowserResult = await runLive(orgId, d, emp, task, d.title);
  if (login) await (await import("./logins")).keepSession(orgId, login, res.storageState).catch(() => null);
  try {
    if (res.status === "need_code") throw new Error("The site sent a sign-in code and none came in 10 minutes. Press Record it, then paste the code when Simone asks.");
    if (res.status !== "done") {
      const why = `The recording stopped: ${res.note || "the screen didn't match the plan"}`.slice(0, 300);
      // Finished steps are kept (a redo of one step keeps nothing: that step didn't finish).
      const done = upTo ? 0 : stepsDone(res, p.steps.length);
      if (done > 0 && res.frames?.length) {
        update(orgId, id, { step: "Keeping the steps that finished" });
        throw new StoppedEarly(await cutTake(orgId, d, p, res, done), why);
      }
      throw new Error(why);
    }
    if (!res.frames?.length) throw new Error("Nothing was recorded.");
    update(orgId, id, { step: "Cutting each step" });
    return await cutTake(orgId, d, p, res, upTo);
  } finally {
    if (res.recDir) fs.rmSync(res.recDir, { recursive: true, force: true });
  }
}

/** Each step's moments (the waits between actions left out), as its own clip with its clicks and a screenshot. */
async function cutTake(orgId: number, d: DemoVideo, p: Plan, res: BrowserResult, upTo?: number): Promise<Take> {
  const frames = res.frames!;
  const end = frames[frames.length - 1].t + 1;
  const acts = res.log.filter((l) => typeof l.at === "number" && (l.plan ?? 0) > 0);
  const n = upTo ?? p.steps.length;
  const steps: TakeStep[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-take-"));
  try {
    let prevEnd = acts[0]?.at ?? 0;
    for (let i = 1; i <= n; i++) {
      const mine = acts.filter((a) => a.plan === i);
      const windows = mine.length ? mine.map((a) => ({ from: Math.max(0, a.at! - 0.8), to: Math.min(end, (a.end ?? a.at! + 1) + 0.4) })) : [{ from: prevEnd, to: Math.min(end, prevEnd + 2) }];
      // Overlapping moments become one.
      const merged: { from: number; to: number }[] = [];
      for (const w of windows.sort((a, b) => a.from - b.from)) {
        const last = merged[merged.length - 1];
        if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
        else merged.push({ ...w });
      }
      prevEnd = merged[merged.length - 1].to;
      const file = path.join(dir, `step-${i}.mp4`);
      await clipFromFrames(frames, merged, file);
      // Clicks in the clip's own time.
      let offset = 0;
      const clicks: TakeStep["clicks"] = [];
      for (const w of merged) {
        for (const a of mine) if (a.box && a.at! >= w.from && a.at! <= w.to) clicks.push({ at: offset + (a.at! - w.from), ...a.box });
        offset += w.to - w.from;
      }
      const shotFile = path.join(dir, `shot-${i}.jpg`);
      const ff = (await import("./drama")).ffmpegPath();
      await run(ff, ["-y", "-loglevel", "error", "-sseof", "-0.2", "-i", file, "-frames:v", "1", shotFile], { timeout: 60_000 }).catch(() => null);
      const clip = (await storagePut(`org-${orgId}/demo/step.mp4`, fs.readFileSync(file), "video/mp4")).url;
      const shot = fs.existsSync(shotFile) ? (await storagePut(`org-${orgId}/demo/step.jpg`, fs.readFileSync(shotFile), "image/jpeg")).url : null;
      steps.push({ clip, seconds: +offset.toFixed(2), clicks, shot });
    }
    return { steps, screen: { w: res.view?.width ?? 1280, h: res.view?.height ?? 900 }, at: new Date().toISOString() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Redo step: the plan is run again up to that step, and only that step's recording is replaced. */
export async function redoStep(orgId: number, id: number, n: number, by: string) {
  const d = must(orgId, id);
  idle(d);
  const take = takeOf(d);
  if (!take.steps[n]) throw new TRPCError({ code: "NOT_FOUND", message: "That step hasn't been recorded." });
  const started = update(orgId, id, { status: "recording", step: `Recording step ${n + 1} again`, error: null });
  void background(orgId, id, async () => {
    const fresh = await doRecord(orgId, id, n + 1);
    const t = takeOf(get(orgId, id)!);
    t.steps[n] = fresh.steps[n];
    update(orgId, id, { take: JSON.stringify(t) });
    await make(orgId, id, by, { recut: true });
  }, "ready");
  return started;
}

// ==========================================
// 3. Making it
// ==========================================

async function local(url: string, dir: string, name: string) {
  const file = broll.localFile(url);
  if (fs.existsSync(file)) return file;
  const out = path.join(dir, name);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`A file couldn't be read (${res.status}).`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

async function brand(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  const colors = parse<string[]>(org?.brandColors, []).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const logo = org?.logoUrl?.startsWith("/files/") && fs.existsSync(broll.localFile(org.logoUrl)) ? broll.localFile(org.logoUrl) : null;
  return { color: colors[0] ?? "#1B6B4A", logo };
}

/**
 * Makes (or re-cuts) the video: voices and avatar clips for the parts that changed, then every size.
 * Work hours: screen time and avatar time not already used.
 */
export async function make(orgId: number, id: number, by: string, opts: { recut?: boolean } = {}) {
  let d = update(orgId, id, { status: "making", step: "Reading the lines" });
  const emp = await simone(orgId);
  const p = planOf(d);
  const take = { ...takeOf(d) };
  if (!take.steps.length) throw new Error("Record it first.");
  if (take.steps.length !== p.steps.length) take.steps = take.steps.slice(0, p.steps.length);
  const parts = partsOf(d);
  const av = presenters.parsePresenter(d.avatar);
  const avKeys = new Set(avatarKeys(d, p));
  const keys = ["intro", ...p.steps.map((_, i) => `s${i}`), "outro"];
  let avatarSecs = 0;
  // The voice, and the avatar where it's needed, for each part that changed.
  for (const k of keys) {
    const text = lineOf(p, k).trim();
    const prev = parts[k];
    const needAvatar = avKeys.has(k) && !!av && !!text;
    if (text && (!prev || prev.text !== text || prev.voiceId !== d.voiceId)) {
      update(orgId, id, { step: `Reading ${k === "intro" ? "the opening" : k === "outro" ? "the closing" : `step ${Number(k.slice(1)) + 1}`}` });
      const buf = await avatar.speech(orgId, d.voiceId || `${avatar.STANDARD}coral`, text);
      const saved = await storagePut(`org-${orgId}/demo/line.mp3`, buf, "audio/mpeg");
      parts[k] = { text, voiceId: d.voiceId ?? "", voice: saved.url, tenths: avatar.mp3Tenths(buf), avatar: null, avatarFor: null };
    }
    if (!text) delete parts[k];
    if (needAvatar && parts[k] && parts[k].avatarFor !== parts[k].voice) {
      update(orgId, id, { step: `The avatar says ${k === "intro" ? "the opening" : k === "outro" ? "the closing" : `step ${Number(k.slice(1)) + 1}`}` });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-av-"));
      try {
        const out = await presenters.talkClip(orgId, av!, broll.localFile(parts[k].voice), path.join(dir, "av.mp4"), d.kind === "social");
        parts[k].avatar = (await storagePut(`org-${orgId}/demo/avatar.mp4`, fs.readFileSync(out), "video/mp4")).url;
        parts[k].avatarFor = parts[k].voice;
        avatarSecs += parts[k].tenths / 10;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  d = update(orgId, id, { parts: JSON.stringify(parts), take: JSON.stringify(take) });
  const b = await brand(orgId);
  const look = lookOf(d);
  const urls: Partial<Record<Size, string>> = { ...urlsOf(d) };
  let total = 0;
  const sizes = sizesOf(d);
  for (let k = 0; k < sizes.length; k++) {
    const size = sizes[k];
    update(orgId, id, { step: sizes.length > 1 ? `Making ${SIZES[size].ratio} (${k + 1} of ${sizes.length})` : `Making ${SIZES[size].ratio}` });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ld-dv-"));
    try {
      const plan = await planRender(d, size, b, tmp);
      total = plan.total;
      const buf = await renderer(plan.input);
      urls[size] = (await storagePut(`org-${orgId}/demo/${size}.mp4`, buf, "video/mp4")).url;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  // Work hours not already used: screen time once, avatar time for each new clip.
  const owe = Math.max(0, screenMinutes(total) - d.paidMinutes);
  const oweAv = avatarMinutes(avatarSecs);
  if (owe > 0) await chargeNow(orgId, emp, "edit", owe / hours.JOBS.edit.minutes, d.title);
  if (oweAv > 0) await chargeNow(orgId, emp, "video", oweAv / hours.JOBS.video.minutes, `${d.title} (avatar)`);
  d = update(orgId, id, { status: "ready", step: null, error: null, videoUrls: JSON.stringify(urls), videoUrl: urls[sizes[0]] ?? null, tenths: Math.round(total * 10), paidMinutes: d.paidMinutes + owe, paidAvatar: d.paidAvatar + oweAv });
  // The written SOP from the same steps.
  if (d.makeSop && !d.sopId) {
    const sops = await import("./sops");
    const t = takeOf(d);
    const s = sops.create(orgId, { title: d.title, area: "admin", ownerKind: "coo", follows: d.audience, steps: p.steps.map((st, i) => ({ title: st.do, detail: st.say, imageUrl: t.steps[i]?.shot ?? null })) }, by, { kind: "site", note: `From ${emp.name}'s video "${d.title}"`, url: d.url });
    d = update(orgId, id, { sopId: s.id });
  }
  if (!opts.recut) await say(orgId, `"${d.title}" is ready: ${fmt(total)}, ${sizes.map((s) => SIZES[s].ratio).join(" and ")}.${d.sopId && d.makeSop ? " The written SOP is in review on the SOPs tab, with a screenshot under each step." : ""} It's on my Videos tab.`, [{ type: "demo_video", id, title: d.title }]);
}

let renderer: (input: DemoRenderInput) => Promise<Buffer> = renderDemo;
/** Tests swap in their own cut. */
export function setDemoRenderer(fn: ((input: DemoRenderInput) => Promise<Buffer>) | null) {
  renderer = fn ?? renderDemo;
}

/** Everything one size needs. */
export async function planRender(d: DemoVideo, size: Size, b: { color: string; logo: string | null }, tmp: string) {
  const p = planOf(d);
  const take = takeOf(d);
  const parts = partsOf(d);
  const look = lookOf(d);
  const social = d.kind === "social";
  const { w, h } = SIZES[size];
  const out: Part[] = [];
  const file = async (url: string | null | undefined, name: string) => (url ? local(url, tmp, name) : null);
  const card = async (key: "intro" | "outro") => {
    const part = parts[key];
    const avatar = await file(part?.avatar, `${key}.mp4`);
    if (!part && !look.cards) return;
    if (!avatar && !look.cards && !social) {
      if (!part) return;
    }
    out.push({ kind: "card", title: key === "intro" ? d.title : "", sub: key === "intro" ? "" : "", audio: await file(part?.voice, `${key}.mp3`), audioSeconds: (part?.tenths ?? 0) / 10, avatar, text: part?.text ?? "" });
  };
  await card("intro");
  // Social: the bubble is a still of the presenter from the hook.
  let bubble: string | null = null;
  if (social && parts.intro?.avatar) {
    const still = path.join(tmp, "bubble.jpg");
    const ff = (await import("./drama")).ffmpegPath();
    await run(ff, ["-y", "-loglevel", "error", "-ss", "0.5", "-i", await local(parts.intro.avatar, tmp, "hook.mp4"), "-frames:v", "1", still], { timeout: 60_000 }).catch(() => null);
    bubble = fs.existsSync(still) ? still : null;
  }
  for (let i = 0; i < p.steps.length; i++) {
    const st = take.steps[i];
    if (!st) continue;
    const part = parts[`s${i}`];
    out.push({ kind: "step", clip: await local(st.clip, tmp, `step-${i}.mp4`), clipSeconds: st.seconds, clicks: st.clicks.map((c) => ({ ...c })), audio: await file(part?.voice, `s${i}.mp3`), audioSeconds: (part?.tenths ?? 0) / 10, avatar: d.presenter === "corner" && !social ? await file(part?.avatar, `s${i}-av.mp4`) : null, bubble, text: part?.text ?? "" });
  }
  await card("outro");
  const music = look.music.track !== "none" ? await broll.trackFile(look.music.track).catch(() => null) : null;
  const total = out.reduce((n, x) => n + (x.kind === "card" ? cardSeconds(x.audioSeconds, !!x.avatar) : stepTiming(x.clipSeconds, x.audioSeconds).seconds), 0);
  const capLook = editLookOf(null);
  capLook.captions = { on: true, style: social ? "pop" : "boxed", position: social ? "middle" : look.captions.position, highlight: "gold", size: social ? "m" : "s", emojis: false };
  const input: DemoRenderInput = {
    w,
    h,
    screen: take.screen,
    parts: out,
    zoom: look.zoom,
    captions: look.captions.on
      ? (times) => {
          const cut: CutLine[] = times
            .filter((t) => t.text.trim() && t.audioSeconds > 0)
            .map((t, i) => {
              const from = t.from + t.lead;
              const to = from + t.audioSeconds;
              const words = spreadWords(t.text, from, to);
              return { i, from, to, words, line: { from, to, text: t.text, words } };
            });
          return editAss(w, h, cut, capLook, { brand: b.color });
        }
      : null,
    logo: look.logo && b.logo ? { file: b.logo } : null,
    music: music ? { file: music, volume: look.music.volume } : null,
    brand: b.color,
    fontsDir: (await import("./drama")).fontsDir() || undefined,
  };
  return { input, total };
}

// ==========================================
// Edits after it's made (no screen hours)
// ==========================================

/** Edit line: only that part's voice (and avatar, where it has one) is made again, then it's re-cut. */
export function editLine(orgId: number, id: number, key: string, text: string, by: string) {
  const d = must(orgId, id);
  idle(d);
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) throw new TRPCError({ code: "BAD_REQUEST", message: "A line needs words." });
  const p = planOf(d);
  if (key === "intro") p.intro = t.slice(0, 400);
  else if (key === "outro") p.outro = t.slice(0, 400);
  else {
    const n = Number(key.replace(/^s/, ""));
    if (!p.steps[n]) throw new TRPCError({ code: "NOT_FOUND", message: "That step is not in this video." });
    p.steps[n].say = t.slice(0, 400);
  }
  const started = update(orgId, id, { plan: JSON.stringify(p), status: "making", step: "Reading the new line", error: null });
  void background(orgId, id, () => make(orgId, id, by, { recut: true }), "ready");
  return started;
}

export function changeLook(orgId: number, id: number, patch: Partial<DemoLook>, by: string) {
  const d = must(orgId, id);
  idle(d);
  const old = lookOf(d);
  const next: DemoLook = { ...old, ...patch, captions: { ...old.captions, ...(patch.captions ?? {}) }, music: { ...old.music, ...(patch.music ?? {}) } };
  const saved = update(orgId, id, { look: JSON.stringify(next) });
  if (!takeOf(saved).steps.length) return saved;
  const started = update(orgId, id, { status: "making", step: "Making it again", error: null });
  void background(orgId, id, () => make(orgId, id, by, { recut: true }), "ready");
  return started;
}

/** Export: the sizes picked; a new size is cut from what's already made. */
export function setSizes(orgId: number, id: number, sizes: Size[], by: string) {
  const d = must(orgId, id);
  idle(d);
  const picked = Array.from(new Set(sizes)).filter((s) => s in SIZES);
  if (!picked.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one size." });
  const saved = update(orgId, id, { sizes: JSON.stringify(picked) });
  const missing = picked.some((s) => !urlsOf(saved)[s]);
  if (!missing || !takeOf(saved).steps.length) return saved;
  const started = update(orgId, id, { status: "making", step: "Making the new size", error: null });
  void background(orgId, id, () => make(orgId, id, by, { recut: true }), "ready");
  return started;
}

const HOOK_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: ["hooks"], properties: { hooks: { type: "array", items: { type: "string" }, description: "Hooks for the first 3 seconds, said to camera, at most 16 words each, each a different angle." } } };

async function hooks(orgId: number, d: DemoVideo, n: number) {
  const emp = await simone(orgId);
  const { system } = await systemPromptFor(emp, `Write ${n} new hooks for a social video, in this style: ${SOCIAL_HOW[(d.socialStyle as SocialStyle) in SOCIAL_HOW ? (d.socialStyle as SocialStyle) : "come"]}`);
  const out = await generateJson<{ hooks: string[] }>({ system, prompt: `The video shows: ${d.title}.\nThe hook now: ${planOf(d).intro}`, schemaName: "demo_hooks", schema: HOOK_SCHEMA, maxTokens: 800 });
  return (out.hooks ?? []).map((h) => h.trim()).filter(Boolean).slice(0, n);
}

/** New hook: Elena-style, a fresh opening line said by the avatar. */
export async function newHook(orgId: number, id: number, by: string) {
  const d = must(orgId, id);
  idle(d);
  const [hook] = await hooks(orgId, d, 1);
  if (!hook) throw new TRPCError({ code: "BAD_GATEWAY", message: "No new hook came back. Try again." });
  await hours.gate(orgId);
  return editLine(orgId, id, "intro", hook, by);
}

/** 3 versions: two more videos with other hooks, from the same recording. */
export async function versions(orgId: number, id: number, by: string) {
  const d = must(orgId, id);
  idle(d);
  if (d.status !== "ready") throw new TRPCError({ code: "BAD_REQUEST", message: "Make it first." });
  await hours.gate(orgId);
  const hs = await hooks(orgId, d, 2);
  const made: DemoVideo[] = [];
  for (let k = 0; k < hs.length; k++) {
    const hk = hs[k];
    const p = planOf(d);
    p.intro = hk;
    const parts = partsOf(d);
    delete parts.intro;
    const copy = db.getDb().insert(demoVideos).values({ ...d, id: undefined, title: `${d.title} (${k + 2})`, plan: JSON.stringify(p), parts: JSON.stringify(parts), videoUrls: "{}", videoUrl: null, status: "making", step: "Reading the new hook", paidAvatar: 0, paidMinutes: d.paidMinutes, sopId: d.sopId, makeSop: false, createdAt: new Date(), updatedAt: new Date() } as never).returning().get();
    made.push(copy);
    void background(orgId, copy.id, () => make(orgId, copy.id, by, { recut: true }));
  }
  return made;
}

/** Send to Sienna: the video as a draft post with a caption, waiting for approval. */
export async function toSienna(orgId: number, id: number, by: string) {
  const d = must(orgId, id);
  const urls = urlsOf(d);
  const size: Size | undefined = d.kind === "social" ? (urls.vertical ? "vertical" : urls.square ? "square" : urls.wide ? "wide" : undefined) : urls.wide ? "wide" : urls.square ? "square" : urls.vertical ? "vertical" : undefined;
  if (!size || !urls[size]) throw new TRPCError({ code: "BAD_REQUEST", message: "Make the video first." });
  const sienna = await db.getEmployeeByKind(orgId, "social");
  if (!sienna || sienna.status === "paused") throw new TRPCError({ code: "BAD_REQUEST", message: "Sienna isn't on your team. Bring her on from the bench to post videos." });
  const channels = size === "vertical" ? ["instagram", "tiktok", "facebook"] : ["linkedin", "facebook", "instagram"];
  const p = planOf(d);
  const caption = `${p.intro}\n\n${d.title}.`;
  const post = await db.createOutboundItem({
    organizationId: orgId,
    employeeId: sienna.id,
    kind: "social_post",
    status: "pending_approval",
    title: d.title,
    body: caption,
    targetChannels: JSON.stringify(channels),
    metadata: JSON.stringify({ platforms: channels, topic: d.title, headline: d.title, rule: "posts", fromDemo: d.id, post: { type: size === "vertical" ? "reel" : "video", mode: "same", variants: {}, videoUrl: urls[size], videoMeta: { w: SIZES[size].w, h: SIZES[size].h, seconds: Math.round((d.tenths ?? 0) / 10) }, coverUrl: null, coverMs: 1000 } }),
  });
  await db.createChatMessage({ organizationId: orgId, employeeId: sienna.id, role: "employee", authorName: sienna.name, content: `${by} sent me Simone's video "${d.title}". It's in my drafts with a caption. Pick a time and approve it, and I'll post it.` });
  return post;
}

// ==========================================
// What the screens show
// ==========================================

const STATUS: Record<DemoVideo["status"], string> = { planning: "Planning", plan: "Plan ready", asking: "Question", recording: "Recording", making: "Making", ready: "Ready", failed: "Didn't finish" };

export async function view(d: DemoVideo) {
  const p = planOf(d);
  const take = takeOf(d);
  const parts = partsOf(d);
  const e = estimate(d);
  const av = presenters.parsePresenter(d.avatar);
  const where = d.loginName ?? (d.url ? (() => { try { return new URL(d.url!).hostname; } catch { return d.url; } })() : "");
  return {
    id: d.id,
    title: d.title,
    kind: d.kind,
    kindLabel: d.kind === "social" ? "Social video" : "Training video",
    presenter: d.presenter,
    presenterLabel: d.kind === "social" ? SOCIAL_STYLES[(d.socialStyle as SocialStyle) in SOCIAL_STYLES ? (d.socialStyle as SocialStyle) : "come"] : PRESENTER_LABEL[d.presenter],
    avatarLabel: await presenters.label(d.organizationId, av),
    socialStyle: d.socialStyle,
    voiceName: d.voiceName,
    ask: d.ask,
    audience: d.audience,
    where,
    url: d.url,
    status: d.status,
    statusLabel: STATUS[d.status],
    step: d.step,
    error: d.error,
    plan: p,
    take: take.steps.map((s, i) => ({ n: i, shot: s.shot, seconds: s.seconds, clicks: s.clicks.length })),
    /** Steps recorded so far when a recording stopped early (0 when none, or all of them). */
    recordedUpTo: take.steps.length && take.steps.length < p.steps.length ? take.steps.length : 0,
    lines: [
      { key: "intro", label: d.kind === "social" ? "Hook" : "Opening", text: p.intro },
      ...p.steps.map((s, i) => ({ key: `s${i}`, label: String(i + 1), text: s.say, shot: take.steps[i]?.shot ?? null })),
      { key: "outro", label: d.kind === "social" ? "Ending" : "Closing", text: p.outro },
    ],
    look: lookOf(d),
    sizes: sizesOf(d),
    ratios: sizesOf(d).map((s) => SIZES[s].ratio),
    videoUrls: urlsOf(d),
    videoUrl: d.videoUrl,
    length: d.tenths ? fmt(d.tenths / 10) : `About ${fmt(e.seconds)}`,
    hours: e.minutes > 0 ? hoursText(e.minutes) : "No work hours",
    estimateMinutes: e.minutes,
    sopId: d.sopId,
    madeSop: d.makeSop,
    fromSopId: d.fromSopId,
    hasAvatarParts: Object.values(parts).some((x) => !!x.avatar),
    clips: { intro: parts.intro?.avatar ?? null, outro: parts.outro?.avatar ?? null },
    asking: d.asking,
    signInEmail: d.signInEmail,
    liveId: live.get(d.id)?.liveId ?? null,
    avatarLines: avatarKeys(d, p),
    updatedAt: d.updatedAt,
    createdAt: d.createdAt,
  };
}
export type DemoView = Awaited<ReturnType<typeof view>>;

export async function sopVideo(orgId: number, sopId: number) {
  const d = forSop(orgId, sopId).find((x) => x.status === "ready" && x.videoUrl) ?? null;
  return d ? { id: d.id, title: d.title, videoUrl: d.videoUrl, length: d.tenths ? fmt(d.tenths / 10) : null } : null;
}

/** Elena's falKey and Simone's voices are needed; says plainly what isn't set up. */
export function ready() {
  return { browser: true, avatars: Boolean(ENV.falKey) };
}
