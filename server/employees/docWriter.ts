/**
 * A Word file from the simple text the chat shows: "# Title", "## Heading",
 * "- point" lines, "_meta line_", "**bold**" and plain paragraphs.
 */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function simpleDocx(text: string) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const runs = (line: string, base: { italics?: boolean } = {}) =>
    line
      .split(/(\*\*[^*]+\*\*)/g)
      .filter(Boolean)
      .map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? new TextRun({ text: part.slice(2, -2), bold: true, ...base }) : new TextRun({ text: part, ...base })));
  const children: InstanceType<typeof Paragraph>[] = [];
  for (const block of text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
    const lines = block.split("\n");
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      if (l.startsWith("# ")) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(l.slice(2))] }));
      else if (l.startsWith("## ")) children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun(l.slice(3))] }));
      else if (/^[-*] /.test(l)) children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 80 }, children: runs(l.slice(2)) }));
      else if (/^_.*_$/.test(l)) children.push(new Paragraph({ spacing: { after: 160 }, children: runs(l.slice(1, -1), { italics: true }) }));
      else children.push(new Paragraph({ spacing: { after: 140 }, children: runs(l) }));
    }
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}
