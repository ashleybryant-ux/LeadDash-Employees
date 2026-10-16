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
import { readScript, scriptSeconds, secondsFor, splitLine, type ScriptLine } from "@shared/script";

/** The most shots a Scene holds: a long script runs a few minutes, about 7 seconds a shot. */
export const MAX_SHOTS = 40;
/** The most reference pictures a Scene takes. */
export const MAX_REFS = 6;

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
  look: string;
  music: string;
  cast: { name: string; role: string; look: string; owner: boolean; gender: string; picture: number }[];
  shots: { scene: number; flow: "cut" | "continue"; framing: string; move: string; action: string; setting: string; cast: string[]; line_who: string; line_text: string; script_line: number; pictures: number[]; seconds: number; sound: string }[];
};

const str = { type: "string" } as const;
const SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "logline", "look", "music", "cast", "shots"],
  properties: {
    title: str,
    logline: str,
    look: { type: "string", description: "The look of this piece in one or two sentences, from what she asked for and the kind of piece it is: the light, the color, the lens, the energy. Every picture is drawn to it." },
    music: { type: "string", description: "One music cue: mood, tempo and where it builds or drops out." },
    cast: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "role", "look", "owner", "gender", "picture"], properties: { name: str, role: str, look: { type: "string", description: "Age, hair, skin, clothes: enough to draw them the same every time." }, owner: { type: "boolean", description: "True only for the owner playing herself." }, gender: { type: "string", enum: ["female", "male", "other"] }, picture: { type: "integer", description: "The number of her reference picture that shows this person, 0 when none does." } } },
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scene", "flow", "framing", "move", "action", "setting", "cast", "line_who", "line_text", "script_line", "pictures", "seconds", "sound"],
        properties: {
          scene: { type: "integer" },
          flow: { type: "string", enum: ["cut", "continue"] },
          framing: str,
          move: str,
          action: { type: "string", description: "What we see happen in this shot, naming the people in it." },
          setting: str,
          cast: { type: "array", items: str },
          line_who: { type: "string", description: "Who speaks in this shot, '' when nobody does." },
          line_text: { type: "string", description: "Their line, answering the line before it; '' when nobody speaks. From her script, her exact words." },
          script_line: { type: "integer", description: "The number of the script line this shot carries, 0 when there is no script or no line in this shot." },
          pictures: { type: "array", items: { type: "integer" }, description: "The numbers of her reference pictures this shot uses (a place, a product, a feel), [] for none. A person's picture goes on the cast, not here." },
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

/** The cast name a script speaker is: the same name, or the cast member whose name holds it ("Cohen" is "Dr. Rachel Cohen"). */
export function castNameFor(who: string, names: string[]) {
  const w = who.trim().toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === w);
  if (exact) return exact;
  const words = w.replace(/^(dr|mr|mrs|ms|miss)\.?\s+/, "").split(/\s+/).filter(Boolean);
  return names.find((n) => { const has = n.toLowerCase().split(/[\s.]+/); return words.length > 0 && words.every((x) => has.includes(x)); }) ?? null;
}

/**
 * Her script, word for word, on the shots (2026-10-16). Each script line goes on the shots the writer
 * marked with its number, cut across them at sentence ends; a line nobody marked gets a shot of its
 * own after the line before it; a part too long for one clip gets another shot of the same speaker
 * that carries straight on. Shots with no line stay where the writer put them, and the talking shots
 * keep the script's order.
 */
