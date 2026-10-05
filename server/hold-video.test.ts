import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as integrations from "./integrations";
import { encryptJson } from "./_core/crypto";
import { saveOps, opsFor } from "./employees/ops";

const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

async function hold(orgId: number, attendees: string[]) {
  const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
  return db.createOutboundItem({ organizationId: orgId, employeeId: avery.id, kind: "calendar_hold", status: "approved", title: "Call with Riverbend", body: "Agenda: pricing", targetChannels: JSON.stringify(["Google Calendar"]), metadata: JSON.stringify({ date: "2026-10-20", time: "2:00 PM", attendees, linkId: null }) });
}

describe("Avery's booked calls", () => {
  it("get a Zoom link and send invites when Zoom is the meeting link; a hold with no guests stays quiet", async () => {
    const { orgId } = await makeWorkspace("hold-video");
    const conn = (provider: any) => db.upsertExternalConnection({ organizationId: orgId, provider, accountLabel: provider, status: "connected", settings: "{}", secretsEncrypted: encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });
    await conn("google_workspace");
    await conn("zoom");
    const { ops } = await opsFor(orgId);
    await saveOps(orgId, { ...ops, meetingLink: "zoom" } as any);
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (/api\.zoom\.us\/v2\/users\/me\/meetings/.test(url)) return json({ id: 123, join_url: "https://us02web.zoom.us/j/123" });
      return json({ id: "ev1", htmlLink: "https://calendar.google.com/ev1" });
    });

    const r = await integrations.dispatch((await hold(orgId, ["lauren@riverbend.com"]))!);
    expect(r.results[0].ok).toBe(true);
    const zoom = calls.find((c) => /zoom\.us\/v2\/users\/me\/meetings/.test(c.url))!;
    expect(zoom.body.start_time).toBe("2026-10-20T19:00:00Z");
    const ev = calls.find((c) => /googleapis\.com\/calendar/.test(c.url))!;
    expect(ev.url).toMatch(/sendUpdates=all/);
    expect(ev.body.location).toBe("https://us02web.zoom.us/j/123");
    expect(ev.body.description).toMatch(/^Join on Zoom: https:\/\/us02web\.zoom\.us\/j\/123/);
    expect(integrations.meetingLinkOf(ev.body)).toEqual({ platform: "zoom", url: "https://us02web.zoom.us/j/123" });

    calls.length = 0;
    await integrations.dispatch((await hold(orgId, []))!);
    expect(calls.some((c) => /zoom\.us/.test(c.url))).toBe(false);
    expect(calls.find((c) => /googleapis/.test(c.url))!.url).toMatch(/sendUpdates=none/);
  });
});
