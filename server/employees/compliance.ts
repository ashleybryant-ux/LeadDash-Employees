import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { COMPLIANCE_KINDS, type ComplianceItem } from "../../drizzle/schema";
import { dateIn, listView as sopList } from "./sops";
import { longDate, view as ehrView } from "../ehr";

/**
 * Camille, the Compliance Coordinator. Her dates (CAQH attestations, license
 * renewals and CE hours, HIPAA training, payer enrollments) are typed by the
 * practice and kept here; nothing is looked up about a person. From LeadDash
 * EHR she reads counts only: unsigned notes, plans due, measures overdue, by
 * clinician. SOPs past their review date come from the SOP library.
 */

export type ComplianceKind = (typeof COMPLIANCE_KINDS)[number];
export const KIND_LABELS: Record<ComplianceKind, string> = { caqh: "CAQH attestation", license: "License renewal", training: "Training", enrollment: "Payer enrollment", other: "Other" };

export function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysUntil(ymd: string | null) {
  if (!ymd) return null;
  const d = new Date(`${ymd}T12:00:00Z`).getTime();
  return Math.round((d - new Date(`${today()}T12:00:00Z`).getTime()) / 86_400_000);
}

export function itemView(i: ComplianceItem) {
  const days = i.status === "open" ? daysUntil(i.due) : null;
  return { ...i, kindLabel: KIND_LABELS[i.kind], dueText: longDate(i.due), days, overdue: days !== null && days < 0, dueSoon: days !== null && days >= 0 && days <= 30 };
}

export type ItemInput = { kind: ComplianceKind; title: string; who?: string; due?: string; note?: string };

function clean(input: ItemInput) {
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Say what it is." });
  if (!(COMPLIANCE_KINDS as readonly string[]).includes(input.kind)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a kind." });
  const due = input.due ? dateIn(input.due) : "";
  if (input.due && !due) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the date as MM/DD/YYYY." });
  return { kind: input.kind, title, who: (input.who ?? "").trim().slice(0, 120), due: due || null, note: (input.note ?? "").trim().slice(0, 1000) };
}

export function add(orgId: number, input: ItemInput) {
  return db.compliance.add({ organizationId: orgId, ...clean(input) });
}

export function save(orgId: number, id: number, input: ItemInput) {
  if (!db.compliance.get(orgId, id)) throw new TRPCError({ code: "NOT_FOUND", message: "That item is gone." });
  return db.compliance.update(id, clean(input));
}

export function setDone(orgId: number, id: number, done: boolean) {
  const it = db.compliance.get(orgId, id);
  if (!it) throw new TRPCError({ code: "NOT_FOUND", message: "That item is gone." });
  return db.compliance.update(id, { status: done ? "done" : "open", doneAt: done ? today() : null });
}

export function remove(orgId: number, id: number) {
  return db.compliance.remove(orgId, id) > 0;
}

/** Everything on Camille's Desk: her dates, the EHR documentation counts, and SOPs due for review. */
export async function deskView(orgId: number) {
  const items = db.compliance.list(orgId).map(itemView);
  const open = items.filter((i) => i.status === "open");
  const ehr = await ehrView(orgId);
  const sops = sopList(orgId).sops.filter((s) => s.reviewDue).map((s) => ({ id: s.id, title: s.title, ownerName: s.ownerName, nextReview: s.nextReview, nextReviewText: longDate(s.nextReview) }));
  const docs = ehr.snapshot?.docs ?? [];
  return {
    items,
    due30: open.filter((i) => i.overdue || i.dueSoon),
    counts: { due30: open.filter((i) => i.overdue || i.dueSoon).length, overdue: open.filter((i) => i.overdue).length, unsigned: docs.reduce((n, d) => n + d.unsigned, 0), plansDue: docs.reduce((n, d) => n + d.plansDue, 0), enrollments: open.filter((i) => i.kind === "enrollment").length, sopsDue: sops.length },
    docs,
    sops,
    ehr: { connected: ehr.connected, practice: ehr.practice, fetchedAt: ehr.fetchedAt, error: ehr.error },
    kinds: COMPLIANCE_KINDS.map((k) => ({ key: k, label: KIND_LABELS[k] })),
  };
}

/** A line for Camille's prompt. */
export async function complianceFacts(orgId: number) {
  const v = await deskView(orgId);
  const lines = v.due30.slice(0, 12).map((i) => `- ${i.kindLabel}: ${i.title}${i.who ? ` (${i.who})` : ""}, due ${i.dueText}${i.overdue ? ", overdue" : ""}`);
  return `\nCompliance dates in the next 30 days (${v.counts.due30}${v.counts.overdue ? `, ${v.counts.overdue} overdue` : ""}):\n${lines.join("\n") || "- none"}\nSOPs past their review date: ${v.counts.sopsDue}.${v.docs.length ? `\nFrom LeadDash EHR, by clinician (counts only): ${v.docs.map((d) => `${d.clinician}: ${d.unsigned} unsigned, ${d.plansDue} plans due, ${d.measuresOverdue} measures overdue`).join("; ")}.` : ""}`;
}
