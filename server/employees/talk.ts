import * as db from "../db";
import { generateJson, generateText } from "../_core/llm";
import { storagePut } from "../storage";
import type { AIEmployee, ChatMessage } from "../../drizzle/schema";
import { systemPromptAbout, working } from "./tasks";

/**
 * Taylor's talk work: the full word-for-word script, timed to the talk's real
 * length with the slide for each part, and the slide deck to go with it. Both
 * run in the background and land in Taylor's chat as a card that opens right
 * there (the script as a document, the deck slide by slide) with the Word or
 * PowerPoint file to download.
 */

type Section = { title: string; minutes: number; slide: string; covers: string };
type Outline = { title: string; event: string; sections: Section[] };
export type Slide = { kind: "title" | "points" | "big" | "activity" | "close"; title: string; points: string[]; notes: string };
export type Deck = { title: string; event: string; slides: Slide[] };

const STYLE = `Write the way an experienced human speaker talks: plain, warm, specific, in first person.
- No em dashes or en dashes. Use periods, commas, parentheses or colons.
- Never use "you're not here because...", "you don't only...", "this isn't X, it's Y", or "we won't do X, we will do Y" constructions.
- Never add lines that announce how important something is ("this is the sentence to take off this slide", "that number will sit behind everything"). Just say the thing.
- Use only facts, numbers and research that appear in what you were given. When a point needs a statistic you weren't given, write [add source] instead of making one up.
- Say what the audience does when there's an activity (stand, write, turn to a partner), and how long it takes.`;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** What's being made right now, for the "working" line in chat. */
const busy = new Map<number, string>();

export function talkInProgress(orgId: number) {
  return busy.get(orgId) ?? null;
}

const fmt = (m: number) => `${m}:00`;
const safeName = (t: string) => t.replace(/[^\w\s.,()-]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Talk";
const strip = (t: string) => t.replace(/\s*[–—]\s*/g, ", ");

function runInBackground(emp: AIEmployee, label: string, job: () => Promise<unknown>) {
  const orgId = emp.organizationId;
  busy.set(orgId, label);
  void job()
    .catch(async (err) => {
      await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `I couldn't finish it: ${err instanceof Error ? err.message : String(err)}. Ask me again and I'll start over.` });
    })
    .finally(() => busy.delete(orgId));
}

// ==========================================
// How long the talk is
// ==========================================

/**
 * The talk's length: what the person said in this conversation, else what the
 * Brain says for that session, else what was decided. 0 means nobody said.
 */
export async function talkMinutes(orgId: number, title: string, recentUserText: string[], decided: number) {
  for (const t of recentUserText) {
    const m = t.match(/\b(\d{2,3})[\s-]*(?:minutes?|mins?)\b/i) ?? t.match(/\b(\d)(?:\.(\d))?[\s-]*hours?\b/i);
    if (m && /min/i.test(m[0])) return Number(m[1]);
    if (m) return Math.round((Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0)) * 60);
  }
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const brain = await db.listKnowledgeByOrg(orgId);
  const scored = brain
    .map((k) => {
      const text = `${k.title}\n${k.content}`.toLowerCase();
      return { k, score: words.filter((w) => text.includes(w)).length, mins: text.match(/\b(\d{2,3})\s*minutes?\s*(?:each|long)?\b/) };
    })
    .filter((x) => x.mins && x.score >= Math.min(3, Math.max(1, words.length)))
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.mins) return Number(scored[0].mins[1]);
  return decided > 0 ? decided : 0;
}

// ==========================================
// The script
// ==========================================

/** Starts the script. Returns what Taylor says right away. */
export function startTalkScript(emp: AIEmployee, input: { title: string; minutes: number; notes: string; said: string }) {
  const orgId = emp.organizationId;
  if (busy.has(orgId)) return { started: false, text: `I'm still working on ${busy.get(orgId)}. I'll post it here when it's done.` };
  const minutes = Math.max(10, Math.min(180, Math.round(input.minutes)));
  runInBackground(emp, `the script for ${input.title || "your talk"}`, () => writeTalkScript(emp, { ...input, minutes }));
  return { started: true, text: `I'm writing the ${minutes}-minute script for ${input.title || "your talk"} now, word for word with the slide for each part. It takes a few minutes. It'll show up here, and you can open it right in this chat.` };
}

