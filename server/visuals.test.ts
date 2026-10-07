import { describe, expect, it, vi } from "vitest";

let decision: any = null;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "chat_decision") return decision;
      if (opts.schemaName === "org_chart") {
        return { title: "AI team", boxes: [
          { id: "a", name: "Dr. Ashley Bryant", role: "CEO", parent: "", group: "" },
          { id: "c", name: "Caroline", role: "Director of Client Success and AI Team Manager", parent: "a", group: "" },
          { id: "g", name: "Growth", role: "Sales", parent: "c", group: "Riley, Jada" },
          { id: "o", name: "Operations", role: "Running the business", parent: "c", group: "Avery, Quinn, Simone, Nora" },
          { id: "x", name: "Loop", role: "Bad answer", parent: "y", group: "" },
          { id: "y", name: "Loop two", role: "Bad answer", parent: "x", group: "" },
        ] };
      }
      return {};
    }),
    generateText: vi.fn(async () => "# AI team management structure\n\n## Roles\n- **Ashley:** sets goals\n- **Caroline:** runs the day to day"),
  };
});

import sharp from "sharp";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";

const blank = { thinking: "", reply: "", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

describe("any employee makes a document or an org chart itself", () => {
  it("Quinn draws the org chart as a picture and writes the structure as a document that opens in chat", async () => {
    const { orgId, owner } = await makeWorkspace("visuals");
    const quinn = (await db.getEmployeeByKind(orgId, "hiring"))!;

    decision = { ...blank, action: "make_chart", title: "AI team management structure", reply: "Drawing it." };
    let r = await caller(owner).chat.send({ organizationId: orgId, employeeId: quinn.id, text: "The org chart should be an actual image." });
    const chart = JSON.parse(r.reply.cards!)[0];
    expect(chart).toMatchObject({ type: "image", title: "AI team management structure" });
    expect(chart.imageUrl).toMatch(/\.png$/);
    const file = db.getChatFiles(orgId, [chart.id])[0];
    expect(file).toMatchObject({ kind: "image", mime: "image/png" });
    expect(file.text).toContain("Caroline, Director of Client Success");

    decision = { ...blank, action: "write_doc", title: "AI team management structure", notes: "roles, approval lines, rhythm", reply: "Writing it." };
    r = await caller(owner).chat.send({ organizationId: orgId, employeeId: quinn.id, text: "draft that as a document" });
    const doc = JSON.parse(r.reply.cards!)[0];
    expect(doc).toMatchObject({ type: "doc", title: "AI team management structure", subtitle: "Word document · 1 section" });
    expect(db.getChatFiles(orgId, [doc.id])[0].text).toContain("## Roles");
    expect(r.reply.content).toContain("Press Open to read it here");
  });

  it("the chart is a real image even when the answer has a loop in it", async () => {
    const { renderOrgChart } = await import("./employees/visuals");
    const png = await renderOrgChart("Test", [
      { id: "a", name: "Top", role: "CEO", parent: "", group: "" },
      { id: "x", name: "Loop", role: "r", parent: "y", group: "" },
      { id: "y", name: "Loop two", role: "r", parent: "x", group: "" },
    ]);
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBeGreaterThan(600);
  });
});
