import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateJson, type JsonSchema } from "../_core/llm";
import { storagePut } from "../storage";

/**
 * A real browser on the server that an employee drives one step at a time:
 * it reads the page (text plus a numbered list of what can be clicked or
 * typed into), picks one action, and repeats until the goal is met.
 *
 * Passwords and sign-in codes never reach the AI: it asks to type "the
 * password" and the browser fills the real value. Final-submit buttons are
 * refused unless the task was approved for submitting.
 */

/** content: a long block (a page's HTML) the browser pastes, so the AI never has to type it out. */
export type Secrets = { email?: string; password?: string; code?: string; content?: string };
export type BrowserFile = { path: string; name: string };
export type Download = { name: string; buf: Buffer; mime: string; url: string };
export type StepLog = { step: number; action: string; detail: string; url: string; title?: string; screenshotUrl?: string | null };

export type BrowserResult = {
  status: "done" | "need_code" | "failed";
  result: string;
  note: string;
  storageState: string | null;
  downloads: Download[];
  log: StepLog[];
  screenshotUrl: string | null;
  /** What the person did while they had control, to remember for next time. */
  helped: string[];
  /** The page the browser ended on. */
  url: string;
};

export type BrowserTask = {
  orgId: number;
  goal: string;
  startUrl: string;
  secrets?: Secrets;
  /** Saved cookies from the last run, so a sign-in code is rarely needed. */
  storageState?: string | null;
  /** Only true after the person approved the submission. */
  allowSubmit?: boolean;
  files?: BrowserFile[];
  maxSteps?: number;
  /** Who is doing the work, for the AI's instructions. */
  actor?: string;
  /** Buttons refused until the task is approved (default: final submits). */
  submitWords?: RegExp;
  /** Buttons refused even after approval (deleting, for example). */
  neverWords?: RegExp;
  /** Only these pages may be opened. Anything else is closed and the browser goes back to startUrl. */
  allowUrl?: (url: string) => boolean;
  /** Extra rules for the AI, added to the usual ones. */
  rules?: string;
  /** Lets the person watch in chat and take over. onStuck posts the "waiting for you" card. */
  live?: { id: string; onStuck?: (reason: string) => Promise<void>; holdMs?: number; label?: string };
  /** For tests: replaces the AI's choice of action. */
  decide?: (view: PageView, history: StepLog[]) => Promise<Action>;
  /** Keep a screenshot after every action (an SOP is written from them), saved under this folder. */
  shots?: string;
};

export type PageElement = { i: number; tag: string; type: string; label: string; text: string; href: string };
export type PageView = { url: string; title: string; text: string; elements: PageElement[] };

export type Action = {
  thought: string;
  action: "click" | "type" | "select" | "upload" | "press_enter" | "goto" | "wait" | "download" | "need_code" | "done" | "fail";
  index: number;
  value: string;
  secret: "" | "email" | "password" | "code" | "content";
  fileIndex: number;
  result: string;
};

const ACTION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["thought", "action", "index", "value", "secret", "fileIndex", "result"],
  properties: {
    thought: { type: "string", description: "One short sentence: what you see and why this action" },
    action: { type: "string", enum: ["click", "type", "select", "upload", "press_enter", "goto", "wait", "download", "need_code", "done", "fail"] },
    index: { type: "integer", description: "The element number for click, type, select, upload or download; -1 otherwise" },
    value: { type: "string", description: "Text to type, the option to select, or the URL for goto; '' otherwise" },
    secret: { type: "string", enum: ["", "email", "password", "code", "content"], description: "For type: fill a saved value instead of value" },
    fileIndex: { type: "integer", description: "For upload: which file from the file list; -1 otherwise" },
    result: { type: "string", description: "For done: the answer the goal asks for (JSON when asked); for fail: why; '' otherwise" },
  },
};

