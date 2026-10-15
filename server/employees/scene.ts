import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as hours from "../workHours";
import * as avatar from "./avatar";
import { teamPortrait } from "./campaign";
import { ROSTER } from "./roster";
import * as drama from "./drama";
import * as styles from "./styles";
import type { DramaEpisode } from "../../drizzle/schema";

/**
 * Scenes (2026-10-13): a short film where the characters talk to each other, lip synced,
 * from the Make a video card. Real people (cinematic) or drawn in a style (3D animation,
 * claymation and the rest). It is made by Elena's drama studio, so it gets the same
 * pictures-first approval, animation and lip sync, with its own cast instead of the series cast.
 *
 * 1. Write: what happens, the style, and whether the owner plays herself. Elena writes the
 *    cast (each with a voice) and the shots, one line at most per shot.
 * 2. The pictures are made right away; she can change a shot, redo a picture, change the cast.
 * 3. Make the scene: each shot is animated and every line is lip synced, then it's cut.
 */

type Written = {
  title: string;
  logline: string;
  music: string;
  cast: { name: string; role: string; look: string; owner: boolean; gender: string }[];
  shots: { scene: number; flow: "cut" | "continue"; framing: string; move: string; action: string; setting: string; cast: string[]; line_who: string; line_text: string; seconds: number; sound: string }[];
};

const str = { type: "string" } as const;
const SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "logline", "music", "cast", "shots"],
  properties: {
    title: str,
    logline: str,
    music: { type: "string", description: "One music cue: mood, tempo and where it builds or drops out." },
    cast: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "role", "look", "owner", "gender"], properties: { name: str, role: str, look: { type: "string", description: "Age, hair, skin, clothes: enough to draw them the same every time." }, owner: { type: "boolean", description: "True only for the owner playing herself." }, gender: { type: "string", enum: ["female", "male", "other"] } } },
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scene", "flow", "framing", "move", "action", "setting", "cast", "line_who", "line_text", "seconds", "sound"],
        properties: {
          scene: { type: "integer" },
          flow: { type: "string", enum: ["cut", "continue"] },
          framing: str,
          move: str,
          action: { type: "string", description: "What we see happen in this shot, naming the people in it." },
          setting: str,
          cast: { type: "array", items: str },
          line_who: { type: "string", description: "Who speaks in this shot, '' when nobody does." },
          line_text: { type: "string", description: "Their line, 6 to 20 words, answering the line before it; '' when nobody speaks." },
          seconds: { type: "integer" },
          sound: str,
        },
      },
    },
  },
};

async function elena(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "video");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Elena isn't on this team." });
  return emp;
}

