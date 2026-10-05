import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import { withUsage } from "../usage";
import { partsIn } from "../employees/schedule";
import { employeeFor, systemPromptFor, working } from "../employees/tasks";
import { addDays, fmtDay, overview, periodFor, sundayOf, todayYmd, zoneOf, type ReadItem, type Status } from "./goals";

/**
 * Simone on Goals: every Monday morning she reads the scorecard and the goals,
 * writes her read on the week (what's off and why, with one action each) and
 * the one-line scorecard note, and may suggest one goal for the owner to
 * approve. Late in the year she drafts next year's goals from this year's
 * numbers and the Brain. Nothing she suggests or drafts counts until the owner
 * approves it. Topics added "to the meeting" go on her next agenda.
 */

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const STATUS = { type: "string", enum: ["on", "risk", "off"] } as const;

const fmtNum = (v: number | null, unit: string) => (v === null ? "no number" : unit === "currency" ? `$${Math.round(v).toLocaleString("en-US")}` : unit === "percent" ? `${v}%` : unit === "hours" ? `${v} hours` : v.toLocaleString("en-US"));

/** Everything Simone reads for the week, as plain lines. */
export async function goalFacts(orgId: number) {
  const o = await overview(orgId);
  const lines = [`Today: ${fmtDay(o.today)}.`, "Goals:"];
  for (const g of o.goals.filter((x) => x.goal.state === "active")) {
    const t = g.targets.map((x) => `${x.name}: ${x.kind === "boolean" ? (x.done ? "done" : "not done") : x.kind === "tasks" ? `${x.tasksDone} of ${x.tasksTotal} tasks` : x.kind === "measure" ? `${x.measureValue ?? "no number"} of ${x.targetValue}` : `${x.currentValue} of ${x.targetValue}`}`).join("; ");
    lines.push(`- [goal ${g.goal.id}] ${g.goal.title} (${g.goal.level}, ${g.goal.period}, due ${fmtDay(g.goal.dueDate)}, owner ${g.owner?.name ?? "nobody"}): ${g.progress}% done, should be ${g.expected}% by now, ${g.status}${t ? `. Targets: ${t}` : ""}${g.forecast ? `. At this pace it lands at ${g.forecast.landing} of ${g.forecast.target}` : ""}${g.lastUpdate ? `. Last update from ${g.lastUpdate.author}: ${g.lastUpdate.body.slice(0, 200)}` : ""}`);
  }
  lines.push("Scorecard, last weeks oldest first:");
  for (const r of o.scorecard.rows) lines.push(`- [measure ${r.measure.id}] ${r.measure.name} (${r.measure.kind}, owner ${r.owner?.name ?? "nobody"}, weekly goal ${fmtNum(r.measure.weeklyGoal, r.measure.unit)}${r.goal ? `, feeds ${r.goal}` : ""}): ${r.values.slice(-6).map((v) => fmtNum(v, r.measure.unit)).join(", ")}; this week ${r.status ?? "no number yet"}`);
  const late = o.today_.filter((t) => t.late).length;
  lines.push(`Tasks late: ${late}. Tasks finished today: ${o.today_.filter((t) => t.done).length}.`);
  return { lines: lines.join("\n"), o };
}

type ReadOut = { note: string; items: { status: "on" | "risk" | "off"; text: string; action: string; goal: string; measure: string; employee: string }[]; suggest: { title: string; why: string; dueDate: string; parentGoal: string; measure: string }[] };

