import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import type { Measure } from "../../drizzle/schema";
import { employeeFor, systemPromptFor, working } from "../employees/tasks";
import { fmtDay, owners, periodFor, saveGoal, saveScorecard, setMeasureValue, sundayOf, todayYmd, zoneOf, SOURCES, type MeasureInput, type Owner } from "./goals";
import { draftYear } from "./simone";

/**
 * Simone keeps the Goals page scorecard: from chat she builds it from the
 * active goals (2 to 4 measures that move each one), adds, changes and removes
 * measures, sets weekly goals, records a week's number, and asks who gives her
 * a number the app can't count. There is one scorecard, on the Goals page.
 */

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });

/** Which employee does the work behind a counted number, and what it is counted from. */
export const SOURCE_WORK: Record<string, { kind: string; from: string }> = {
  new_leads: { kind: "leads", from: "leads" },
  practices_contacted: { kind: "outreach", from: "outreach emails" },
  demos_booked: { kind: "leads", from: "bookings" },
  reply_minutes: { kind: "leads", from: "lead replies" },
  posts_published: { kind: "social", from: "posts" },
  articles_published: { kind: "blog", from: "articles" },
  grant_apps_sent: { kind: "grants", from: "applications" },
  tasks_on_time: { kind: "projects", from: "Projects tasks" },
  approvals_waiting: { kind: "inbox", from: "Approvals" },
  project_tasks_done: { kind: "projects", from: "Projects tasks" },
};

export type Said = { text: string; choices: string[] };

const activeMeasures = (orgId: number) => db.work.measures.all(orgId).filter((m) => m.active).sort((a, b) => a.sort - b.sort || a.id - b.id);
const toInput = (m: Measure): MeasureInput => ({ id: m.id, name: m.name, ownerType: m.ownerType, ownerId: m.ownerId, weeklyGoal: m.weeklyGoal, unit: m.unit, direction: m.direction, kind: m.kind, source: m.source, goalId: m.goalId });
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "for", "our", "week", "weekly", "goal", "number", "measure"].includes(w));
const stem = (w: string) => w.replace(/(ies|es|s)$/, "");
const listAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const plain = (s: string) => s.replace(/\s*[–—]\s*/g, ", ").trim();
const NUMS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number) => NUMS[n] ?? String(n);

/** The measure whose name best matches what the person said (all words first, then most words). */
export function findMeasure(list: Measure[], said: string): Measure | null {
  const t = said.trim().toLowerCase();
  if (!t) return null;
  const exact = list.find((m) => m.name.toLowerCase() === t);
  if (exact) return exact;
  const ws = words(said).map(stem);
  if (!ws.length) return null;
  let best: Measure | null = null;
  let score = 0;
  for (const m of list) {
    const name = words(m.name).map(stem);
    const hit = ws.filter((w) => name.some((n) => n === w || n.startsWith(w) || w.startsWith(n))).length;
    if (hit > score || (hit === score && best && hit === ws.length && m.name.length < best.name.length)) {
      best = m;
      score = hit;
    }
  }
  return score > 0 ? best : null;
}

