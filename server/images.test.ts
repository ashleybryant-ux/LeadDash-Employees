import { describe, expect, it } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { copyImages } from "../deploy/copy-images";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("photos in the Brain", () => {
  it("copies a workspace's photos into another workspace once, with their notes, as that workspace's own files", async () => {
    const a = await makeWorkspace("img-a");
    const b = await makeWorkspace("img-b");
    await caller(a.owner).knowledge.uploadImage({ organizationId: a.orgId, title: "Headshot white dress", note: "Lobby, smiling", data: PNG });
    await caller(a.owner).knowledge.uploadImage({ organizationId: a.orgId, title: "Tweed dress outdoors", note: "", data: PNG });
    expect(await copyImages(a.orgId, b.orgId)).toEqual({ copied: 2, total: 2 });
    expect(await copyImages(a.orgId, b.orgId)).toEqual({ copied: 0, total: 2 });
    const imgs = (await db.listKnowledgeByOrg(b.orgId)).filter((k) => k.kind === "image");
    expect(imgs.map((i) => i.title).sort()).toEqual(["Headshot white dress", "Tweed dress outdoors"]);
    expect(imgs.find((i) => i.title === "Headshot white dress")!.content).toBe("Lobby, smiling");
    expect(imgs.every((i) => i.fileUrl!.startsWith(`/files/org-${b.orgId}/`))).toBe(true);
  });
});