function mustScene(orgId: number, id: number) {
  const ep = db.getDramaEpisode(id, orgId);
  if (!ep || ep.kind !== "scene") throw new TRPCError({ code: "NOT_FOUND", message: "That scene isn't in this workspace." });
  return ep;
}
function notBusy(ep: DramaEpisode) {
  if (ep.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this step finishes." });
}

/** The style key a scene is made in: "real" (cinematic, real people) or a drawn style in this workspace. */
function cleanStyle(orgId: number, style: string | null | undefined) {
  const key = (style || "real").trim();
  if (key === "real") return "real";
  if (!styles.isDrawn(key) || styles.resolve(orgId, key).key === "real") throw new TRPCError({ code: "BAD_REQUEST", message: "That style isn't in this workspace. Pick another." });
  return key;
}

/**
 * The voice an AI team member speaks with in a scene: the voice they use in huddles when a video
 * can read it aloud (a standard voice, or ElevenLabs when this workspace has it), else a stock voice.
 */
async function teamVoice(orgId: number, kind: string, look: string, taken: string[] = []) {
  const huddle = await import("./huddle");
  const v = await huddle.voiceFor(orgId, kind).catch(() => null);
  const own = v?.id && v.provider === "openai" ? { id: `${avatar.STANDARD}${v.id}`, name: v.name } : v?.id && v.provider === "elevenlabs" && (await avatar.hasElevenLabs(orgId)) ? { id: v.id, name: v.name } : null;
  // Two team members can share a default huddle voice; in one scene the second gets a free one instead.
  if (own && !taken.includes(own.id)) return own;
  return drama.stockVoiceFor(orgId, look, taken);
}

/**
 * The AI team members who can play themselves in a scene. LeadDash's own workspaces can show anyone
 * on the roster (a marketing video for practices needs Harper even where billing isn't on the team);
 * a customer's workspace shows its own team.
 */
async function castableTeam(orgId: number, internal: boolean) {
  if (!internal) return (await db.listEmployeesByOrg(orgId)).filter((e) => e.kind !== "custom" && e.name.trim()).map((e) => ({ kind: e.kind as string, name: e.name.trim(), roleTitle: e.roleTitle, avatar: e.avatar ?? null }));
  const rows = await db.listAllEmployeesByOrg(orgId);
  return ROSTER.map((r) => {
    const row = rows.find((e) => e.kind === r.kind);
    return { kind: r.kind as string, name: (row?.name || r.name).trim(), roleTitle: row?.roleTitle || r.roleTitle, avatar: row?.avatar ?? null };
  });
}

/** Writes (or rewrites) the scene: its cast with voices, and the shots with who says what. */
async function write(orgId: number, input: { what: string; style: string; me: boolean; seconds: number; current?: DramaEpisode; change?: string }) {
  const emp = await elena(orgId);
  const org = await db.getOrganizationById(orgId);
  const ownerName = (org?.signerName || "").trim() || "the owner";
  const drawn = input.style !== "real" ? styles.resolve(orgId, input.style).label : null;
  const shotsWanted = input.seconds <= 20 ? "3 to 5" : input.seconds <= 40 ? "5 to 8" : "8 to 12";
  // The AI team can play themselves, with their own portraits and voices.
  const team = await castableTeam(orgId, Boolean(org?.internal));
  const sys = await (await import("./tasks")).systemPromptAbout(emp, input.what, `You are ${emp.name}, the owner's video producer. You write short cinematic scenes where the characters talk to each other.\n${drama.STYLE}`);
  const current = input.current
    ? `\nThe scene so far: ${input.current.title}. ${input.current.logline}\n${drama.shotsOf(input.current).map((s) => `${s.n}. ${s.action}${s.line ? ` ${s.line.who}: "${s.line.text}"` : ""}`).join("\n")}\nChange: ${input.change || "write it again"}. Keep what wasn't asked to change.`
    : "";
  const out = await generateJson<Written>({
    system: sys.system,
    prompt: `Write one scene of about ${input.seconds} seconds: ${input.what}
${drawn ? `It is drawn in ${drawn}, not filmed: describe each person so an artist draws them the same every time.` : "It is shot with real-looking people, in whatever genre and tone she asked for (a trailer, an ad, a drama, a comedy)."}
What she asked for decides the shape: the places, the pace, how it opens and how it ends. Give it the shape that kind of piece really has.
- About ${shotsWanted} shots, 3 to 7 seconds each, in as many places as the piece needs.
- When people talk, write their conversation first, the way people really talk: each line answers the line before it, plain words and contractions. Then cut it into shots: a shot carries at most one line, by someone in that shot, lip synced to their face. Shots with no line are fine wherever the picture says it better. There is no narrator or voice-over track.
- ${input.me ? `The owner is not the lead: the lead is one of the AI team or someone outside the business. The owner plays herself in a supporting part: a character named ${ownerName} (mark owner true) who speaks a few of the lines. ` : "Nobody plays the owner (owner false). "}As many characters as the piece needs, up to six, never a real client.
- The AI team members can play themselves, shown as people with their own faces and voices: ${team.map((e) => `${e.name} (${e.roleTitle})`).join(", ") || "none"}. Anyone who works for the business on screen is one of them, by these exact names, in the role they really have; never make up a coworker, assistant or staff member. Have them hand work to each other in their lines. Only people outside the business (a client, a caller) are made up, with plain names.
- Every shot lists the people in it by name in cast, spelled exactly as in the cast list.${current}`,
    schemaName: "scene",
    schema: SCHEMA,
    maxTokens: 6000,
    timeoutMs: 180_000,
  });
  const ownVoice = input.me ? avatar.settingsOf(emp) : null;
  const cast: drama.SceneCast[] = [];
  for (const c of (out.cast ?? []).slice(0, 6)) {
    const name = c.name.trim().slice(0, 60);
    if (!name || cast.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const owner = Boolean(input.me && c.owner) && !cast.some((x) => x.owner);
    const kept = input.current ? drama.scenePlanOf(input.current).sceneCast?.find((x) => x.name.toLowerCase() === name.toLowerCase()) : null;
    const member = owner ? null : team.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (member) {
      // An AI team member plays themselves: their portrait and voice, not a made-up face.
      if (kept?.team === member.kind) {
        cast.push(kept);
        continue;
      }
      const voice = await teamVoice(orgId, member.kind, `${c.gender === "female" ? "woman" : c.gender === "male" ? "man" : ""} ${c.look}`, cast.map((x) => x.voiceId).filter((x): x is string => !!x));
      cast.push({ name: member.name.slice(0, 60), role: (member.roleTitle || c.role).trim().slice(0, 80), look: c.look.trim().slice(0, 500), owner: false, team: member.kind, voiceId: voice?.id ?? null, voiceName: voice?.name ?? null, portrait: teamPortrait(member.kind, member.avatar ?? null) });
      continue;
    }
    if (kept && kept.look === c.look.trim().slice(0, 500)) {
      cast.push(kept);
      continue;
    }
    // Each made-up person gets a voice nobody else in this scene has.
    const voice = owner ? (ownVoice?.voiceId ? { id: ownVoice.voiceId, name: ownVoice.voiceName ?? "Your voice" } : null) : await drama.stockVoiceFor(orgId, `${c.gender === "female" ? "woman" : c.gender === "male" ? "man" : ""} ${c.look}`, cast.map((x) => x.voiceId).filter((x): x is string => !!x));
    cast.push({ name, role: c.role.trim().slice(0, 80), look: c.look.trim().slice(0, 500), owner, voiceId: voice?.id ?? null, voiceName: voice?.name ?? null, portrait: null });
  }
  if (!cast.length) throw new Error("I couldn't write the cast. Tell me a little more about who is in it.");
  const names = new Set(cast.map((c) => c.name.toLowerCase()));
  const shots: drama.Shot[] = (out.shots ?? []).slice(0, 12).map((x, i) => {
    const inShot = Array.from(new Set((x.cast ?? []).map((n) => n.trim()).filter((n) => names.has(n.toLowerCase())))).slice(0, 3);
    const who = cast.find((c) => c.name.toLowerCase() === (x.line_who || "").trim().toLowerCase())?.name ?? null;
    const line = who && x.line_text?.trim() ? { who, text: x.line_text.trim().slice(0, 200) } : null;
    return {
      n: i + 1,
      framing: x.framing.slice(0, 80),
      move: x.move.slice(0, 120),
      action: x.action.slice(0, 600),
      setting: x.setting.slice(0, 300),
      cast: line && !inShot.includes(line.who) ? [...inShot, line.who].slice(0, 3) : inShot,
      line,
      seconds: Math.max(3, Math.min(7, Math.round(x.seconds || 5))),
      sound: (x.sound ?? "").slice(0, 200),
      scene: Math.max(1, Math.round(x.scene || 1)),
      flow: x.flow === "continue" ? ("continue" as const) : ("cut" as const),
      status: "todo" as const,
    };
  });
  shots.forEach((sh, i) => {
    if (i === shots.length - 1 || shots[i + 1].scene !== sh.scene) sh.flow = "cut";
  });
  if (!shots.length) throw new Error("I couldn't write the shots. Tell me a little more about what happens.");
  // Read the conversation start to finish and smooth any line that doesn't follow the one before it.
  await drama.polishLines(sys.system, out.title || "Scene", shots, cast).catch((err) => console.warn("[scene] dialogue pass skipped:", err instanceof Error ? err.message : err));
  return { title: (out.title || "Scene").trim().slice(0, 120), logline: (out.logline || "").trim().slice(0, 400), music: (out.music || "").slice(0, 500), cast, shots };
}

/** Elena writes the scene and starts drawing its pictures. */
export async function writeScene(orgId: number, input: { what: string; style?: string | null; me?: boolean; seconds?: number }) {
  const what = input.what.trim().slice(0, 2000);
  if (!what) throw new TRPCError({ code: "BAD_REQUEST", message: "Say what happens in the scene." });
  if (hours.meteredSync(orgId)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Scenes with talking characters aren't part of work-hour plans yet." });
  const style = cleanStyle(orgId, input.style);
  const me = Boolean(input.me);
  const seconds = Math.max(10, Math.min(60, Math.round(input.seconds || 30)));
  const w = await write(orgId, { what, style, me, seconds });
  const ep = db.createDramaEpisode({
    organizationId: orgId,
    number: 0,
    kind: "scene",
    title: w.title,
    logline: w.logline,
    music: w.music,
    shots: JSON.stringify(w.shots),
    plan: JSON.stringify({ approved: false, style, what, me, sceneCast: w.cast } satisfies drama.ScenePlan),
    costCents: drama.estimateEpisode(w.shots),
  });
  return startPictures(orgId, ep.id);
}

/** Makes the pictures that are missing (the studio stops for approval once they're all made). */
async function startPictures(orgId: number, id: number) {
  try {
    return await drama.startEpisode(orgId, id);
  } catch (err) {
    // Written but not drawn (no photos of her yet, the monthly limit): the error shows on the card.
    db.updateDramaEpisode(id, orgId, { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 400), progress: null });
    return db.getDramaEpisode(id, orgId)!;
  }
}

/** Rewrite the whole scene with a change; pictures of what changed are made again. */
export async function rewriteScene(orgId: number, id: number, change: string) {
  const ep = mustScene(orgId, id);
  notBusy(ep);
  const p = drama.scenePlanOf(ep);
  const w = await write(orgId, { what: p.what ?? ep.logline, style: p.style ?? "real", me: Boolean(p.me), seconds: drama.shotsOf(ep).reduce((t, s) => t + s.seconds, 0) || 30, current: ep, change });
  db.updateDramaEpisode(id, orgId, { title: w.title, logline: w.logline, music: w.music, shots: JSON.stringify(w.shots), plan: JSON.stringify({ ...p, approved: false, sceneCast: w.cast }), costCents: drama.estimateEpisode(w.shots), status: "script", videoUrl: null, error: null, progress: null });
  return startPictures(orgId, id);
}

/** One shot: who speaks, the line, and what we see. A new "what we see" means a new picture. */
export async function saveShot(orgId: number, id: number, n: number, input: { who: string | null; line: string; see: string }) {
  const ep = mustScene(orgId, id);
  notBusy(ep);
  const cast = drama.scenePlanOf(ep).sceneCast ?? [];
  const shots = drama.shotsOf(ep);
  const s = shots.find((x) => x.n === n);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "That shot isn't in this scene." });
  const who = input.who ? cast.find((c) => c.name.toLowerCase() === input.who!.toLowerCase())?.name ?? null : null;
  if (input.who && !who) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick someone in the cast." });
  const text = input.line.trim().slice(0, 140);
  const line = who && text ? { who, text } : null;
  const see = input.see.trim().slice(0, 600) || s.action;
  const newPicture = see !== s.action || (line && !s.cast.includes(line.who));
  const lineChanged = JSON.stringify(line) !== JSON.stringify(s.line);
  s.action = see;
  s.line = line;
  if (line && !s.cast.includes(line.who)) s.cast = [...s.cast, line.who].slice(0, 3);
  if (newPicture) Object.assign(s, { stillUrl: null, clipUrl: null, rawClipUrl: null, lineUrl: null, status: "todo", costCents: 0 });
  else if (lineChanged) Object.assign(s, { clipUrl: null, rawClipUrl: null, lineUrl: null, status: "todo" });
  db.updateDramaEpisode(id, orgId, { shots: JSON.stringify(shots), costCents: drama.estimateEpisode(shots), ...(newPicture || lineChanged ? { videoUrl: null } : {}) });
  return newPicture ? startPictures(orgId, id) : db.getDramaEpisode(id, orgId)!;
}