export async function writeTalkScript(emp: AIEmployee, input: { title: string; minutes: number; notes: string; said: string }) {
  return working(emp, async () => {
    const about = `${input.title} ${input.notes} ${input.said}`;
    const { system } = await systemPromptAbout(
      emp,
      about,
      `Plan the full script for a talk the owner is giving: ${input.title}. It runs exactly ${input.minutes} minutes. Use the session title, summary, learning objectives, audience and event details in the Brain when they're there.
Split it into sections that add up to exactly ${input.minutes} minutes: an opening, the main parts, any activities, and a close. For each: a short title, its minutes, the slide it goes on (the slide's title), and one or two sentences on what it covers.
event: the event, date and room as one line from the Brain ('' when the Brain doesn't say).`
    );
    const outline = await generateJson<Outline>({
      system,
      prompt: `What the owner asked for: ${input.said}\n${input.notes ? `Notes: ${input.notes}\n` : ""}Length: ${input.minutes} minutes.`,
      schemaName: "talk_outline",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "event", "sections"],
        properties: {
          title: { type: "string" },
          event: { type: "string" },
          sections: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["title", "minutes", "slide", "covers"], properties: { title: { type: "string" }, minutes: { type: "number" }, slide: { type: "string" }, covers: { type: "string" } } },
          },
        },
      },
      maxTokens: 3000,
    });
    const sections = fitMinutes(outline.sections ?? [], input.minutes);
    if (!sections.length) throw new Error("The plan for the talk came back empty");

    // About 130 spoken words a minute; each section is written on its own so the whole talk fits.
    const plan = sections.map((s, i) => `${i + 1}. ${s.title} (${s.minutes} min, slide: ${s.slide}): ${s.covers}`).join("\n");
    const texts: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const { system: sys } = await systemPromptAbout(emp, `${input.title} ${s.title} ${s.covers}`, `Write the word-for-word speaker script for one section of the owner's talk "${outline.title || input.title}".\n${STYLE}`);
      texts.push(
        strip(
          await generateText({
            system: sys,
            prompt: `The whole talk, for context:\n${plan}\n\nWrite section ${i + 1} only: "${s.title}", ${s.minutes} minutes (about ${s.minutes * 130} spoken words), on the slide "${s.slide}". It covers: ${s.covers}\nWrite only what she says, in paragraphs, with any stage direction in square brackets. No headings.`,
            maxTokens: Math.min(8000, 400 + s.minutes * 260),
            timeoutMs: 240_000,
          })
        )
      );
    }

    const title = outline.title || input.title || "Talk script";
    const buf = await scriptDocx(title, outline.event, input.minutes, sections, texts);
    const name = `${safeName(title)} - script.docx`;
    const saved = await storagePut(`org-${emp.organizationId}/talks/${Date.now()}-${name.replace(/\s+/g, "-")}`, buf, DOCX);
    // The text is kept as simple headings and paragraphs: the chat shows it, and Taylor reads it for changes and slides.
    let at = 0;
    const doc = [
      `# ${title}`,
      outline.event ? outline.event : "",
      `_${input.minutes} minutes · ${sections.length} parts_`,
      ...sections.map((s, i) => {
        const line = `## ${i + 1}. ${s.title}\n**${fmt(at)} to ${fmt(at + s.minutes)} · Slide: ${s.slide}**\n\n${texts[i].trim()}`;
        at += s.minutes;
        return line;
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
    const file = db.createChatFile({ organizationId: emp.organizationId, employeeId: emp.id, name, mime: DOCX, size: buf.length, kind: "document", fileUrl: saved.url, text: doc.slice(0, 200_000), pages: null });
    const msg = await db.createChatMessage({
      organizationId: emp.organizationId,
      employeeId: emp.id,
      role: "employee",
      authorName: emp.name,
      content: `The script for "${title}" is ready: ${input.minutes} minutes in ${sections.length} parts, with the time and the slide for each part. Press Open to read it here. Tell me what to change, like "make the opening shorter", or say "build the slides" and I'll make the deck from it.`,
      cards: JSON.stringify([{ type: "doc", id: file.id, title, subtitle: `Word document · ${input.minutes} minutes · ${sections.length} parts` }]),
    });
    db.attachChatFiles(emp.organizationId, [file.id], msg.id);
    return { file, sections };
  });
}