/** A person or employee by "me", a first name or a full name. */
export function findOwner(list: Owner[], said: string, userId: number | null | undefined): Owner | null {
  const t = said.trim().toLowerCase();
  if (!t) return null;
  if (/^(me|myself|i|i will|i'll)$/.test(t)) return list.find((o) => o.type === "user" && o.id === userId) ?? null;
  return list.find((o) => o.name.toLowerCase() === t) ?? list.find((o) => firstName(o.name).toLowerCase() === firstName(t)) ?? null;
}

function sourceFor(said: string) {
  const t = said.trim().toLowerCase();
  if (!t || /manual|typed|type it|by hand/.test(t)) return "manual";
  const byKey = SOURCES.find((s) => s.key === t);
  if (byKey) return byKey.key;
  const ws = words(t).map(stem);
  const hit = SOURCES.filter((s) => s.key !== "manual").find((s) => ws.length > 0 && ws.every((w) => s.label.toLowerCase().includes(w)));
  return hit?.key ?? "manual";
}

function findGoal(orgId: number, said: string) {
  const goals = db.work.goals.all(orgId).filter((g) => g.state === "active");
  const t = said.trim().toLowerCase();
  if (!t) return null;
  const ws = words(t);
  return goals.find((g) => g.title.toLowerCase() === t) ?? goals.find((g) => ws.length > 0 && ws.every((w) => g.title.toLowerCase().includes(w))) ?? goals.find((g) => ws.some((w) => g.title.toLowerCase().includes(w))) ?? null;
}

/** Tap-to-answer choices for "who gives me this number": Me, the team's first names, and Skip. */
async function whoChoices(orgId: number, userId: number | null | undefined) {
  const people = (await owners(orgId)).filter((o) => o.type === "user" && o.id !== userId);
  return ["Me", ...people.slice(0, 2).map((p) => firstName(p.name)), "Skip that one"];
}

/** The next typed-in measure nobody gives a number for yet, after `afterId`. */
function nextUnowned(orgId: number, afterId = 0) {
  return activeMeasures(orgId).filter((m) => m.source === "manual" && !m.ownerType && m.id > afterId).sort((a, b) => a.id - b.id)[0] ?? null;
}

async function askOwner(orgId: number, m: Measure, userId: number | null | undefined, lead = ""): Promise<Said> {
  return { text: `${lead}${m.name} isn't counted anywhere in the app yet. Who should give me that number each Friday?`.trim(), choices: await whoChoices(orgId, userId) };
}

type Proposed = { measures: { goalId: number; name: string; source: string; weeklyGoal: number; kind: "leading" | "result"; unit: Measure["unit"]; direction: Measure["direction"] }[] };

/** Measures for every active goal: 2 to 4 each, counted by the app where it can, linked to the goal. */
export async function buildScorecard(orgId: number, userId?: number | null): Promise<Said & { added: Measure[] }> {
  const tz = await zoneOf(orgId);
  const goals = db.work.goals.all(orgId).filter((g) => g.state === "active").sort((a, b) => a.sort - b.sort || a.id - b.id);
  if (!goals.length) {
    const year = Number(todayYmd(tz).slice(0, 4));
    return { text: `There are no goals on your Goals page yet, so there's nothing to build the scorecard from. What do you want to reach in ${year}? Tell me, or I can draft goals from your numbers for you to approve.`, choices: [`Draft my ${year} goals`, "I'll tell you mine"], added: [] };
  }
  const have = activeMeasures(orgId);
  const targets = db.work.targets.all(orgId);
  const emps = await db.listEmployeesByOrg(orgId);
  const simone = await employeeFor(orgId, "coo");
  const facts = [
    "Goals:",
    ...goals.map((g) => `- [goal ${g.id}] ${g.title} (${g.level}, due ${fmtDay(g.dueDate)})${targets.filter((t) => t.goalId === g.id).map((t) => `; target: ${t.name} ${t.kind === "boolean" ? "" : `${t.currentValue} of ${t.targetValue}`}`).join("")}`),
    "Measures already on the scorecard:",
    ...(have.length ? have.map((m) => `- ${m.name} (source ${m.source}, weekly goal ${m.weeklyGoal ?? "none"}${m.goalId ? `, moves goal ${m.goalId}` : ""})`) : ["- none"]),
    "Sources the app counts by itself (use the key):",
    ...SOURCES.filter((s) => s.key !== "manual").map((s) => `- ${s.key}: ${s.label.replace(/^Counted: /, "")}`),
  ].join("\n");
  const added = await working(
    simone,
    async () => {
      const { system } = await systemPromptFor(
        simone,
        `Build the owner's weekly scorecard from their goals. For each goal, 2 to 4 weekly measures that move it: the leading numbers the team can push each week, and the result number when it can be counted weekly.
goalId: the goal's id. name: short and plain, like "New inquiries" or "Consults booked". source: one of the counted keys when that key really counts this number; otherwise "manual" (someone types it in each week). Prefer counted sources. weeklyGoal: the number per week that gets the goal done by its due date, worked out from the target and the weeks left. kind: leading or result. unit: number, currency, percent or hours. direction: up when more is better, down when less is better.
Leave out any measure already on the scorecard. Never invent a source. No em dashes.`
      );
      const out = await generateJson<Proposed>({
        system,
        prompt: facts,
        schemaName: "scorecard_measures",
        schema: obj({ measures: arr(obj({ goalId: { type: "integer" }, name: str, source: str, weeklyGoal: num, kind: { type: "string", enum: ["leading", "result"] }, unit: { type: "string", enum: ["number", "currency", "percent", "hours"] }, direction: { type: "string", enum: ["up", "down"] } })) }),
        maxTokens: 2000,
      });
      const fresh: MeasureInput[] = [];
      const perGoal = new Map<number, number>();
      for (const p of out.measures ?? []) {
        const goal = goals.find((g) => g.id === p.goalId);
        const name = plain(p.name ?? "").slice(0, 120);
        if (!goal || !name) continue;
        if ((perGoal.get(goal.id) ?? 0) >= 4) continue;
        const source = SOURCES.some((s) => s.key === p.source) ? p.source : "manual";
        const dupe = [...have.map(toInput), ...fresh].some((m) => m.name.toLowerCase() === name.toLowerCase() || (source !== "manual" && m.source === source && m.goalId === goal.id));
        if (dupe) continue;
        const work = SOURCE_WORK[source];
        const emp = work ? emps.find((e) => e.kind === work.kind) : null;
        fresh.push({ name, ownerType: emp ? "employee" : null, ownerId: emp?.id ?? null, weeklyGoal: Number.isFinite(p.weeklyGoal) ? Math.max(0, Math.round(p.weeklyGoal * 100) / 100) : null, unit: p.unit ?? "number", direction: p.direction === "down" ? "down" : "up", kind: p.kind === "result" ? "result" : "leading", source, goalId: goal.id });
        perGoal.set(goal.id, (perGoal.get(goal.id) ?? 0) + 1);
      }
      if (fresh.length) saveScorecard(orgId, [...have.map(toInput), ...fresh]);
      const ids = new Set(have.map((m) => m.id));
      return activeMeasures(orgId).filter((m) => !ids.has(m.id));
    },
    { job: "doc", label: "Scorecard built from your goals", done: (r) => r.length > 0 }
  );
  if (!added.length) return { text: have.length ? "Your Goals scorecard already has the measures that move each goal, so I didn't add any. Want me to change one?" : "I couldn't work out measures for your goals. Tell me a number you want to see each week and I'll add it.", choices: have.length ? ["Show me the scorecard", "Add a measure"] : [], added };
  const lines: string[] = [];
  for (const g of goals) {
    const mine = added.filter((m) => m.goalId === g.id);
    if (!mine.length) continue;
    const named = mine.map((m) => {
      const work = SOURCE_WORK[m.source];
      if (m.source === "manual" || !work) return m.name;
      const emp = m.ownerType === "employee" ? emps.find((e) => e.id === m.ownerId) : null;
      return `${m.name} (counted from ${emp ? `${emp.name}'s ` : ""}${work.from})`;
    });
    const title = / by /i.test(g.title) ? g.title : `${g.title} by ${fmtDay(g.dueDate)}`;
    lines.push(`For "${title}" I added ${count(mine.length)} measure${mine.length === 1 ? "" : "s"} to your Goals scorecard: ${listAnd(named)}.`);
  }
  const first = added.filter((m) => m.source === "manual" && !m.ownerType).sort((a, b) => a.id - b.id)[0];
  if (!first) return { text: `${lines.join("\n")}\nIt's on your Goals page, Scorecard.`, choices: ["Show me the scorecard", "Change a weekly goal"], added };
  const ask = await askOwner(orgId, first, userId);
  return { text: `${lines.join("\n")}\n${ask.text}`, choices: ask.choices, added };
}

/** Who gives Simone a typed-in number each week ("Priya", "Me", "Skip that one"). */
export async function setMeasureOwner(orgId: number, measure: string, person: string, userId?: number | null): Promise<Said> {
  const list = activeMeasures(orgId);
  const m = findMeasure(list, measure) ?? nextUnowned(orgId);
  if (!m) return { text: "Which measure? I don't see one waiting for an owner.", choices: list.slice(0, 4).map((x) => x.name) };
  const skip = /^skip|^no one|^nobody|^none/i.test(person.trim());
  let said: string;
  if (skip) said = `OK, nobody gives me ${m.name} for now. You can type it in on your Goals page, Scorecard.`;
  else {
    const people = await owners(orgId);
    const o = findOwner(people, person, userId);
    if (!o) return { text: `I couldn't find ${person} on your team. Who should give me ${m.name} each Friday?`, choices: await whoChoices(orgId, userId) };
    db.work.measures.update(orgId, m.id, { ownerType: o.type, ownerId: o.id });
    const me = o.type === "user" && o.id === userId;
    said = m.source === "manual" && o.type === "user"
      ? `Done. ${me ? "You own" : `${firstName(o.name)} owns`} ${m.name}, and I'll ask ${me ? "you" : "for it"}${me ? " for it" : ""} each Friday. It's on your Goals page, Scorecard.`
      : `Done. ${me ? "You own" : `${o.name} owns`} ${m.name}. It's on your Goals page, Scorecard.`;
  }
  const next = nextUnowned(orgId, m.id);
  if (!next) return { text: said, choices: [] };
  return askOwner(orgId, next, userId, `${said}\n`);
}

export type MeasureChange = { name: string; newName?: string; source?: string; weeklyGoal?: number | null; goal?: string; owner?: string };

/** Adds a measure to the Goals scorecard. */
export async function addMeasure(orgId: number, c: MeasureChange, userId?: number | null): Promise<Said> {
  const name = plain(c.name).slice(0, 120);
  if (!name) return { text: "What should the measure be called?", choices: [] };
  const have = activeMeasures(orgId);
  const same = have.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (same) return { text: `${same.name} is already on your Goals scorecard. Want me to change it?`, choices: [`Change ${same.name}`.slice(0, 60), "Leave it"] };
  const source = sourceFor(c.source ?? "");
  const goal = c.goal ? findGoal(orgId, c.goal) : null;
  const def = SOURCES.find((s) => s.key === source)!;
  let owner: Owner | null = c.owner ? findOwner(await owners(orgId), c.owner, userId) : null;
  if (!owner && SOURCE_WORK[source]) owner = (await owners(orgId)).find((o) => o.type === "employee" && o.kind === SOURCE_WORK[source].kind) ?? null;
  saveScorecard(orgId, [...have.map(toInput), { name, ownerType: owner?.type ?? null, ownerId: owner?.id ?? null, weeklyGoal: c.weeklyGoal ?? null, unit: def.unit, direction: def.direction, kind: "leading", source, goalId: goal?.id ?? null }]);
  const m = activeMeasures(orgId).find((x) => x.name === name)!;
  const how = source === "manual" ? "typed in each week" : `counted by the app (${def.label.replace(/^Counted: /, "")})`;
  const text = `Added ${m.name} to your Goals scorecard, ${how}${m.weeklyGoal !== null ? `, with a weekly goal of ${m.weeklyGoal}` : ""}${goal ? `. It moves "${goal.title}"` : ""}${owner ? `. ${owner.name} owns it` : ""}.`;
  if (source === "manual" && !owner) return askOwner(orgId, m, userId, `${text}\n`);
  return { text, choices: m.weeklyGoal === null ? ["Set its weekly goal"] : [] };
}

/** Changes a measure: its name, source, weekly goal, the goal it moves, or its owner. */
export async function changeMeasure(orgId: number, c: MeasureChange, userId?: number | null): Promise<Said> {
  const list = activeMeasures(orgId);
  const m = findMeasure(list, c.name);
  if (!m) return notTracked(c.name);
  const patch: Partial<MeasureInput> = {};
  const said: string[] = [];
  const newName = plain(c.newName ?? "").slice(0, 120);
  if (newName && newName !== m.name) {
    patch.name = newName;
    said.push(`renamed it ${newName}`);
  }
  if (c.source?.trim()) {
    const source = sourceFor(c.source);
    if (source !== m.source) {
      const def = SOURCES.find((s) => s.key === source)!;
      Object.assign(patch, { source, unit: def.unit, direction: def.direction });
      said.push(source === "manual" ? "it's typed in each week now" : `the app counts it now (${def.label.replace(/^Counted: /, "")})`);
    }
  }
  if (c.weeklyGoal !== undefined && c.weeklyGoal !== null) {
    patch.weeklyGoal = Math.max(0, c.weeklyGoal);
    said.push(`the weekly goal is ${patch.weeklyGoal}`);
  }
  if (c.goal?.trim()) {
    const g = findGoal(orgId, c.goal);
    if (!g) return { text: `I couldn't find a goal like "${c.goal}" on your Goals page.`, choices: [] };
    patch.goalId = g.id;
    said.push(`it moves "${g.title}"`);
  }
  if (c.owner?.trim()) {
    const o = findOwner(await owners(orgId), c.owner, userId);
    if (!o) return { text: `I couldn't find ${c.owner} on your team.`, choices: [] };
    Object.assign(patch, { ownerType: o.type, ownerId: o.id });
    said.push(`${o.name} owns it`);
  }
  if (!said.length) return { text: `What should I change on ${m.name}: its weekly goal, its name, who owns it, or the goal it moves?`, choices: ["Its weekly goal", "Who owns it"] };
  saveScorecard(orgId, list.map((x) => (x.id === m.id ? { ...toInput(x), ...patch } : toInput(x))));
  return { text: `Done. ${m.name}: ${said.join(", ")}. It's on your Goals page, Scorecard.`, choices: [] };
}

/** "Set the weekly goal for consults to 6": the matching measure on the Goals scorecard. */
export async function setWeeklyGoal(orgId: number, measure: string, goal: number): Promise<Said> {
  const list = activeMeasures(orgId);
  const m = findMeasure(list, measure);
  if (!m) return notTracked(measure);
  const value = Math.max(0, Math.round(goal * 100) / 100);
  saveScorecard(orgId, list.map((x) => (x.id === m.id ? { ...toInput(x), weeklyGoal: value } : toInput(x))));
  return { text: `The weekly goal for ${m.name} is now ${value.toLocaleString("en-US")}. It's on your Goals page, Scorecard.`, choices: [] };
}

export async function removeMeasure(orgId: number, measure: string): Promise<Said> {
  const list = activeMeasures(orgId);
  const m = findMeasure(list, measure);
  if (!m) return { text: `There's no measure like "${measure}" on your Goals scorecard.`, choices: [] };
  saveScorecard(orgId, list.filter((x) => x.id !== m.id).map(toInput));
  return { text: `I took ${m.name} off your Goals scorecard.`, choices: [] };
}

/** A typed-in measure's number for a week ("intakes were 3 this week"). */
export async function recordNumber(orgId: number, measure: string, value: number, by: string, week = ""): Promise<Said> {
  const list = activeMeasures(orgId);
  const m = findMeasure(list, measure);
  if (!m) return notTracked(measure);
  if (m.source !== "manual") return { text: `The app counts ${m.name} by itself, so there's nothing to type in.`, choices: [] };
  const tz = await zoneOf(orgId);
  const start = sundayOf(/^\d{4}-\d{2}-\d{2}$/.test(week) ? week : todayYmd(tz));
  await setMeasureValue(orgId, m.id, start, value, by);
  const goal = m.weeklyGoal === null ? "" : m.direction === "up" ? (value >= m.weeklyGoal ? `, at or above the goal of ${m.weeklyGoal}` : `, under the goal of ${m.weeklyGoal}`) : value <= m.weeklyGoal ? `, within the goal of ${m.weeklyGoal}` : `, over the goal of ${m.weeklyGoal}`;
  return { text: `Saved ${m.name}: ${value.toLocaleString("en-US")} for the week of ${fmtDay(start)}${goal}.`, choices: [] };
}

function notTracked(said: string): Said {
  const name = plain(said).replace(/^the\s+/i, "").slice(0, 40);
  return { text: "I don't track that yet. Want me to add it?", choices: name ? [`Add ${name}`.slice(0, 60), "No thanks"] : ["No thanks"] };
}

/** A number from what the person said ("3", "1.5", "$2,400"), or null. */
export function numberIn(...xs: (string | number | null | undefined)[]) {
  for (const x of xs) {
    if (typeof x === "number" && Number.isFinite(x)) return x;
    const m = typeof x === "string" ? x.replace(/,/g, "").match(/-?\d+(\.\d+)?/) : null;
    if (m) return Number(m[0]);
  }
  return null;
}

/** A goal the owner set in chat ("40 new clients by Dec 31"). It counts at once: they set it themselves. */
export async function addGoal(orgId: number, g: { title: string; target: number | null; unit: string; targetName: string; dueDate: string; owner: string }, by: string, userId?: number | null): Promise<Said> {
  const title = plain(g.title).slice(0, 200);
  if (!title) return { text: "What's the goal? Give me the number and the date, like 40 new clients by Dec 31.", choices: [] };
  const tz = await zoneOf(orgId);
  const now = todayYmd(tz);
  const year = Number(now.slice(0, 4));
  const p = periodFor("year", year);
  const due = /^\d{4}-\d{2}-\d{2}$/.test(g.dueDate) && g.dueDate >= now ? g.dueDate : p.dueDate;
  const o = g.owner.trim() ? findOwner(await owners(orgId), g.owner, userId) : (await owners(orgId)).find((x) => x.type === "user" && x.id === userId) ?? null;
  const unit = /currency|dollar|\$|revenue/i.test(g.unit) ? "currency" : "number";
  const goal = saveGoal(orgId, {
    title,
    description: "",
    level: "year",
    parentId: null,
    folderId: null,
    ownerType: o?.type ?? null,
    ownerId: o?.id ?? null,
    startDate: now < p.startDate ? p.startDate : now,
    dueDate: due,
    period: due.slice(0, 4) === String(year) ? p.period : due.slice(0, 4),
    color: "#1b6b4a",
    status: null,
    manualProgress: null,
    targets: g.target && g.target > 0 ? [{ kind: unit, name: plain(g.targetName || title).slice(0, 120), startValue: 0, currentValue: 0, targetValue: g.target, done: false, listId: null, measureId: null }] : [],
  }, by);
  return { text: `Added "${goal.title}", due ${fmtDay(goal.dueDate)}, to your Goals page. Want me to build the scorecard measures that move it?`, choices: ["Build my scorecard", "Add another goal"] };
}

/** Simone drafts the year's goals from the numbers; they wait on the Goals page for the owner's approval. */
export async function draftGoals(orgId: number, year: number): Promise<Said> {
  const made = await draftYear(orgId, year);
  if (!made.length) return { text: "I couldn't draft goals from what I have. Tell me what you want to reach this year and I'll add it.", choices: [] };
  return { text: `I drafted ${count(made.length)} goal${made.length === 1 ? "" : "s"} for ${year} on your Goals page: ${listAnd(made.map((g) => `"${g.title}"`))}. Approve them there, then I'll build the scorecard from them.`, choices: [] };
}
