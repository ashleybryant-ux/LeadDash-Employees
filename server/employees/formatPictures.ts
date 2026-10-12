import fs from "node:fs";
import path from "node:path";
import { ENV } from "../_core/env";
import { uploadsRoot } from "../storage";

/**
 * The photos on the Make a video format cards. They're made once with the image model (the
 * same one Elena uses for stills), kept on the server for every workspace, and served at
 * /api/video-pictures/<key>. Until a photo exists, the card shows its color and caption only. Nothing here is about a workspace or a client.
 */

export const PICTURES = {
  ad: "A vertical phone video frame: a smiling young woman holding a glass skincare serum bottle up close to the camera in a bright modern bathroom, natural window light.",
  broll: "A vertical phone video frame of cinematic b-roll: hands pouring coffee at a sunlit modern office desk with plants, golden morning light.",
  explainer: "A vertical phone video frame: a confident Black woman in a lavender blazer explaining something with an open hand gesture, upper body, looking at the camera, in a bright modern studio with a soft purple background.",
  talking: "A vertical selfie-style phone video frame: a friendly woman in her 30s talking straight into the phone camera in a cozy modern home office, warm lamp and plants behind her, natural skin texture.",
  story: "A vertical phone video frame: a smiling woman hugging her golden retriever in a sunny park at golden hour, a candid personal moment.",
  audio: "A vertical phone video frame: a man wearing headphones speaking into a podcast microphone in a modern studio with purple and blue light, side angle.",
} as const;
import { PRESETS, PRESET_KEYS } from "./styles";

type FormatKey = keyof typeof PICTURES;
/** A format card photo, or a style's preview in the picker ("style-claymation"). */
export type PictureKey = FormatKey | `style-${keyof typeof PRESETS}`;
export const PICTURE_KEYS: PictureKey[] = [...(Object.keys(PICTURES) as FormatKey[]), ...PRESET_KEYS.map((k) => `style-${k}` as const)];

const STYLE = "Realistic, sharp, modern social media video look, shallow depth of field, natural color. No text, letters, words, captions, logos or watermarks anywhere in the picture.";
const NO_TEXT = "No text, letters, words, captions, logos or watermarks anywhere in the picture.";

/** What to draw, its shape and its size on disk. */
function specOf(key: PictureKey) {
  if (key.startsWith("style-")) {
    const p = PRESETS[key.slice(6) as keyof typeof PRESETS];
    return { prompt: `${p.prompt}. ${p.preview}. ${NO_TEXT}`, ratio: "1:1", w: 360, h: 360, suffix: "1x1" };
  }
  return { prompt: `${PICTURES[key as FormatKey]} ${STYLE}`, ratio: "9:16", w: 360, h: 640, suffix: "9x16" };
}

export const pictureDir = () => path.join(uploadsRoot(), "..", "ld-pictures");
/** Format cards are phone-shaped (9:16), like a frame of the finished video; style previews are square. */
export const pictureFile = (key: PictureKey) => path.join(pictureDir(), `${key}-${specOf(key).suffix}.webp`);

const making = new Map<PictureKey, Promise<string | null>>();

/** The photo for a format card, made now if it doesn't exist yet. Null when it can't be made (no image service, or it failed). */
export function makePicture(key: PictureKey): Promise<string | null> {
  const file = pictureFile(key);
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (!ENV.falKey) return Promise.resolve(null);
  if (!making.has(key)) {
    making.set(
      key,
      (async () => {
        try {
          const drama = await import("./drama");
          const spec = specOf(key);
          const r = await drama.falRun("fal-ai/nano-banana-pro", { prompt: spec.prompt, aspect_ratio: spec.ratio, num_images: 1, output_format: "png" }, 5);
          const url = r?.images?.[0]?.url as string | undefined;
          if (!url) throw new Error("no picture came back");
          const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
          if (!res.ok) throw new Error(`download failed (${res.status})`);
          const sharp = (await import("sharp")).default;
          // Shown at about a third of this size, so it stays sharp on any screen.
          const out = await sharp(Buffer.from(await res.arrayBuffer())).resize(spec.w, spec.h, { fit: "cover" }).webp({ quality: 86 }).toBuffer();
          fs.mkdirSync(pictureDir(), { recursive: true });
          fs.writeFileSync(file, out);
          return file;
        } catch (err) {
          console.warn(`[pictures] ${key} not made:`, err instanceof Error ? err.message : err);
          return null;
        } finally {
          making.delete(key);
        }
      })()
    );
  }
  return making.get(key)!;
}

/** At startup: any format photo or style preview not made yet is made in the background, one at a time. */
export async function warmPictures() {
  if (!ENV.falKey || process.env.NODE_ENV === "test") return;
  for (const key of PICTURE_KEYS) await makePicture(key);
}