/** Simone's read on the week. Saved for the Goals page; one suggested goal at most. */
export async function weeklyRead(orgId: number) {
  const simone = await employeeFor(orgId, "coo");
  const tz = await zoneOf(orgId);
  const week = sundayOf(todayYmd(tz));
  const { lines, o } = await goalFacts(orgId);
  if (!o.goals.length && !o.scorecard.rows.length) return null;
  const emps = await db.listEmployeesByOrg(orgId);
  const out = await working(simone, async () => {
    const { system } = await systemPromptFor(
      simone,
      `Write your read on the week for the owner's Goals page, from the facts you're given.
note: one sentence for the top of the scorecard: how many measures are off track or at risk and which, and anything that turned green. Use the real names and numbers.
items: 2 to 4 points, most important first. status: off, risk or on. text: one or two sentences with the real numbers: what's happening and why, from the facts only. action: "task" (make a task for it), "meeting" (add it to the next meeting), or "ask" (ask the employee who owns it). goal and measure: the exact title of the goal or measure it is about ('' for none). employee: the employee's name when action is ask ('' otherwise). Employees: ${emps.map((e) => e.name).join(", ")}.
suggest: at most one new goal, only when a measure has been under its goal three weeks or more and no goal covers it yet. title, why (one sentence with the numbers), dueDate (YYYY-MM-DD, by the end of this quarter), parentGoal (the exact title of the year goal it feeds, or ''), measure (the exact measure name). Otherwise [].
Never invent a number. No em dashes.`
    );
    return generateJson<ReadOut>({
      system,
      prompt: lines,
      schemaName: "goal_read",
      schema: obj({ note: str, items: arr(obj({ status: STATUS, text: str, action: { type: "string", enum: ["task", "meeting", "ask"] }, goal: str, measure: str, employee: str })), suggest: arr(obj({ title: str, why: str, dueDate: str, parentGoal: str, measure: str })) }),
      maxTokens: 2000,
    });
  });
  const strip = (s: string) => s.replace(/\s*[–—]\s*/g, ", ").trim();
  const items: (ReadItem & { employee?: string })[] = (out.items ?? []).slice(0, 4).map((i) => ({
    status: i.status as Status,
    text: strip(i.text),
    action: i.action === "ask" && i.employee ? `ask:${i.employee}` : i.action,
    goalId: o.goals.find((g) => g.goal.title === i.goal)?.goal.id ?? null,
    measureId: o.scorecard.rows.find((r) => r.measure.name === i.measure)?.measure.id ?? null,
  }));
  db.work.reads.insert({ organizationId: orgId, weekStart: week, note: strip(out.note ?? ""), items: JSON.stringify(items) });
  for (const s of (out.suggest ?? []).slice(0, 1)) {
    const title = strip(s.title).slice(0, 200);
    if (!title || o.goals.some((g) => g.goal.title.toLowerCase() === title.toLowerCase())) continue;
    const today = todayYmd(tz);
    const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
    const p = periodFor("quarter", Number(today.slice(0, 4)), q);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(s.dueDate) && s.dueDate >= today ? s.dueDate : p.dueDate;
    const parent = o.goals.find((g) => g.goal.title === s.parentGoal && g.goal.state === "active");
    const measure = o.scorecard.rows.find((r) => r.measure.name === s.measure)?.measure;
    const g = db.work.goals.insert({ organizationId: orgId, title, level: "quarter", period: p.period, startDate: today, dueDate: due, parentId: parent?.goal.id ?? null, ownerType: measure?.ownerType ?? null, ownerId: measure?.ownerId ?? null, state: "suggested", why: strip(s.why), setBy: simone.name, color: parent?.goal.color ?? "#1b6b4a" });
    if (measure && measure.weeklyGoal !== null) db.work.targets.insert({ organizationId: orgId, goalId: g.id, kind: "measure", name: measure.name, targetValue: Math.round(measure.weeklyGoal), measureId: measure.id });
  }
  await db.createChatMessage({ organizationId: orgId, employeeId: simone.id, role: "employee", authorName: simone.name, content: `Monday scorecard for the week of ${fmtDay(week)} is on Goals. ${strip(out.note ?? "")}` });
  return db.work.reads.all(orgId).filter((r) => r.weekStart === week).sort((a, b) => b.id - a.id)[0];
}

type DraftOut = { goals: { title: string; why: string; owner: string; target: number; unit: "currency" | "number"; targetName: string }[] };

/** Simone drafts next year's goals from this year's numbers and the Brain. They stay drafts until the owner approves them. */
export async function draftYear(orgId: number, year: number) {
  const simone = await employeeFor(orgId, "coo");
  const have = db.work.goals.all(orgId).filter((g) => g.level === "year" && g.period === String(year) && (g.state === "draft" || g.state === "active"));
  if (have.some((g) => g.state === "draft")) return have.filter((g) => g.state === "draft");
  const { lines } = await goalFacts(orgId);
  const people = (await db.listMembers(orgId)).filter((m) => m.role !== "reviewer");
  const emps = await db.listEmployeesByOrg(orgId);
  const out = await working(simone, async () => {
    const { system } = await systemPromptFor(
      simone,
      `Draft the owner's ${year} goals for this workspace: 3 to 6 year goals, from this year's goals, how they're landing, the scorecard and what the Brain says about the business and its plans.
For each: title (short, with the number, like "$420,000 in revenue"), why (one or two sentences from this year's real numbers: pace, growth, what's already in motion), owner (a person: ${people.map((p) => p.name || p.email).join(", ")}; or an employee: ${emps.map((e) => e.name).join(", ")}), target (the number), unit (currency or number), targetName (what's counted, like "Revenue collected").
Only use numbers from the facts. When the facts can't support a number, base it on this year's goal and say so in why. No em dashes.`
    );
    return generateJson<DraftOut>({ system, prompt: `${lines}\n\nAlready set for ${year}: ${have.map((g) => g.title).join("; ") || "nothing"}`, schemaName: "year_draft", schema: obj({ goals: arr(obj({ title: str, why: str, owner: str, target: { type: "number" }, unit: { type: "string", enum: ["currency", "number"] }, targetName: str })) }), maxTokens: 2500 });
  });
  const p = periodFor("year", year);
  const made = [];
  const drafts = (out.goals ?? []).slice(0, 6);
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const title = d.title.replace(/\s*[–—]\s*/g, ", ").trim().slice(0, 200);
    if (!title) continue;
    const person = people.find((x) => (x.name || x.email).toLowerCase() === d.owner.toLowerCase());
    const emp = emps.find((e) => e.name.toLowerCase() === d.owner.toLowerCase());
    const g = db.work.goals.insert({ organizationId: orgId, title, level: "year", period: p.period, startDate: p.startDate, dueDate: p.dueDate, ownerType: person ? "user" : emp ? "employee" : null, ownerId: person?.userId ?? emp?.id ?? null, state: "draft", why: d.why.replace(/\s*[–—]\s*/g, ", ").trim(), setBy: simone.name, sort: i, color: ["#1b6b4a", "#2563eb", "#7c3aed", "#d97706", "#0f766e", "#9a4f2c"][i % 6] });
    if (d.target > 0) db.work.targets.insert({ organizationId: orgId, goalId: g.id, kind: d.unit === "currency" ? "currency" : "number", name: (d.targetName || title).slice(0, 120), targetValue: Math.round(d.target), history: "[]" });
    made.push(g);
  }
  if (made.length) await db.createChatMessage({ organizationId: orgId, employeeId: simone.id, role: "employee", authorName: simone.name, content: `I drafted ${made.length} goals for ${year} on Goals, each with why. Change anything, then approve them. They don't count until you do.` });
  return made;
}

