import { describe, expect, it, vi } from "vitest";

let prompts: string[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName !== "history_facts") return {};
      prompts.push(opts.prompt);
      // Each chat is judged by what it says: pricing is business, a client chat is client details, anything else is personal.
      const chats = opts.prompt.split(/## Chat (\d+)\n/).slice(1);
      const out = [];
      for (let k = 0; k < chats.length; k += 2) {
        const n = Number(chats[k]);
        const text = chats[k + 1];
        if (/pricing/i.test(text)) out.push({ n, about_business: true, client_details: false, facts: [{ topic: "Founding member pricing", fact: "Founding member pricing closes December 31, 2026.", category: "services_offers" }] });
        else if (/client/i.test(text)) out.push({ n, about_business: false, client_details: true, facts: [{ topic: "Client", fact: "A client's treatment plan.", category: "mission_profile" }] });
        else out.push({ n, about_business: false, client_details: false, facts: [] });
      }
      return { chats: out };
    }),
  };
});

import fs from "node:fs";
import JSZip from "jszip";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as history from "./employees/history";

const claudeExport = [
  { name: "Pricing", created_at: "2026-09-14T15:00:00Z", chat_messages: [{ sender: "human", text: "Founding member pricing closes December 31, 2026. Remember that." }, { sender: "assistant", text: "Got it." }] },
  { name: "Session note help", created_at: "2026-09-15T15:00:00Z", chat_messages: [{ sender: "human", text: "Help me write a progress note for a client with anxiety." }] },
  { name: "Dinner", created_at: "2026-09-16T15:00:00Z", chat_messages: [{ sender: "human", text: "What should I cook for dinner tonight with chicken?" }] },
  { name: "Hard talk", created_at: "2026-09-16T16:00:00Z", chat_messages: [{ sender: "human", text: "How do I bring up a late payment with a client kindly?" }] },
  { name: "Hi", created_at: "2026-09-17T15:00:00Z", chat_messages: [{ sender: "human", text: "hi" }] },
  { name: "Eval write-up", created_at: "2026-09-13T15:00:00Z", chat_messages: [{ sender: "human", text: "Write up the evaluation. DOB 03/12/1988, presenting problem is panic, diagnosis F41.0." }] },
];

describe("company history from Claude and ChatGPT exports", () => {
  it("reads both export shapes, oldest first, and skips chats with nothing from the owner", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", JSON.stringify(claudeExport));
    const c = await history.readExport(await zip.generateAsync({ type: "nodebuffer" }));
    expect(c.source).toBe("claude");
    expect(history.pickChats(c.convos).map((x) => x.title)).toEqual(["Eval write-up", "Pricing", "Session note help", "Dinner", "Hard talk"]);
    expect(history.pickChats(c.convos).map((x) => history.looksClinical(x))).toEqual([true, false, true, false, false]);

    const gpt = [{ title: "Brand", create_time: 1717300000, current_node: "b", mapping: { a: { message: { author: { role: "user" }, content: { parts: ["Our brand green is #1b6b4a and the background is #F8FAFB."] } }, parent: null }, b: { message: { author: { role: "assistant" }, content: { parts: ["Noted."] } }, parent: "a" } } }];
    const g = await history.readExport(Buffer.from(JSON.stringify(gpt)));
    expect(g.source).toBe("chatgpt");
    expect(g.convos[0].turns.map((t) => t.who)).toEqual(["owner", "ai"]);
    await expect(history.readExport(Buffer.from("{}"))).rejects.toThrow(/isn't a Claude or ChatGPT export/);
  });

  it("saves the business facts to the Brain, leaves client chats out, deletes the upload and lets a fact be removed", async () => {
    prompts = [];
    const { orgId, owner } = await makeWorkspace("history");
    const zip = new JSZip();
    zip.file("data/conversations.json", JSON.stringify(claudeExport));
    const dest = history.holdingPath(orgId);
    fs.writeFileSync(dest, await zip.generateAsync({ type: "nodebuffer" }));
    const imp = await history.start(orgId, { id: owner.id, name: "Ashley" }, "claude-data.zip", dest);
    for (let i = 0; i < 200 && db.getHistoryImport(imp.id, orgId)!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
    const done = (await caller(owner).history.latest({ organizationId: orgId }))!;
    expect(done).toMatchObject({ status: "done", source: "claude", total: 5, done: 5, skippedClient: 3, skippedOther: 1 });
    // A chat with a client's details never reaches the AI at all.
    expect(prompts.join("")).not.toContain("03/12/1988");
    expect(prompts.join("")).not.toContain("progress note for a client");
    expect(done.items).toEqual([expect.objectContaining({ topic: "Founding member pricing", from: "Claude, Sep 14, 2026" })]);
    // The owner's words go in; the three chats were read in one batch.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Owner: Founding member pricing closes December 31, 2026.");
    const entry = (await db.listKnowledgeByOrg(orgId)).find((k) => k.title === "Learned: Founding member pricing")!;
    expect(entry.content).toBe("Founding member pricing closes December 31, 2026.\n(Ashley told Claude in a chat on Sep 14, 2026.)");
    expect((await db.listKnowledgeByOrg(orgId)).some((k) => /treatment plan/.test(k.content))).toBe(false);
    for (let i = 0; i < 50 && fs.existsSync(dest); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(dest)).toBe(false);

    const after = await caller(owner).history.removeFact({ organizationId: orgId, id: imp.id, knowledgeId: entry.id });
    expect(after.items).toEqual([]);
    expect((await db.listKnowledgeByOrg(orgId)).some((k) => k.id === entry.id)).toBe(false);
  });
});
