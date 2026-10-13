import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { OPENAI_VOICES, VOICES, backupOf, usageFor, voiceFor } from "./employees/huddle";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("photos and voices", () => {
  it("shows every option with prices, keeps a workspace's own voice per employee, and the photo shows everywhere", async () => {
    const { orgId, owner } = await makeWorkspace("voices");
    const me = caller(owner);
    let v = await me.voices.options({ organizationId: orgId });
    // No ElevenLabs key in tests: the automatic setting speaks with OpenAI, each role with its standard voice.
    expect(v.setting).toBe("auto");
    expect(v.provider).toBe("openai");
    expect(v.hasElevenLabs).toBe(false);
    expect(v.openai.map((x) => x.id)).toEqual(OPENAI_VOICES.map((x) => x.id));
    // The providers and what they cost LeadDash are its trade secret: the workspace sees its own prices, staff get LeadDash's cost.
    expect(v.prices.openai.perMinute).toBe("Included");
    expect(v.prices.openai.detail).toBe("");
    const { staff } = { staff: (await db.getUserByEmail("staff@leaddash.io"))! };
    const sv = await caller(staff).voices.options({ organizationId: orgId });
    expect(sv.prices.openai.perMinute).toMatch(/\$0\.015 per minute/);
    expect(sv.prices.elevenlabs.detail).toMatch(/Starter \$6/);
    const simone = v.employees.find((e) => e.kind === "coo")!;
    expect(simone).toMatchObject({ provider: "openai", voiceId: VOICES.coo, voiceName: "Coral", own: false });

    // The owner picks Marin for Simone; the huddle and one-on-ones use it.
    v = await me.voices.setEmployee({ organizationId: orgId, employeeId: simone.id, choice: { provider: "openai", voiceId: "marin", voiceName: "Marin" } });
    expect(v.employees.find((e) => e.kind === "coo")).toMatchObject({ provider: "openai", voiceId: "marin", voiceName: "Marin", own: true });
    expect(await voiceFor(orgId, "coo")).toEqual({ provider: "openai", id: "marin", name: "Marin" });
    await expect(me.voices.setEmployee({ organizationId: orgId, employeeId: simone.id, choice: { provider: "openai", voiceId: "nobody", voiceName: "x" } })).rejects.toThrow(/one of OpenAI's voices/);
    // Back to the standard voice for the role.
    v = await me.voices.setEmployee({ organizationId: orgId, employeeId: simone.id, choice: null });
    expect(v.employees.find((e) => e.kind === "coo")).toMatchObject({ voiceId: VOICES.coo, own: false });

    // The provider for the whole workspace.
    v = await me.voices.setProvider({ organizationId: orgId, setting: "openai" });
    expect(v.setting).toBe("openai");
    expect((await db.getOrganizationById(orgId))!.voiceProvider).toBe("openai");
    // ElevenLabs chosen with no key on the server still speaks with OpenAI rather than going silent.
    v = await me.voices.setProvider({ organizationId: orgId, setting: "elevenlabs" });
    expect(v.provider).toBe("openai");

    // A photo uploaded for an employee is the one every screen reads.
    const r = await me.employees.uploadPhoto({ organizationId: orgId, id: simone.id, data: PNG });
    expect(r.avatar).toMatch(/^\/files\/org-\d+\/employees\/coo-/);
    expect((await me.employees.list({ organizationId: orgId })).find((e) => e.id === simone.id)!.avatar).toBe(r.avatar);
    expect((await me.voices.options({ organizationId: orgId })).employees.find((e) => e.id === simone.id)!.avatar).toBe(r.avatar);
    expect((await me.setup.get({ organizationId: orgId })).team.find((e) => e.id === simone.id)!.avatar).toBe(r.avatar);
    await me.employees.removePhoto({ organizationId: orgId, id: simone.id });
    expect((await me.employees.list({ organizationId: orgId })).find((e) => e.id === simone.id)!.avatar).toBeNull();
  });
});

describe("LeadDash voices, backups and the month's cost", () => {
  afterEach(() => {
    delete process.env.LOCAL_TTS_URL;
    vi.restoreAllMocks();
  });

  it("speaks with LeadDash voices once the server has them, keeps ElevenLabs then OpenAI as backups, and only staff set the order", async () => {
    process.env.LOCAL_TTS_URL = "http://127.0.0.1:8880/v1/";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ voices: ["af_bella", "af_heart", "am_michael", "bf_emma", "jf_alpha"] }), { status: 200, headers: { "content-type": "application/json" } }));
    const { orgId, owner } = await makeWorkspace("local-voices");
    const me = caller(owner);
    const staff = caller((await db.getUserByEmail("staff@leaddash.io"))!);

    let v = await staff.voices.options({ organizationId: orgId });
    expect(v.hasLocal).toBe(true);
    expect(v.provider).toBe("local");
    // Only the English voices from the server's list, named the way people read them.
    expect(v.local.map((x) => x.id)).toEqual(["af_bella", "af_heart", "am_michael", "bf_emma"]);
    expect(v.local[2]).toEqual({ id: "am_michael", name: "Michael", note: "Male, American" });
    expect(v.employees.find((e) => e.kind === "coo")).toMatchObject({ provider: "local", voiceId: "af_bella", voiceName: "Bella", own: false });
    expect(v.prices.local.perMinute).toBe("$0.00 per minute");
    expect(v.backup).toEqual(["elevenlabs", "openai"]);

    // An employee's own LeadDash voice.
    const simone = v.employees.find((e) => e.kind === "coo")!;
    v = await me.voices.setEmployee({ organizationId: orgId, employeeId: simone.id, choice: { provider: "local", voiceId: "af_heart", voiceName: "Heart" } });
    expect(await voiceFor(orgId, "coo")).toEqual({ provider: "local", id: "af_heart", name: "Heart" });
    await expect(me.voices.setEmployee({ organizationId: orgId, employeeId: simone.id, choice: { provider: "local", voiceId: "nobody", voiceName: "x" } })).rejects.toThrow(/LeadDash voices/);

    // The backup order names the providers, so only LeadDash staff set it.
    await expect(me.voices.setBackup({ organizationId: orgId, order: ["openai"] })).rejects.toThrow(/LeadDash staff/);
    v = await staff.voices.setBackup({ organizationId: orgId, order: ["openai", "elevenlabs"] });
    expect(v.backup).toEqual(["openai", "elevenlabs"]);
    v = await staff.voices.setBackup({ organizationId: orgId, order: ["openai", "openai"] });
    expect(v.backup).toEqual(["openai"]);
    expect(backupOf({ voiceBackup: "not json" })).toEqual(["elevenlabs", "openai"]);
    expect(backupOf({ voiceBackup: "[]" })).toEqual([]);

    // Main voice: LeadDash voices chosen outright; with the server's voices gone it falls back to OpenAI here.
    v = await staff.voices.setProvider({ organizationId: orgId, setting: "local" });
    expect(v.setting).toBe("local");
    expect(v.provider).toBe("local");
    delete process.env.LOCAL_TTS_URL;
    expect((await me.voices.options({ organizationId: orgId })).provider).toBe("openai");
  });

  it("shows staff each provider at LeadDash's cost, and the workspace Standard as included and Premium at 1.5x", async () => {
    const { orgId } = await makeWorkspace("voice-usage");
    const now = new Date("2026-10-13T15:00:00Z");
    db.addVoiceUsage(orgId, "local", 412_000, now);
    db.addVoiceUsage(orgId, "elevenlabs", 30_000, now);
    db.addVoiceUsage(orgId, "elevenlabs", 8_000, now);
    db.addVoiceUsage(orgId, "openai", 6_000, now);
    db.addVoiceUsage(orgId, "openai", 9_999, new Date("2026-09-30T15:00:00Z"));

    const mine = usageFor(orgId, true, now);
    expect(mine.period).toBe("Oct 1 to Oct 13, 2026");
    expect(mine.rows).toEqual([
      { key: "local", label: "LeadDash voices", minutes: 412, cost: "$0.00" },
      { key: "elevenlabs", label: "ElevenLabs", minutes: 38, cost: "$3.42" },
      { key: "openai", label: "OpenAI", minutes: 6, cost: "$0.09" },
    ]);
    expect(mine.total).toEqual({ minutes: 456, cost: "$3.51" });

    const theirs = usageFor(orgId, false, now);
    expect(theirs.rows).toEqual([
      { key: "standard", label: "Standard", minutes: 418, cost: "Included" },
      { key: "premium", label: "Premium", minutes: 38, cost: "$5.13" },
    ]);
    expect(theirs.total).toEqual({ minutes: 456, cost: "$5.13" });
    // A workspace that used only the standard voices pays nothing for them.
    const { orgId: other } = await makeWorkspace("voice-usage-standard");
    db.addVoiceUsage(other, "openai", 2_000, now);
    expect(usageFor(other, false, now).rows).toEqual([{ key: "standard", label: "Standard", minutes: 2, cost: "Included" }]);
    expect(usageFor(other, false, now).total.cost).toBe("Included");
  });
});
