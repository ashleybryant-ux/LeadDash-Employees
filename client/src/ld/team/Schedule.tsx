import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { deviceZone, zoneName } from "../meta";

/**
 * Scheduled messages: the clock beside Send picks when a message goes out, and the bar above the
 * box lists the person's waiting messages for this conversation, each with Send now, Edit and
 * Delete. Times are picked and shown in the time zone this device is in, so after a flight they
 * read in the new local time.
 */

export type Where = { channel: string } | { employeeId: number };

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Sun, Oct 25, 2026, 9:00 AM" in this device's time zone. */
export function whenText(at: Date | string | number) {
  return new Date(at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The same moment where it was scheduled, when that was a different time zone: "9:00 AM Central". */
function thereText(at: Date | string | number, tz: string | null) {
  if (!tz || tz === deviceZone()) return "";
  try {
    return `${new Date(at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })} ${zoneName(tz)}`;
  } catch {
    return "";
  }
}

function at(day: Date, hour: number, minute = 0) {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** The quick picks: in an hour (on the next 5 minutes), tomorrow at 9:00 AM, and next Monday at 9:00 AM. */
export function quickTimes(now = new Date()) {
  const hour = new Date(now.getTime() + 60 * 60_000);
  hour.setSeconds(0, 0);
  hour.setMinutes(Math.ceil(hour.getMinutes() / 5) * 5);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const monday = new Date(now);
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7));
  const list = [
    { label: "In 1 hour", at: hour },
    { label: "Tomorrow", at: at(tomorrow, 9) },
  ];
  if (monday.toDateString() !== tomorrow.toDateString()) list.push({ label: `Next ${WEEKDAY[1]}`, at: at(monday, 9) });
  return list;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** A date and time typed in the boxes, read as this device's local time. */
export function fromBoxes(date: string, time: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m || !t) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date and time boxes, with the device's time zone named under them. */
function WhenBoxes({ date, time, onDate, onTime }: { date: string; time: string; onDate: (v: string) => void; onTime: (v: string) => void }) {
  return (
    <div className="tc-when">
      <input className="ld-in" type="date" value={date} min={dateValue(new Date())} onChange={(e) => onDate(e.target.value)} aria-label="Date" />
      <input className="ld-in" type="time" value={time} onChange={(e) => onTime(e.target.value)} aria-label="Time" />
    </div>
  );
}

/** The clock beside Send: pick a time and the message waits until then. */
export function ScheduleButton({ disabled, onPick }: { disabled?: boolean; onPick: (at: Date) => void }) {
  const [open, setOpen] = React.useState(false);
  const [custom, setCustom] = React.useState(false);
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("09:00");
  const [bad, setBad] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const pick = (d: Date) => {
    setOpen(false);
    setCustom(false);
    onPick(d);
  };
  const toggle = () => {
    if (!open) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setDate(dateValue(tomorrow));
      setTime("09:00");
      setCustom(false);
      setBad(null);
    }
    setOpen((v) => !v);
  };
  const scheduleCustom = () => {
    const d = fromBoxes(date, time);
    if (!d) return setBad("Pick a date and time.");
    if (d.getTime() < Date.now() + 30_000) return setBad("Pick a time that hasn't passed.");
    pick(d);
  };
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" className="ld-btn p sm tc-schedbtn" disabled={disabled} onClick={toggle} aria-label="Schedule this message" title="Schedule for later" aria-expanded={open}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      </button>
      {open && (
        <div className="tc-sched" role="dialog" aria-label="Schedule message">
          <b className="tc-sched-h">Schedule message</b>
          {!custom ? (
            <>
              {quickTimes().map((q) => (
                <button key={q.label} type="button" className="tc-sched-opt" onClick={() => pick(q.at)}>
                  <b>{q.label}</b>
                  <span>{whenText(q.at)}</span>
                </button>
              ))}
              <button type="button" className="tc-sched-opt" onClick={() => setCustom(true)}>
                <b>Custom time</b>
                <span>Pick a date and time</span>
              </button>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 6px" }}>
              <WhenBoxes date={date} time={time} onDate={(v) => { setDate(v); setBad(null); }} onTime={(v) => { setTime(v); setBad(null); }} />
              {bad && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>{bad}</span>}
              <span className="ld-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="ld-btn sm" onClick={() => setCustom(false)}>Back</button>
                <button type="button" className="ld-btn p sm" onClick={scheduleCustom}>Schedule</button>
              </span>
            </div>
          )}
          <span className="tc-sched-tz">{zoneName(deviceZone())} time</span>
        </div>
      )}
    </span>
  );
}

/** Scheduled messages for one conversation: the list query and what the box does with a picked time. */
export function useScheduled(where: Where) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const input = { organizationId: currentOrgId, ...where };
  const list = trpc.scheduled.list.useQuery(input, { enabled: currentOrgId > 0, refetchInterval: 30_000 });
  const done = () => utils.scheduled.list.invalidate();
  const create = trpc.scheduled.create.useMutation({ onSuccess: done });
  return {
    list: list.data ?? [],
    create,
    schedule: (content: string, attachmentIds: number[], when: Date, onDone: () => void) =>
      create.mutate({ ...input, content, attachmentIds, sendAt: when.getTime(), timezone: deviceZone() }, { onSuccess: onDone }),
  };
}

