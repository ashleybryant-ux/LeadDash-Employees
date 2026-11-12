import type { Express, Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { readChatToken, seat, type ChatToken } from "./ehrChat";
import type { EmployeeKind } from "../drizzle/schema";

/**
 * The Group Partner team in LeadDash EHR (2026-11-11).
 *
 * A Group Partner practice talks to its LeadDash employees from inside
 * LeadDash EHR ("Your LeadDash team"), with no second sign-in. The screen is
 * drawn in the EHR; the employees, their chats and their work stay here. The
 * EHR's server asks for one person with the same short-lived signed token
 * Team chat uses (ehrChat.ts): it names the practice and the person, and the
 * workspace is always the one that practice is linked to. Nothing in a
 * request body can choose another workspace or another person.
 *
 * WHO
 * Only someone who administers the practice in the EHR (the token says so).
 * Whether they read every message in an employee's chat or only their own
 * follows their seat here: owners and admins of the workspace read all of
 * it, as they do in this app; anyone else reads their own conversation.
 *
 * WHICH EMPLOYEES
 * The five a Group Partner practice gets (the owner's roster, 2026-11-11):
 * Harper, Avery, Malik, Camille and Quinn. No other employee in the
 * workspace can be listed, read or messaged through this door.
 *
 * WHERE THE EMPLOYEES ARE OFF
 * A workspace made for Team chat alone has no employees. Every call here
 * answers that the team is not turned on, and nothing is created.
 *
 * A SEND DOES NOT WAIT FOR A LONG JOB
 * An employee can take a minute over several steps. The send answers within
 * a few seconds either way; the EHR reads the chat again until the reply is
 * there. The work goes on here whether or not anyone is still asking.
 */

/** The Group Partner five, in the order the practice sees them. */
export const PARTNER_TEAM: { kind: EmployeeKind; area: string; does: string }[] = [
  { kind: "billing", area: "Billing and collections", does: "Claims, rejections, balances and cards on file. Keeps money coming in and tells you what is stuck." },
  { kind: "inbox", area: "Front office", does: "Fills open slots from the waitlist, chases unconfirmed sessions and finds clients who have gone quiet." },
  { kind: "leads", area: "Intake", does: "Answers new client inquiries within minutes, books the first session and gets the paperwork out." },
  { kind: "compliance", area: "Compliance", does: "Licenses, unsigned notes, consents and supervision. Keeps the practice audit-ready without a binder." },
  { kind: "hiring", area: "People", does: "Posts the job, screens and checks licenses, onboards each clinician, offboards right." },
];
const KINDS = new Set<string>(PARTNER_TEAM.map((p) => p.kind));
const NOT_ON = "Your LeadDash employees are not turned on for this practice yet.";
const WAIT_MS = 6_000;

type SendFn = (opts: { organizationId: number; employeeId: number; text: string; authorName: string; userId: number | null; visible?: "all" | (number | null)[] }) => Promise<unknown>;
let sender: SendFn | null = null;
/** Tests stand in for the employee's reply; the app uses the real chat engine. */
export function setSenderForTests(fn: SendFn | null) {
  sender = fn;
}

const int = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new TRPCError({ code: "BAD_REQUEST", message: "That request is missing a number it needs." });
  return n;
};

/** Titles of the cards under a message (a report, a draft), so the EHR can say one is there without drawing it. */
function cardTitles(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const cards = JSON.parse(raw) as { type?: string; title?: string }[];
    return (Array.isArray(cards) ? cards : []).filter((c) => c && c.type !== "choices" && typeof c.title === "string" && c.title.trim()).map((c) => String(c.title).trim().slice(0, 160)).slice(0, 6);
  } catch {
    return [];
  }
}