/** Buttons that finish a submission. Refused unless the task was approved to submit. */
export const SUBMIT_WORDS = /\b(submit|place bid|send bid|send response|finali[sz]e|sign and submit|certify and submit|complete submission)\b/i;

let running: Promise<unknown> = Promise.resolve();

// ==========================================
// Live view: watch the browser in chat and take over
// ==========================================

type Page = import("playwright-core").Page;
export type LiveState = "starting" | "running" | "waiting" | "control" | "done" | "stopped";
type Live = {
  id: string;
  orgId: number;
  state: LiveState;
  step: string;
  url: string;
  reason: string;
  frame: Buffer | null;
  frameAt: number;
  page: Page | null;
  stop: boolean;
  handBack: boolean;
  helped: string[];
};
const lives = new Map<number, Live>();

export function liveView(orgId: number) {
  const l = lives.get(orgId);
  if (!l) return { id: "", state: "none" as const, step: "", url: "", reason: "", frame: null as string | null, frameAt: 0 };
  return { id: l.id, state: l.state, step: l.step, url: l.url, reason: l.reason, frame: l.frame ? `data:image/jpeg;base64,${l.frame.toString("base64")}` : null, frameAt: l.frameAt };
}

/** Shows "Opening the browser" for a session that is queued but not started yet. */
export function liveStart(orgId: number, id: string) {
  const l = lives.get(orgId);
  if (l && l.page && l.state !== "done" && l.state !== "stopped") return;
  lives.set(orgId, { id, orgId, state: "starting", step: "Opening the browser", url: "", reason: "", frame: null, frameAt: 0, page: null, stop: false, handBack: false, helped: [] });
}

function liveFor(orgId: number, id: string) {
  const l = lives.get(orgId);
  if (!l || l.id !== id || l.state === "done" || l.state === "stopped") throw new Error("That browser session has ended.");
  return l;
}

export function liveTakeOver(orgId: number, id: string) {
  const l = liveFor(orgId, id);
  l.state = "control";
  return liveView(orgId);
}
export function liveHandBack(orgId: number, id: string) {
  const l = liveFor(orgId, id);
  if (l.state !== "control") return liveView(orgId);
  l.state = "running";
  l.handBack = true;
  return liveView(orgId);
}
export function liveStop(orgId: number, id: string) {
  const l = liveFor(orgId, id);
  l.stop = true;
  return liveView(orgId);
}

const KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
export type LiveInput = { kind: "click"; x: number; y: number } | { kind: "type"; text: string } | { kind: "key"; key: string } | { kind: "scroll"; dy: number };

/** The person's own click, typing or scroll, only while they have control. Typed text is never stored. */
export async function liveInput(orgId: number, id: string, input: LiveInput) {
  // A page that hangs mid-navigation never holds the person's buttons for long.
  return Promise.race([doInput(orgId, id, input), sleep(8000).then(() => liveView(orgId))]);
}

async function doInput(orgId: number, id: string, input: LiveInput) {
  const l = liveFor(orgId, id);
  if (l.state !== "control" || !l.page) throw new Error("Press Take over first.");
  const page = l.page;
  if (input.kind === "click") {
    const x = Math.round(Math.max(0, Math.min(1, input.x)) * VIEW.width);
    const y = Math.round(Math.max(0, Math.min(1, input.y)) * VIEW.height);
    const what = await page
      .evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py) as HTMLElement | null;
        if (!el || (el as HTMLInputElement).type === "password") return "";
        return (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 60);
      }, [x, y] as [number, number])
      .catch(() => "");
    await page.mouse.click(x, y);
    if (what) l.helped.push(`On ${pathOf(page.url())} they clicked "${what}"`);
  } else if (input.kind === "type") {
    await page.keyboard.type(input.text.slice(0, 500));
    l.helped.push(`On ${pathOf(page.url())} they typed into a box`);
  } else if (input.kind === "key") {
    if (!KEYS.has(input.key)) throw new Error("That key isn't supported.");
    await page.keyboard.press(input.key);
  } else {
    await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, input.dy)));
  }
  await page.waitForTimeout(300);
  await capture(l);
  l.helped = l.helped.slice(-8);
  return liveView(orgId);
}

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