type Row = { id: number; content: string; attachmentCount: number; sendAt: Date | string; timezone: string | null; status: string; error: string | null };

/** Above the message box: the person's waiting messages here. Collapsed to one line; Show opens the list in place. */
export function ScheduledBar({ rows, onSent }: { rows: Row[]; onSent?: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState({ content: "", date: "", time: "" });
  const [bad, setBad] = React.useState<string | null>(null);
  const after = async () => {
    await utils.scheduled.list.invalidate();
    onSent?.();
  };
  const sendNow = trpc.scheduled.sendNow.useMutation({ onSuccess: after, onError: after });
  const remove = trpc.scheduled.remove.useMutation({ onSuccess: after });
  const update = trpc.scheduled.update.useMutation({ onSuccess: async () => { setEditing(null); await after(); } });
  if (!rows.length) return null;
  const failed = rows.filter((r) => r.status === "failed").length;
  const first = rows[0];
  const summary = rows.length === 1 ? `1 message scheduled for ${whenText(first.sendAt)}` : `${rows.length} scheduled messages, next ${whenText(first.sendAt)}`;
  const startEdit = (r: Row) => {
    const d = new Date(r.sendAt);
    setDraft({ content: r.content, date: dateValue(d), time: timeValue(d) });
    setBad(null);
    update.reset();
    setEditing(r.id);
  };
  const save = (r: Row) => {
    const d = fromBoxes(draft.date, draft.time);
    if (!d) return setBad("Pick a date and time.");
    if (d.getTime() < Date.now() + 30_000) return setBad("Pick a time that hasn't passed.");
    if (!draft.content.trim() && !r.attachmentCount) return setBad("Write a message.");
    update.mutate({ organizationId: currentOrgId, id: r.id, content: draft.content, sendAt: d.getTime(), timezone: deviceZone() });
  };
  return (
    <div className={`tc-schedbar ${failed ? "bad" : ""}`}>
      <div className="tc-schedbar-top">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        <span className="tx">{failed ? `${failed} scheduled message${failed === 1 ? "" : "s"} could not be sent` : summary}</span>
        <button type="button" className="ld-btn sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && (
        <div className="tc-schedlist">
          {rows.map((r) => {
            const there = thereText(r.sendAt, r.timezone);
            return (
              <div key={r.id} className="tc-schedrow">
                <div className="tc-schedrow-main">
                  <div className="tc-schedrow-text">
                    <b>{whenText(r.sendAt)}</b>
                    {there && <span className="tc-schedrow-there">({there})</span>}
                    <p>{r.content || (r.attachmentCount ? `${r.attachmentCount} file${r.attachmentCount === 1 ? "" : "s"}` : "")}</p>
                    {r.content && r.attachmentCount > 0 && <span className="tc-schedrow-there">and {r.attachmentCount} file{r.attachmentCount === 1 ? "" : "s"}</span>}
                    {r.status === "failed" && r.error && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>Not sent: {r.error}</span>}
                    {r.status === "sending" && <span className="ld-small">Sending now</span>}
                  </div>
                  <div className="tc-schedrow-btns">
                    <button type="button" className="ld-btn p sm" disabled={sendNow.isPending || r.status === "sending"} onClick={() => sendNow.mutate({ organizationId: currentOrgId, id: r.id })}>{r.status === "failed" ? "Try again" : "Send now"}</button>
                    <button type="button" className="ld-btn sm" disabled={editing !== null || r.status === "sending"} onClick={() => startEdit(r)}>Edit</button>
                    <button type="button" className="ld-btn sm danger" disabled={remove.isPending || r.status === "sending"} onClick={() => remove.mutate({ organizationId: currentOrgId, id: r.id })}>Delete</button>
                  </div>
                </div>
                {editing === r.id && (
                  <div className="tc-schededit">
                    <textarea className="ld-ta" rows={3} value={draft.content} onChange={(e) => { setDraft((p) => ({ ...p, content: e.target.value })); setBad(null); }} aria-label="Message" />
                    <WhenBoxes date={draft.date} time={draft.time} onDate={(v) => { setDraft((p) => ({ ...p, date: v })); setBad(null); }} onTime={(v) => { setDraft((p) => ({ ...p, time: v })); setBad(null); }} />
                    <span className="tc-sched-tz" style={{ padding: 0 }}>{zoneName(deviceZone())} time</span>
                    {bad && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>{bad}</span>}
                    <ErrorLine error={update.error} />
                    <span className="ld-row" style={{ justifyContent: "flex-end" }}>
                      <button type="button" className="ld-btn sm" onClick={() => setEditing(null)}>Cancel</button>
                      <button type="button" className="ld-btn p sm" disabled={update.isPending} onClick={() => save(r)}>Save</button>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
          <ErrorLine error={sendNow.error ?? remove.error} />
        </div>
      )}
    </div>
  );
}
