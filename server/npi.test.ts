import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as sales from "./employees/sales";
import { parseArea, npiPractices } from "./employees/npi";

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const npiUrls: string[] = [];
const RESULTS = [
  { number: 1234567890, basic: { organization_name: "LONE STAR COUNSELING PLLC", authorized_official_first_name: "JORDAN", authorized_official_last_name: "HALE", authorized_official_title_or_position: "OWNER", status: "A" }, addresses: [{ address_purpose: "MAILING", city: "DALLAS", state: "TX" }, { address_purpose: "LOCATION", city: "FORT WORTH", state: "TX", telephone_number: "817-555-0100" }], taxonomies: [{ desc: "Counselor", primary: true }] },
  { number: 2222222222, basic: { organization_name: "OKLAHOMA PLACE LLC", status: "A" }, addresses: [{ address_purpose: "LOCATION", city: "TULSA", state: "OK" }], taxonomies: [{ desc: "Counselor", primary: true }] },
];

let llm: typeof import("./_core/llm");
beforeEach(async () => {
  npiUrls.length = 0;
  llm = await import("./_core/llm");
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).startsWith("https://npiregistry.cms.hhs.gov/api/")) {
      npiUrls.push(String(url));
      return json({ result_count: RESULTS.length, results: RESULTS });
    }
    return json({ error: "no route" }, 500);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NPI Registry", () => {
  it("reads states and cities from the area", () => {
    expect(parseArea("Texas")).toEqual([{ state: "TX" }]);
    expect(parseArea("Austin, TX")).toEqual([{ state: "TX", city: "Austin" }]);
    expect(parseArea("Oklahoma and Texas")).toEqual([{ state: "OK" }, { state: "TX" }]);
    expect(parseArea("the whole country")).toEqual([]);
  });

  it("keeps active practices in the state, with the owner and phone", async () => {
    const list = await npiPractices([{ state: "TX" }], ["practices"]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Lone Star Counseling PLLC", city: "Fort Worth, TX", phone: "817-555-0100", official: "Jordan Hale", officialTitle: "Owner" });
    expect(npiUrls[0]).toContain("enumeration_type=NPI-2");
    expect(npiUrls.some((u) => u.includes("taxonomy_description=Counselor") && u.includes("state=TX"))).toBe(true);
  });

  it("Riley starts from NPI practices and fills the phone and owner from the record", async () => {
    let prompt = "";
    vi.spyOn(llm, "searchJson").mockImplementation(async (opts: any) => {
      prompt = opts.prompt;
      return {
        data: { items: [{ name: "Lone Star Counseling PLLC", city: "", contactName: "", contactTitle: "", email: "", phone: "", website: "", foundOn: "", sourceUrl: "https://npiregistry.cms.hhs.gov/provider-view/1234567890", size: "", partnerType: "", fitScore: 60, fitReason: "Group practice with no online booking." }] },
        sources: [{ url: "https://bhec.texas.gov/verify", title: "License lookup" }],
        queries: ["Lone Star Counseling Fort Worth"],
      } as any;
    });
    const { orgId, owner } = await makeWorkspace("npi-riley");
    await caller(owner).sales.saveSettings({ organizationId: orgId, sells: "software", area: "Texas" });
    const r = await sales.findProspects(orgId);
    expect(prompt).toContain("NPI Registry");
    expect(prompt).toContain("Lone Star Counseling PLLC | Fort Worth, TX | 817-555-0100 | Jordan Hale, Owner");
    expect(r.created).toHaveLength(1);
    const p = (await db.listProspects(orgId))[0];
    expect(p).toMatchObject({ phone: "817-555-0100", contactName: "Jordan Hale", contactTitle: "Owner", city: "Fort Worth, TX", foundOn: "NPI Registry" });
    expect(JSON.parse(p.details!).npi).toBe("1234567890");
  });
});