/** One person in the cast: name, look and voice. A new look means their portrait and their shots are drawn again. */
export async function saveCast(orgId: number, id: number, index: number, input: { name: string; look: string; voiceId: string | null; voiceName: string | null }) {
  const ep = mustScene(orgId, id);
  notBusy(ep);
  const p = drama.scenePlanOf(ep);
  const list = [...(p.sceneCast ?? [])];
  const c = list[index];
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That person isn't in this scene." });
  // A team member keeps their own name.
  const name = c.team ? c.name : input.name.trim().slice(0, 60) || c.name;
  if (list.some((x, i) => i !== index && x.name.toLowerCase() === name.toLowerCase())) throw new TRPCError({ code: "BAD_REQUEST", message: "Someone in the cast already has that name." });
  const look = input.look.trim().slice(0, 500) || c.look;
  // The owner's face comes from her photos and a team member's from their portrait, so only a made-up look redraws.
  const lookChanged = !c.owner && !c.team && look !== c.look;
  list[index] = { ...c, name, look, voiceId: input.voiceId, voiceName: input.voiceName, ...(lookChanged ? { portrait: null } : {}) };
  const shots = drama.shotsOf(ep).map((s) => {
    const inIt = s.cast.some((x) => x.toLowerCase() === c.name.toLowerCase());
    const next = { ...s, cast: s.cast.map((x) => (x.toLowerCase() === c.name.toLowerCase() ? name : x)), line: s.line && s.line.who.toLowerCase() === c.name.toLowerCase() ? { ...s.line, who: name } : s.line };
    if (inIt && lookChanged) return { ...next, stillUrl: null, clipUrl: null, rawClipUrl: null, lineUrl: null, status: "todo" as const, costCents: 0 };
    if (s.line?.who.toLowerCase() === c.name.toLowerCase() && input.voiceId !== c.voiceId) return { ...next, clipUrl: null, rawClipUrl: null, lineUrl: null, status: "todo" as const };
    return next;
  });
  db.updateDramaEpisode(id, orgId, { plan: JSON.stringify({ ...p, sceneCast: list, approved: false }), shots: JSON.stringify(shots), videoUrl: null });
  return lookChanged ? startPictures(orgId, id) : db.getDramaEpisode(id, orgId)!;
}

