import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { browserReady, liveHandBack, liveInput, liveTakeOver, liveView, runBrowserTask, type Action, type PageView } from "./employees/browser";

// On a machine without Chromium yet, these skip instead of blocking a deploy.
const ready = await browserReady();
if (!ready) console.warn("Chromium is not installed here, so the browser tests were skipped.");

// A tiny fake portal: sign in (email, password, then a code), a list of bids, a document, and a submit button.
let server: http.Server;
let base = "";
const seen: { password?: string; code?: string; submitted?: boolean } = {};
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/") return res.end(page(`<form action="/login"><label for="e">Email</label><input id="e" name="e"><label for="p">Password</label><input id="p" name="p" type="password"><button>Sign in</button></form>`));
    if (url.pathname === "/login") {
      seen.password = url.searchParams.get("p") ?? undefined;
      return res.end(page(`<form action="/code"><label for="c">Verification code</label><input id="c" name="c"><button>Verify</button></form>`));
    }
    if (url.pathname === "/code") {
      seen.code = url.searchParams.get("c") ?? undefined;
      return res.end(page(`<h1>Leads inbox</h1><a href="/bid/1">County EHR System</a><a href="/doc.pdf">RFP document</a><form action="/submit"><button>Submit response</button></form>`));
    }
    if (url.pathname === "/home") return res.end(page(`<a href="/" target="_blank">Log In</a>`));
    if (url.pathname === "/doc.pdf") {
      res.setHeader("content-type", "application/pdf");
      return res.end("%PDF-1.4 fake");
    }
    if (url.pathname === "/submit") {
      seen.submitted = true;
      return res.end(page(`<p>Confirmation BF-118</p>`));
    }
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const el = (v: PageView, words: RegExp) => v.elements.find((e) => words.test(`${e.label} ${e.text}`))!.i;
const act = (a: Partial<Action>): Action => ({ thought: "", action: "wait", index: -1, value: "", secret: "", fileIndex: -1, result: "", ...a });

/** A scripted driver standing in for the AI. */
function driver(opts: { submit: boolean }) {
  return async (v: PageView): Promise<Action> => {
    if (/Email/.test(v.text) && v.elements.some((e) => e.label === "Email" && !e.text)) return act({ action: "type", index: el(v, /^Email/), secret: "email" });
    if (v.elements.some((e) => e.type === "password" && !e.text)) return act({ action: "type", index: v.elements.find((e) => e.type === "password")!.i, secret: "password" });
    if (/Sign in/.test(v.text)) return act({ action: "click", index: el(v, /Sign in/) });
    if (/Verification code/.test(v.text)) {
      const box = v.elements.find((e) => /Verification/.test(e.label))!;
      if (!box.text) return act({ action: "type", index: box.i, secret: "code" });
      return act({ action: "click", index: el(v, /Verify/) });
    }
    if (/Leads inbox/.test(v.text)) {
      if (opts.submit) return act({ action: "click", index: el(v, /Submit response/) });
      return act({ action: "done", result: JSON.stringify({ bids: [{ title: "County EHR System", agency: "Oklahoma County" }] }) });
    }
    if (/Confirmation/.test(v.text)) return act({ action: "done", result: JSON.stringify({ confirmation: "BF-118" }) });
    return act({ action: "fail", result: "lost" });
  };
}

