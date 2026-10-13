import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as vg from "./employees/videoGuides";
import { siteGoal } from "./employees/sops";

const files = ["playbook.md", "leaddash-ehr.md", "leaddash-employees.md", "leaddash-events.md"];
const text = (f: string) => fs.readFileSync(path.resolve("server/employees/videoGuides", f), "utf8");

describe("Video and SOP guides for Simone", () => {
  it("has the playbook and a guide for each LeadDash app, in the house style", () => {
    for (const f of files) {
      const t = text(f);
      expect(t.length).toBeGreaterThan(4000);
      expect(t).not.toMatch(/[–—]/);
      expect(t).not.toMatch(/\bNABC\b|\bassociation\b/i);
      expect(t).not.toMatch(/openai|anthropic|elevenlabs|fal\.ai|assemblyai|heygen|kling/i);
    }
    expect(vg.playbook()).toMatch(/Done when/);
    for (const k of Object.keys(vg.APPS) as vg.AppKey[]) {
      const { top, tasks, screens } = vg.partsOf(text(vg.APPS[k].file));
      expect(Object.keys(top).some((x) => x.startsWith("where"))).toBe(true);
      expect(Object.keys(top).some((x) => x.startsWith("never"))).toBe(true);
      expect(tasks.length).toBeGreaterThanOrEqual(25);
      expect(screens.length).toBeGreaterThanOrEqual(10);
      // Every task says where it starts and when it's done.
      for (const t of tasks) {
        expect(t.body, t.title).toMatch(/Starts on:/);
        expect(t.body, t.title).toMatch(/Done when:/);
      }
    }
  });

  it("knows the app from the address or the login's name", () => {
    expect(vg.appFor("https://demo.leaddash.io/calendar")).toBe("ehr");
    expect(vg.appFor(null, "LeadDash EHR")).toBe("ehr");
    expect(vg.appFor("events.leaddash.io/admin")).toBe("events");
    expect(vg.appFor("https://employees.leaddash.io/chats")).toBe("employees");
    expect(vg.appFor("https://example.com")).toBeNull();
  });

  it("gives a job only the parts it needs, and only in LeadDash's own workspaces", () => {
    const job = { title: "How to take an insurance payment", url: "https://demo.leaddash.io" };
    expect(vg.guideFor({ internal: false }, job)).toBeNull();
    const g = vg.guideFor({ internal: true }, job)!;
    expect(g.label).toBe("LeadDash EHR");
    expect(g.text).toMatch(/demo\.leaddash\.io/);
    expect(g.text).toMatch(/insurance payment/i);
    expect(g.text).toMatch(/Done when:/);
    expect(g.text.length).toBeLessThan(text("leaddash-ehr.md").length / 2);
    // The SOP site walk carries it ahead of its own instructions.
    expect(siteGoal("Insurance payment", g.text)).toMatch(/^What we know about this app/);
    expect(siteGoal("Insurance payment")).toMatch(/^You are writing/);
  });
});
