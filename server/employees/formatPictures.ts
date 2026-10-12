import fs from "node:fs";
import path from "node:path";
import { ENV } from "../_core/env";
import { uploadsRoot } from "../storage";

/**
 * The photos on the Make a video format cards. They're made once with the image model (the
 * same one Elena uses for stills), kept on the server for every workspace, and served at
 * /api/video-pictures/<key>. Until a photo exists, the drawn picture that ships with the app
 * is shown. Nothing here is about a workspace or a client.
 */

export const PICTURES = {
  ad: "A glass skincare serum bottle with a gold cap on a blush pink stone pedestal, soft pink flowers around it, warm studio light. A realistic commercial product photo for a social media ad.",
  broll: "A mirrorless camera on a small tripod filming a sunlit modern office desk with plants and a coffee cup, golden window light. A realistic behind-the-scenes photo of a b-roll shoot.",
  explainer: "A confident Black woman presenter standing beside a large wall screen with simple bright charts and shapes, in a modern bright studio with soft lavender light, holding a tablet. A realistic photo.",
  talking: "A warm, friendly woman in her 30s talking straight to the camera in a cozy modern home office, a soft ring light glow, plants and a lamp behind her. A realistic vlog-style photo with natural skin texture.",
  story: "Printed family snapshots and instant photos spread on a sunlit wooden table: on top, a smiling woman hugging her golden retriever outdoors; beside it, a beach photo. A realistic, warm, nostalgic photo.",
  audio: "A podcast microphone on a boom arm in a modern recording studio with purple and blue light, a monitor behind it showing an audio waveform. A realistic, sharp photo.",
} as const;
export type PictureKey = keyof typeof PICTURES;
export const PICTURE_KEYS = Object.keys(PICTURES) as PictureKey[];

const STYLE = "Shot on a full-frame camera, shallow depth of field, natural color, current and editorial. No text, letters, words, logos or watermarks anywhere in the picture.";

export const pictureDir = () => path.join(uploadsRoot(), "..", "ld-pictures");
export const pictureFile = (key: PictureKey) => path.join(pictureDir(), `${key}.webp`);

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
          const r = await drama.falRun("fal-ai/nano-banana-pro", { prompt: `${PICTURES[key]} ${STYLE}`, aspect_ratio: "16:9", num_images: 1, output_format: "png" }, 5);
          const url = r?.images?.[0]?.url as string | undefined;
          if (!url) throw new Error("no picture came back");
          const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
          if (!res.ok) throw new Error(`download failed (${res.status})`);
          const sharp = (await import("sharp")).default;
          // The card shows it at about 181 by 111; this is twice that, cropped to fit.
          const out = await sharp(Buffer.from(await res.arrayBuffer())).resize(724, 444, { fit: "cover" }).webp({ quality: 86 }).toBuffer();
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

/** At startup: any format photo not made yet is made in the background, one at a time. */
export async function warmPictures() {
  if (!ENV.falKey || process.env.NODE_ENV === "test") return;
  for (const key of PICTURE_KEYS) await makePicture(key);
}
