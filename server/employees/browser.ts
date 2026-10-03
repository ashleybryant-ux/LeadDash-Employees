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

export type Secrets = { email?: string; password?: string; code?: string };
export type BrowserFile = { path: string; name: string };
export type Download = { name: string; buf: Buffer; mime: string; url: string };
export type StepLog = { step: number; action: string; detail: string; url: string };

export type BrowserResult = {
  status: "done" | "need_code" | "failed";
  result: string;
  note: string;
  storageState: string | null;
  downloads: Download[];
  log: StepLog[];
  screenshotUrl: string | null;
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
  /** For tests: replaces the AI's choice of action. */
  decide?: (view: PageView, history: StepLog[]) => Promise<Action>;
};

export type PageElement = { i: number; tag: string; type: string; label: string; text: string; href: string };
export type PageView = { url: string; title: string; text: string; elements: PageElement[] };

export type Action = {
  thought: string;
  action: "click" | "type" | "select" | "upload" | "press_enter" | "goto" | "wait" | "download" | "need_code" | "done" | "fail";
  index: number;
  value: string;
  secret: "" | "email" | "password" | "code";
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
    secret: { type: "string", enum: ["", "email", "password", "code"], description: "For type: fill a saved value instead of value" },
    fileIndex: { type: "integer", description: "For upload: which file from the file list; -1 otherwise" },
    result: { type: "string", description: "For done: the answer the goal asks for (JSON when asked); for fail: why; '' otherwise" },
  },
};

/** Buttons that finish a submission. Refused unless the task was approved to submit. */
export const SUBMIT_WORDS = /\b(submit|place bid|send bid|send response|finali[sz]e|sign and submit|certify and submit|complete submission)\b/i;

let running: Promise<unknown> = Promise.resolve();

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
  try {
    const state = task.storageState ? JSON.parse(task.storageState) : undefined;
    const context = await browser.newContext({ storageState: state, acceptDownloads: true, viewport: { width: 1280, height: 900 }, userAgent: DESKTOP_UA, locale: "en-US", timezoneId: "America/Chicago" });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("download", async (d) => {
      try {
        const p = await d.path();
        if (p) downloads.push({ name: d.suggestedFilename(), buf: fs.readFileSync(p), mime: mimeOf(d.suggestedFilename()), url: d.url() });
      } catch {
        /* a download that fails is skipped */
      }
    });
    await page.goto(task.startUrl, { waitUntil: "domcontentloaded" });
    const max = task.maxSteps ?? 30;
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
      return { status, result, note, storageState, downloads: [...downloads, ...directDownloads(task)], log, screenshotUrl };
    };

    for (let step = 1; step <= max; step++) {
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
      try {
        await perform(page, task, view, act);
        entry(describe(act, view));
      } catch (err) {
        entry(`Could not ${act.action}: ${(err as Error).message.split("\n")[0]}`);
      }
      await page.waitForTimeout(600);
    }
    return await finish("failed", "", `Stopped after ${max} steps without finishing.`);
  } finally {
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
      if (!task.allowSubmit && SUBMIT_WORDS.test(words)) throw new Error("submitting is not allowed in this task");
      await loc().click();
      return;
    }
    case "type": {
      const value = act.secret ? task.secrets?.[act.secret] ?? "" : act.value;
      if (act.secret && !value) throw new Error(`no saved ${act.secret}`);
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
  const saved = (["email", "password", "code"] as const).filter((k) => task.secrets?.[k]).join(", ") || "none";
  const els = view.elements.map((e) => `[${e.i}] ${e.tag}${e.type ? `(${e.type})` : ""} ${e.label ? `label="${e.label}" ` : ""}${e.text ? `"${e.text}"` : ""}${e.href && e.tag === "a" ? ` -> ${e.href}` : ""}`).join("\n");
  const past = history.slice(-12).map((h) => `${h.step}. ${h.action}: ${h.detail}`).join("\n") || "(first step)";
  return generateJson<Action>({
    system: `You are ${task.actor ?? "an assistant"} operating a web browser for the person you work for. Pick exactly one next action toward the goal.
Rules:
- Use only elements from the numbered list. Never invent an element number.
- To fill a saved sign-in value, use action "type" with secret "email", "password" or "code" and leave value empty. Saved values available: ${saved}.
- If the site asks for a one-time sign-in or verification code and no code is saved, use "need_code".
- ${task.allowSubmit ? "You are approved to submit this one response. Submit only after every required file is uploaded and every required field is filled, then capture the confirmation number or message." : "Never press a button that submits, places or finalizes a bid, application or form. If the goal would need that, use done and say what is ready."}
- Never accept terms, pay fees, change account settings, or delete anything unless the goal says to.
- If you are stuck, blocked by a CAPTCHA, or the page is not what the goal expects, use "fail" and say why in result.
- When the goal is reached, use "done" and put the requested answer in result.`,
    prompt: `GOAL:\n${task.goal}\n\nFILES YOU CAN UPLOAD:\n${files}\n\nSTEPS SO FAR:\n${past}\n\nCURRENT PAGE: ${view.title}\n${view.url}\n\nELEMENTS:\n${els}\n\nPAGE TEXT:\n${view.text}`,
    schemaName: "browser_action",
    schema: ACTION_SCHEMA,
    maxTokens: 1500,
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
