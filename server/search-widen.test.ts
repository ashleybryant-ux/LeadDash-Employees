import { describe, expect, it } from "vitest";
import { withRealSource } from "./employees/tasks";
import { googleQueries } from "./employees/apply";

describe("wider opportunity searches", () => {
  it("keeps an opportunity found on a roundup page that came up in the search", () => {
    const sources = [{ url: "https://www.roundup.com/pitch-competitions-2026" }];
    const kept = withRealSource(
      [
        { title: "A", sourceUrl: "https://contest-a.org/apply", foundOn: "https://www.roundup.com/pitch-competitions-2026" },
        { title: "B", sourceUrl: "https://from-memory.org/x", foundOn: "" },
      ],
      sources
    );
    expect(kept.map((k) => k.title)).toEqual(["A"]);
  });

  it("builds several Google searches per kind, with the workspace's state and the person's focus", () => {
    const q = googleQueries("pitch", "Oklahoma", "health tech");
    expect(q.length).toBeGreaterThanOrEqual(6);
    expect(q[0]).toContain("health tech");
    expect(q.some((x) => x.includes("Oklahoma"))).toBe(true);
    expect(googleQueries("pitch", "").every(Boolean)).toBe(true);
  });
});
