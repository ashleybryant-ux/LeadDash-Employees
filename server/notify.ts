import webpush from "web-push";
import * as db from "./db";
import { ENV } from "./_core/env";
import { sendEmail } from "./_core/email";
import type { Application, OutboundItem, User } from "../drizzle/schema";

/**
 * Push notices and emails. Each person picks, per event, whether they want a
 * push notice, an email, both or neither (My account, "Tell me when").
 * Notices never carry a client's name: they say what is waiting and link to it.
 */

export const NOTIFY_EVENTS = ["team_message", "task_assigned", "approval", "report", "application", "deadline", "task_failed", "team_due", "ehr"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const EVENT_LABELS: Record<NotifyEvent, string> = {
  team_message: "A teammate messages me",
  task_assigned: "I'm given a task or mentioned on one",
  approval: "Something is waiting in Approvals",
  report: "An employee sends a report",
  application: "An application is ready to submit",
  deadline: "A deadline is 7 days out",
  task_failed: "A task fails",
  team_due: "A team license or certification is due",
  ehr: "LeadDash EHR: a claim is denied, paperwork is past due, a booking changes",
};

/** sound: a sound on this device while the app is open. */
export type Prefs = Record<NotifyEvent, { push: boolean; email: boolean; sound: boolean }>;

export const DEFAULT_PREFS: Prefs = {
  team_message: { push: true, email: false, sound: true },
  task_assigned: { push: true, email: false, sound: true },
  approval: { push: true, email: false, sound: true },
  report: { push: true, email: false, sound: false },
  application: { push: true, email: false, sound: false },
  deadline: { push: true, email: true, sound: false },
  task_failed: { push: true, email: true, sound: true },
  team_due: { push: true, email: false, sound: false },
  ehr: { push: true, email: false, sound: false },
};

export const SOUNDS = ["chime", "knock", "bell"] as const;
export type SoundSettings = { kind: (typeof SOUNDS)[number]; volume: number };
export const DEFAULT_SOUND: SoundSettings = { kind: "chime", volume: 70 };

/** Which sound and how loud, kept with the person's notice choices. */
export function readSound(raw: string | null | undefined): SoundSettings {
  try {
    const v = (raw ? JSON.parse(raw) : {})._sound;
    if (v && typeof v === "object") return { kind: (SOUNDS as readonly string[]).includes(v.kind) ? v.kind : DEFAULT_SOUND.kind, volume: Math.max(0, Math.min(100, Math.round(Number(v.volume ?? DEFAULT_SOUND.volume)))) };
  } catch {
    /* defaults */
  }
  return { ...DEFAULT_SOUND };
}

export function readPrefs(raw: string | null | undefined): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = raw ? JSON.parse(raw) : {};
  } catch {
    saved = {};
  }
  const out = { ...DEFAULT_PREFS };
  for (const k of NOTIFY_EVENTS) {
    const v = saved[k];
    if (v && typeof v === "object") out[k] = { push: !!v.push, email: !!v.email, sound: typeof v.sound === "boolean" ? v.sound : DEFAULT_PREFS[k].sound };
  }
  return out;
}

export function pushReady() {
  return !!(ENV.vapidPublicKey && ENV.vapidPrivateKey);
}

let configured = false;
function configure() {
  if (configured || !pushReady()) return pushReady();
  webpush.setVapidDetails(ENV.vapidSubject, ENV.vapidPublicKey, ENV.vapidPrivateKey);
  configured = true;
  return true;
}

export type Notice = { title: string; body: string; url: string; tag?: string };

// ==========================================
// In the app: a pop-up, and a sound when the person turned it on
// ==========================================

export type Ping = { id: number; orgId: number; event: NotifyEvent; title: string; body: string; url: string; at: number };
const pings = new Map<number, Ping[]>();
let pingSeq = 0;

/** Kept in memory for a few minutes; the app asks for new ones every few seconds. */
export function addPing(userIds: number[], p: Omit<Ping, "id" | "at">) {
  const at = Date.now();
  for (const id of userIds) {
    const list = (pings.get(id) ?? []).filter((x) => at - x.at < 10 * 60_000);
    list.push({ ...p, id: ++pingSeq, at });
    pings.set(id, list.slice(-50));
  }
}

export function pingsFor(userId: number, afterId: number) {
  return { latest: pingSeq, pings: (pings.get(userId) ?? []).filter((p) => p.id > afterId) };
}

/** Sends one notice to every device a person turned push on for. Dead subscriptions are removed. */
export async function pushTo(userIds: number[], notice: Notice) {
  if (!configure() || process.env.NODE_ENV === "test") return 0;
  const subs = await db.listPushSubscriptions(userIds);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: notice.title, body: notice.body.slice(0, 240), url: notice.url, tag: notice.tag }),
        { TTL: 60 * 60 * 24 }
      );
      await db.touchPushSubscription(s.id);
      sent++;
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) await db.deletePushEndpoint(s.endpoint);
      else console.warn("[push] send failed:", err?.statusCode ?? "", err?.body ?? err?.message ?? err);
    }
  }
  return sent;
}

/** Tells everyone on a workspace about something, following each person's choices. */
export async function notify(orgId: number, event: NotifyEvent, notice: Notice, opts: { channel?: "push" | "email" | "chat"; only?: number[] } = {}) {
  if (opts.channel === "chat") return;
  // The app review demo workspace never sends notices.
  if (db.getReviewAccess()?.organizationId === orgId) return;
  const people: User[] = (await db.notifyRecipients(orgId)).filter((p) => !opts.only || opts.only.includes(p.id));
  const org = await db.getOrganizationById(orgId);
  const pushIds: number[] = [];
  addPing(people.map((p) => p.id), { orgId, event, title: notice.title, body: notice.body.slice(0, 240), url: notice.url });
  for (const p of people) {
    const prefs = readPrefs(p.notifyPrefs);
    const wantPush = opts.channel === "push" ? true : prefs[event].push;
    const wantEmail = opts.channel === "email" ? true : prefs[event].email;
    if (wantPush) pushIds.push(p.id);
    if (wantEmail && process.env.NODE_ENV !== "test") {
      const link = `${ENV.appUrl}${notice.url}`;
      sendEmail(p.email, `${notice.title}${org ? ` (${org.name})` : ""}`, `${notice.body}\n\nOpen it: ${link}`).catch((err) =>
        console.warn("[notify] email failed:", err instanceof Error ? err.message : err)
      );
    }
  }
  await pushTo(pushIds, { ...notice, title: org ? `${notice.title} · ${org.name}` : notice.title });
}

/** Wires database events to notices. Called once at startup. */
export function startNotifications() {
  db.dbEvents.on("approval", async (item: OutboundItem) => {
    try {
      const emp = item.employeeId ? await db.getEmployeeForOrg(item.employeeId, item.organizationId) : null;
      await notify(item.organizationId, "approval", {
        title: `${emp?.name ?? "An employee"} needs your approval`,
        body: item.title,
        url: "/approvals",
        tag: `approval-${item.id}`,
      });
    } catch (err) {
      console.warn("[notify] approval notice failed:", err);
    }
  });
  db.dbEvents.on("application_ready", async (app: Application) => {
    try {
      const emp = app.employeeId ? await db.getEmployeeForOrg(app.employeeId, app.organizationId) : null;
      await notify(app.organizationId, "application", {
        title: `${emp?.name ?? "Your employee"} finished an application`,
        body: `${app.title} is ready for you to submit.`,
        url: "/approvals",
        tag: `application-${app.id}`,
      });
    } catch (err) {
      console.warn("[notify] application notice failed:", err);
    }
  });
}
