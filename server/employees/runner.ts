import * as db from "../db";
import type { ScheduledTask } from "../../drizzle/schema";
import { sendChatMessage } from "./chat";
import { nextRun } from "./schedule";
import { remindRegistrations } from "./apply";
import { notify } from "../notify";
import { hiringDaily } from "./hiring";
import { sweepExpired } from "../review";

/**
 * Runs scheduled tasks. Every minute it picks up tasks whose time has come,
 * moves each one's next run forward first (so a slow run is never started
 * twice), then sends the task's instructions to the employee as a chat
 * message. The employee's reply, with any cards, lands in that chat.
 */

const running = new Set<number>();

async function timezoneFor(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  return org?.timezone || "America/Chicago";
}

export async function runTaskNow(task: ScheduledTask, manual = false) {
  if (running.has(task.id)) return null;
  running.add(task.id);
  const startedAt = new Date();
  try {
    if (!manual) {
      const tz = await timezoneFor(task.organizationId);
      const next = nextRun(task, tz, new Date(startedAt.getTime() + 60_000));
      await db.updateScheduledTask(task.id, task.organizationId, {
        nextRunAt: next,
        enabled: task.repeat === "once" ? false : task.enabled,
      });
    }
    const result = await sendChatMessage({
      organizationId: task.organizationId,
      employeeId: task.employeeId,
      text: task.instructions,
      authorName: `Scheduled task: ${task.title}`,
      userId: null,
    });
    const failed = result.reply.content.startsWith("I couldn't do that.") || result.reply.content.startsWith("I'm paused");
    await db.updateScheduledTask(task.id, task.organizationId, {
      lastRunAt: startedAt,
      lastStatus: failed ? "failed" : "ok",
      lastError: failed ? result.reply.content.slice(0, 500) : null,
    });
    await db.createTaskRun({
      organizationId: task.organizationId,
      taskId: task.id,
      status: failed ? "failed" : "ok",
      error: failed ? result.reply.content.slice(0, 500) : null,
      messageId: result.reply.id,
      startedAt,
      finishedAt: new Date(),
    });
    await db.logAction({
      organizationId: task.organizationId,
      actorType: "system",
      actorName: "Scheduled task",
      action: failed ? "Task failed" : "Task ran",
      details: task.title,
    });
    const emp = await db.getEmployeeForOrg(task.employeeId, task.organizationId);
    const url = emp ? (emp.kind === "custom" ? `/chats/e/${emp.id}` : `/chats/${emp.kind}`) : "/chats";
    if (failed) {
      await notify(task.organizationId, "task_failed", { title: `${emp?.name ?? "A task"} could not finish a task`, body: `${task.title}: ${result.reply.content.slice(0, 160)}`, url, tag: `task-${task.id}` });
    } else if (!manual) {
      await notify(
        task.organizationId,
        "report",
        { title: `${emp?.name ?? "Your employee"}: ${task.title}`, body: result.reply.content.slice(0, 220), url, tag: `task-${task.id}` },
        { channel: task.notify }
      );
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.updateScheduledTask(task.id, task.organizationId, { lastRunAt: startedAt, lastStatus: "failed", lastError: message.slice(0, 500) });
    await db.createTaskRun({ organizationId: task.organizationId, taskId: task.id, status: "failed", error: message.slice(0, 500), startedAt, finishedAt: new Date() });
    await notify(task.organizationId, "task_failed", { title: "A scheduled task failed", body: `${task.title}: ${message.slice(0, 160)}`, url: "/tasks", tag: `task-${task.id}` }).catch(() => {});
    return null;
  } finally {
    running.delete(task.id);
  }
}

export async function tick(now = new Date()) {
  const due = await db.dueScheduledTasks(now);
  // One at a time keeps memory and API use flat on a small server.
  for (const task of due) {
    await runTaskNow(task);
  }
  return due.length;
}

export function startScheduler() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
      await remindRegistrations();
      await hiringDaily();
      await sweepExpired();
    } catch (err) {
      console.error("[tasks] scheduler error:", err);
    } finally {
      busy = false;
    }
  }, 60_000);
  timer.unref();
}