export async function teamCall(t: ChatToken, name: string, raw: unknown) {
  if (String(t.user.role || "").toLowerCase() !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Your LeadDash team is for practice administrators." });
  // Looked up before anyone is seated: a practice with no workspace gets nothing made for it here.
  const linked = await db.getOrganizationByEhrLocation(t.loc);
  if (!linked || linked.chatOnly) throw new TRPCError({ code: "PRECONDITION_FAILED", message: NOT_ON });
  const { org, user, me } = await seat(t);
  const o = org.id;
  const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seatHere = (await db.listMembers(o)).find((m) => m.userId === user.id);
  const visible: "all" | (number | null)[] = seatHere && (seatHere.role === "owner" || seatHere.role === "admin") ? "all" : [user.id];

  /** One of the five, in this workspace; anything else is not found. */
  const employee = async (id: number) => {
    const emp = await db.getEmployeeForOrg(id, o);
    if (!emp || !KINDS.has(emp.kind)) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not on your LeadDash team." });
    return emp;
  };

  if (name === "team") {
    const bench = await import("./employees/bench");
    const v = await bench.benchView(o);
    const summaries = await db.chatSummaries(o, user.id, visible).catch(() => [] as { employeeId: number; unread?: number }[]);
    return {
      practice: org.name,
      team: PARTNER_TEAM.map((p) => {
        const e = v.employees.find((x) => x.kind === p.kind);
        if (!e) return null;
        const s = (summaries as { employeeId: number; unread?: number }[]).find((x) => x.employeeId === e.id);
        return {
          id: e.id,
          kind: e.kind,
          name: e.name,
          area: p.area,
          does: p.does,
          // A path on this server: the EHR's server puts this server's address in front of it.
          avatar: e.avatar || `/avatars/${e.kind}.webp`,
          onTeam: e.onTeam,
          canBringOn: e.canBringOn,
          away: e.away ? { kind: e.away.kind, canReturn: e.away.canReturn } : null,
          unread: Number(s?.unread) || 0,
        };
      }).filter(Boolean),
    };
  }

  if (name === "messages") {
    const emp = await employee(int(i.employeeId));
    const rows = await db.listChatMessages(o, emp.id, 120, visible);
    await db.markChatRead(o, emp.id, user.id);
    const { workingOn } = await import("./employees/chat");
    const w = await workingOn(o, emp).catch(() => ({ busy: false, what: "" }));
    return {
      employee: { id: emp.id, name: emp.name },
      working: w,
      messages: rows.map((m) => ({ id: m.id, from: m.role === "user" ? "person" : m.role === "employee" ? "employee" : "note", author: m.authorName, mine: m.role === "user" && m.userId === user.id, text: m.content, cards: cardTitles(m.cards), at: m.createdAt })),
    };
  }

  if (name === "send") {
    const emp = await employee(int(i.employeeId));
    const text = String(i.text ?? "").trim().slice(0, 8000);
    if (!text) throw new TRPCError({ code: "BAD_REQUEST", message: "Type a message." });
    if (emp.status === "paused") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${emp.name} is not on your team yet. Bring them on first.` });
    const send: SendFn = sender ?? (async (opts) => (await import("./employees/chat")).sendChatMessage(opts));
    const job = send({ organizationId: o, employeeId: emp.id, text, authorName: me.name, userId: user.id, visible });
    let failed = "";
    const done = await Promise.race([
      job.then(() => true, (err) => { failed = err instanceof TRPCError ? err.message : "That message did not go through. Try again."; if (!(err instanceof TRPCError)) console.error("[ehr-team] send failed:", err instanceof Error ? err.message : err); return true; }),
      new Promise<boolean>((r) => setTimeout(() => r(false), WAIT_MS)),
    ]);
    if (failed) throw new TRPCError({ code: "BAD_REQUEST", message: failed });
    return { answered: done };
  }

  if (name === "bringOn") {
    const emp = await employee(int(i.employeeId));
    const bench = await import("./employees/bench");
    await bench.bringOn(o, emp.id);
    await db.logAction({ organizationId: o, actorType: "human_user", actorName: me.name, action: "Employee brought onto the team", details: `${emp.name}, from LeadDash EHR` });
    return { ok: true };
  }

  throw new TRPCError({ code: "NOT_FOUND", message: "Your LeadDash team does not have that." });
}

const STATUS: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412, TOO_MANY_REQUESTS: 429 };

export function registerEhrTeam(app: Express) {
  // The EHR's server calls for one person. The token rides in a header, never in the address.
  app.post("/api/ehr-team/:name", async (req: Request, res: Response) => {
    const read = readChatToken(String(req.headers["x-ehr-chat"] || ""));
    if ("error" in read) return res.status(401).json({ ok: false, error: read.error });
    try {
      const result = await teamCall(read.token, String(req.params.name || ""), req.body);
      res.json({ ok: true, result: result ?? null });
    } catch (err) {
      if (err instanceof TRPCError) return res.status(STATUS[err.code] ?? 400).json({ ok: false, error: err.message, code: err.code });
      console.error("[ehr-team] call failed:", err instanceof Error ? err.message : err);
      res.status(500).json({ ok: false, error: "Your LeadDash team could not do that. Try again." });
    }
  });
}