/** Section minutes that add up to exactly the talk's length. */
export function fitMinutes(list: Section[], total: number): Section[] {
  const s = list.filter((x) => x && x.title).map((x) => ({ ...x, minutes: Math.max(1, Math.round(Number(x.minutes) || 1)) }));
  if (!s.length) return s;
  let sum = s.reduce((a, x) => a + x.minutes, 0);
  // Scale to the total, then settle the remainder on the longest parts.
  if (sum !== total) {
    s.forEach((x) => (x.minutes = Math.max(1, Math.round((x.minutes * total) / sum))));
    sum = s.reduce((a, x) => a + x.minutes, 0);
    const byLength = [...s].sort((a, b) => b.minutes - a.minutes);
    for (let i = 0; sum !== total && i < 500; i++) {
      const x = byLength[i % byLength.length];
      if (sum < total) {
        x.minutes++;
        sum++;
      } else if (x.minutes > 1) {
        x.minutes--;
        sum--;
      }
    }
  }
  return s;
}

async function scriptDocx(title: string, event: string, minutes: number, sections: Section[], texts: string[]) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
    ...(event ? [new Paragraph({ spacing: { after: 80 }, children: [new TextRun(event)] })] : []),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: `${minutes} minutes · ${sections.length} parts`, italics: true })] }),
  ];
  let at = 0;
  sections.forEach((s, i) => {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun(`${i + 1}. ${s.title}`)] }));
    children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: `${fmt(at)} to ${fmt(at + s.minutes)} · Slide: ${s.slide}`, bold: true })] }));
    at += s.minutes;
    for (const para of texts[i].split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
      const direction = /^\[.*\]$/.test(para);
      children.push(new Paragraph({ spacing: { after: 140 }, children: [new TextRun({ text: para, italics: direction })] }));
    }
  });
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ==========================================
// The slides
// ==========================================

/** The newest talk script in Taylor's chat, to build the slides from. */
export function latestScript(orgId: number, empId: number) {
  return db.recentChatFiles(orgId, empId, 30).find((f) => f.mime === DOCX && / - script\.docx$/.test(f.name)) ?? null;
}

export function startSlides(emp: AIEmployee, input: { title: string; notes: string; said: string }) {
  const orgId = emp.organizationId;
  if (busy.has(orgId)) return { started: false, text: `I'm still working on ${busy.get(orgId)}. I'll post it here when it's done.` };
  const script = latestScript(orgId, emp.id);
  const label = `the slides for ${input.title || (script ? script.name.replace(/ - script\.docx$/, "") : "your talk")}`;
  runInBackground(emp, label, () => buildSlides(emp, input));
  return { started: true, text: `I'm building ${label} now${script ? ", from the script, with your speaker notes on every slide" : ""}. It'll show up here, and you can flip through it right in this chat.` };
}

