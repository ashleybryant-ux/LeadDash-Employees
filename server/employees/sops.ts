import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { SOP_AREAS, SOP_STATUSES, type AIEmployee, type Sop, type SopJob, type SopStep, type WebTask } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import { ENV } from "../_core/env";
import { storagePut } from "../storage";
import { indexKnowledge } from "./kb";
import { rosterEntry } from "./roster";
import { systemPromptFor, working } from "./tasks";
import type { BrowserResult, StepLog } from "./browser";

/**
 * SOPs: how this workspace does things. Simone owns the library and reviews
 * every SOP; the employee closest to the work writes it and keeps it current.
 * Three ways one gets written:
 * - record: the owner records their screen and talks; the narration is
 *   transcribed, a frame is pulled at every change of screen, and the steps
 *   are written from both with a screenshot under each one.
 * - site: an employee walks the screens in its own browser with a saved
 *   Website login, keeps a screenshot after every step, and writes it up.
 * - chat: written from what was said in chat, for procedures not on a screen.
 * A current SOP is carried into the Brain, so every employee follows the
 * workspace's own procedure when it works.
 */

const exec = promisify(execFile);

export type SopArea = (typeof SOP_AREAS)[number];
export type SopStatus = (typeof SOP_STATUSES)[number];

export const AREA_LABELS: Record<SopArea, string> = { front_desk: "Front desk", billing: "Billing", clinical: "Clinical", marketing: "Marketing", admin: "Admin" };
export const STATUS_LABELS: Record<SopStatus, string> = { draft: "Draft", writing: "Writing", review: "In review", current: "Current", retired: "Retired" };

/** The reviewer: Simone when the workspace has her, otherwise the owner reviews. */
export const REVIEWER_KIND = "coo";

// ==========================================
// Reading
// ==========================================