export function fitScript(written: { shot: drama.Shot; ref: number }[], script: ScriptLine[], names: string[]): drama.Shot[] {
  const speaker = (i: number) => castNameFor(script[i].who, names) ?? script[i].who;
  // Groups: a talking shot and the silent shots after it. Silent shots before the first line lead.
  type Group = { line: number; at: number; shots: { shot: drama.Shot; ref: number }[] };
  const lead: { shot: drama.Shot; ref: number }[] = [];
  const groups: Group[] = [];
  written.forEach((w, at) => {
    const ref = w.ref >= 1 && w.ref <= script.length ? w.ref : 0;
    if (ref) groups.push({ line: ref, at, shots: [{ ...w, ref }] });
    else if (groups.length) groups[groups.length - 1].shots.push({ ...w, ref: 0 });
    else lead.push({ ...w, ref: 0 });
  });
  // A script line the writer left out gets its own shot, in the place it was written.
  const template = written[0]?.shot;
  for (let i = 1; i <= script.length; i++) {
    if (groups.some((g) => g.line === i)) continue;
    const before = groups.filter((g) => g.line < i).sort((x, y) => y.line - x.line)[0];
    const like = before?.shots[0].shot ?? template;
    const who = speaker(i - 1);
    const shot: drama.Shot = { n: 0, framing: "Medium", move: "Slow push in", action: `${who} speaks${script[i - 1].note ? ` (${script[i - 1].note})` : ""}.`, setting: like?.setting ?? "", cast: [who], line: null, seconds: 5, scene: like?.scene ?? 1, flow: "cut", status: "todo" };
    groups.push({ line: i, at: before ? before.at + 0.5 : -1, shots: [{ shot, ref: i }] });
  }
  groups.sort((x, y) => x.line - y.line || x.at - y.at);
  // Each line's words across its shots, never changed.
  const out: drama.Shot[] = lead.map((w) => ({ ...w.shot, line: null }));
  for (let i = 1; i <= script.length; i++) {
    const mine = groups.filter((g) => g.line === i);
    const talking = mine.map((g) => g.shots[0].shot);
    const who = speaker(i - 1);
    const parts = splitLine(script[i - 1].text, talking.length);
    // More parts than shots: the last one carries on into another shot of the same speaker, closer or wider.
    const lastGroup = mine[mine.length - 1];
    let ins = 1;
    while (talking.length < parts.length) {
      const last = talking[talking.length - 1];
      const more: drama.Shot = { ...last, framing: /close/i.test(last.framing) ? "Medium" : "Close-up", move: "Slow push in", flow: "cut" };
      last.flow = "continue";
      talking.push(more);
      lastGroup.shots.splice(ins++, 0, { shot: more, ref: i });
    }
    let k = 0;
    for (const g of mine) {
      for (const w of g.shots) {
        const text = w.ref === i && talking.includes(w.shot) && k < parts.length ? parts[k++] : null;
        if (!text) {
          // A silent shot, or a shot marked for a line whose words are all said: it stays, with no line.
          out.push({ ...w.shot, line: null });
          continue;
        }
        const cast = w.shot.cast.includes(who) ? w.shot.cast : [...w.shot.cast, who].slice(-3);
        out.push({ ...w.shot, cast, line: { who, text }, seconds: Math.min(7, Math.max(w.shot.seconds, secondsFor(text))) });
      }
    }
  }
  return out.map((sh, i) => ({ ...sh, n: i + 1 }));
}

