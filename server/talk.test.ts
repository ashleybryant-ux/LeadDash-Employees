import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as talk from "./employees/talk";
import { learnFact } from "./employees/learn";

afterEach(() => vi.restoreAllMocks());

describe("Taylor's talk scripts", () => {
  it("writes the whole talk timed to its real length and posts it in the chat as a Word file", async () => {
    const { orgId } = await makeWorkspace("talk-run");
    const llm = await import("./_core/llm");
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName === "talk_outline")
        return {
          title: "The Relational Skills HR Already Has",
          event: "HR2026 Arkansas SHRM, Thu, Oct 15, 2026, Room 203-204",
          // Adds up to 55: the script still comes out at exactly 60.
          sections: [
            { title: "Opening", minutes: 5, slide: "Title", covers: "Who I am" },
            { title: "Praise", minutes: 20, slide: "Praise", covers: "Praise yourself" },
            { title: "Plan", minutes: 30, slide: "Your next 30 days", covers: "Two actions" },
          ],
        } as any;
      return {} as any;
    });
    const text = vi.spyOn(llm, "generateText").mockResolvedValue("Good afternoon, everyone.\n\n[Pause. Let the room settle.]\n\nLet's start with a question.");
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    const r = await talk.writeTalkScript(taylor, { title: "SHRM Arkansas session", minutes: 60, notes: "", said: "write my SHRM talk" });
    expect(r.sections.reduce((a, s) => a + s.minutes, 0)).toBe(60);
    expect(text).toHaveBeenCalledTimes(3);
    const msgs = await db.listChatMessages(orgId, taylor.id, 5);
    const done = msgs.find((m) => /is ready: 60 minutes in 3 parts/.test(m.content))!;
    expect(JSON.parse(done.cards!)).toEqual([{ type: "doc", id: r.file.id, title: "The Relational Skills HR Already Has", subtitle: "Word document · 60 minutes · 3 parts" }]);
    expect(r.file.name).toMatch(/ - script\.docx$/);
    expect(r.file.size).toBeGreaterThan(1000);
    expect(db.getChatFiles(orgId, [r.file.id])[0].messageId).toBe(done.id);
    // What the chat shows when it's opened.
    expect(r.file.text).toMatch(/^# The Relational Skills HR Already Has/);
    expect(r.file.text).toMatch(/## 3\. Plan\n\*\*27:00 to 60:00 · Slide: Your next 30 days\*\*/);

    // The slides come from that script, with presenter notes, pictures and her headshot.
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      expect(opts.prompt).toMatch(/The script:\n# The Relational Skills/);
      return {
        title: "The Relational Skills HR Already Has",
        event: "HR2026",
        slides: [
          { kind: "title", title: "The Relational Skills HR Already Has", points: [], notes: "0:00 Welcome", picture: "should be ignored" },
          { kind: "section", title: "The week you just had", points: [], notes: "8:00 Think about your week", picture: "An HR director at her desk at dusk" },
          { kind: "points", title: "Praise", points: ["Name one win a day"], notes: "12:00 Talk about praise", picture: "" },
          { kind: "big", title: "75% say it is exhausting", points: ["SHRM, 2024"], notes: "", picture: "" },
        ],
      } as any;
    });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const { storagePut } = await import("./storage");
    const head = await storagePut(`org-${orgId}/brain/headshot.png`, png, "image/png");
    await db.createKnowledgeItem({ organizationId: orgId, title: "Headshot 02014.jpg", category: "mission_profile", kind: "image", content: "", fileUrl: head.url });
    const images = await import("./_core/imageGeneration");
    const gen = vi.spyOn(images, "generateImage").mockImplementation(async () => ({ url: (await storagePut(`org-${orgId}/talks/pic.png`, png, "image/png")).url }));
    const d = await talk.buildSlides(taylor, { title: "", notes: "", said: "build the slides" });
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0][0].prompt).toMatch(/An HR director at her desk at dusk.*No text, letters/);
    expect(d.file.name).toMatch(/ - slides\.pptx$/);
    const saved = JSON.parse(d.file.text);
    expect(saved.headshot).toBe(head.url);
    expect(saved.slides[0].image).toBeNull(); // the title slide gets the headshot, not a picture
    expect(saved.slides[1].image).toMatch(/^\/files\/org-\d+\/talks\/pic_/);
    const deckMsg = (await db.listChatMessages(orgId, taylor.id, 5)).find((m) => /Your slides are ready: 4 slides from the script, with what you say on each one in the presenter notes\. 1 slide has a picture I made for it\. Your headshot is on the title slide\./.test(m.content))!;
    expect(JSON.parse(deckMsg.cards!)[0]).toMatchObject({ type: "deck", id: d.file.id, subtitle: "PowerPoint · 4 slides · 1 pictures" });

    // The PowerPoint holds the notes and both images.
    const unzip = async (fileId: number) => {
      const f = db.getChatFiles(orgId, [fileId])[0];
      const { uploadsRoot } = await import("./storage");
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(require("node:fs").readFileSync(require("node:path").join(uploadsRoot(), f.fileUrl.replace(/^\/files\//, ""))));
      const names = Object.keys(zip.files);
      const notes = (await Promise.all(names.filter((n) => /notesSlides\/notesSlide\d+\.xml$/.test(n)).map((n) => zip.file(n)!.async("string")))).join(" ");
      return { names, notes };
    };
    let x = await unzip(d.file.id);
    expect(x.names.filter((n) => n.startsWith("ppt/media/")).length).toBeGreaterThanOrEqual(2);
    expect(x.notes).toContain("12:00 Talk about praise");

    // Edit in the chat: the notes change in the deck and the PowerPoint.
    await talk.setSlideNotes(orgId, d.file.id, 2, "12:00 Ask who said one nice thing to themselves this week.");
    x = await unzip(d.file.id);
    expect(x.notes).toContain("Ask who said one nice thing to themselves");
    expect(x.notes).not.toContain("Talk about praise");
    // A new picture on one slide.
    await talk.newSlidePicture(orgId, d.file.id, 2, "a woman at her desk after work");
    expect(gen).toHaveBeenCalledTimes(2);
    expect(JSON.parse(db.getChatFiles(orgId, [d.file.id])[0].text).slides[2]).toMatchObject({ picture: "a woman at her desk after work", image: expect.stringMatching(/^\/files\//) });
    await expect(talk.newSlidePicture(orgId, d.file.id, 0)).rejects.toThrow(/headshot/);
  });

  it("builds graphics and illustrations into the slides, editable in PowerPoint, and never charts a made-up number", async () => {
    const { orgId } = await makeWorkspace("talk-graphics");
    await db.createKnowledgeItem({ organizationId: orgId, title: "HR burnout research", category: "speaking", kind: "fact", content: "In our 2025 member survey, 75% of HR professionals said their work is emotionally exhausting (SHRM State of the Workplace)." });
    const llm = await import("./_core/llm");
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    const none = { picture: "", style: "photo", items: [], figure: "", source: "", series: [], takeaway: "" };
    vi.spyOn(llm, "generateJson").mockResolvedValue({
      title: "The Relational Skills HR Already Has",
      event: "",
      slides: [
        { ...none, kind: "title", title: "The Relational Skills HR Already Has", points: [], notes: "" },
        { ...none, kind: "framework", title: "The P.U.L.S.E. Framework, turned inward", points: [], notes: "17:00 The model", items: [{ label: "P", text: "Praise", detail: "Name your own wins", values: [] }, { label: "U", text: "Understand", detail: "Know what drains you", values: [] }, { label: "L", text: "Listen", detail: "Hear your own signals", values: [] }] },
        { ...none, kind: "stat", title: "of HR professionals say their work is emotionally exhausting", points: [], notes: "", figure: "75%", source: "SHRM, 2025" },
        { ...none, kind: "stat", title: "of managers skip lunch", points: [], notes: "", figure: "62%", source: "Made up" },
        { ...none, kind: "chart", title: "Who gets your best skills?", points: [], notes: "", series: ["For others", "For me"], items: [{ label: "Praise", text: "", detail: "", values: [4.6, 1.8] }, { label: "Listen", text: "", detail: "", values: [4.8, 2.1] }] },
        { ...none, kind: "steps", title: "A 3-minute reset", points: [], notes: "", items: [{ label: "Notice", text: "Name what you feel", detail: "", values: [] }, { label: "Breathe", text: "Four slow breaths", detail: "", values: [] }, { label: "Choose", text: "Pick the next right thing", detail: "", values: [] }] },
        { ...none, kind: "points", title: "Listen to your own signals", points: ["Tight shoulders"], notes: "", picture: "A woman noticing tension in her shoulders", style: "illustration" },
      ],
    } as any);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const { storagePut, uploadsRoot } = await import("./storage");
    const images = await import("./_core/imageGeneration");
    const gen = vi.spyOn(images, "generateImage").mockImplementation(async () => ({ url: (await storagePut(`org-${orgId}/talks/pic.png`, png, "image/png")).url }));
    const d = await talk.buildSlides(taylor, { title: "", notes: "", said: "build the slides" });
    expect(gen.mock.calls[0][0].prompt).toMatch(/^Flat modern vector illustration.*No text, letters/);
    const deck = JSON.parse(d.file.text);
    expect(deck.slides.map((s: any) => s.kind)).toEqual(["title", "framework", "stat", "big", "points", "steps", "points"]);
    expect(deck.slides[3]).toMatchObject({ title: "of managers skip lunch", points: ["[add source]"] }); // 62% isn't anywhere: no number on the slide
    expect(deck.slides[4]).toMatchObject({ title: "Who gets your best skills?", points: ["Praise", "Listen"] }); // scores nobody gave: no chart
    expect(deck.slides[6]).toMatchObject({ style: "illustration", image: expect.stringMatching(/^\/files\//) });
    const msg = (await db.listChatMessages(orgId, taylor.id, 5)).find((m) => /Your slides are ready/.test(m.content))!;
    expect(msg.content).toContain("3 slides are graphics (a framework, a statistic, steps) you can edit in PowerPoint. 1 slide has a picture I made for it (an illustration).");

    const unzip = async (fileId: number) => {
      const f = db.getChatFiles(orgId, [fileId])[0];
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(require("node:fs").readFileSync(require("node:path").join(uploadsRoot(), f.fileUrl.replace(/^\/files\//, ""))));
      const names = Object.keys(zip.files);
      const slidesXml = (await Promise.all(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map((n) => zip.file(n)!.async("string")))).join(" ");
      const charts = await Promise.all(names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).map((n) => zip.file(n)!.async("string")));
      return { slidesXml, charts };
    };
    let x = await unzip(d.file.id);
    // The framework is real text in shapes; the 75% is a ring chart.
    expect(x.slidesXml).toContain("Understand");
    expect(x.slidesXml).toContain("Hear your own signals");
    expect(x.charts.some((c) => c.includes("doughnutChart"))).toBe(true);

    // "make slide 5 a chart": refused while the numbers aren't real, then built when she gives them.
    vi.spyOn(llm, "generateJson").mockResolvedValue({ ...none, kind: "chart", title: "Who gets your best skills?", points: [], notes: "ignored", series: ["For others", "For me"], items: [{ label: "Praise", text: "", detail: "", values: [4.6, 1.8] }, { label: "Listen", text: "", detail: "", values: [4.8, 2.1] }] } as any);
    await expect(talk.newSlideGraphic(orgId, d.file.id, 4, "make it a chart", "chart")).rejects.toThrow(/I left slide 5 as it was\. A chart needs real numbers/);
    expect(JSON.parse(db.getChatFiles(orgId, [d.file.id])[0].text).slides[4].kind).toBe("points");
    await talk.newSlideGraphic(orgId, d.file.id, 4, "chart my self-check: praise 4.6 for others and 1.8 for me, listen 4.8 and 2.1", "chart");
    const now = JSON.parse(db.getChatFiles(orgId, [d.file.id])[0].text).slides[4];
    expect(now).toMatchObject({ kind: "chart", series: ["For others", "For me"], notes: "" });
    expect(now.items.map((i: any) => i.values)).toEqual([[4.6, 1.8], [4.8, 2.1]]);
    expect(talk.slideKindName(orgId, d.file.id, 4)).toBe("a chart");
    x = await unzip(d.file.id);
    expect(x.charts.some((c) => c.includes("barChart") && c.includes("For me"))).toBe(true);
    // No graphics on the title slide; a new picture on a graphic keeps its words.
    await expect(talk.newSlideGraphic(orgId, d.file.id, 0)).rejects.toThrow(/title slide/);
    await talk.newSlidePicture(orgId, d.file.id, 5, "");
    expect(JSON.parse(db.getChatFiles(orgId, [d.file.id])[0].text).slides[5]).toMatchObject({ kind: "points", points: ["Notice: Name what you feel", "Breathe: Four slow breaths", "Choose: Pick the next right thing"], items: [] });
  });

  it("times the talk from what she said, else from the Brain, never a guess", async () => {
    const { orgId } = await makeWorkspace("talk-len");
    await db.createKnowledgeItem({ organizationId: orgId, title: "Company training: SHRM Arkansas (HR2026) proposal", category: "speaking", kind: "fact", content: "The Relational Skills HR Already Has, and Almost Never Uses on Themselves. Length: 60 minutes each, the same session both times." });
    const title = "The Relational Skills HR Already Has, and Almost Never Uses on Themselves";
    expect(await talk.talkMinutes(orgId, title, ["can you write it now?"], 90)).toBe(60);
    expect(await talk.talkMinutes(orgId, title, ["make it a 45 minute version"], 90)).toBe(45);
    expect(await talk.talkMinutes(orgId, "A brand new keynote", ["write it"], 0)).toBe(0);
  });

  it("shows the script it already wrote when she asks to see it, and only writes a new one when asked", async () => {
    const { orgId } = await makeWorkspace("talk-show");
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    expect(await talk.showLatest(taylor, "script")).toBeNull();
    // A script saved the old way (before it could open in the chat).
    const f = db.createChatFile({ organizationId: orgId, employeeId: taylor.id, name: "The Relational Skills HR Already Has - script.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 30000, kind: "document", fileUrl: "/files/s.docx", text: "Opening (5 min, slide: Title)\nGood afternoon.\n\nPraise (10 min, slide: Praise)\nLet's talk about praise." });
    db.attachChatFiles(orgId, [f.id], 1);
    const r = (await talk.showLatest(taylor, "script"))!;
    expect(r.card).toMatchObject({ type: "doc", id: f.id, title: "The Relational Skills HR Already Has", subtitle: "Word document · 2 parts" });
    expect(db.getChatFiles(orgId, [f.id])[0].text).toBe("## 1. Opening\n**0:00 to 5:00 · Slide: Title**\n\nGood afternoon.\n\n## 2. Praise\n**5:00 to 15:00 · Slide: Praise**\n\nLet's talk about praise.");
    for (const s of ["can you put it in the chat again where i dont have to download it", "show me the script", "where is the talk", "I can't see it, open it here"]) expect(talk.wantsToSee(s)).toBe(true);
    for (const s of ["write it again as a 45 minute version", "rewrite the opening", "write my SHRM talk", "make a new script"]) expect(talk.wantsToSee(s)).toBe(false);
  });

  it("splits minutes so the parts add up to the talk", () => {
    const parts = talk.fitMinutes(
      [
        { title: "A", minutes: 10, slide: "", covers: "" },
        { title: "B", minutes: 10, slide: "", covers: "" },
        { title: "C", minutes: 10, slide: "", covers: "" },
      ],
      90
    );
    expect(parts.map((p) => p.minutes)).toEqual([30, 30, 30]);
  });

  it("doesn't save or announce the same Brain fact twice", async () => {
    const { orgId } = await makeWorkspace("talk-learn");
    const fact = { topic: "SHRM Arkansas session", fact: "The SHRM Arkansas HR2026 session was accepted.", who: "Ashley", via: "Taylor" };
    expect(await learnFact(orgId, fact)).not.toBeNull();
    expect(await learnFact(orgId, fact)).toBeNull();
    expect((await learnFact(orgId, { ...fact, fact: "The SHRM Arkansas HR2026 session was accepted, and it runs twice." }))?.replaced).toBe(true);
  });
});