export function stepsOf(s: Pick<Sop, "steps">): SopStep[] {
  try {
    const v = JSON.parse(s.steps);
    return Array.isArray(v) ? v.map((x) => ({ title: String(x?.title ?? ""), detail: String(x?.detail ?? ""), imageUrl: x?.imageUrl ? String(x.imageUrl) : null })) : [];
  } catch {
    return [];
  }
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** A year from a date, as YYYY-MM-DD. */
export function yearAfter(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** MM/DD/YYYY as typed, or YYYY-MM-DD as stored; '' for anything else. */
export function dateIn(s: string) {
  const t = s.trim();
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : "";
}

/** "Review due" when the next review date has passed on a current SOP. */
export function reviewDue(s: Pick<Sop, "status" | "nextReview">) {
  return s.status === "current" && Boolean(s.nextReview) && s.nextReview! < today();
}

export function ownerName(s: Pick<Sop, "ownerKind">) {
  const r = rosterEntry(s.ownerKind as never);
  return r ? r.name : "Simone";
}

export function view(s: Sop) {
  return { ...s, steps: stepsOf(s), ownerName: ownerName(s), areaLabel: AREA_LABELS[s.area], statusLabel: reviewDue(s) ? "Review due" : STATUS_LABELS[s.status], reviewDue: reviewDue(s) };
}

export function listView(orgId: number) {
  const all = db.sops.list(orgId).filter((s) => s.status !== "retired").map(view);
  const counts: Record<string, number> = { all: all.length };
  for (const a of SOP_AREAS) counts[a] = all.filter((s) => s.area === a).length;
  return { sops: all, counts, areas: SOP_AREAS.map((a) => ({ key: a, label: AREA_LABELS[a] })), reviewDue: all.filter((s) => s.reviewDue).length };
}

export function text(s: Sop) {
  const steps = stepsOf(s);
  return [`${s.title}`, s.when ? `When: ${s.when}` : "", s.follows ? `Who follows it: ${s.follows}` : "", "", ...steps.map((st, i) => `${i + 1}. ${st.title}${st.detail ? `\n   ${st.detail}` : ""}`)].filter((l, i) => l !== "" || i === 3).join("\n");
}

// ==========================================
// Writing and versions
// ==========================================

export type SopInput = { title: string; area: SopArea; ownerKind?: string; follows?: string; when?: string; steps: SopStep[]; nextReview?: string };

function clean(input: SopInput) {
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the SOP a title." });
  if (!(SOP_AREAS as readonly string[]).includes(input.area)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick an area." });
  const steps = input.steps.map((st) => ({ title: st.title.trim().slice(0, 240), detail: (st.detail ?? "").trim().slice(0, 2000), imageUrl: st.imageUrl || null })).filter((st) => st.title);
  const nextReview = input.nextReview ? dateIn(input.nextReview) : "";
  if (input.nextReview && !nextReview) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the review date as MM/DD/YYYY." });
  return { title, area: input.area, ownerKind: input.ownerKind || REVIEWER_KIND, follows: (input.follows ?? "").trim().slice(0, 300), when: (input.when ?? "").trim().slice(0, 300), steps, nextReview };
}

function snapshotOf(s: Pick<Sop, "title" | "area" | "ownerKind" | "follows" | "when" | "steps">) {
  return JSON.stringify({ title: s.title, area: s.area, ownerKind: s.ownerKind, follows: s.follows, when: s.when, steps: stepsOf(s) });
}

export function create(orgId: number, input: SopInput, by: string, source: { kind: Sop["sourceKind"]; note?: string; url?: string | null } = { kind: "manual" }) {
  const c = clean(input);
  const s = db.sops.add({ organizationId: orgId, title: c.title, area: c.area, ownerKind: c.ownerKind, follows: c.follows, when: c.when, steps: JSON.stringify(c.steps), status: "draft", version: 1, sourceKind: source.kind, sourceNote: (source.note ?? "").slice(0, 300), sourceUrl: source.url ?? null, nextReview: c.nextReview || null, createdBy: by });
  db.sops.addVersion({ organizationId: orgId, sopId: s.id, version: 1, snapshot: snapshotOf(s), changedBy: by, note: "Created" });
  return s;
}

/** Saves a new version. A current SOP stays current; its Brain entry is refreshed. */
export async function save(orgId: number, id: number, input: SopInput, by: string, note = "") {
  const s = db.sops.get(orgId, id);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "That SOP is not in this workspace." });
  const c = clean(input);
  const next = db.sops.update(id, { title: c.title, area: c.area, ownerKind: c.ownerKind, follows: c.follows, when: c.when, steps: JSON.stringify(c.steps), version: s.version + 1, nextReview: c.nextReview || s.nextReview });
  db.sops.addVersion({ organizationId: orgId, sopId: id, version: next.version, snapshot: snapshotOf(next), changedBy: by, note: note.slice(0, 200) || "Edited" });
  if (next.status === "current") await carryToBrain(next);
  return next;
}

/** draft -> review (sent to Simone), review -> current (approved), current -> review (changes), any -> retired. */
export async function setStatus(orgId: number, id: number, status: "review" | "current" | "draft" | "retired", by: string) {
  const s = db.sops.get(orgId, id);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "That SOP is not in this workspace." });
  if (status === "current" && stepsOf(s).length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "An SOP needs at least one step before it is current." });
  const patch: Parameters<typeof db.sops.update>[1] = { status };
  if (status === "current") {
    patch.reviewedAt = today();
    patch.nextReview = s.nextReview && s.nextReview > today() ? s.nextReview : yearAfter(today());
  }
  const next = db.sops.update(id, patch);
  db.sops.addVersion({ organizationId: orgId, sopId: id, version: next.version, snapshot: snapshotOf(next), changedBy: by, note: status === "current" ? "Approved" : status === "review" ? "Sent for review" : status === "retired" ? "Retired" : "Back to draft" });
  if (status === "current") await carryToBrain(next);
  else await dropFromBrain(next);
  return next;
}

/** Reviewed today: the next review moves a year out. */
export async function markReviewed(orgId: number, id: number, by: string) {
  const s = db.sops.get(orgId, id);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "That SOP is not in this workspace." });
  const next = db.sops.update(id, { reviewedAt: today(), nextReview: yearAfter(today()) });
  db.sops.addVersion({ organizationId: orgId, sopId: id, version: next.version, snapshot: snapshotOf(next), changedBy: by, note: "Reviewed, no changes" });
  return next;
}

export function history(orgId: number, id: number) {
  return db.sops.versions(orgId, id).map((v) => {
    let snap: { title?: string; steps?: SopStep[] } = {};
    try {
      snap = JSON.parse(v.snapshot);
    } catch {
      /* an unreadable snapshot shows as empty */
    }
    return { id: v.id, version: v.version, changedBy: v.changedBy, note: v.note, createdAt: v.createdAt, title: snap.title ?? "", stepCount: Array.isArray(snap.steps) ? snap.steps.length : 0 };
  });
}