/** Writes (or rewrites) the scene: its cast with voices, and the shots with who says what. */
async function write(orgId: number, input: { what: string; style: string; me: boolean; seconds?: number | null; ratio?: drama.Ratio; current?: DramaEpisode; change?: string; refs?: drama.SceneRef[] }) {
  const emp = await elena(orgId);
  const org = await db.getOrganizationById(orgId);
  const ownerName = (org?.signerName || "").trim() || "the owner";
  const drawn = input.style !== "real" ? styles.resolve(orgId, input.style).label : null;
  // Her script is kept word for word, unless the change she asked for is to the words themselves.
  const script = input.change && /\b(lines?|dialogue|script|says?|said|wording|words?|reword|rewrite the (talk|conversation))\b/i.test(input.change) ? null : readScript(input.what);
  const refs = (input.refs ?? []).slice(0, MAX_REFS);
  const seconds = script ? scriptSeconds(script) : input.seconds ?? null;
  const length = script
    ? `Her script runs about ${seconds} seconds said at a natural pace, so the scene runs as long as the script needs.`
    : seconds
      ? `About ${seconds} seconds long.`
      : "As long as the piece needs: most scenes like this run 20 to 60 seconds, and a fuller story can run longer.";
  const shotsWanted = script
    ? `one shot or more for every script line (a line over ${16} words runs over two or three shots in a row), plus shots with no line wherever the picture says it better; ${MAX_SHOTS} shots at most`
    : !seconds
      ? `as many shots as the piece needs, ${MAX_SHOTS} at most`
      : seconds <= 20 ? "about 3 to 5 shots" : seconds <= 40 ? "about 5 to 8 shots" : `about ${Math.round(seconds / 5)} shots`;
  // The AI team can play themselves, with their own portraits and voices.
  const team = await castableTeam(orgId, Boolean(org?.internal));
  const sys = await (await import("./tasks")).systemPromptAbout(emp, input.what.slice(0, 4000), `You are ${emp.name}, the owner's video producer. You write short cinematic scenes where the characters talk to each other.\n${drama.STYLE}`);
  const current = input.current
    ? `\nThe scene so far: ${input.current.title}. ${input.current.logline}\n${drama.shotsOf(input.current).map((s) => `${s.n}. ${s.action}${s.line ? ` ${s.line.who}: "${s.line.text}"` : ""}`).join("\n")}\nChange: ${input.change || "write it again"}. Keep what wasn't asked to change.`
    : "";
  const scriptBlock = script
    ? `\n\nThis is her script. Every spoken line is used exactly as she wrote it, word for word, in this order, by the person she gave it to: never reword, shorten, merge, split into new sentences, drop or add a spoken line, and never write a line of your own. Put the script line's number in script_line on each shot that carries it (its words in line_text), 0 on shots with no line. A long line runs over two or three shots in a row by the same speaker, each marked with the same number. Notes in brackets say what we see or how it's said. Everyone who speaks in the script is in the cast under the name she used.\n${script.map((l, i) => `${i + 1}. ${l.who}: ${l.text}${l.note ? ` [${l.note}]` : ""}`).join("\n")}`
    : "";
  const refBlock = refs.length
    ? `\n\nShe gave ${refs.length === 1 ? "a reference picture" : `${refs.length} reference pictures`}:\n${refs.map((r, i) => `Picture ${i + 1}: ${r.note ? `her note: "${r.note}"` : "no note"}${r.seen ? `. It shows: ${r.seen}` : ""}`).join("\n")}\nUse each one the way her note says; with no note, work out from what it shows and what she wrote how it fits. A picture of a person she wants in it is that character: put its number in their picture, and their face, hair and skin tone come from it while the look of this piece still decides the light, the place and the quality. Any other picture (a place, a product, an outfit, a feel) goes in pictures on the shots it belongs in. A picture only adds what it's for; it never changes the rest of what she asked for.`
    : "";
  const out = await generateJson<Written>({
    system: sys.system,
    prompt: `Write one scene: ${script ? "she wrote the script below." : input.what}
${script ? `What she sent with it:\n${input.what.slice(0, 12000)}\n` : ""}${length}
${drawn ? `It is drawn in ${drawn}, not filmed: describe each person so an artist draws them the same every time.` : "It is shot with real-looking people, in whatever genre and tone she asked for (a trailer, an ad, a drama, a comedy)."}
What she asked for decides the shape: the places, the pace, how it opens and how it ends. Give it the shape that kind of piece really has.
- It is filmed ${drama.RATIO_SIZE[input.ratio ?? "9:16"].word}${input.ratio === "16:9" ? ": compose every shot for a wide screen, with room for people side by side and the place around them" : input.ratio === "1:1" ? ": compose every shot for a square frame" : ": compose every shot for a phone held upright"}.
- ${shotsWanted[0].toUpperCase()}${shotsWanted.slice(1)}, 3 to 7 seconds each, in as many places as the piece needs.
- ${script ? "The words are hers. Your work is the picture: who is where, what they do while they talk, the framing, the camera, the places and the cuts." : "When people talk, write their conversation first, the way people really talk: each line answers the line before it, plain words and contractions."} Then cut it into shots: a shot carries at most one line, by someone in that shot, lip synced to their face. Shots with no line are fine wherever the picture says it better. There is no narrator or voice-over track.
- The people talk to each other: everyone with a speaking part says at least one line, and each line answers the one before it. Someone talking looks at the person they're talking to, not into the camera, unless she asked for talking to camera.
- Lip sync can only follow a face it can see, so a shot with a line shows the speaker from the chest up or closer, facing the camera (front or three-quarter, never profile or from behind). Wide shots, backs of heads and people walking away carry no line.
- ${input.me ? `The owner is not the lead: the lead is one of the AI team or someone outside the business. The owner plays herself in a supporting part: a character named ${ownerName} (mark owner true) who speaks a few of the lines. ` : "Nobody plays the owner (owner false). "}As many characters as the piece needs, up to six, never a real client.
- The AI team members can play themselves, shown as people with their own faces and voices: ${team.map((e) => `${e.name} (${e.roleTitle})`).join(", ") || "none"}. Anyone who works for the business on screen is one of them, by these exact names, in the role they really have; never make up a coworker, assistant or staff member. Have them hand work to each other in their lines. Only people outside the business (a client, a caller) are made up, with plain names.
- Every shot lists the people in it by name in cast, spelled exactly as in the cast list.${scriptBlock}${refBlock}${current}`,
    schemaName: "scene",
    schema: SCHEMA,
    maxTokens: script || !seconds || seconds > 60 ? 16000 : 6000,
    timeoutMs: 240_000,
  });
  const ownVoice = input.me ? avatar.settingsOf(emp) : null;
  const cast: drama.SceneCast[] = [];
  const pictureOf = (n: number) => (n >= 1 && n <= refs.length ? refs[n - 1].url : null);
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
    const picture = owner ? null : pictureOf(c.picture);
    if (kept && kept.look === c.look.trim().slice(0, 500) && (kept.picture ?? null) === picture) {
      cast.push(kept);
      continue;
    }
    // Each made-up person gets a voice nobody else in this scene has.
    const voice = owner ? (ownVoice?.voiceId ? { id: ownVoice.voiceId, name: ownVoice.voiceName ?? "Your voice" } : null) : await drama.stockVoiceFor(orgId, `${c.gender === "female" ? "woman" : c.gender === "male" ? "man" : ""} ${c.look}`, cast.map((x) => x.voiceId).filter((x): x is string => !!x));
    cast.push({ name, role: c.role.trim().slice(0, 80), look: c.look.trim().slice(0, 500), owner, voiceId: voice?.id ?? null, voiceName: voice?.name ?? null, portrait: null, picture });
  }
  // Anyone who speaks in her script is in the cast, even if the writer left them out.
  for (const l of script ?? []) {
    if (cast.length >= 6 || castNameFor(l.who, cast.map((c) => c.name))) continue;
    const voice = await drama.stockVoiceFor(orgId, l.who, cast.map((x) => x.voiceId).filter((x): x is string => !!x));
    cast.push({ name: l.who.slice(0, 60), role: "In the scene", look: l.who.slice(0, 500), owner: false, voiceId: voice?.id ?? null, voiceName: voice?.name ?? null, portrait: null, picture: null });
  }
  if (!cast.length) throw new Error("I couldn't write the cast. Tell me a little more about who is in it.");
  const names = new Set(cast.map((c) => c.name.toLowerCase()));
  const written = (out.shots ?? []).slice(0, MAX_SHOTS).map((x, i) => {
    const inShot = Array.from(new Set((x.cast ?? []).map((n) => n.trim()).filter((n) => names.has(n.toLowerCase())))).slice(0, 3);
    const who = cast.find((c) => c.name.toLowerCase() === (x.line_who || "").trim().toLowerCase())?.name ?? null;
    const line = who && x.line_text?.trim() ? { who, text: x.line_text.trim().slice(0, 200) } : null;
    const pictures = Array.from(new Set((x.pictures ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= refs.length))).slice(0, MAX_REFS);
    const shot: drama.Shot = {
      n: i + 1,
      // A talking shot is framed where lip sync can find the face (2026-10-16).
      framing: talkingFrame(line, x.framing),
      move: x.move.slice(0, 120),
      action: x.action.slice(0, 600),
      setting: x.setting.slice(0, 300),
      cast: line && !inShot.includes(line.who) ? [...inShot, line.who].slice(0, 3) : inShot,
      line,
      seconds: Math.max(3, Math.min(7, Math.round(x.seconds || 5))),
      sound: (x.sound ?? "").slice(0, 200),
      scene: Math.max(1, Math.round(x.scene || 1)),
      flow: x.flow === "continue" ? ("continue" as const) : ("cut" as const),
      ...(pictures.length ? { pictures } : {}),
      status: "todo" as const,
    };
    return { shot, ref: Math.round(x.script_line || 0) };
  });
  const shots = script ? fitScript(written, script, cast.map((c) => c.name)) : written.map((w) => w.shot);
  if (shots.length > MAX_SHOTS) throw new Error(`That script needs ${shots.length} shots and a scene holds ${MAX_SHOTS}. Split it into two scenes and send the first half.`);
  shots.forEach((sh, i) => {
    if (i === shots.length - 1 || shots[i + 1].scene !== sh.scene) sh.flow = "cut";
  });
  if (!shots.length) throw new Error("I couldn't write the shots. Tell me a little more about what happens.");
  // Read the conversation start to finish and smooth any line that doesn't follow the one before it. Never her script.
  if (!script) await drama.polishLines(sys.system, out.title || "Scene", shots, cast).catch((err) => console.warn("[scene] dialogue pass skipped:", err instanceof Error ? err.message : err));
  return { title: (out.title || "Scene").trim().slice(0, 120), logline: (out.logline || "").trim().slice(0, 400), look: (out.look || "").trim().slice(0, 500), music: (out.music || "").slice(0, 500), cast, shots };
}