async function capture(l: Live) {
  if (!l.page) return;
  try {
    l.frame = await l.page.screenshot({ type: "jpeg", quality: 55 });
    l.frameAt = Date.now();
    l.url = l.page.url();
  } catch {
    /* a page mid-navigation is caught on the next tick */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VIEW = { width: 1280, height: 900 };

/** One browser at a time keeps memory flat on a small server. */
export function runBrowserTask(task: BrowserTask): Promise<BrowserResult> {
  const job = running.then(() => run(task));
  running = job.catch(() => null);
  return job;
}

/** True when Chromium is installed and starts on this machine. */
export async function browserReady() {
  try {
    const b = await launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

/** The visible text of a page after its scripts run (for sites built with JavaScript). */
export async function renderText(url: string) {
  const b = await launch();
  try {
    const page = await b.newPage({ userAgent: DESKTOP_UA });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => page.goto(url, { waitUntil: "load", timeout: 30_000 }));
    return ((await page.evaluate(() => document.body?.innerText ?? "")) as string).slice(0, 200_000);
  } finally {
    await b.close();
  }
}

/** The page's HTML after its scripts run, with the address it ended on (for sites built with JavaScript). */
export async function renderHtml(url: string) {
  const b = await launch();
  try {
    const page = await b.newPage({ userAgent: DESKTOP_UA });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => page.goto(url, { waitUntil: "load", timeout: 30_000 }));
    await page.waitForTimeout(800);
    return { html: ((await page.content()) as string).slice(0, 1_000_000), url: page.url(), title: (await page.title()) as string };
  } finally {
    await b.close();
  }
}

async function launch() {
  const { chromium } = await import("playwright-core");
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  try {
    return await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  } catch (err) {
    throw new Error(
      `The server's browser is not installed yet. Run: cd /home/ssm-user/employees && npx playwright-core install chromium && sudo npx playwright-core install-deps chromium (${(err as Error).message.split("\n")[0]})`
    );
  }
}

/** The headless browser otherwise announces itself as "HeadlessChrome", which many sites turn away with 403. */
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

async function run(task: BrowserTask): Promise<BrowserResult> {
  const log: StepLog[] = [];
  const downloads: Download[] = [];
  const browser = await launch();
  let storageState: string | null = null;
  let screenshotUrl: string | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  try {
    const state = task.storageState ? JSON.parse(task.storageState) : undefined;
    const context = await browser.newContext({ storageState: state, acceptDownloads: true, viewport: VIEW, userAgent: DESKTOP_UA, locale: "en-US", timezoneId: "America/Chicago" });
    const watch = (pg: import("playwright-core").Page) => {
      pg.setDefaultTimeout(20_000);
      pg.on("download", async (d) => {
        try {
          const p = await d.path();
          if (p) downloads.push({ name: d.suggestedFilename(), buf: fs.readFileSync(p), mime: mimeOf(d.suggestedFilename()), url: d.url() });
        } catch {
          /* a download that fails is skipped */
        }
      });
    };
    let page = await context.newPage();
    watch(page);
    // A link that opens a new tab (a "Log in" button often does) is followed there.
    context.on("page", (pg) => {
      watch(pg);
      page = pg;
      if (live) live.page = pg;
    });

    // The live view: a fresh picture about once a second while the session is open.
    let live: Live | null = null;
    if (task.live) {
      const prev = lives.get(task.orgId);
      live = { id: task.live.id, orgId: task.orgId, state: "starting", step: "Opening the site", url: task.startUrl, reason: "", frame: null, frameAt: 0, page, stop: prev?.id === task.live.id && prev.stop, handBack: false, helped: [] };
      lives.set(task.orgId, live);
      const l = live;
      let busy = false;
      ticker = setInterval(() => {
        if (busy) return;
        busy = true;
        capture(l).finally(() => (busy = false));
      }, 1000);
    }
    /** Stuck: wait for the person to take over and hand back. True means keep going. */
    const waitForPerson = async (reason: string) => {
      if (!live) return false;
      live.state = "waiting";
      live.reason = reason;
      await capture(live);
      await task.live?.onStuck?.(reason).catch(() => null);
      const until = Date.now() + (task.live?.holdMs ?? 10 * 60_000);
      while (Date.now() < until) {
        if (live.stop) return false;
        if (live.handBack) break;
        await sleep(500);
      }
      if (!live.handBack) return false;
      return true;
    };

    await page.goto(task.startUrl, { waitUntil: "domcontentloaded" });
    if (live) live.state = "running";
    let max = task.maxSteps ?? 30;
    const finish = async (status: BrowserResult["status"], result: string, note: string): Promise<BrowserResult> => {
      try {
        const shot = await page.screenshot({ fullPage: false });
        screenshotUrl = (await storagePut(`org-${task.orgId}/browser/step-${Date.now()}.png`, shot, "image/png")).url;
      } catch (err) {
        console.warn("[browser] screenshot failed:", (err as Error).message);
        screenshotUrl = null;
      }
      try {
        storageState = JSON.stringify(await context.storageState());
      } catch {
        storageState = null;
      }
      if (live) {
        await capture(live);
        live.state = status === "done" ? "done" : "stopped";
        live.step = status === "done" ? "Finished" : note.slice(0, 200);
        live.page = null;
      }
      return { status, result, note, storageState, downloads: [...downloads, ...directDownloads(task)], log, screenshotUrl, helped: live?.helped ?? [], url: page.url() };
    };

    let lastSig = "";
    let repeats = 0;
    let step = 0;
    for (;;) {
    while (++step <= max) {
      if (live) {
        if (live.stop) return await finish("failed", "", "Stopped by you.");
        // While the person has control, the employee waits.
        while (live.state === "control" && !live.stop) await sleep(500);
        if (live.stop) return await finish("failed", "", "Stopped by you.");
        if (live.handBack) {
          live.handBack = false;
          live.state = "running";
          log.push({ step, action: "person", detail: `The person took over and handed back.${live.helped.length ? ` ${live.helped.join(". ")}.` : ""} Continue the goal from this page.`, url: page.url() });
          max += 15;
          lastSig = "";
        }
      }
      await page.waitForLoadState("domcontentloaded").catch(() => null);
      const view = hideSecrets(await snapshot(page), task.secrets);
      const act = task.decide ? await task.decide(view, log) : await decide(task, view, log);
      const entry = (detail: string) => log.push({ step, action: act.action, detail: detail.slice(0, 300), url: view.url });
      if (act.action === "done") {
        entry("Goal reached");
        return await finish("done", act.result, act.thought);
      }
      if (act.action === "fail") {
        entry(act.result || act.thought);
        if (live && (await waitForPerson(act.result || act.thought))) continue;
        return await finish("failed", "", act.result || act.thought);
      }
      if (act.action === "need_code") {
        if (task.secrets?.code) {
          entry("A code was asked for and one was given; typing it is the next step");
          continue;
        }
        // Only stop for a code when the page really shows a box for one.
        if (!hasCodeBox(view)) {
          entry("There is no code box on this page, so no code is needed. Sign in with the email and password, or use fail and say what the page shows.");
          continue;
        }
        entry("The site asked for a sign-in code");
        return await finish("need_code", "", codeWords(view) || act.thought);
      }
      const sig = `${act.action}:${act.index}:${act.secret}:${act.value}`;
      repeats = sig === lastSig ? repeats + 1 : 0;
      lastSig = sig;
      if (repeats >= 2) {
        entry("That was tried three times with no change. Do something different: another element, goto a URL, or fail and say what the page shows.");
        repeats = 0;
        continue;
      }
      if (live) live.step = `${task.live?.label ? `${task.live.label} ` : ""}Step ${step}: ${act.thought || describe(act, view)}`.slice(0, 220);
      try {
        await perform(page, task, view, act);
        entry(describe(act, view));
      } catch (err) {
        entry(`Could not ${act.action}: ${(err as Error).message.split("\n")[0]}`);
      }
      await page.waitForTimeout(600);
      if (task.shots) {
        const last = log[log.length - 1];
        try {
          await page.waitForLoadState("domcontentloaded").catch(() => null);
          const shot = await page.screenshot({ fullPage: false });
          last.screenshotUrl = (await storagePut(`${task.shots}/step-${String(step).padStart(2, "0")}-${Date.now()}.png`, shot, "image/png")).url;
          last.title = (await page.title().catch(() => "")).slice(0, 120);
        } catch {
          last.screenshotUrl = null;
        }
      }
      // A click that lands outside the allowed pages is undone right away.
      if (task.allowUrl && !task.allowUrl(page.url())) {
        log.push({ step, action: "blocked", detail: `That page is outside what this login may open, so I went back. Stay inside it.`, url: hideSecrets({ url: page.url(), title: "", text: "", elements: [] }, task.secrets).url });
        await page.goto(task.startUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
      }
    }
    const lastSteps = log.slice(-5).map((l) => `${l.action} (${l.detail})`).join("; then ");
    const why = `Stopped after ${max} steps without finishing. Last page: ${page.url()}. Last steps: ${lastSteps}`.slice(0, 900);
    // Out of steps: the person can take over, and handing back gives more steps from that page.
    const lastThought = [...log].reverse().find((l) => l.action !== "person")?.detail ?? "";
    if (live && (await waitForPerson(`I used all my steps without finishing. The last thing I did: ${lastThought || "nothing yet"}. If the page already shows what I need, press Hand back and I'll read it; if it's the wrong page, get me to the right one first`))) {
      step = max;
      max += 15;
      continue;
    }
    return await finish("failed", "", why);
    }
  } finally {
    clearInterval(ticker);
    await browser.close().catch(() => null);
  }
}

/** Saved values never reach the AI, even when a site echoes them in an address or on the page. */
export function hideSecrets(view: PageView, secrets?: Secrets): PageView {
  const values = [secrets?.password, secrets?.code].filter((v): v is string => Boolean(v && v.length >= 3));
  if (!values.length) return view;
  const forms = values.flatMap((v) => [v, encodeURIComponent(v)]);
  const clean = (s: string) => forms.reduce((acc, v) => acc.split(v).join("•••"), s);
  return { url: clean(view.url), title: clean(view.title), text: clean(view.text), elements: view.elements.map((e) => ({ ...e, label: clean(e.label), text: clean(e.text), href: clean(e.href) })) };
}

function describe(act: Action, view: PageView) {
  const el = view.elements.find((e) => e.i === act.index);
  const what = el ? (el.label || el.text || el.href || el.tag).slice(0, 80) : "";
  if (act.action === "type") return `Typed ${act.secret ? `the saved ${act.secret}` : `"${act.value.slice(0, 60)}"`} into ${what}`;
  if (act.action === "goto") return `Opened ${act.value}`;
  if (act.action === "upload") return `Uploaded a file to ${what}`;
  return `${act.action} ${what}`.trim();
}

async function perform(page: import("playwright-core").Page, task: BrowserTask, view: PageView, act: Action) {
  const loc = () => page.locator(`[data-ld-i="${act.index}"]`).first();
  const el = view.elements.find((e) => e.i === act.index);
  switch (act.action) {
    case "click": {
      const words = `${el?.text ?? ""} ${el?.label ?? ""}`;
      if (task.neverWords?.test(words)) throw new Error("that button is never pressed in this task");
      if (!task.allowSubmit && (task.submitWords ?? SUBMIT_WORDS).test(words)) throw new Error("pressing that is not allowed until the person approves it; use done and say it's ready");
      if (el?.href && task.allowUrl && /^https?:/i.test(el.href) && !task.allowUrl(el.href)) throw new Error("that link is outside what this login may open");
      await loc().click();
      return;
    }
    case "type": {
      const value = act.secret ? task.secrets?.[act.secret] ?? "" : act.value;
      if (act.secret && !value) throw new Error(`no saved ${act.secret}`);
      if (act.secret === "content") {
        // Code editors (the kind a custom HTML box uses) ignore fill, so the block is pasted where the cursor is.
        const ok = await loc().fill(value, { timeout: 5000 }).then(() => true, () => false);
        if (!ok) {
          await loc().click();
          await page.keyboard.press("Control+A");
          await page.keyboard.insertText(value);
        }
        return;
      }
      await loc().fill(value);
      return;
    }
    case "select":
      await loc().selectOption({ label: act.value }).catch(() => loc().selectOption(act.value));
      return;
    case "upload": {
      const f = task.files?.[act.fileIndex];
      if (!f) throw new Error("no such file");
      await loc().setInputFiles(f.path);
      return;
    }
    case "press_enter":
      await page.keyboard.press("Enter");
      return;
    case "goto":
      if (!/^https?:\/\//i.test(act.value)) throw new Error("not a web address");
      if (task.allowUrl && !task.allowUrl(act.value)) throw new Error("that address is outside what this login may open");
      await page.goto(act.value, { waitUntil: "domcontentloaded" });
      return;
    case "download": {
      const href = el?.href;
      if (href && /^https?:/i.test(href)) {
        const res = await page.context().request.get(href);
        if (res.ok()) {
          const name = decodeURIComponent(href.split("?")[0].split("/").pop() || "document");
          downloadsOf(task).push({ name, buf: Buffer.from(await res.body()), mime: res.headers()["content-type"] || mimeOf(name), url: href });
          return;
        }
      }
      await loc().click();
      await page.waitForTimeout(1500);
      return;
    }
    case "wait":
      await page.waitForTimeout(2000);
      return;
  }
}

const CODE_WORDS = /\b(code|verification|verify|one[- ]time|otp|passcode|2fa|two[- ]factor|security code)\b/i;

/** A visible text box labeled for a code (not the email or password box). */
export function hasCodeBox(view: PageView) {
  return view.elements.some((e) => e.tag === "input" && !["password", "email", "hidden", "checkbox", "radio", "submit", "button"].includes(e.type) && CODE_WORDS.test(e.label));
}

/** The page's own sentence about the code, to show the person. */
function codeWords(view: PageView) {
  const line = view.text.split(/\n+/).map((l) => l.trim()).find((l) => CODE_WORDS.test(l) && l.length > 12 && l.length < 220);
  return line ?? "";
}

// Downloads fetched directly (not through the browser's download event) are added here, then merged.
const extra = new WeakMap<BrowserTask, Download[]>();
function downloadsOf(task: BrowserTask) {
  let list = extra.get(task);
  if (!list) extra.set(task, (list = []));
  return list;
}
export function directDownloads(task: BrowserTask) {
  return extra.get(task) ?? [];
}

/** The page as the AI sees it: visible text and a numbered list of things to act on. Typed values in password fields are hidden. */
export async function snapshot(page: import("playwright-core").Page): Promise<PageView> {
  const data = await page.evaluate(() => {
    const out: { i: number; tag: string; type: string; label: string; text: string; href: string }[] = [];
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const labelOf = (el: Element) => {
      const id = el.getAttribute("id");
      const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : "";
      return (el.getAttribute("aria-label") || byFor || el.closest("label")?.textContent || el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
    };
    let n = 0;
    document.querySelectorAll("a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [onclick]").forEach((el) => {
      if (!visible(el) || n >= 250) return;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "hidden") return;
      el.setAttribute("data-ld-i", String(n));
      out.push({
        i: n,
        tag: el.tagName.toLowerCase(),
        type,
        label: labelOf(el).slice(0, 120),
        text: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || "").trim().replace(/\s+/g, " ").slice(0, 120),
        href: (el as HTMLAnchorElement).href || "",
      });
      if (type === "password") out[out.length - 1].text = (el as HTMLInputElement).value ? "(filled)" : "";
      n++;
    });
    return { url: location.href, title: document.title, text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 14_000), elements: out };
  });
  return data;
}

async function decide(task: BrowserTask, view: PageView, history: StepLog[]): Promise<Action> {
  const files = (task.files ?? []).map((f, i) => `${i}. ${f.name}`).join("\n") || "(none)";
  const saved = (["email", "password", "code", "content"] as const).filter((k) => task.secrets?.[k]).join(", ") || "none";
  const els = view.elements.map((e) => `[${e.i}] ${e.tag}${e.type ? `(${e.type})` : ""} ${e.label ? `label="${e.label}" ` : ""}${e.text ? `"${e.text}"` : ""}${e.href && e.tag === "a" ? ` -> ${e.href}` : ""}`).join("\n");
  const past = history.slice(-12).map((h) => `${h.step}. ${h.action}: ${h.detail}`).join("\n") || "(first step)";
  return generateJson<Action>({
    system: `You are ${task.actor ?? "an assistant"} operating a web browser for the person you work for. Pick exactly one next action toward the goal.
Rules:
- Use only elements from the numbered list. Never invent an element number.
- To fill a saved value, use action "type" with secret "email", "password", "code" or "content" and leave value empty ("content" pastes the whole block you were given, like a page's HTML). Saved values available: ${saved}.
- If the site asks for a one-time sign-in or verification code and no code is saved, use "need_code".
- ${task.allowSubmit ? "You are approved to press the final button this goal needs (submit, save or publish). Press it only after every required file is uploaded and every required field is filled, then capture the confirmation number or message." : "Never press a button that submits, places or finalizes a bid, application or form. If the goal would need that, use done and say what is ready."}
- Never accept terms, pay fees, change account settings, or delete anything unless the goal says to.
- If a sign-in page needs an email or password that isn't saved, use "fail" and say the site needs someone signed in. Never ask anyone for a password, credentials or a code, in result or anywhere else.
- If you are stuck, blocked by a CAPTCHA, or the page is not what the goal expects, use "fail" and say why in result.
- When the goal is reached, use "done" and put the requested answer in result, in under 400 words: the facts and findings the goal asks for, not a long write-up.${task.rules ? `\n${task.rules}` : ""}`,
    prompt: `GOAL:\n${task.goal}\n\nFILES YOU CAN UPLOAD:\n${files}\n\nSTEPS SO FAR:\n${past}\n\nCURRENT PAGE: ${view.title}\n${view.url}\n\nELEMENTS:\n${els}\n\nPAGE TEXT:\n${view.text}`,
    schemaName: "browser_action",
    schema: ACTION_SCHEMA,
    maxTokens: 3000,
    timeoutMs: 90_000,
  });
}

function mimeOf(name: string) {
  const ext = path.extname(name).toLowerCase();
  return (
    {
      ".pdf": "application/pdf",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".zip": "application/zip",
      ".txt": "text/plain",
    } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}

/** Writes files to a temp folder so the browser can upload them. */
export function tempFiles(files: { name: string; buf: Buffer }[]): BrowserFile[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-upload-"));
  return files.map((f) => {
    const p = path.join(dir, f.name.replace(/[\\/:*?"<>|]+/g, "_"));
    fs.writeFileSync(p, f.buf);
    return { path: p, name: f.name };
  });
}