describe.skipIf(!ready)("the server's browser", () => {
  it("signs in with saved values the AI never sees, and stops to ask for a code", async () => {
    const views: string[] = [];
    const d = driver({ submit: false });
    const r = await runBrowserTask({
      orgId: 1,
      goal: "read leads",
      startUrl: base,
      secrets: { email: "a@b.co", password: "s3cret-pw" },
      decide: async (v) => {
        views.push(JSON.stringify(v));
        const a = await d(v);
        // No code saved: the AI would ask for one.
        return a.secret === "code" ? act({ action: "need_code" }) : a;
      },
    });
    expect(r.status).toBe("need_code");
    expect(seen.password).toBe("s3cret-pw");
    expect(views.join("")).not.toContain("s3cret-pw");
    expect(r.storageState).toBeTruthy();
  }, 60_000);

  it("with the code, reads the list; a submit button is refused unless approved", async () => {
    const r = await runBrowserTask({ orgId: 1, goal: "read leads", startUrl: base, secrets: { email: "a@b.co", password: "pw", code: "482915" }, decide: driver({ submit: false }) });
    expect(r.status).toBe("done");
    expect(seen.code).toBe("482915");
    expect(JSON.parse(r.result).bids[0].title).toBe("County EHR System");

    seen.submitted = false;
    const blocked = await runBrowserTask({ orgId: 1, goal: "try to submit", startUrl: base, secrets: { email: "a@b.co", password: "pw", code: "1234" }, decide: driver({ submit: true }), maxSteps: 8 });
    expect(seen.submitted).toBe(false);
    expect(blocked.log.some((l) => /not allowed/.test(l.detail))).toBe(true);

    const ok = await runBrowserTask({ orgId: 1, goal: "submit", startUrl: base, secrets: { email: "a@b.co", password: "pw", code: "1234" }, decide: driver({ submit: true }), allowSubmit: true, maxSteps: 12 });
    expect(seen.submitted).toBe(true);
    expect(JSON.parse(ok.result).confirmation).toBe("BF-118");
    expect(ok.screenshotUrl).toMatch(/^\/files\//);
  }, 90_000);

  it("won't stop for a code on a page with no code box", async () => {
    let n = 0;
    const r = await runBrowserTask({
      orgId: 1,
      goal: "read leads",
      startUrl: base,
      secrets: { email: "a@b.co", password: "pw" },
      decide: async () => (n++ === 0 ? act({ action: "need_code" }) : act({ action: "fail", result: "stopped for the test" })),
    });
    expect(r.status).toBe("failed");
    expect(r.log[0].detail).toMatch(/no code box/);
  }, 60_000);

  it("follows a Log In link that opens a new tab", async () => {
    let clicked = false;
    const urls: string[] = [];
    const r = await runBrowserTask({
      orgId: 1,
      goal: "open sign in",
      startUrl: `${base}/home`,
      decide: async (v) => {
        urls.push(v.url);
        if (!clicked) {
          clicked = true;
          return act({ action: "click", index: el(v, /Log In/) });
        }
        return act({ action: "done", result: v.url });
      },
    });
    expect(r.status).toBe("done");
    expect(r.result).toBe(`${base}/`);
  }, 60_000);

  it("streams the page live, waits when stuck, lets the person take over, then keeps going", async () => {
    let stuck = false;
    let handedBack = false;
    const job = runBrowserTask({
      orgId: 77,
      goal: "read leads",
      startUrl: base,
      secrets: { email: "a@b.co", password: "pw" },
      live: { id: "s1", holdMs: 20_000, onStuck: async () => { stuck = true; } },
      decide: async (v, history) => {
        if (history.some((h) => h.action === "person")) {
          handedBack = true;
          return act({ action: "done", result: v.url });
        }
        return act({ action: "fail", result: "a page I don't understand" });
      },
    });
    while (!stuck) await new Promise((r) => setTimeout(r, 100));
    expect(liveView(77)).toMatchObject({ id: "s1", state: "waiting", reason: "a page I don't understand" });
    expect(liveView(77).frame).toMatch(/^data:image\/jpeg;base64,/);
    await expect(liveInput(77, "s1", { kind: "click", x: 0.1, y: 0.1 })).rejects.toThrow(/Take over/);
    liveTakeOver(77, "s1");
    expect(liveView(77).state).toBe("control");
    // The person clicks the email box and types; the employee waits meanwhile.
    await liveInput(77, "s1", { kind: "type", text: "hello" });
    liveHandBack(77, "s1");
    const r = await job;
    expect(handedBack).toBe(true);
    expect(r.status).toBe("done");
    expect(r.helped.join(" ")).toMatch(/typed into a box/);
    expect(liveView(77).state).toBe("done");
  }, 60_000);

  it("downloads a linked document", async () => {
    let asked = false;
    const r = await runBrowserTask({
      orgId: 1,
      goal: "download",
      startUrl: `${base}/code?c=1`,
      decide: async (v) => {
        if (!asked) {
          asked = true;
          return act({ action: "download", index: el(v, /RFP document/) });
        }
        return act({ action: "done", result: "ok" });
      },
    });
    expect(r.downloads.map((d) => d.name)).toContain("doc.pdf");
    expect(r.downloads[0].buf.toString()).toContain("%PDF");
  }, 60_000);
});