export async function remove(orgId: number, id: number) {
  const s = db.sops.get(orgId, id);
  if (!s) return false;
  await dropFromBrain(s);
  db.sops.remove(orgId, id);
  return true;
}

// ==========================================
// The Brain: a current SOP is a procedure every employee follows
// ==========================================

async function carryToBrain(s: Sop) {
  const content = text(s);
  const title = `SOP: ${s.title}`;
  if (s.knowledgeId) {
    const existing = await db.getKnowledgeItem(s.knowledgeId, s.organizationId);
    if (existing) {
      const item = await db.updateKnowledgeItem(existing.id, s.organizationId, { title, content, category: "procedures" });
      if (item) indexKnowledge(item);
      return;
    }
  }
  const item = await db.createKnowledgeItem({ organizationId: s.organizationId, title, category: "procedures", kind: "fact", content });
  indexKnowledge(item);
  db.sops.update(s.id, { knowledgeId: item.id });
}

async function dropFromBrain(s: Sop) {
  if (!s.knowledgeId) return;
  await db.deleteKnowledgeItem(s.knowledgeId, s.organizationId).catch(() => null);
  db.sops.update(s.id, { knowledgeId: null });
}

// ==========================================
// Writing the steps with the AI
// ==========================================

const STEPS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "area", "follows", "when", "steps"],
  properties: {
    title: { type: "string", description: "The SOP's name, as a task: 'Booking a first session'" },
    area: { type: "string", enum: [...SOP_AREAS] },
    follows: { type: "string", description: "Who at the practice follows it, in a few words" },
    when: { type: "string", description: "When it applies, one short sentence" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "at"],
        properties: {
          title: { type: "string", description: "The step as an instruction, one line, starting with a verb" },
          detail: { type: "string", description: "What to watch for or why, one or two sentences; '' when the title says it all" },
          at: { type: "integer", description: "For a recording: the second the step starts; for a site walk: the browser step number; 0 otherwise" },
        },
      },
    },
  },
};
type Written = { title: string; area: SopArea; follows: string; when: string; steps: { title: string; detail: string; at: number }[] };

const RULES = `- Write for a new hire on their first day: plain American English, short sentences, no em dashes, no hype.
- One action per step, starting with a verb. Six to twelve steps is usual; never pad.
- Keep the owner's own wording for names of screens, buttons and people.
- Say what to watch for only when it matters (a rule, a thing that goes wrong, who to tell).
- Never include a password, a code, a client's name or anything from a client's record.`;

async function writeSteps(emp: AIEmployee, about: string, prompt: string, hint: string) {
  const { system } = await systemPromptFor(emp, `Your job: write a standard operating procedure (SOP) for this workspace from the material below.\n${RULES}\n${hint}`, about);
  return generateJson<Written>({ system, prompt, schemaName: "sop_steps", schema: STEPS_SCHEMA, maxTokens: 6000 });
}

function stepsFrom(w: Written, image: (at: number) => string | null): SopStep[] {
  return w.steps.map((st) => ({ title: st.title.trim(), detail: (st.detail ?? "").trim(), imageUrl: image(st.at) })).filter((st) => st.title);
}

export async function reviewer(orgId: number) {
  return (await db.getEmployeeByKind(orgId, REVIEWER_KIND)) ?? null;
}

async function post(emp: AIEmployee, content: string, cards: unknown[] = []) {
  return db.createChatMessage({ organizationId: emp.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content, cards: cards.length ? JSON.stringify(cards) : null });
}

export function card(s: Pick<Sop, "id" | "title">) {
  return { type: "sop" as const, id: s.id, title: s.title };
}

// ==========================================
// From chat: written from what was said
// ==========================================

export async function writeFromChat(emp: AIEmployee, input: { title: string; said: string; area?: string; follows?: string; by: string }) {
  const s = await working(emp, async () => {
    const w = await writeSteps(
      emp,
      input.title,
      `The procedure: ${input.title || "(name it from what was said)"}\n${input.area ? `Area: ${input.area}\n` : ""}${input.follows ? `Who follows it: ${input.follows}\n` : ""}\nWhat the owner said about how it is done, in their words:\n${input.said}`,
      "The material is a conversation. Use only what was said; where a step is missing, write the step the words imply and keep it short. Do not invent screens or buttons that were not mentioned."
    );
    return create(emp.organizationId, { title: input.title || w.title, area: (SOP_AREAS as readonly string[]).includes(input.area ?? "") ? (input.area as SopArea) : w.area, ownerKind: emp.kind, follows: input.follows || w.follows, when: w.when, steps: stepsFrom(w, () => null) }, input.by, { kind: "chat", note: `Written by ${emp.name} from chat` });
  });
  return s;
}

