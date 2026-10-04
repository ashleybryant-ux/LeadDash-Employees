/**
 * Portraits for employees added after the original team sheet (Kai, Imani).
 * Runs on deploy: makes each missing portrait once with OpenAI's image model,
 * in the same style as the others, and gives it to that employee in every
 * workspace that hasn't picked a photo. Skips quietly when images aren't set up.
 *   npx tsx deploy/portraits.ts
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import * as db from "../server/db";
import { ENV } from "../server/_core/env";
import { uploadsRoot } from "../server/storage";
import { generateImage } from "../server/_core/imageGeneration";

const STYLE = "Warm professional headshot portrait, head and shoulders, softly smiling, looking at the camera, dark green blazer, soft natural light, a modern office background with muted green, terracotta and cream shapes, shallow depth of field, photorealistic, square crop.";
const PEOPLE: Record<string, string> = {
  developer: "A Black man in his early 30s with short twists and a neatly trimmed beard, thin black glasses.",
  onboarding: "A Black woman in her early 30s with long braids pulled back, small gold earrings, a friendly open expression.",
  platform: "A South Asian woman in her late 20s with shoulder-length wavy dark hair, small silver hoop earrings, a focused, friendly expression.",
};

(async () => {
  if (!ENV.openAiKey) {
    console.log("portraits: skipped (OPENAI_API_KEY is not set)");
    return;
  }
  const dir = path.join(uploadsRoot(), "roster");
  fs.mkdirSync(dir, { recursive: true });
  for (const [kind, who] of Object.entries(PEOPLE)) {
    const marker = path.join(dir, `${kind}.url`);
    let url = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
    if (!url) {
      try {
        url = (await generateImage({ prompt: `${who} ${STYLE}`, size: "1024x1024", quality: "medium", folder: "roster" })).url;
        fs.writeFileSync(marker, url);
        console.log(`portraits: made ${kind}`);
      } catch (err) {
        console.log(`portraits: ${kind} failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }
    }
    let set = 0;
    for (const orgId of await db.listAllOrganizationIds()) {
      const emp = await db.getEmployeeByKind(orgId, kind as never);
      if (emp && !emp.avatar) {
        await db.updateEmployee(emp.id, orgId, { avatar: url });
        set++;
      }
    }
    console.log(`portraits: ${kind} ready${set ? `, given to ${set} workspace${set === 1 ? "" : "s"}` : ""}`);
  }
})();
