import { describe, expect, it } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { OPENAI_VOICES, VOICES, voiceFor } from "./employees/huddle";

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
    expect(v.prices.openai.perMinute).toMatch(/\$0\.015 per minute/);
    expect(v.prices.elevenlabs.detail).toMatch(/Starter \$6/);
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
