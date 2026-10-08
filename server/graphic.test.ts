import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { uploadsRoot } from "./storage";
import { renderCard, renderIllustrated, wordsOnly } from "./employees/graphic";
import { storagePut } from "./storage";

const blank = { reply: "", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

afterEach(() => vi.restoreAllMocks());

describe("Sienna makes the graphic herself", () => {
  it("draws a text card with the exact words in the brand colors, puts it on the post, and never hands it off", async () => {
    const { orgId, owner } = await makeWorkspace("graphic");
    await db.updateOrganization(orgId, { brandColors: JSON.stringify(["#0d3b2e", "#d6a74a"]) });
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const post = await db.createOutboundItem({ organizationId: orgId, employeeId: sienna.id, kind: "social_post", status: "pending_approval", title: "Notes still waiting", body: "9 PM. Session done. Notes still waiting. DashNotes writes them while you work.", targetChannels: JSON.stringify(["instagram"]), imageUrl: "/files/old.png", metadata: JSON.stringify({ platforms: ["instagram"], post: { type: "post", mode: "same", variants: {}, imageMeta: { w: 1024, h: 1536 } } }) });

    const systems: string[] = [];
    const llm = await import("./_core/llm");
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName === "chat_decision") {
        systems.push(opts.system);
        return { ...blank, action: "post_graphic", focus: "text", notes: "forest green card, the headline, waiting in gold", reply: "Making it." } as any;
      }
      if (opts.schemaName === "graphic_spec") return { headline: "9 PM. Session done. Notes still waiting.", emphasis: "waiting", subline: "DashNotes writes them while you work.", background: "#0d3b2e", accent: "#d6a74a", text: "#ffffff", subtext: "#efe7d6", strip: "#14221c", stripText: "#ffffff" };
      return {} as any;
    });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: sienna.id, text: "Make a graphic" });
    expect(r.reply.content).toBe('Here\'s the graphic: "9 PM. Session done. Notes still waiting." with "waiting" in #d6a74a on #0d3b2e, and "DashNotes writes them while you work." under it. It\'s on the post now. Tell me what to change, or approve the post.');
    expect(systems[0]).toContain("Never say you can't build image files");

    const after = (await db.getOutboundItemForOrg(post.id, orgId))!;
    expect(after.imageUrl).toMatch(new RegExp(`^/files/org-${orgId}/social/graphic-${post.id}-\\d+(_[0-9a-f]+)?\\.png$`));
    const file = path.join(uploadsRoot(), after.imageUrl!.slice("/files/".length));
    expect(fs.existsSync(file)).toBe(true);
    // Instagram post: portrait.
    const meta = await sharp(file).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
    const saved = JSON.parse(after.metadata || "{}");
    expect(saved.graphic).toMatchObject({ headline: "9 PM. Session done. Notes still waiting.", emphasis: "waiting", shape: "portrait" });
    expect(saved.post.imageMeta).toEqual({ w: 1080, h: 1350 });
    const card = JSON.parse(r.reply.cards!)[0];
    expect(card).toMatchObject({ type: "post", id: post.id, imageUrl: after.imageUrl });
  });

  it("draws a real picture for the graphic and sets the exact headline under it", async () => {
    const { orgId, owner } = await makeWorkspace("graphic-art");
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const post = await db.createOutboundItem({ organizationId: orgId, employeeId: sienna.id, kind: "social_post", status: "pending_approval", title: "$299 covers more", body: "I built LeadDash because I was paying five separate bills to run one practice.", targetChannels: JSON.stringify(["linkedin"]), metadata: JSON.stringify({ platforms: ["linkedin"], post: { type: "post", mode: "same", variants: {} } }) });
    const prompts: string[] = [];
    const images = await import("./_core/imageGeneration");
    vi.spyOn(images, "generateImage").mockImplementation(async (opts: any) => {
      prompts.push(opts.prompt);
      const art = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#f3dcc0" } }).png().toBuffer();
      return storagePut(`org-${orgId}/social/art.png`, art, "image/png");
    });
    const llm = await import("./_core/llm");
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName === "chat_decision") return { ...blank, action: "post_graphic", focus: "text", notes: "make it a cartoon", reply: "Making it." } as any;
      if (opts.schemaName === "graphic_spec") {
        expect(opts.system).toContain("The picture is what stops the scroll");
        return { headline: "$299 covers more than you think", emphasis: "$299", subline: "One login. One bill. Everything included.", background: "#0d3b2e", accent: "#e88a3a", text: "#ffffff", subtext: "#efe7d6", strip: "#14221c", stripText: "#ffffff", scene: "A shopping cart piled high with a desk phone, a fax machine, a calendar and a laptop.", style: "Playful editorial cartoon" };
      }
      return {} as any;
    });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: sienna.id, text: "This is just copy on a card. Make it a cartoon." });
    expect(r.reply.content).toBe('Here\'s the graphic: playful editorial cartoon of a shopping cart piled high with a desk phone, a fax machine, a calendar and a laptop, with "$299 covers more than you think" and "One login. One bill. Everything included." designed into it. Check the words are spelled right. It\'s on the post now. Tell me what to change, or approve the post.');
    expect(prompts[0]).toContain("Style: Playful editorial cartoon");
    expect(prompts[0]).toContain('set this headline exactly, letter for letter, large and bold in a clean modern sans serif: "$299 covers more than you think"');
    expect(prompts[0]).toContain("square (1:1)");
    const after = (await db.getOutboundItemForOrg(post.id, orgId))!;
    const file = path.join(uploadsRoot(), after.imageUrl!.slice("/files/".length));
    expect([(await sharp(file).metadata()).width, (await sharp(file).metadata()).height]).toEqual([1080, 1080]);
    expect(JSON.parse(after.metadata!).graphic.art.style).toBe("Playful editorial cartoon");
  });

  it("makes a words-only card only when asked for just the words", () => {
    expect(wordsOnly("just the words on green")).toBe(true);
    expect(wordsOnly("no picture, text only")).toBe(true);
    expect(wordsOnly("make it a cartoon with the headline")).toBe(false);
  });

  it("renders the three shapes, shrinking a long headline to fit", async () => {
    const spec = { headline: "Your intake form should not take longer than the session itself, and your notes should be done before you leave.", emphasis: "longer", subline: "", background: "#0d3b2e", accent: "#d6a74a", text: "#ffffff", subtext: "#efe7d6", strip: "#14221c", stripText: "#ffffff" };
    for (const [shape, w, h] of [["square", 1080, 1080], ["portrait", 1080, 1350], ["story", 1080, 1920]] as const) {
      const png = await renderCard(spec, shape, null);
      const meta = await sharp(png).metadata();
      expect([meta.width, meta.height]).toEqual([w, h]);
      const art = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } }).png().toBuffer();
      const both = await sharp(await renderIllustrated(spec, shape, art, null, "LeadDash")).metadata();
      expect([both.width, both.height]).toEqual([w, h]);
    }
  });
});
