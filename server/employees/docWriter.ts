/**
 * A Word file from the simple text the chat shows: "# Title", "## Heading",
 * "- point" lines, "_meta line_", "**bold**" and plain paragraphs.
 */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** "1. a 2. b" on one line, split into its numbered items. */
function numbered(line: string) {
  const parts = line.split(/(?:^|\s)(\d{1,2})[.)] (?=\S)/);
  const items: string[] = [];
  let want = Number(line.match(/^(\d{1,2})/)?.[1] ?? 1);
  let cur = "";
  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    if (n === want) {
      if (cur) items.push(cur.trim());
      cur = parts[i + 1] ?? "";
      want = n + 1;
    } else cur += ` ${parts[i]}. ${parts[i + 1] ?? ""}`;
  }
  if (cur) items.push(cur.trim());
  return items;
}

export async function simpleDocx(text: string) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, ShadingType } = await import("docx");
  const cellsOf = (line: string) => line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const isRule = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line);
  const runs = (line: string, base: { italics?: boolean } = {}) =>
    line
      .split(/(\*\*[^*]+\*\*)/g)
      .filter(Boolean)
      .map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? new TextRun({ text: part.slice(2, -2), bold: true, ...base }) : new TextRun({ text: part, ...base })));
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  let listNo = 0;
  let lastNumbered = false;
  for (const block of text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
    const lines = block.split("\n");
    const trimmed = lines.map((l) => l.trim()).filter(Boolean);
    // A "| a | b |" table with its "|---|" line becomes a real Word table.
    if (trimmed.length >= 2 && trimmed.every((l) => l.startsWith("|")) && isRule(trimmed[1])) {
      const [head, , ...rest] = trimmed;
      const rows = [head, ...rest.filter((r) => !isRule(r))].map((r, ri) =>
        new TableRow({
          tableHeader: ri === 0,
          children: cellsOf(r).map(
            (c) =>
              new TableCell({
                shading: ri === 0 ? { type: ShadingType.CLEAR, color: "auto", fill: "EEF4F1" } : undefined,
                children: [new Paragraph({ children: ri === 0 ? [new TextRun({ text: c.replace(/\*\*/g, ""), bold: true })] : runs(c) })],
              })
          ),
        })
      );
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
      continue;
    }
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      const wasNumbered = lastNumbered;
      lastNumbered = false;
      if (l.startsWith("# ")) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(l.slice(2))] }));
      else if (l.startsWith("## ")) children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun(l.slice(3))] }));
      else if (/^(-{3,}|\*{3,}|_{3,})$/.test(l)) children.push(new Paragraph({ border: { bottom: { color: "CFDCD5", space: 1, style: "single", size: 6 } }, spacing: { after: 160 }, children: [] }));
      else if (l.startsWith("### ")) children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200 }, children: [new TextRun(l.slice(4).replace(/\*\*/g, ""))] }));
      else if (/^\d{1,2}[.)] \S/.test(l)) {
        // Each list starts again at 1: a new numbering instance whenever the line before wasn't a step.
        if (!wasNumbered) listNo++;
        for (const item of numbered(l)) children.push(new Paragraph({ numbering: { reference: "steps", level: 0, instance: listNo }, spacing: { after: 80 }, children: runs(item) }));
        lastNumbered = true;
        continue;
      }
      else if (/^[-*] /.test(l)) children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 80 }, children: runs(l.slice(2)) }));
      else if (/^_.*_$/.test(l)) children.push(new Paragraph({ spacing: { after: 160 }, children: runs(l.slice(1, -1), { italics: true }) }));
      else children.push(new Paragraph({ spacing: { after: 140 }, children: runs(l) }));
    }
  }
  return Packer.toBuffer(new Document({ numbering: { config: [{ reference: "steps", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: "left", style: { paragraph: { indent: { left: 360, hanging: 260 } } } }] }] }, sections: [{ children }] }));
}
