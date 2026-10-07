import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { uploadsRoot } from "./storage";
import { renderCard } from "./employees/graphic";

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

  it("renders the three shapes, shrinking a long headline to fit", async () => {
    const spec = { headline: "Your intake form should not take longer than the session itself, and your notes should be done before you leave.", emphasis: "longer", subline: "", background: "#0d3b2e", accent: "#d6a74a", text: "#ffffff", subtext: "#efe7d6", strip: "#14221c", stripText: "#ffffff" };
    for (const [shape, w, h] of [["square", 1080, 1080], ["portrait", 1080, 1350], ["story", 1080, 1920]] as const) {
      const png = await renderCard(spec, shape, null);
      const meta = await sharp(png).metadata();
      expect([meta.width, meta.height]).toEqual([w, h]);
    }
  });
});
