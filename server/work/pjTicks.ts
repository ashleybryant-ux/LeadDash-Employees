import * as db from "../db";
import { partsIn } from "../employees/schedule";
import { todayYmd, zoneOf } from "./goals";
import { doAction, parse, runAutomations, spawnNext, type Action, type Repeat, type Trigger } from "./projects";

/**
 * The Projects checks the scheduler runs every few minutes:
 * - due-date and overdue automations (each fires once per task),
 * - scheduled automations (every day, weekday, or a day of the week at a time),
 * - repeating tasks set to repeat on schedule, made when their date arrives.
 */
export async function projectsTicks(now = new Date()) {
  for (const orgId of db.orgsWithProjects()) {
    try {
      await tickOrg(orgId, now);
    } catch (err) {
      console.warn("[projects] check failed:", err instanceof Error ? err.message : err);
    }
  }
}

export async function tickOrg(orgId: number, now = new Date()) {
  const tz = await zoneOf(orgId);
  const today = todayYmd(tz, now);
  const p = partsIn(now, tz);
  const hhmm = `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
  const rules = db.work.automations.all(orgId).filter((a) => a.active);
  const tasks = db.work.tasks.all(orgId);
  const lists = db.work.lists.all(orgId);
  const covers = (r: (typeof rules)[number], listId: number) => r.listId === listId || (r.listId === null && (r.folderId === null || r.folderId === lists.find((l) => l.id === listId)?.folderId));

  for (const r of rules) {
    const tr = parse<Trigger>(r.trigger, { on: "created" });
    if (tr.on === "due" || tr.on === "overdue") {
      // Due-date rules wait until 8:00 AM so nobody gets a notice at midnight.
      if (p.h < 8) continue;
      for (const t of tasks) {
        if (t.closedAt || !t.dueDate || !covers(r, t.listId)) continue;
        if (tr.on === "due" ? t.dueDate !== today : t.dueDate >= today) continue;
        if (!db.work.markOnce(orgId, `${tr.on}:${r.id}:${t.id}:${tr.on === "due" ? today : t.dueDate}`)) continue;
        await runAutomations(orgId, t, { on: tr.on }, 0, r.id);
      }
    }
    if (tr.on === "schedule") {
      const time = tr.time ?? "09:00";
      if (hhmm < time) continue;
      const dow = p.wd;
      if (tr.every === "weekday" && (dow === 0 || dow === 6)) continue;
      if (tr.every === "week" && dow !== (tr.day ?? 1)) continue;
      if (!db.work.markOnce(orgId, `sched:${r.id}:${today}`)) continue;
      await doAction(orgId, null, { ...parse<Action>(r.action, { do: "chat", value: "" }), listId: parse<Action>(r.action, { do: "chat", value: "" }).listId ?? r.listId ?? undefined });
    }
  }

  // Repeating on schedule: the next one is made when this one's date arrives, done or not.
  for (const t of tasks) {
    if (!t.repeat) continue;
    const rep = parse<Repeat | null>(t.repeat, null);
    if (!rep || rep.mode !== "schedule" || rep.spawned) continue;
    const at = t.dueDate ?? t.startDate;
    if (!at || at > today) continue;
    await spawnNext(orgId, t, { type: "system", id: null, name: "Projects" });
  }
}
