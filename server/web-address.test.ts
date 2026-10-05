import { describe, expect, it, vi } from "vitest";

let found: any = { data: { url: "https://scra.org/accelerate" }, sources: [{ url: "https://scra.org/accelerate", title: "SC Accelerate" }] };
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return { ...actual, searchJson: vi.fn(async () => found) };
});
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (host: string) => { if (host.endsWith("scra.org")) return { address: "1.2.3.4" }; throw new Error("ENOTFOUND"); }) }));

import * as web from "./employees/web";

describe("the browser and web addresses", () => {
  it("turns Playwright's error into one plain sentence", () => {
    const raw = 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.acceleratesc.org/\nCall log:\n\u001b[2m  - navigating to "https://www.acceleratesc.org/", waiting until "domcontentloaded"\u001b[22m\n';
    expect(web.plainNote(raw, "https://www.acceleratesc.org/")).toBe("there's no website at acceleratesc.org");
    expect(web.plainNote("page.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting", "https://a.example/x")).toBe("a.example took too long to load");
  });

  it("finds the real site when an address doesn't exist, but only one a search returned", async () => {
    expect(await web.siteExists("https://www.acceleratesc.org/")).toBe(false);
    expect(await web.findRealSite("Find the application deadline for the SC Accelerate pitch", "https://www.acceleratesc.org/")).toBe("https://scra.org/accelerate");
    // An address the search didn't actually show is never used.
    found = { data: { url: "https://scra.org/made-up" }, sources: [{ url: "https://other.example/page", title: "x" }] };
    expect(await web.findRealSite("Find it", "https://www.acceleratesc.org/")).toBeNull();
  });
});
