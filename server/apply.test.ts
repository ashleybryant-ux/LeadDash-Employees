import { beforeEach, describe, expect, it, vi } from "vitest";

const prompts: { schema: string; system: string; prompt: string }[] = [];
let answerFor: (prompt: string) => any = () => ({ answer: "A grounded answer.", missing: [], sources: ["Brain"] });

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    searchJson: vi.fn(async () => ({ queries: [], sources: [], data: { history: "", url: "" } })),
    generateJson: vi.fn(async (opts: any) => {
      prompts.push({ schema: opts.schemaName, system: opts.system, prompt: opts.prompt });
      if (opts.schemaName === "answer") return answerFor(opts.prompt);
      if (opts.schemaName === "outline") return { outline: ["The gap", "Aim 1"], facts: [{ text: "PHQ-9 is collected", source: "Funding facts" }] };
      if (opts.schemaName === "attachment") return { content: "Item | Amount | Justification\nClinician time | $38,000 | Weekly sessions" };
      if (opts.schemaName === "review") return { criteria: [{ name: "Need", points: 22, max: 25, note: "" }, { name: "Program design", points: 31, max: 35, note: "" }], fixes: [{ text: "Add starting numbers to the evaluation plan.", questionNumber: 2 }] };
      if (opts.schemaName === "shorter") return { answer: "short" };
      if (opts.schemaName === "report") return { draft: "Progress this quarter." };
      if (opts.schemaName === "pitch_materials") return { deck: [{ title: "LeadDash", bullets: ["One system"] }], videoScript: "Every week...", financials: "Revenue [MRR]" };
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as apply from "./employees/apply";
import { findPassages, indexKnowledge, ftsQuery } from "./employees/kb";
import { chunkText } from "./employees/docs";

const reqs = (over: Partial<apply.Requirements> = {}): apply.Requirements => ({
  due: "Nov 30, 2026 at 5:00 PM CT",
  questions: [
    { text: "Describe the community you serve.", limit: "250 words", maxWords: 250 },
    { text: "How will you measure success?", limit: "300 words", maxWords: 300 },
  ],
  narrativeLimit: "",
  format: "12 pt",
  scoring: [{ name: "Need", points: 25 }, { name: "Program design", points: 35 }],
  attachments: [
    { name: "Budget", required: true, needsSignature: false },
    { name: "Attachment B, Assurances", required: true, needsSignature: true },
  ],
  eligibility: "Licensed providers",
  aiPolicy: { restricted: false, note: "", citation: "" },
  channel: "submittable",
  channelDetail: "",
  submitWhat: "",
  eventDate: "",
  decisionDate: "Mar 2027",
  videoRequired: false,
  videoLimit: "",
  deckLimit: "",
  pages: { due: "RFP page 3", eligibility: "", scoring: "", limits: "" },
  ...over,
});

async function readyOpp(orgId: number, over: Partial<apply.Requirements> = {}, kind: "grant" | "pitch" | "speaking" = "grant") {
  return db.createOpp({ organizationId: orgId, kind, title: "Rural Telehealth Access Program", host: "Heartland Rural Health Fund", amount: "$25,000 to $75,000", requirements: JSON.stringify(reqs(over)), packageStatus: "ready" });
}

describe("knowledge is read in full", () => {
  it("splits long documents into passages and finds the one that answers a question, even past the old 6,000-character cut", async () => {
    const { orgId } = await makeWorkspace("kb");
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    const filler = Array.from({ length: 90 }, (_, i) => `Section ${i + 1}. The practice keeps careful records of intake and scheduling for every location.`).join("\n\n");
    const content = `${filler}\n\nEVALUATION PLAN\nWe measure days from first call to first session, and PHQ-9 change at month three.`;
    expect(content.length).toBeGreaterThan(6000);
    const item = await db.createKnowledgeItem({ organizationId: orgId, employeeId: morgan.id, folder: "Past applications", kind: "document", category: "past_performance", title: "2025 SAMHSA application", content });
    expect(indexKnowledge(item)).toBeGreaterThan(3);
    const hits = await findPassages(orgId, "How will you measure PHQ-9 outcomes?", { employeeId: morgan.id });
    expect(hits[0].text).toContain("PHQ-9 change at month three");
    expect(hits[0].source).toBe("2025 SAMHSA application");
    // Another employee's Knowledge stays out; the shared Brain is always in.
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    expect(await findPassages(orgId, "PHQ-9 month three", { employeeId: taylor.id })).toHaveLength(0);
    expect(ftsQuery("Describe the program and the timeline")).toBe('"timeline"');
    expect(chunkText("A\n".repeat(10)).length).toBe(1);
  });
});

describe("applying, end to end", () => {
  beforeEach(() => {
    prompts.length = 0;
    answerFor = () => ({ answer: "A grounded answer.", missing: [], sources: ["Brain"] });
  });

  it("writes to the host's own questions, makes the budget, runs the reviewer check, and waits for Submit", async () => {
    const { orgId, owner, reviewer } = await makeWorkspace("apply");
    const opp = await readyOpp(orgId);
    const started = await caller(owner).applications.start({ organizationId: orgId, opportunityId: opp.id });
    expect(started.status).toBe("writing");
    await apply.idle();

    const { app, blockers } = await caller(owner).applications.get({ organizationId: orgId, id: started.id });
    const qs = JSON.parse(app.questions);
    expect(qs.map((q: any) => q.text)).toEqual(["Describe the community you serve.", "How will you measure success?"]);
    expect(qs.every((q: any) => q.answer === "A grounded answer.")).toBe(true);
    expect(app.channel).toBe("submittable");
    const atts = JSON.parse(app.attachments);
    expect(atts.find((a: any) => a.name === "Budget")).toMatchObject({ source: "made" });
    expect(atts.find((a: any) => a.name.startsWith("Attachment B"))).toMatchObject({ needsSignature: true });
    const review = JSON.parse(app.review);
    expect(review).toMatchObject({ score: 53, total: 60 });
    expect(review.fixes.some((f: any) => /signature/.test(f.text))).toBe(true);
    expect(app.status).toBe("ready");
    // The scoring weights and the reviewer rubric reach the model.
    expect(prompts.find((p) => p.schema === "answer")!.prompt).toContain("Scoring: Need 25, Program design 35");
    expect(prompts.find((p) => p.schema === "review")!.system).toContain("You did not write it");

    // Submit is blocked until the signed form is in.
    expect(blockers).toContain("A form needs your signature");
    await expect(caller(owner).applications.submit({ organizationId: orgId, id: app.id })).rejects.toThrow(/signature/);
    const fixed = JSON.parse(app.attachments).map((a: any) => (a.needsSignature ? { ...a, source: "upload", fileUrl: "/files/x.pdf" } : a));
    await db.updateApplication(app.id, orgId, { attachments: JSON.stringify(fixed) });

    // A reviewer cannot submit; a member certifies with their own name.
    await expect(caller(reviewer).applications.submit({ organizationId: orgId, id: app.id })).rejects.toThrow(/role/);
    const approved = await caller(owner).applications.submit({ organizationId: orgId, id: app.id });
    expect(approved).toMatchObject({ status: "approved", certifiedBy: owner.name });

    const submitted = await caller(owner).applications.markSubmitted({ organizationId: orgId, id: app.id, confirmation: "PHF-27-0412" });
    expect(submitted).toMatchObject({ status: "submitted", confirmation: "PHF-27-0412" });
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    const chat = await db.listChatMessages(orgId, morgan.id);
    // After Approve, with no saved sign-in for the portal, Morgan says it's ready for a person to send.
    expect(chat.map((m) => JSON.parse(m.cards || "[]")[0]?.type)).toEqual(["application_draft", undefined, "submitted"]);
    expect(chat[1].content).toMatch(/ready for you to send/);

    const won = await caller(owner).applications.decide({ organizationId: orgId, id: app.id, result: "awarded", amount: "$58,500", period: "Jan 1, 2027 to Dec 31, 2027", reports: [{ name: "Q1 progress report", due: "Apr 15, 2027" }] });
    expect(JSON.parse(won!.award!).total).toBe(58500);
    const report = await caller(owner).applications.draftReport({ organizationId: orgId, id: app.id, index: 0 });
    expect(JSON.parse(report!.award!).reports[0]).toMatchObject({ status: "ready", draft: "Progress this quarter." });
  });

  it("asks for a missing fact with fixed choices, saves the answer to Knowledge, and finishes", async () => {
    const { orgId, owner } = await makeWorkspace("ask");
    answerFor = () => ({ answer: "Indirect costs are [INDIRECT RATE].", missing: [{ label: "Indirect cost rate", question: "Which rate does Legacy use?", options: ["15% de minimis", "Negotiated rate", "No indirect costs"] }], sources: [] });
    const opp = await readyOpp(orgId, { attachments: [] });
    const app = await caller(owner).applications.start({ organizationId: orgId, opportunityId: opp.id });
    await apply.idle();
    const got = await caller(owner).applications.get({ organizationId: orgId, id: app.id });
    expect(got.app.status).toBe("needs_answer");
    expect(got.questions).toHaveLength(1);
    await expect(caller(owner).applications.answer({ organizationId: orgId, questionId: got.questions[0].id, answer: " " })).rejects.toThrow(/type an answer/);

    answerFor = () => ({ answer: "Indirect costs use the 15% de minimis rate.", missing: [], sources: [] });
    await caller(owner).applications.answer({ organizationId: orgId, questionId: got.questions[0].id, answer: "15% de minimis" });
    await apply.idle();
    const after = await caller(owner).applications.get({ organizationId: orgId, id: app.id });
    expect(after.app.status).toBe("ready");
    expect(after.blockers).toEqual([]);
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    const kn = await db.listEmployeeKnowledge(orgId, morgan.id);
    expect(kn[0]).toMatchObject({ folder: "Answers", title: "Indirect cost rate" });
  });

  it("switches to outline-only when the host restricts AI-written applications", async () => {
    const { orgId, owner } = await makeWorkspace("airule");
    const opp = await readyOpp(orgId, { aiPolicy: { restricted: true, note: "NIH", citation: "NOT-OD-25-132" }, attachments: [] });
    const app = await caller(owner).applications.start({ organizationId: orgId, opportunityId: opp.id });
    await apply.idle();
    const got = await caller(owner).applications.get({ organizationId: orgId, id: app.id });
    expect(got.app.mode).toBe("outline");
    const qs = JSON.parse(got.app.questions);
    expect(qs[0]).toMatchObject({ answer: "", outline: ["The gap", "Aim 1"] });
    expect(prompts.some((p) => p.schema === "answer")).toBe(false);
    expect(got.blockers).toContain("Your sections are not all written");
    await caller(owner).applications.saveAnswer({ organizationId: orgId, id: app.id, questionId: "q1", answer: "My words." });
    await caller(owner).applications.saveAnswer({ organizationId: orgId, id: app.id, questionId: "q2", answer: "Mine too." });
    expect((await caller(owner).applications.get({ organizationId: orgId, id: app.id })).blockers).toEqual([]);
  });

  it("builds a deck and video script for a pitch competition and holds Submit until the video is uploaded", async () => {
    const { orgId, owner } = await makeWorkspace("pitch");
    const opp = await readyOpp(orgId, { attachments: [], videoRequired: true }, "pitch");
    const app = await caller(owner).applications.start({ organizationId: orgId, opportunityId: opp.id });
    await apply.idle();
    const got = await caller(owner).applications.get({ organizationId: orgId, id: app.id });
    const extras = JSON.parse(got.app.extras!);
    expect(extras.deck[0].title).toBe("LeadDash");
    expect(extras.videoScript).toBe("Every week...");
    expect(got.blockers).toContain("Needs your video");
  });

  it("holds Grants.gov applications until SAM.gov and Grants.gov are set up, and reminds before SAM.gov expires", async () => {
    const { orgId, owner } = await makeWorkspace("federal");
    const opp = await readyOpp(orgId, { channel: "grants_gov", attachments: [] });
    const app = await caller(owner).applications.start({ organizationId: orgId, opportunityId: opp.id });
    await apply.idle();
    expect((await db.getApplication(app.id, orgId))!.status).toBe("needs_setup");

    const regs = await caller(owner).registrations.list({ organizationId: orgId });
    expect(regs.map((r) => r.kind)).toContain("sam");
    await expect(caller(owner).registrations.save({ organizationId: orgId, kind: "sam", status: "active", details: { uei: "ABC" }, expires: "2027-08-14" })).rejects.toThrow(/MM\/DD\/YYYY/);
    const soon = new Date(Date.now() + 10 * 86400_000);
    const mmdd = `${String(soon.getMonth() + 1).padStart(2, "0")}/${String(soon.getDate()).padStart(2, "0")}/${soon.getFullYear()}`;
    await caller(owner).registrations.save({ organizationId: orgId, kind: "sam", status: "active", details: { uei: "ABC" }, expires: mmdd });
    expect(await apply.remindRegistrations(new Date())).toBe(1);
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    expect((await db.listChatMessages(orgId, morgan.id)).at(-1)!.content).toMatch(/SAM.gov registration expires/);
  });

  it("keeps portal passwords encrypted and never returns them", async () => {
    const { orgId, owner } = await makeWorkspace("portals");
    await caller(owner).portals.save({ organizationId: orgId, name: "Foundant", username: "ashley", password: "s3cret!" });
    const list = await caller(owner).portals.list({ organizationId: orgId });
    expect(list[0]).toMatchObject({ name: "Foundant", username: "ashley", hasPassword: true });
    expect(JSON.stringify(list)).not.toContain("s3cret!");
    expect((await db.listPortalLogins(orgId))[0].secretEncrypted).not.toContain("s3cret!");
  });
});
