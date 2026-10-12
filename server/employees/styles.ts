import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import * as db from "../db";
import { ENV } from "../_core/env";
import { storagePut, uploadsRoot } from "../storage";
import { videoStyles, type VideoStyle } from "../../drizzle/schema";

/**
 * The looks a story video can be drawn in: Real footage (the b-roll path), Auto (Elena picks),
 * 17 preset styles, and styles a workspace makes from 1 to 3 of its own pictures (Add style).
 * Drawing: each person in the story gets a portrait first, and every scene they're in is drawn
 * with that portrait as a reference, so they look the same in every scene.
 */

export const PRESETS = {
  animation: { label: "3D animation", prompt: "Stylized 3D animated feature film look, expressive cartoon proportions, soft cinematic lighting", preview: "A tired young therapist in blue scrubs rubbing his eyes at a desk late at night, warm lamp light" },
  claymation: { label: "Claymation", prompt: "Claymation stop-motion look, handmade plasticine figures and sets, visible clay texture, soft studio light", preview: "A clay figure of a woman sitting on a couch holding a mug in a cozy office" },
  watercolor: { label: "Watercolor", prompt: "Loose watercolor illustration, soft washes, visible paper texture, gentle colors", preview: "A sunny counseling office window with a potted plant and two chairs" },
  penink: { label: "Pen and ink", prompt: "Detailed black pen and ink illustration with cross-hatching on white paper", preview: "A woman walking up the steps of a small brick office building" },
  line: { label: "2D line", prompt: "Minimal 2D black line drawing on white, clean single-weight outlines, no shading", preview: "A teenage girl with a backpack walking past a tree" },
  chalk: { label: "Chalkboard", prompt: "White chalk drawing on a black chalkboard, simple hand-drawn figures, a few colored chalk accents", preview: "Two stick figures, a tangled scribble over the left one, a calm smile and a green arrow to the right one" },
  comic: { label: "Comic book", prompt: "Bold comic book panel, ink outlines, flat bright colors, classic European comic style, no speech bubbles", preview: "Close-up of a hopeful young man's face, busy city behind him" },
  halftone: { label: "Halftone", prompt: "Black and white halftone dot print look with bold red accent circles and lines, retro poster style", preview: "A man looking at himself in a bathroom mirror" },
  collage: { label: "Paper collage", prompt: "Torn paper collage: black and white photo cutouts layered with kraft paper, mustard yellow shapes and graph paper scraps", preview: "Hands holding a teacup" },
  lowpoly: { label: "Low-poly", prompt: "Low-poly retro 3D render, chunky faceted shapes, bright primary colors, 1990s video game look", preview: "A small city street with a cafe and blocky trees" },
  pixel: { label: "Pixel art", prompt: "Detailed 16-bit pixel art, rich colors, video game scene", preview: "A person at a desk at night studying a glowing map under a lamp" },
  miniature: { label: "Miniature", prompt: "Handcrafted miniature diorama, tiny felt and wood figurines, tilt-shift, warm sunlight", preview: "Tiny figurines shopping at an outdoor farmers market stall" },
  editorial: { label: "Vintage editorial", prompt: "Vintage editorial illustration on cream paper, sepia ink tones, old newspaper print feel", preview: "A sepia city skyline inside a simple line chart rising to the right" },
  studio: { label: "Studio minimal", prompt: "Studio minimalism, clean seamless background, soft commercial lighting, minimal props, realistic", preview: "A plain matte white ceramic mug on a soft gray background" },
  science: { label: "Scientific 3D", prompt: "3D scientific visualization, glowing detailed structures, dark background, macro depth of field", preview: "Glowing neurons with branching dendrites connecting in dark space" },
  software: { label: "Software showcase", prompt: "Sleek 3D render of devices and app screens, angled perspective, soft glow, tech showcase, realistic", preview: "A floating tablet showing a dark dashboard app with green line charts" },
  doodle: { label: "Playful doodles", prompt: "A real photo with playful hand-drawn colorful doodles, swirls and sparkles drawn over it", preview: "A smiling woman in a denim jacket holding a coffee cup on a city street" },
} as const;
export type PresetKey = keyof typeof PRESETS;
export const PRESET_KEYS = Object.keys(PRESETS) as PresetKey[];

export const isDrawn = (style: string | null | undefined) => !!style && style !== "real";
export const isPreset = (s: string): s is PresetKey => s in PRESETS;

// ==========================================
// Custom styles (Add style)
// ==========================================