// ==========================================
// From the site: an employee walks the screens in its browser
// ==========================================

export function siteGoal(title: string) {
  return `You are writing a step-by-step SOP titled "${title}" for a new hire, by doing it yourself on this site and keeping a screenshot after every step.
Go through the real screens in the order a person would: open the right section, pick the right items, fill in example values where a form needs them, and stop before anything that saves, sends, submits, publishes or deletes (use done at that point and say what the final button is).
Do not change data. Use done when every screen on the way has been visited, with result as JSON: {"answer":"one paragraph: the screens you went through, in order, with the exact names of sections and buttons, and anything a new hire should watch for","pending":"the final button you stopped before, or ''"}`;
}

export async function startFromSite(emp: AIEmployee, input: { title: string; url?: string; login?: string; by: string }) {
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "What is the SOP for?" });
  const web = await import("./web");
  const { task, login } = await web.startWebTask(emp, { goal: siteGoal(title), url: input.url, login: input.login, title: `SOP: ${title}`, kind: "sop", shots: `org-${emp.organizationId}/sops` });
  const job = db.sops.addJob({ organizationId: emp.organizationId, kind: "site", title, status: "working", stage: `Signing in to ${login ? login.name : "the site"}`, stages: "[]", webTaskId: task.id, createdBy: input.by });
  return { task, login, job };
}

/** Called by web.ts when an SOP walk finishes: the steps are written from the log and screenshots. */
export async function finishFromSite(emp: AIEmployee, t: WebTask, res: BrowserResult) {
  const orgId = emp.organizationId;
  const job = db.sops.jobForWebTask(orgId, t.id);
  if (!job) return null;
  const title = job.title || t.title.replace(/^SOP:\s*/, "");
  const walked = res.log.filter((l) => !["person", "blocked"].includes(l.action));
  if (res.status !== "done" || walked.length === 0) {
    const why = res.status === "need_code" ? "the site asked for a sign-in code first" : res.note || "I could not get through the screens";
    db.sops.updateJob(job.id, { status: "failed", stage: "Stopped", note: why.slice(0, 300) });
    return null;
  }
  db.sops.updateJob(job.id, { stage: "Writing the steps", stages: JSON.stringify(walked.map((l) => ({ label: l.title || l.url, detail: l.detail }))) });
  const sop = await working(emp, async () => {
    const lines = walked.map((l) => `Step ${l.step}: ${l.detail}${l.title ? ` (page: ${l.title})` : ""}${l.screenshotUrl ? " [screenshot]" : ""}`).join("\n");
    const w = await writeSteps(emp, title, `The procedure: ${title}\nSite: ${t.startUrl}\n\nWhat I did in the browser, in order:\n${lines}\n\nWhat I found: ${res.result.slice(0, 3000)}`, "The material is a browser log. Each SOP step should name the screen or button as the log does, and `at` is the browser step number whose screenshot shows that screen (pick the step after the click, where the result is visible).");
    const byStep = new Map(walked.filter((l) => l.screenshotUrl).map((l) => [l.step, l.screenshotUrl!]));
    const image = (at: number) => byStep.get(at) ?? Array.from(byStep.entries()).filter(([k]) => k <= at).pop()?.[1] ?? null;
    return create(orgId, { title, area: w.area, ownerKind: emp.kind, follows: w.follows, when: w.when, steps: stepsFrom(w, image) }, job.createdBy, { kind: "site", note: `${emp.name} walked the screens on ${new Date().toISOString().slice(0, 10)}`, url: t.startUrl });
  });
  db.sops.updateJob(job.id, { status: "done", stage: "Done", sopId: sop.id });
  return sop;
}

// ==========================================
// From a recording: the owner's screen and voice
// ==========================================

function ffmpegPath() {
  try {
    const p = createRequire(import.meta.url)("ffmpeg-static") as string | null;
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* fall back to the system's */
  }
  return "ffmpeg";
}

export type Frame = { at: number; file: string };