/** A topic for the next meeting (from a goal, a measure, or Simone's read). */
export function addTopic(orgId: number, text: string, by: string) {
  const row = db.work.reads.all(orgId).find((r) => r.weekStart === "topics");
  const list = row ? (JSON.parse(row.items) as { text: string; by: string; at: string }[]) : [];
  list.push({ text: text.slice(0, 300), by, at: new Date().toISOString() });
  if (row) db.work.reads.update(orgId, row.id, { items: JSON.stringify(list.slice(-20)) });
  else db.work.reads.insert({ organizationId: orgId, weekStart: "topics", items: JSON.stringify(list) });
  return list.length;
}
/** The topics waiting for the next meeting, cleared once an agenda uses them. */
export function takeTopics(orgId: number) {
  const row = db.work.reads.all(orgId).find((r) => r.weekStart === "topics");
  if (!row) return [] as string[];
  const list = JSON.parse(row.items) as { text: string; by: string }[];
  db.work.reads.update(orgId, row.id, { items: "[]" });
  return list.map((t) => `${t.text} (added by ${t.by})`);
}

/** Typed-in measures: the people who own them get a notice when last week's number is missing. */
export async function askForNumbers(orgId: number, lastWeek: string) {
  const ms = db.work.measures.all(orgId).filter((m) => m.active && m.source === "manual" && m.ownerType === "user" && m.ownerId);
  const have = db.work.values.all(orgId).filter((v) => v.weekStart === lastWeek);
  const missing = new Map<number, string[]>();
  for (const m of ms) if (!have.some((v) => v.measureId === m.id)) missing.set(m.ownerId!, [...(missing.get(m.ownerId!) ?? []), m.name]);
  const { notify } = await import("../notify");
  for (const [userId, names] of Array.from(missing.entries())) {
    await notify(orgId, "task_assigned", { title: "Scorecard numbers for last week", body: `Enter ${names.join(", ")} for the week of ${fmtDay(lastWeek)}.`, url: "/goals?view=scorecard" }, { only: [userId] }).catch(() => null);
  }
  return missing.size;
}

/** Monday after 7:00: the read, once a week. In November and December: next year's draft, once. */
export async function goalsTicks() {
  for (const orgId of await db.listAllOrganizationIds()) {
    try {
      const tz = await zoneOf(orgId);
      const p = partsIn(new Date(), tz);
      if (p.wd !== 1 || p.h < 7) continue;
      const week = sundayOf(todayYmd(tz));
      if (db.work.reads.all(orgId).some((r) => r.weekStart === week)) continue;
      if (!db.work.goals.all(orgId).length && !db.work.measures.all(orgId).some((m) => m.active)) continue;
      await askForNumbers(orgId, addDays(week, -7));
      await withUsage({ orgId, kind: "coo" }, async () => {
        await weeklyRead(orgId);
        if (p.m >= 11 && !db.work.goals.all(orgId).some((g) => g.level === "year" && g.period === String(p.y + 1))) await draftYear(orgId, p.y + 1);
      });
    } catch (err) {
      console.warn("[goals] Monday read failed:", err instanceof Error ? err.message : err);
    }
  }
}

export { addDays };
