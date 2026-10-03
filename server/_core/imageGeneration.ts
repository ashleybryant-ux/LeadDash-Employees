import { storagePut } from "../storage";
import { ENV } from "./env";
import { AiNotConfiguredError } from "./llm";
import { recordImage } from "../usage";

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

/**
 * Generates an image with OpenAI's image API and saves it under /files.
 * Social posts use 1024x1536 (portrait) or 1024x1024; blog banners 1536x1024.
 */
export async function generateImage(opts: {
  prompt: string;
  size?: ImageSize;
  quality?: "low" | "medium" | "high";
  folder?: string;
}): Promise<{ url: string }> {
  if (!ENV.openAiKey) {
    throw new AiNotConfiguredError("Images are not set up yet: OPENAI_API_KEY is missing on the server.");
  }
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${ENV.openAiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: ENV.imageModel,
      prompt: opts.prompt,
      size: opts.size ?? "1024x1024",
      quality: opts.quality ?? "medium",
      n: 1,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Image generation error ${res.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);
  await recordImage(opts.size ?? "1024x1024");
  const item = data?.data?.[0];
  let buffer: Buffer;
  if (item?.b64_json) {
    buffer = Buffer.from(item.b64_json, "base64");
  } else if (item?.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
    buffer = Buffer.from(await img.arrayBuffer());
  } else {
    throw new Error("Image generation returned no image");
  }
  const saved = await storagePut(`${opts.folder ?? "images"}/image.png`, buffer, "image/png");
  return { url: saved.url };
}