/** The moments the screen changed, as PNG frames with their second, at most `max` of them. */
export async function sceneFrames(video: string, dir: string, max = 40): Promise<Frame[]> {
  const pattern = path.join(dir, "frame-%03d.png");
  // showinfo prints each kept frame's time to stderr; scene > 0.2 keeps real screen changes, not cursor moves.
  const { stderr } = await exec(ffmpegPath(), ["-y", "-i", video, "-vf", "select='gt(scene,0.2)',showinfo", "-vsync", "vfr", "-frames:v", String(max), pattern], { maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000 });
  const times = Array.from(String(stderr).matchAll(/pts_time:([\d.]+)/g)).map((m) => Number(m[1]));
  const files = fs.readdirSync(dir).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
  const frames = files.map((f, i) => ({ at: times[i] ?? 0, file: path.join(dir, f) }));
  if (frames.length === 0) {
    // A recording with no cuts: one frame at the start.
    await exec(ffmpegPath(), ["-y", "-i", video, "-frames:v", "1", path.join(dir, "frame-000.png")], { timeout: 60_000 }).catch(() => null);
    const one = path.join(dir, "frame-000.png");
    return fs.existsSync(one) ? [{ at: 0, file: one }] : [];
  }
  return frames;
}

export async function audioOf(video: string, dir: string) {
  const out = path.join(dir, "audio.mp3");
  await exec(ffmpegPath(), ["-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", out], { maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60_000 });
  return out;
}

export function recordingPath(orgId: number) {
  const dir = path.join(path.dirname(path.resolve(ENV.databasePath)), "recordings");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `org-${orgId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`);
}

/** Hooks tests use instead of ffmpeg and AssemblyAI. */
export const tools = {
  frames: sceneFrames,
  audio: audioOf,
  transcribe: async (buf: Buffer) => (await import("../_core/transcribe")).transcribeFile(buf),
};

const active = new Set<number>();
const pending = new Set<Promise<unknown>>();
/** Waits for every background job (tests). */
export async function settled() {
  while (pending.size) await Promise.allSettled(Array.from(pending));
}

export function startFromRecording(orgId: number, input: { title: string; filePath: string; by: string }) {
  const job = db.sops.addJob({ organizationId: orgId, kind: "record", title: input.title.trim().slice(0, 160), status: "queued", stage: "Recording saved", stages: "[]", filePath: input.filePath, createdBy: input.by });
  queueRecording(orgId, job.id);
  return job;
}

/** At start-up: recordings left half done start over; site walks left half done are marked stopped. */
export async function resumeJobs() {
  for (const org of await db.listOrganizations()) {
    for (const j of db.sops.jobs(org.id)) {
      if (j.status !== "queued" && j.status !== "working") continue;
      if (j.kind === "record" && j.filePath && fs.existsSync(j.filePath)) queueRecording(org.id, j.id);
      else db.sops.updateJob(j.id, { status: "failed", stage: "Stopped", note: "The server restarted before this finished. Start it again." });
    }
  }
}

