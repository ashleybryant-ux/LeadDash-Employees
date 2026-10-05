import * as db from "../db";
import { generateJson, generateText } from "../_core/llm";
import { storagePut } from "../storage";
import type { AIEmployee } from "../../drizzle/schema";
import { systemPromptAbout, working } from "./tasks";

/**
 * Taylor writes the full word-for-word script for a talk the owner is giving,
 * timed to its real length, with the slide each part goes on. It runs in the
 * background and lands in Taylor's chat as a Word file, so the reply never
 * promises work that isn't happening.
 */

type Section = { title: string; minutes: number; slide: string; covers: string };
type Outline = { title: string; event: string; sections: Section[] };

const STYLE = `Write the way an experienced human speaker talks: plain, warm, specific, in first person.
- No em dashes or en dashes. Use periods, commas, parentheses or colons.
- Never use "you're not here because...", "you don't only...", "this isn't X, it's Y", or "we won't do X, we will do Y" constructions.
- Never add lines that announce how important something is ("this is the sentence to take off this slide", "that number will sit behind everything"). Just say the thing.
- Use only facts, numbers and research that appear in what you were given. When a point needs a statistic you weren't given, write [add source] instead of making one up.
- Say what the audience does when there's an activity (stand, write, turn to a partner), and how long it takes.`;

/** In-progress scripts, for the "working" line in chat. */
const writing = new Map<number, string>();

export function talkInProgress(orgId: number) {
  return writing.get(orgId) ?? null;
}

const fmt = (m: number) => `${m}:00`;

/** Starts the script. Returns what Taylor says right away. */
export function startTalkScript(emp: AIEmployee, input: { title: string; minutes: number; notes: string; said: string }) {
  const orgId = emp.organizationId;
  if (writing.has(orgId)) return { started: false, text: `I'm already writing the script for ${writing.get(orgId)}. I'll post it here as a Word file when it's done.` };
  const minutes = Math.max(10, Math.min(180, Math.round(input.minutes)));
  writing.set(orgId, input.title || "your talk");
  void writeTalkScript(emp, { ...input, minutes })
    .catch(async (err) => {
      await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `I couldn't finish the script: ${err instanceof Error ? err.message : String(err)}. Ask me again and I'll start over.` });
    })
    .finally(() => writing.delete(orgId));
  return { started: true, text: `I'm writing the ${minutes}-minute script for ${input.title || "your talk"} now, word for word with the slide for each part. It takes a few minutes. I'll post it here as a Word file when it's done.` };
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
        await generateText({
          system: sys,
          prompt: `The whole talk, for context:\n${plan}\n\nWrite section ${i + 1} only: "${s.title}", ${s.minutes} minutes (about ${s.minutes * 130} spoken words), on the slide "${s.slide}". It covers: ${s.covers}\nWrite only what she says, in paragraphs, with any stage direction in square brackets. No headings.`,
          maxTokens: Math.min(8000, 400 + s.minutes * 260),
          timeoutMs: 240_000,
        })
      );
    }

    const title = outline.title || input.title || "Talk script";
    const buf = await scriptDocx(title, outline.event, input.minutes, sections, texts);
    const name = `${title.replace(/[^\w\s.,()-]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Talk script"} - script.docx`;
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const saved = await storagePut(`org-${emp.organizationId}/talks/${Date.now()}-${name.replace(/\s+/g, "-")}`, buf, mime);
    const fullText = sections.map((s, i) => `${s.title} (${s.minutes} min, slide: ${s.slide})\n${texts[i]}`).join("\n\n");
    const file = db.createChatFile({ organizationId: emp.organizationId, employeeId: emp.id, name, mime, size: buf.length, kind: "document", fileUrl: saved.url, text: fullText.slice(0, 200_000), pages: null });
    const msg = await db.createChatMessage({
      organizationId: emp.organizationId,
      employeeId: emp.id,
      role: "employee",
      authorName: emp.name,
      content: `The script for "${title}" is ready: ${input.minutes} minutes in ${sections.length} parts, with the time and the slide for each part. It's attached as a Word file. Tell me what to change, like "make the opening shorter" or "add a story in part 3", and I'll redo that part.`,
      attachments: JSON.stringify([{ id: file.id, name, size: buf.length, kind: "document", url: saved.url }]),
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
      children.push(new Paragraph({ spacing: { after: 140 }, children: [new TextRun({ text: para.replace(/[–—]/g, ", "), italics: direction })] }));
    }
  });
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
