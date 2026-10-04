import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import type { DramaEpisode } from "../../drizzle/schema";
import * as drama from "./drama";

/**
 * Branded cinematic campaigns (Elena). The production order, every time:
 * goal, three creative directions, then (once one is picked) the script,
 * storyboard and shot list with each shot's character reference, keyframes,
 * the owner's approval, animation, voice-over, music and sound, the edit,
 * captions, the call to action and the export versions. Nothing is generated
 * straight from "make a video about LeadDash".
 */

const DIRECTOR = `You are Elena, the owner's AI cinematic video director. You create premium commercial-style videos featuring the owner as the recurring founder character.
- The owner's face, hair and skin tone stay identical in every scene. Every shot with her names the character plate it uses.
- Never generate before planning: concept, hook, script, storyboard, shot list, keyframe prompts, motion prompts, voice-over, sound design, edit timeline, captions and call to action come first.
- Realistic commercial cinematography, never a generic AI look. The image model decides who is in a scene and how it looks; the video model only moves the camera and the people.
- Use the brand's colors (from the Brain) selectively: wardrobe, light, props, signage, an interface on a screen. Never flood a frame with them.
- Controlled camera movement: dolly-in, tracking, crane, orbit, push-in, rack focus, restrained handheld. Avoid excessive movement, surreal body motion, distorted hands, unnecessary slow motion and obvious AI transformations.
- Wardrobe and room continuity across connected shots.
- Every campaign is a transformation story: show the problem in pictures before the answer appears.
- It should feel like a campaign from a professional creative agency.`;

function teamPortrait(kind: string, avatarUrl: string | null) {
  if (avatarUrl) return avatarUrl;
  const file = `/avatars/${kind}.webp`;
  for (const base of ["dist/public", "client/public"]) if (fs.existsSync(path.resolve(process.cwd(), base, file.slice(1)))) return file;
  return null;
}

async function elena(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "video");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Elena is not in this workspace." });
  return emp;
}

const DIRECTIONS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "goal", "directions"],
  properties: {
    title: { type: "string", description: "A short working title for the campaign" },
    goal: { type: "string", description: "The campaign goal in one sentence: who should feel what, and do what" },
    directions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "hook", "story", "metaphor", "location", "wardrobe", "lighting", "camera", "ending"],
        properties: {
          title: { type: "string" },
          hook: { type: "string", description: "The emotional hook in the first 2 seconds, one sentence" },
          story: { type: "string", description: "The story arc, problem to transformation, one or two sentences" },
          metaphor: { type: "string", description: "The visual metaphor" },
          location: { type: "string" },
          wardrobe: { type: "string" },
          lighting: { type: "string", description: "The lighting mood" },
          camera: { type: "string", description: "The camera language" },
          ending: { type: "string", description: "The final image and the call to action" },
        },
      },
    },
  },
};

/** Step 1 and 2: the goal and three creative directions. Nothing visual yet. */
export async function writeDirections(orgId: number, brief: string) {
  const emp = await elena(orgId);
  const sys = await (await import("./tasks")).systemPromptAbout(emp, brief, `${DIRECTOR}\n${drama.STYLE}${drama.styleText(orgId)}`);
  const out = await generateJson<{ title: string; goal: string; directions: drama.Direction[] }>({
    system: sys.system,
    prompt: `The owner asked for: ${brief}\nWrite the campaign goal and exactly three distinct creative directions (different hooks, worlds and looks), each 20 to 45 seconds long as a finished vertical video.`,
    schemaName: "campaign_directions",
    schema: DIRECTIONS_SCHEMA,
    maxTokens: 3000,
    timeoutMs: 120_000,
  });
  const directions = (out.directions ?? []).slice(0, 3);
  if (!directions.length) throw new Error("No directions came back. Tell me a little more and I'll try again.");
  const n = db.listDramaEpisodes(orgId).filter((e) => e.kind === "campaign").length + 1;
  return db.createDramaEpisode({ organizationId: orgId, number: n, kind: "campaign", title: (out.title || brief).slice(0, 120), logline: brief.slice(0, 400), plan: JSON.stringify({ goal: out.goal ?? "", directions }), shots: "[]" });
}