export function listCustom(orgId: number) {
  return db.getDb().select().from(videoStyles).where(eq(videoStyles.organizationId, orgId)).orderBy(desc(videoStyles.id)).all();
}
export function getCustom(orgId: number, id: number) {
  return db.getDb().select().from(videoStyles).where(and(eq(videoStyles.id, id), eq(videoStyles.organizationId, orgId))).get() ?? null;
}
export const refsOf = (s: Pick<VideoStyle, "refs">) => {
  try {
    const r = JSON.parse(s.refs);
    return Array.isArray(r) ? (r as string[]) : [];
  } catch {
    return [];
  }
};
export function addCustom(orgId: number, input: { name: string; refs: string[]; by: string }) {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the style." });
  const refs = input.refs.filter((u) => u.startsWith(`/files/org-${orgId}/`)).slice(0, 3);
  if (!refs.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload at least one picture in the look you want." });
  return db.getDb().insert(videoStyles).values({ organizationId: orgId, name, refs: JSON.stringify(refs), createdBy: input.by }).returning().get();
}
export function removeCustom(orgId: number, id: number) {
  if (!getCustom(orgId, id)) throw new TRPCError({ code: "NOT_FOUND", message: "That style is not in this workspace." });
  db.getDb().delete(videoStyles).where(and(eq(videoStyles.id, id), eq(videoStyles.organizationId, orgId))).run();
}

/** A style's name, the words that describe it to the image model, and any pictures it's drawn from. */
export function resolve(orgId: number, style: string) {
  if (isPreset(style)) return { key: style, label: PRESETS[style].label, prompt: PRESETS[style].prompt, refs: [] as string[] };
  const m = style.match(/^custom:(\d+)$/);
  const c = m ? getCustom(orgId, Number(m[1])) : null;
  if (c) return { key: style, label: c.name, prompt: "The exact same art style, colors, texture and rendering as the style reference pictures", refs: refsOf(c) };
  return { key: "real", label: "Real footage", prompt: "", refs: [] as string[] };
}

/** Every look the picker shows, for this workspace. */
export function pickerView(orgId: number) {
  return {
    custom: listCustom(orgId).map((c) => ({ key: `custom:${c.id}`, id: c.id, label: c.name, image: refsOf(c)[0] ?? null })),
    presets: PRESET_KEYS.map((k) => ({ key: k, label: PRESETS[k].label, image: `/api/video-pictures/style-${k}` })),
  };
}

// ==========================================
// Drawing
// ==========================================

export const RATIO = { vertical: "9:16", square: "1:1", wide: "16:9" } as const;
const NO_TEXT = "No text, letters, words, captions, logos or watermarks anywhere in the picture.";

/** A stored or shipped picture as something the image model can read. */
async function asInput(url: string) {
  if (/^https?:/i.test(url)) return url;
  const file = path.join(uploadsRoot(), url.replace(/^\/files\//, ""));
  const sharp = (await import("sharp")).default;
  const buf = await sharp(fs.readFileSync(file)).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

/** One picture from the image model, saved for the workspace. References keep a person or a look the same. */
export async function draw(orgId: number, input: { prompt: string; ratio: string; refs: string[]; name: string }) {
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Drawing scenes isn't set up on the server yet. LeadDash support can turn it on." });
  const drama = await import("./drama");
  const refs = input.refs.slice(0, 5);
  const r = refs.length
    ? await drama.falRun("fal-ai/nano-banana-pro/edit", { prompt: input.prompt, image_urls: await Promise.all(refs.map(asInput)), aspect_ratio: input.ratio, num_images: 1, output_format: "png" }, 5)
    : await drama.falRun("fal-ai/nano-banana-pro", { prompt: input.prompt, aspect_ratio: input.ratio, num_images: 1, output_format: "png" }, 5);
  const url = r?.images?.[0]?.url as string | undefined;
  if (!url) throw new Error("The picture didn't come back.");
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Couldn't download the picture (${res.status}).`);
  return (await storagePut(`org-${orgId}/videos/${input.name}.png`, Buffer.from(await res.arrayBuffer()), "image/png")).url;
}

export type CastMember = { name: string; look: string; portrait?: string | null };

/** The portrait a person is drawn from in every scene. */
export function portraitPrompt(style: { prompt: string; refs: string[] }, c: CastMember) {
  return `${style.prompt}. A character reference portrait of ${c.name}: ${c.look}. Upper body, facing the viewer, plain simple background. ${NO_TEXT}`;
}

/** One scene, in the style, with the people in it drawn like their portraits. */
export function scenePrompt(style: { prompt: string }, see: string, cast: CastMember[]) {
  const who = cast.length ? ` The people in it look exactly like their reference portraits: ${cast.map((c) => `${c.name} (${c.look})`).join("; ")}.` : "";
  return `${style.prompt}. One frame of a story video: ${see}.${who} Cinematic composition, no split panels. ${NO_TEXT}`;
}

/** Animated clips: a drawn scene brought to life (5 or 10 seconds, no sound), kept with the video. */
export async function animate(orgId: number, input: { still: string; see: string; seconds: 5 | 10; name: string }) {
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Animating scenes isn't set up on the server yet. LeadDash support can turn it on." });
  const drama = await import("./drama");
  const r = await drama.falRun("fal-ai/kling-video/v3/pro/image-to-video", {
    start_image_url: await asInput(input.still),
    prompt: `${input.see}. Gentle, natural motion in the same art style; the people stay exactly as drawn.`,
    duration: String(input.seconds),
    generate_audio: false,
    negative_prompt: "style change, photorealism change, on-screen text, captions, watermark, distorted faces, morphing, extra fingers",
  }, 25);
  const url = r?.video?.url as string | undefined;
  if (!url) throw new Error("The animated scene didn't come back.");
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Couldn't download the animated scene (${res.status}).`);
  return (await storagePut(`org-${orgId}/videos/${input.name}.mp4`, Buffer.from(await res.arrayBuffer()), "video/mp4")).url;
}
