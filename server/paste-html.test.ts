import { describe, expect, it, vi } from "vitest";

const prompts: string[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "chat_decision") {
        prompts.push(opts.prompt);
        return { thinking: "", reply: "Got your page.", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
      }
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { pastedHtml } from "./employees/chat";

const page = `<!DOCTYPE html><html><head><title>LeadDash</title><style>${"body{margin:0}".repeat(1500)}</style></head><body>${Array.from({ length: 60 }, (_, i) => `<section id="s${i}"><h2>Section ${i}</h2><p>Practice software text ${i}</p></section>`).join("\n")}</body></html>`;

describe("pasting a page's HTML into a chat", () => {
  it("posts as written, and the employee gets it as the page's code instead of the whole page in its prompt", async () => {
    const { orgId, owner } = await makeWorkspace("paste-html");
    const jordan = (await db.getEmployeeByKind(orgId, "website"))!;
    const text = `Here is my current homepage, audit it\n${page}`;
    expect(text.length).toBeGreaterThan(20_000);

    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: jordan.id, text });
    expect(r.reply.content).toBe("Got your page.");
    expect(r.user.content).toBe(text);
    const files = db.recentChatFiles(orgId, jordan.id, 3);
    const html = files.find((f) => /^pasted-page-.*\.html$/.test(f.name))!;
    expect(html.text).toContain("Section 59");
    expect(html.messageId).toBe(r.user.id);

    const p = prompts[prompts.length - 1];
    expect(p).toContain("Here is my current homepage, audit it");
    expect(p).toMatch(/pasted a page's HTML, [\d,]+ characters, given to you as pasted-page-/);
    expect(p).not.toContain("Section 59");
  });

  it("only treats real page markup as pasted HTML", () => {
    expect(pastedHtml("short <div>x</div>")).toBeNull();
    expect(pastedHtml("plain words ".repeat(300))).toBeNull();
    expect(pastedHtml(`before ${page} after`)!.words).toBe("before after");
  });
});
