import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { uploadsRoot } from "../storage";
import { fileKind, readFile, unsupportedNote } from "../employees/docs";
import { guestSharesForUser } from "../db";
import type { Viewer } from "./pjAccess";

/**
 * A preview of an attached file, shown in the app instead of a download.
 * Images and PDFs the browser shows itself; Word, PowerPoint, text and
 * spreadsheets come back here as text or rows.
 */
export type Preview =
  | { kind: "image" | "pdf"; url: string }
  | { kind: "text"; text: string; note: string | null }
  | { kind: "sheet"; sheets: { name: string; rows: string[][] }[] }
  | { kind: "none"; note: string };

const MAX = 20 * 1024 * 1024;

function splitCsvLine(line: string) {
  const out: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cell); cell = ""; }
    else cell += c;
  }
  out.push(cell);
  return out;
}

export async function preview(orgId: number, v: Viewer, fileId: number): Promise<Preview> {
  const f = db.getChatFiles(orgId, [fileId])[0];
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That file is gone." });
  if (v.kind === "guest" && !(f.fileUrl.includes("/work/") && guestSharesForUser(v.userId).some((g) => g.organizationId === orgId))) throw new TRPCError({ code: "FORBIDDEN", message: "That file isn't shared with you." });
  const name = f.name;
  const mime = f.mime || "";
  if (f.kind === "image" || /^image\//.test(mime)) return { kind: "image", url: f.fileUrl };
  const kind = fileKind(name, mime);
  if (kind === "pdf" || mime === "application/pdf") return { kind: "pdf", url: f.fileUrl };
  const note = unsupportedNote(name);
  if (note) return { kind: "none", note: `${note} You can still download it.` };
  const full = path.join(uploadsRoot(), f.fileUrl.replace(/^\/files\//, ""));
  const stat = await fs.promises.stat(full).catch(() => null);
  if (!stat) return { kind: "none", note: "This file is missing from the server." };
  if (stat.size > MAX) return { kind: "none", note: "This file is too big to preview here. Download it instead." };
  const buf = await fs.promises.readFile(full);
  if (kind === "csv" || mime === "text/csv" || /\.csv$/i.test(name)) {
    const lines = buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 500);
    return { kind: "sheet", sheets: [{ name: name.replace(/\.csv$/i, ""), rows: lines.map(splitCsvLine) }] };
  }
  let read;
  try {
    read = await readFile(buf, name, mime);
  } catch (err) {
    return { kind: "none", note: `${(err as Error).message} You can still download it.` };
  }
  if (read.unit === "sheets") {
    const sheets = read.text
      .split(/\n\n(?=## Sheet: )/)
      .map((part) => {
        const [head, ...rows] = part.split("\n");
        return { name: head.replace(/^## Sheet: /, ""), rows: rows.slice(0, 500).map((r) => r.split(" | ")) };
      })
      .filter((s) => s.rows.length);
    return { kind: "sheet", sheets };
  }
  return { kind: "text", text: read.text.slice(0, 200_000), note: read.note ?? null };
}
