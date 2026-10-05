import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { ENV } from "../_core/env";
import { owners, ownerOf } from "./goals";
import { askEmployee, createTask, fieldsOf, parse, runAutomations, statusesOf, type Actor, type Assignee } from "./projects";

/**
 * Forms: questions anyone can answer at a public link. Each answer makes a
 * task in the form's list, fills the task fields the questions point to, and
 * goes to the person or employee picked (an employee can be asked to start on
 * it right away).
 */

export const Q_TYPES = ["text", "longtext", "email", "phone", "number", "dropdown", "labels", "date", "files"] as const;
export type Question = { id: string; label: string; type: (typeof Q_TYPES)[number]; required: boolean; options?: string[]; mapTo: string };
export type FormSettings = { intro: string; status: string; assignTo: string; ask: string; thanks: string };

const token = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 8)}`;

function mustForm(orgId: number, id: number) {
  const f = db.work.forms.get(orgId, id);
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That form isn't in this workspace." });
  return f;
}

export async function form(orgId: number, id: number) {
  const f = mustForm(orgId, id);
  const list = f.listId ? db.work.lists.get(orgId, f.listId) : null;
  const folder = f.folderId ? db.work.folders.get(orgId, f.folderId) : null;
  const people = await owners(orgId);
  const s = parse<FormSettings>(f.settings, { intro: "", status: "", assignTo: "", ask: "", thanks: "" });
  const [type, idStr] = s.assignTo.split(":");
  return {
    form: { id: f.id, title: f.title, folderId: f.folderId, folderName: folder?.name ?? null, listId: f.listId, listName: list?.name ?? null, questions: parse<Question[]>(f.questions, []), settings: s, active: f.active, link: `${ENV.appUrl}/form/${f.token}` },
    assignee: s.assignTo ? ownerOf(people, type, Number(idStr)) : null,
    fields: list ? fieldsOf(orgId, list) : [],
    statuses: list ? statusesOf(list) : [],
    answers: db.work.answers.where(orgId, "formId", f.id).length,
    people: people.map((p) => ({ type: p.type, id: p.id, name: p.name })),
    lists: db.work.lists.all(orgId).map((l) => ({ id: l.id, name: l.name })),
  };
}

export function saveForm(orgId: number, input: { id?: number; folderId?: number | null; title: string; listId?: number | null; questions?: Question[]; settings?: FormSettings; active?: boolean }) {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the form." });
  if (input.listId && !db.work.lists.get(orgId, input.listId)) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  const questions = input.questions?.slice(0, 50).map((q, i) => ({
    id: String(q.id || `q${i}`).slice(0, 40),
    label: q.label.trim().slice(0, 200),
    type: (Q_TYPES as readonly string[]).includes(q.type) ? q.type : "text",
    required: !!q.required,
    ...(q.options?.length ? { options: q.options.map((o) => o.trim().slice(0, 80)).filter(Boolean).slice(0, 40) } : {}),
    mapTo: String(q.mapTo || "description").slice(0, 80),
  }));
  if (questions?.some((q) => !q.label)) throw new TRPCError({ code: "BAD_REQUEST", message: "Every question needs words." });
  const settings = input.settings ? { intro: input.settings.intro.slice(0, 1000), status: input.settings.status.slice(0, 40), assignTo: input.settings.assignTo.slice(0, 40), ask: input.settings.ask.slice(0, 1000), thanks: input.settings.thanks.slice(0, 500) } : undefined;
  const row = { title, ...(input.folderId !== undefined ? { folderId: input.folderId } : {}), ...(input.listId !== undefined ? { listId: input.listId } : {}), ...(questions ? { questions: JSON.stringify(questions) } : {}), ...(settings ? { settings: JSON.stringify(settings) } : {}), ...(input.active !== undefined ? { active: input.active } : {}) };
  if (input.id) {
    mustForm(orgId, input.id);
    return db.work.forms.update(orgId, input.id, row)!;
  }
  return db.work.forms.insert({
    organizationId: orgId,
    folderId: input.folderId ?? null,
    listId: input.listId ?? null,
    title,
    token: token(),
    sort: db.work.forms.all(orgId).length,
    questions: JSON.stringify(questions ?? [{ id: "q0", label: "Your name", type: "text", required: true, mapTo: "name" }, { id: "q1", label: "Email", type: "email", required: true, mapTo: "description" }]),
    settings: JSON.stringify(settings ?? { intro: "", status: "", assignTo: "", ask: "", thanks: "Thanks. We got it." }),
  });
}

export function removeForm(orgId: number, id: number) {
  mustForm(orgId, id);
  for (const a of db.work.answers.where(orgId, "formId", id)) db.work.answers.remove(orgId, a.id);
  db.work.forms.remove(orgId, id);
}

export function answers(orgId: number, id: number) {
  const f = mustForm(orgId, id);
  const qs = parse<Question[]>(f.questions, []);
  return db.work.answers
    .where(orgId, "formId", id)
    .sort((a, b) => b.id - a.id)
    .map((a) => {
      const vals = parse<Record<string, unknown>>(a.answers, {});
      const t = a.taskId ? db.work.tasks.get(orgId, a.taskId) : null;
      return { id: a.id, at: a.createdAt, task: t ? { id: t.id, name: t.name, status: t.status } : null, items: qs.map((q) => ({ label: q.label, value: show(vals[q.id]) })) };
    });
}

const show = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "object" && x && "name" in x ? (x as { name: string }).name : String(x))).join(", ") : v === undefined || v === null ? "" : String(v));

/** The public page's view of a form (no workspace details beyond its name). */
export async function publicForm(tok: string) {
  const f = db.formByToken(tok);
  if (!f || !f.active) return null;
  const org = await db.getOrganizationById(f.organizationId);
  const s = parse<FormSettings>(f.settings, { intro: "", status: "", assignTo: "", ask: "", thanks: "" });
  return { title: f.title, intro: s.intro, thanks: s.thanks || "Thanks. We got it.", questions: parse<Question[]>(f.questions, []), orgName: org?.name ?? "", logoUrl: org?.logoUrl ?? null };
}

type Upload = { name: string; mime: string; data: string };

/** One answer from the public page: checks it, makes the task, and passes it on. */
export async function submit(tok: string, values: Record<string, unknown>, uploads: Record<string, Upload[]>) {
  const f = db.formByToken(tok);
  if (!f || !f.active) throw new TRPCError({ code: "NOT_FOUND", message: "This form isn't taking answers." });
  const orgId = f.organizationId;
  const qs = parse<Question[]>(f.questions, []);
  const s = parse<FormSettings>(f.settings, { intro: "", status: "", assignTo: "", ask: "", thanks: "" });
  const list = f.listId ? db.work.lists.get(orgId, f.listId) : null;
  if (!list) throw new TRPCError({ code: "BAD_REQUEST", message: "This form isn't set up yet." });
  const clean: Record<string, unknown> = {};
  for (const q of qs) {
    let v = values[q.id];
    if (q.type === "labels") v = (Array.isArray(v) ? v : v ? [v] : []).map(String).filter((x) => (q.options ?? []).includes(x));
    else if (q.type === "dropdown") v = typeof v === "string" && (q.options ?? []).includes(v) ? v : "";
    else if (q.type === "number") v = v === "" || v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v);
    else if (q.type === "files") v = [];
    else v = typeof v === "string" ? v.trim().slice(0, q.type === "longtext" ? 5000 : 500) : "";
    if (q.type === "email" && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) throw new TRPCError({ code: "BAD_REQUEST", message: `"${q.label}" needs an email address.` });
    if (q.type === "date" && v && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new TRPCError({ code: "BAD_REQUEST", message: `"${q.label}" needs a date.` });
    const empty = v === "" || v === null || (Array.isArray(v) && !v.length);
    if (q.required && empty && !(q.type === "files" && uploads[q.id]?.length)) throw new TRPCError({ code: "BAD_REQUEST", message: `Fill in "${q.label}".` });
    clean[q.id] = v;
  }
  // Files: saved to the workspace, then attached to the task.
  const { storagePut } = await import("../storage");
  const { sniffImageType } = await import("../uploads");
  const fileIds: number[] = [];
  let total = 0;
  for (const q of qs.filter((x) => x.type === "files")) {
    const saved: { id: number; name: string }[] = [];
    for (const u of (uploads[q.id] ?? []).slice(0, 5)) {
      const buf = Buffer.from(u.data, "base64");
      total += buf.length;
      if (total > 20_000_000) throw new TRPCError({ code: "BAD_REQUEST", message: "Files can be up to 20 MB in all." });
      const name = u.name.replace(/[^\w.\- ]+/g, "").slice(0, 120) || "file";
      const img = sniffImageType(buf);
      const put = await storagePut(`org-${orgId}/work/${name}`, buf, img ?? u.mime);
      const cf = db.createChatFile({ organizationId: orgId, employeeId: 0, userId: 0, name, mime: img ?? (u.mime || "application/octet-stream").slice(0, 100), size: buf.length, kind: img ? "image" : "document", fileUrl: put.url, text: "", pages: null });
      saved.push({ id: cf.id, name: cf.name });
      fileIds.push(cf.id);
    }
    clean[q.id] = saved;
  }
  const fields = fieldsOf(orgId, list);
  const taskFields: Record<string, unknown> = {};
  let name = "";
  let due: string | null = null;
  const lines: string[] = [];
  for (const q of qs) {
    const v = clean[q.id];
    const text = show(v);
    if (q.mapTo === "name" && text) name = name ? `${name} ${text}` : text;
    else if (q.mapTo === "due" && typeof v === "string" && v) due = v;
    else if (q.mapTo.startsWith("field:")) {
      const fd = fields.find((x) => x.id === q.mapTo.slice(6));
      if (fd) {
        if (fd.type === "dropdown") taskFields[fd.id] = fd.options?.find((o) => o.name.toLowerCase() === text.toLowerCase())?.id ?? null;
        else if (fd.type === "labels") taskFields[fd.id] = (Array.isArray(v) ? v : [v]).map((x) => fd.options?.find((o) => o.name.toLowerCase() === String(x).toLowerCase())?.id).filter(Boolean);
        else if (fd.type === "number" || fd.type === "money" || fd.type === "rating") taskFields[fd.id] = v === "" || v === null ? null : Number(v);
        else if (fd.type === "files") taskFields[fd.id] = clean[q.id];
        else taskFields[fd.id] = text;
      }
    }
    if (text) lines.push(`${q.label}: ${text}`);
  }
  const by: Actor = { type: "system", id: null, name: "Form" };
  const people = await owners(orgId);
  const [type, idStr] = s.assignTo.split(":");
  const o = s.assignTo ? ownerOf(people, type, Number(idStr)) : null;
  const assignees: Assignee[] = o ? [{ type: o.type, id: o.id, name: o.name }] : [];
  const t = await createTask(orgId, { listId: list.id, name: (name || `${f.title} answer`).slice(0, 300), description: `Answers from the form "${f.title}":\n\n${lines.join("\n")}`, status: s.status || undefined, dueDate: due, fields: taskFields, assignees: o?.type === "employee" && s.ask ? [] : assignees }, by);
  for (const id of fileIds) db.work.files.insert({ organizationId: orgId, itemType: "task", itemId: t.id, fileId: id, addedBy: "Form" });
  db.work.answers.insert({ organizationId: orgId, formId: f.id, taskId: t.id, answers: JSON.stringify(clean) });
  // An employee with instructions starts with them; otherwise assigning is enough.
  if (o?.type === "employee" && s.ask) {
    db.work.tasks.update(orgId, t.id, { assignees: JSON.stringify(assignees) });
    void askEmployee(orgId, db.work.tasks.get(orgId, t.id)!, o, `This came in from the form "${f.title}". ${s.ask}`);
  }
  await runAutomations(orgId, db.work.tasks.get(orgId, t.id)!, { on: "form", formId: f.id });
  return { thanks: s.thanks || "Thanks. We got it." };
}