/** Elena writes the scene and starts drawing its pictures. */
/** Her reference pictures, kept only when they're this workspace's own uploads. */
export function cleanRefs(orgId: number, refs: { url: string; note?: string | null; seen?: string | null }[] | null | undefined): drama.SceneRef[] {
  return (refs ?? [])
    .filter((r) => typeof r.url === "string" && r.url.startsWith(`/files/org-${orgId}/`))
    .slice(0, MAX_REFS)
    .map((r) => ({ url: r.url.slice(0, 500), note: (r.note ?? "").trim().slice(0, 200), ...(r.seen?.trim() ? { seen: r.seen.trim().slice(0, 400) } : {}) }));
}

/** The longest brief or script a Scene reads. */
export const MAX_WHAT = 20_000;

export async function writeScene(orgId: number, input: { what: string; style?: string | null; me?: boolean; seconds?: number | null; ratio?: drama.Ratio | null; refs?: { url: string; note?: string | null; seen?: string | null }[] | null }) {
  const what = input.what.trim().slice(0, MAX_WHAT);
  if (!what) throw new TRPCError({ code: "BAD_REQUEST", message: "Say what happens in the scene." });
  if (hours.meteredSync(orgId)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Scenes with talking characters aren't part of work-hour plans yet." });
  const style = cleanStyle(orgId, input.style);
  const me = Boolean(input.me);
  // No length picked: a script sets its own, and anything else runs as long as it needs.
  const seconds = input.seconds ? Math.max(10, Math.min(180, Math.round(input.seconds))) : null;
  const refs = cleanRefs(orgId, input.refs);
  // A shape named in the brief ("16:9", "widescreen", "vertical for Reels") wins over the form's choice.
  const ratio: drama.Ratio = drama.ratioFromText(what) ?? input.ratio ?? "9:16";
  const w = await write(orgId, { what, style, me, seconds, ratio, refs });
  const ep = db.createDramaEpisode({
    organizationId: orgId,
    number: 0,
    kind: "scene",
    title: w.title,
    logline: w.logline,
    music: w.music,
    shots: JSON.stringify(w.shots),
    plan: JSON.stringify({ approved: false, style, what, me, sceneCast: w.cast, ratio, look: w.look, ...(refs.length ? { refs } : {}) } satisfies drama.ScenePlan),
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
  // "Make it 16:9" in a change re-films it in that shape; every picture is drawn again anyway.
  const ratio: drama.Ratio = drama.ratioFromText(change) ?? p.ratio ?? "9:16";
  const w = await write(orgId, { what: p.what ?? ep.logline, style: p.style ?? "real", me: Boolean(p.me), seconds: drama.shotsOf(ep).reduce((t, s) => t + s.seconds, 0) || null, ratio, current: ep, change, refs: p.refs });
  db.updateDramaEpisode(id, orgId, { title: w.title, logline: w.logline, music: w.music, shots: JSON.stringify(w.shots), plan: JSON.stringify({ ...p, approved: false, sceneCast: w.cast, ratio, look: w.look || p.look }), costCents: drama.estimateEpisode(w.shots), status: "script", videoUrl: null, error: null, progress: null });
  return startPictures(orgId, id);
}

/**
 * Her reference pictures on a written scene: Save keeps them and, when they changed, writes the
 * scene again with them, so every person and shot uses them the way her notes say.
 */
export async function saveRefs(orgId: number, id: number, refs: { url: string; note?: string | null; seen?: string | null }[]) {
  const ep = mustScene(orgId, id);
  notBusy(ep);
  const p = drama.scenePlanOf(ep);
  const next = cleanRefs(orgId, refs);
  // A note typed now replaces what the picture was seen to show only in the prompt; keep what was seen.
  for (const r of next) if (!r.seen) { const was = p.refs?.find((x) => x.url === r.url)?.seen; if (was) r.seen = was; }
  const same = JSON.stringify((p.refs ?? []).map((r) => [r.url, r.note])) === JSON.stringify(next.map((r) => [r.url, r.note]));
  if (same) return ep;
  db.updateDramaEpisode(id, orgId, { plan: JSON.stringify({ ...p, refs: next }) });
  return rewriteScene(orgId, id, next.length ? "Use her reference pictures the way her notes ask" : "She took the reference pictures out: draw the people and places from the writing alone");
}

/** A talking shot's framing: close enough, and facing, for lip sync to find the mouth; any other shot keeps the writer's. */
export function talkingFrame(line: { who: string } | null, framing: string) {
  const f = (framing || "").slice(0, 80);
  if (!line) return f;
  return /\b(close|medium)\b/i.test(f) && !/wide|full|long|establish|aerial|overhead|behind|back/i.test(f) ? f : "Medium close-up";
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
  const text = input.line.trim().slice(0, 200);
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