export function queueRecording(orgId: number, id: number) {
  if (active.has(id)) return;
  active.add(id);
  const p = runRecording(orgId, id)
    .catch((err) => {
      console.error(`[sops] recording job ${id} failed:`, err instanceof Error ? err.message : err);
      db.sops.updateJob(id, { status: "failed", stage: "Stopped", note: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    })
    .finally(() => {
      active.delete(id);
      pending.delete(p);
    });
  pending.add(p);
}

function stage(job: SopJob, label: string, detail = "") {
  let stages: { label: string; detail: string }[] = [];
  try {
    stages = JSON.parse(job.stages);
  } catch {
    /* start over */
  }
  stages.push({ label, detail });
  return db.sops.updateJob(job.id, { status: "working", stage: label, stages: JSON.stringify(stages) });
}

async function runRecording(orgId: number, id: number) {
  let job = db.sops.job(orgId, id);
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) throw new Error("The recording was not found on the server.");
  const filePath = job.filePath;
  const emp = (await reviewer(orgId)) ?? (await db.getEmployeeByKind(orgId, "projects"));
  if (!emp) throw new Error("No employee can write SOPs in this workspace yet.");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sop-"));
  try {
    const video = fs.readFileSync(filePath);
    const saved = await storagePut(`org-${orgId}/sops/recording-${id}.webm`, video, "video/webm");
    job = stage(job, "Recording saved", `${Math.round(video.length / 1_000_000)} MB`);
    db.sops.updateJob(id, { fileUrl: saved.url });

    const audio = await tools.audio(filePath, tmp);
    const transcript = await tools.transcribe(fs.readFileSync(audio));
    job = stage(job, "Your words transcribed", `${transcript.text.split(/\s+/).filter(Boolean).length} words`);
    db.sops.updateJob(id, { seconds: Math.round(transcript.seconds) });

    const frames = await tools.frames(filePath, tmp);
    const shots: { at: number; url: string }[] = [];
    for (const f of frames) {
      const put = await storagePut(`org-${orgId}/sops/recording-${id}-${String(Math.round(f.at)).padStart(4, "0")}.png`, fs.readFileSync(f.file), "image/png");
      shots.push({ at: f.at, url: put.url });
    }
    job = stage(job, `${shots.length} screen${shots.length === 1 ? "" : "s"} found`);

    job = stage(job, "Writing the steps");
    const sop = await working(emp, async () => {
      const said = transcript.words.length
        ? groupWords(transcript.words)
        : transcript.text || "(Nothing was said on the recording.)";
      const w = await writeSteps(
        emp,
        job!.title,
        `The procedure: ${job!.title || "(name it from the recording)"}\nRecording length: ${Math.round(transcript.seconds)} seconds. The screen changed at these seconds: ${shots.map((s) => Math.round(s.at)).join(", ") || "none found"}.\n\nWhat the owner said while doing it, with the second each line starts:\n${said}`,
        "The material is the narration of a screen recording. `at` is the second the step starts, taken from the line that describes it; the screenshot nearest after that second goes under the step."
      );
      const image = (at: number) => {
        if (!shots.length) return null;
        const after = shots.filter((s) => s.at >= at - 1).sort((a, b) => a.at - b.at)[0];
        return (after ?? shots[shots.length - 1]).url;
      };
      return create(orgId, { title: job!.title || w.title, area: w.area, ownerKind: emp.kind, follows: w.follows, when: w.when, steps: stepsFrom(w, image) }, job!.createdBy, { kind: "record", note: `Screen recording by ${job!.createdBy || "the owner"}, ${mmss(transcript.seconds)}, ${today()}`, url: saved.url });
    });
    db.sops.updateJob(id, { status: "done", stage: "Done", sopId: sop.id });
    await post(emp, `Your recording for "${sop.title}" is written up: ${stepsOf(sop).length} steps with a screenshot under each one. Open it on the SOPs tab, fix anything I misheard, then send it to me for review.`, [card(sop)]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(filePath, { force: true });
  }
}

/** The transcript as lines of about a sentence, each with the second it starts. */
export function groupWords(words: { text: string; start: number; end: number }[]) {
  const lines: string[] = [];
  let cur: string[] = [];
  let start = 0;
  for (const w of words) {
    if (cur.length === 0) start = w.start;
    cur.push(w.text);
    if (/[.!?]$/.test(w.text) || cur.length >= 28) {
      lines.push(`[${Math.round(start)}s] ${cur.join(" ")}`);
      cur = [];
    }
  }
  if (cur.length) lines.push(`[${Math.round(start)}s] ${cur.join(" ")}`);
  return lines.join("\n");
}

export function mmss(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function jobView(j: SopJob) {
  let stages: { label: string; detail: string }[] = [];
  try {
    stages = JSON.parse(j.stages);
  } catch {
    /* none */
  }
  return { ...j, stages, length: j.seconds ? mmss(j.seconds) : null };
}

/** A starter set for a new workspace: titles only, as drafts the owner fills by recording or asking an employee. */
export const STARTERS: Record<"healthcare" | "business", { title: string; area: SopArea; ownerKind: string }[]> = {
  healthcare: [
    { title: "Booking a first session", area: "front_desk", ownerKind: "leads" },
    { title: "Sending paperwork and chasing it", area: "front_desk", ownerKind: "leads" },
    { title: "Checking in a client and collecting a copay", area: "front_desk", ownerKind: "inbox" },
    { title: "Handling a crisis call", area: "front_desk", ownerKind: "coo" },
    { title: "Working a denial", area: "billing", ownerKind: "coo" },
    { title: "Posting a client payment", area: "billing", ownerKind: "coo" },
    { title: "Signing notes on time", area: "clinical", ownerKind: "coo" },
    { title: "Adding a clinician's availability", area: "admin", ownerKind: "platform" },
  ],
  business: [
    { title: "Answering a new lead", area: "front_desk", ownerKind: "leads" },
    { title: "Approving the week's posts", area: "marketing", ownerKind: "social" },
    { title: "Onboarding a new customer", area: "admin", ownerKind: "onboarding" },
    { title: "Month-end close", area: "billing", ownerKind: "coo" },
  ],
};