const PLAN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "script", "music", "cta", "cast", "shots"],
  properties: {
    title: { type: "string" },
    script: { type: "string", description: "The full voice-over script, as the owner says it" },
    music: { type: "string", description: "The score: genre, mood, tempo, instruments, where it builds, where it drops out. Instrumental" },
    cta: { type: "string", description: "The call to action shown at the end, 6 words at most" },
    cast: { type: "array", items: { type: "string" }, description: "Names of everyone on screen: the owner, team members from the list, or made-up extras" },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["framing", "move", "action", "setting", "cast", "plate", "props", "vo", "caption", "seconds", "sound"],
        properties: {
          framing: { type: "string", enum: ["Wide", "Medium", "Two-shot", "Over the shoulder", "Close-up", "Extreme close-up", "Insert", "Reaction"] },
          move: { type: "string", description: "The camera move and how far: slow dolly-in of a few inches, tracking left, crane up, orbit, rack focus, restrained handheld" },
          action: { type: "string", description: "What we see: subject, expression, body language, foreground and background" },
          setting: { type: "string" },
          cast: { type: "array", items: { type: "string" } },
          plate: { type: "string", description: "For a shot with the owner: the character plate that fits (from the list), else ''" },
          props: { type: "array", items: { type: "string" }, description: "Titles of Brain images to show in the shot (a logo, a product screenshot), or []" },
          vo: { type: "string", description: "The voice-over over this shot, in the owner's voice, or ''" },
          caption: { type: "string", description: "The on-screen caption for this shot, 7 words at most, or ''" },
          seconds: { type: "integer", description: "2 to 6" },
          sound: { type: "string", description: "Room tone and sound effects for the shot" },
        },
      },
    },
  },
};