/** Change style: the cast and every picture are made again in the new look. */
export async function setStyle(orgId: number, id: number, style: string) {
  const ep = mustScene(orgId, id);
  notBusy(ep);
  const key = cleanStyle(orgId, style);
  const p = drama.scenePlanOf(ep);
  if ((p.style ?? "real") === key) return ep;
  const shots = drama.shotsOf(ep).map((s) => ({ ...s, stillUrl: null, clipUrl: null, rawClipUrl: null, status: "todo" as const, costCents: 0 }));
  db.updateDramaEpisode(id, orgId, { plan: JSON.stringify({ ...p, style: key, approved: false, sceneCast: (p.sceneCast ?? []).map((c) => (c.team ? c : { ...c, portrait: null })) }), shots: JSON.stringify(shots), status: "script", videoUrl: null, costCents: drama.estimateEpisode(shots) });
  return startPictures(orgId, id);
}

/** Make the scene: every shot is animated, each line lip synced, then it's cut. */
export async function makeScene(orgId: number, id: number) {
  const ep = mustScene(orgId, id);
  if (ep.status === "making") return ep;
  if (drama.shotsOf(ep).some((s) => !s.stillUrl)) {
    if (ep.status === "failed") return drama.startEpisode(orgId, id);
    throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until every picture is made." });
  }
  if (ep.status === "keyframes") return drama.approveKeyframes(orgId, id);
  db.updateDramaEpisode(id, orgId, { plan: JSON.stringify({ ...drama.scenePlanOf(ep), approved: true }) });
  return drama.startEpisode(orgId, id);
}

/** Redo one picture (and the shot made from it). */
export async function redoPicture(orgId: number, id: number, n: number) {
  mustScene(orgId, id);
  return drama.remakeShot(orgId, id, n);
}

export function remove(orgId: number, id: number) {
  const ep = mustScene(orgId, id);
  notBusy(ep);
  db.updateDramaEpisode(id, orgId, { plan: JSON.stringify({ ...drama.scenePlanOf(ep), hidden: true }) });
}

/** The workspace's scenes, newest first, for Elena's Videos tab. */
export function list(orgId: number) {
  return db
    .listDramaEpisodes(orgId)
    .filter((e) => e.kind === "scene" && !drama.scenePlanOf(e).hidden)
    .sort((a, b) => b.id - a.id);
}

export const view = (e: DramaEpisode) => drama.episodeView(e);