export async function buildSlides(emp: AIEmployee, input: { title: string; notes: string; said: string }) {
  return working(emp, async () => {
    const script = latestScript(emp.organizationId, emp.id);
    const { system } = await systemPromptAbout(
      emp,
      `${input.title} ${input.notes} ${script?.name ?? ""}`,
      `Build the slide deck for a talk the owner is giving${input.title ? `: ${input.title}` : ""}.${script ? " Follow the script you're given: one slide for each part it names, in order, plus a title slide first and a closing slide last." : " Use the session details in the Brain."}
- kind: title (first slide), points (a heading with 2 to 4 short points), big (one large statement or number), activity (what the room does, with the minutes), close (thanks and contact).
- Slide text is short: points under 12 words each. No em dashes or en dashes.
- notes: what she says on that slide, taken from the script when there is one (keep its timing line first), else 2 to 4 sentences.
- Use only facts and numbers you were given; write [add source] where a number would need one.
event: the event, date and room as one line ('' when unknown).`
    );
    const deck = await generateJson<Deck>({
      system,
      prompt: `${input.said ? `What the owner asked for: ${input.said}\n` : ""}${input.notes ? `Notes: ${input.notes}\n` : ""}${script ? `The script:\n${script.text.slice(0, 60_000)}` : ""}`,
      schemaName: "talk_deck",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "event", "slides"],
        properties: {
          title: { type: "string" },
          event: { type: "string" },
          slides: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "title", "points", "notes"],
              properties: { kind: { type: "string", enum: ["title", "points", "big", "activity", "close"] }, title: { type: "string" }, points: { type: "array", items: { type: "string" } }, notes: { type: "string" } },
            },
          },
        },
      },
      maxTokens: 16000,
      timeoutMs: 300_000,
    });
    const slides = (deck.slides ?? []).filter((s) => s && s.title).map((s) => ({ ...s, title: strip(s.title), points: (s.points ?? []).map(strip).slice(0, 5), notes: strip(s.notes ?? "") }));
    if (!slides.length) throw new Error("The deck came back empty");
    const title = deck.title || input.title || "Talk";
    const org = await db.getOrganizationById(emp.organizationId);
    const colors = (org?.brandColors ?? "").match(/#[0-9a-f]{6}/gi) ?? [];
    const theme = { dark: colors[0] ?? "#0d3b2e", accent: colors[1] ?? "#e88a3a" };
    const buf = await deckPptxFile(title, deck.event, slides, theme);
    const name = `${safeName(title)} - slides.pptx`;
    const saved = await storagePut(`org-${emp.organizationId}/talks/${Date.now()}-${name.replace(/\s+/g, "-")}`, buf, PPTX);
    const data: Deck & { theme: typeof theme } = { title, event: deck.event ?? "", slides, theme };
    const file = db.createChatFile({ organizationId: emp.organizationId, employeeId: emp.id, name, mime: PPTX, size: buf.length, kind: "document", fileUrl: saved.url, text: JSON.stringify(data).slice(0, 400_000), pages: slides.length });
    const msg = await db.createChatMessage({
      organizationId: emp.organizationId,
      employeeId: emp.id,
      role: "employee",
      authorName: emp.name,
      content: `The slides for "${title}" are ready: ${slides.length} slides${script ? ", with what you say on each one in the speaker notes" : ""}. Press Open to flip through them here. Tell me what to change, like "shorter text on slide 4".`,
      cards: JSON.stringify([{ type: "deck", id: file.id, title, subtitle: `PowerPoint · ${slides.length} slides` }]),
    });
    db.attachChatFiles(emp.organizationId, [file.id], msg.id);
    return { file, slides };
  });
}

async function deckPptxFile(title: string, event: string, slides: Slide[], theme: { dark: string; accent: string }) {
  const PptxGenJS = (await import("pptxgenjs")).default as unknown as new () => any;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = title;
  const dark = theme.dark.slice(1);
  const accent = theme.accent.slice(1);
  for (const s of slides) {
    const slide = pptx.addSlide();
    if (s.kind === "title" || s.kind === "close") {
      slide.background = { color: dark };
      slide.addText(s.title, { x: 0.8, y: 2.2, w: 11.7, h: 1.6, fontSize: 40, bold: true, color: "FFFFFF", fontFace: "Calibri", valign: "bottom" });
      const sub = s.points.length ? s.points.join("\n") : s.kind === "title" ? event : "";
      if (sub) slide.addText(sub, { x: 0.8, y: 3.9, w: 11.7, h: 1.6, fontSize: 20, color: "E6F2EC", fontFace: "Calibri", valign: "top" });
      slide.addShape("rect", { x: 0.8, y: 3.75, w: 1.2, h: 0.08, fill: { color: accent } });
    } else if (s.kind === "big") {
      slide.background = { color: "FFFFFF" };
      slide.addText(s.title, { x: 0.9, y: 1.4, w: 11.5, h: 2.6, fontSize: 44, bold: true, color: dark, fontFace: "Calibri", valign: "middle" });
      if (s.points.length) slide.addText(s.points.join("\n"), { x: 0.9, y: 4.2, w: 11.5, h: 2, fontSize: 22, color: "3D4C45", fontFace: "Calibri", valign: "top" });
      slide.addShape("rect", { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: accent } });
    } else {
      slide.background = { color: s.kind === "activity" ? "F4F8F6" : "FFFFFF" };
      slide.addShape("rect", { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: accent } });
      slide.addText(s.title, { x: 0.7, y: 0.5, w: 12, h: 1, fontSize: 32, bold: true, color: dark, fontFace: "Calibri" });
      if (s.points.length)
        slide.addText(
          s.points.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
          { x: 0.9, y: 1.7, w: 11.6, h: 5.1, fontSize: 24, color: "24332C", fontFace: "Calibri", valign: "top", paraSpaceAfter: 14 }
        );
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

/** Recent messages the person wrote, newest first, for the talk's length. */
export function userLines(history: ChatMessage[] | undefined, said: string) {
  return [said, ...(history ?? []).filter((m) => m.role === "user").map((m) => m.content).reverse()].filter(Boolean).slice(0, 12);
}