/** Steps 3 to 7: script, storyboard, shot list with references, then the keyframes are made for approval. */
export async function planCampaign(orgId: number, id: number, pick: number, who = "") {
  const ep = db.getDramaEpisode(id, orgId);
  if (!ep || ep.kind !== "campaign") throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't in this workspace." });
  if (ep.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes." });
  const plan = drama.episodeView(ep).plan;
  const dir = plan.directions[pick - 1];
  if (!dir) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick direction 1, 2 or 3." });
  const emp = await elena(orgId);
  const org = await db.getOrganizationById(orgId);
  // The owner's name as the story uses it: her character from the series, else the signer, else whoever asked.
  const ownerName = db.listDramaCast(orgId).find((c) => c.kind === "owner")?.name || org?.signerName || who || "the owner";
  const team = (await db.listEmployeesByOrg(orgId)).filter((e) => e.kind !== "custom");
  const plates = drama.settingsOf(orgId).plates ?? [];
  const props = await drama.propImages(orgId);
  const sys = await (await import("./tasks")).systemPromptAbout(emp, `${ep.logline} ${dir.title}`, `${DIRECTOR}\n${drama.STYLE}${drama.styleText(orgId)}`);
  const out = await generateJson<{ title: string; script: string; music: string; cta: string; cast: string[]; shots: { framing: string; move: string; action: string; setting: string; cast: string[]; plate: string; props: string[]; vo: string; caption: string; seconds: number; sound: string }[] }>({
    system: sys.system,
    prompt: `Campaign goal: ${plan.goal}
The direction the owner picked: ${dir.title}. Hook: ${dir.hook} Story: ${dir.story} Visual metaphor: ${dir.metaphor} Location: ${dir.location} Wardrobe: ${dir.wardrobe} Lighting: ${dir.lighting} Camera: ${dir.camera} Ending: ${dir.ending}
People who can appear: the owner, ${ownerName} (call her exactly "${ownerName}"); the AI team members, each shown as a person: ${team.map((e) => `${e.name} (${e.roleTitle})`).join(", ")}; or made-up extras with plain names.
Character plates for the owner: ${plates.map((p) => p.label).join(", ") || "none yet; leave plate ''"}.
Brain images that can be shown in a shot (exact titles): ${props.map((p) => p.title).slice(0, 30).join("; ") || "none"}. Never invent an interface or a logo; show one only from this list.
Write the finished plan: 8 to 12 shots, 20 to 45 seconds in all. The voice-over is the owner's own voice; no one else speaks. Captions are short and land on the beat. End on the call to action.`,
    schemaName: "campaign_plan",
    schema: PLAN_SCHEMA,
    maxTokens: 6000,
    timeoutMs: 180_000,
  });
  // The cast: the owner, team members by their own portraits, made-up extras by name.
  const ensure = (name: string) => {
    const cast = db.listDramaCast(orgId);
    const lower = name.toLowerCase().trim();
    if (!lower) return null;
    const have = cast.find((c) => c.name.toLowerCase() === lower);
    if (have) return have;
    if (lower === ownerName.toLowerCase()) return cast.find((c) => c.kind === "owner") ?? db.createDramaCast({ organizationId: orgId, name: ownerName, role: "Founder", kind: "owner", look: "" });
    const member = team.find((e) => e.name.toLowerCase() === lower);
    if (member) return db.createDramaCast({ organizationId: orgId, name: member.name, role: member.roleTitle, kind: "team", look: "", photoUrl: teamPortrait(member.kind, member.avatar ?? null) });
    return db.createDramaCast({ organizationId: orgId, name: name.trim().slice(0, 80), role: "Extra", kind: "made_up", look: "" });
  };
  const owner = db.listDramaCast(orgId).find((c) => c.kind === "owner");
  const ownerKey = (owner?.name ?? ownerName).toLowerCase();
  const plateNames = new Set(plates.map((p) => p.label.toLowerCase()));
  const propNames = new Set(props.map((p) => p.title.toLowerCase()));
  const shots: drama.Shot[] = (out.shots ?? []).slice(0, 14).map((x, i) => {
    const cast = (x.cast ?? []).map((n) => ensure(n)?.name).filter((n): n is string => Boolean(n)).slice(0, 3);
    return {
      n: i + 1,
      framing: x.framing,
      move: (x.move ?? "").slice(0, 160),
      action: (x.action ?? "").slice(0, 600),
      setting: (x.setting ?? "").slice(0, 300),
      cast,
      line: null,
      seconds: Math.max(2, Math.min(6, Math.round(x.seconds || 3))),
      sound: (x.sound ?? "").slice(0, 200),
      plate: cast.some((n) => n.toLowerCase() === ownerKey) && plateNames.has((x.plate ?? "").toLowerCase()) ? x.plate : "",
      props: (x.props ?? []).filter((t) => propNames.has(t.toLowerCase())).slice(0, 2),
      vo: (x.vo ?? "").trim().slice(0, 300),
      caption: (x.caption ?? "").trim().slice(0, 120),
      status: "todo",
    };
  });
  if (!shots.length) throw new Error("The plan came back empty. Pick the direction again.");
  const next = db.updateDramaEpisode(id, orgId, {
    title: (out.title || dir.title).slice(0, 120),
    shots: JSON.stringify(shots),
    music: (out.music ?? "").slice(0, 500),
    plan: JSON.stringify({ ...JSON.parse(ep.plan || "{}"), chosen: pick, script: (out.script ?? "").slice(0, 3000), cta: (out.cta ?? "").slice(0, 80), approved: false }),
    status: "script",
    costCents: drama.estimateEpisode(shots),
    videoUrl: null,
    versions: "{}",
    error: null,
  })!;
  return next;
}

export function campaignFor(orgId: number, words: string) {
  const list = db.listDramaEpisodes(orgId).filter((e) => e.kind === "campaign" && !JSON.parse(e.plan || "{}").hidden);
  const w = words.trim().toLowerCase();
  return ((w ? list.find((e) => e.title.toLowerCase().includes(w)) : null) ?? list[list.length - 1] ?? null) as DramaEpisode | null;
}
