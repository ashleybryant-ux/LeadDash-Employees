import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, ErrorLine, FolderTabs, Page, PersonAvatar, UnderlineTabs, useIsMobile } from "../ui";
import type { Outputs } from "../types";

const PLATFORM_NAMES: Record<string, string> = { zoom: "Zoom", meet: "Google Meet", teams: "Teams" };
const PLATFORM_SHORT: Record<string, string> = { zoom: "Zoom", meet: "Meet", teams: "Teams" };

/**
 * Calendar: every connected calendar, the tasks and deadlines in the app, and
 * what the AI team has on, as a Day, Week or Month calendar starting on Sunday.
 * The bar on top joins (or, on Zoom as host, starts) the next meeting.
 * Who's on what lists every person and employee and what they're working on.
 */

type View = "day" | "week" | "month" | "who";
type RangeOut = Outputs["calendar"]["range"];
type Item = RangeOut["items"][number];
type WhoOut = Outputs["calendar"]["who"];
type WhoRow = WhoOut["rows"][number];

const HOUR = 56;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ==========================================
// Dates (YYYY-MM-DD strings; times shown in the workspace's time zone)
// ==========================================

function ymdLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
function weekday(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}
function partsOf(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}
/** The wall clock in tz: its date and hours since midnight. */
function inTz(at: Date | string, tz: string) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at))) p[x.type] = x.value;
  return { ymd: `${p.year}-${p.month}-${p.day}`, hours: (+p.hour % 24) + +p.minute / 60 };
}
function timeText(at: Date | string, tz: string) {
  return new Date(at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}
function rangeText(a: Date | string, b: Date | string, tz: string) {
  const x = timeText(a, tz);
  const y = timeText(b, tz);
  return x.slice(-2) === y.slice(-2) ? `${x.slice(0, -3)} to ${y}` : `${x} to ${y}`;
}
function longDay(ymd: string) {
  const { y, m, d } = partsOf(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric", year: "numeric" });
}
function shortDay(ymd: string) {
  const { y, m, d } = partsOf(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function dateText(at: Date | string, tz: string) {
  return new Date(at).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/** The first day and number of days a view covers. */
function span(view: View, anchor: string) {
  if (view === "day") return { from: anchor, days: 1 };
  if (view === "week" || view === "who") return { from: addDays(anchor, -weekday(anchor)), days: 7 };
  const { y, m } = partsOf(anchor);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const lead = weekday(first);
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: addDays(first, -lead), days: Math.ceil((lead + inMonth) / 7) * 7 };
}

function title(view: View, anchor: string) {
  if (view === "day") return longDay(anchor);
  if (view === "month") {
    const { y, m } = partsOf(anchor);
    return `${MONTHS[m - 1]} ${y}`;
  }
  const s = span("week", anchor).from;
  const e = addDays(s, 6);
  const a = partsOf(s);
  const b = partsOf(e);
  const mon = (n: number) => MONTHS[n - 1].slice(0, 3);
  if (a.y !== b.y) return `${mon(a.m)} ${a.d}, ${a.y} to ${mon(b.m)} ${b.d}, ${b.y}`;
  if (a.m !== b.m) return `${mon(a.m)} ${a.d} to ${mon(b.m)} ${b.d}, ${b.y}`;
  return `${mon(a.m)} ${a.d} to ${b.d}, ${b.y}`;
}

/** Light fill for an event's color. */
function tint(hex: string) {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return "var(--ld-line2)";
  const mix = (c: number) => Math.round(c + (255 - c) * 0.86);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

const readHidden = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem("ld-cal-hidden") || "[]");
  } catch {
    return [];
  }
};

// ==========================================
// Page
// ==========================================

export default function Calendar() {
  const { currentOrgId } = useTenant();
  const mobile = useIsMobile();
  const initial = (): View => {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v === "day" || v === "week" || v === "month" || v === "who") return v;
    return window.matchMedia("(max-width: 760px)").matches ? "day" : "week";
  };
  const [view, setView] = React.useState<View>(initial);
  const [anchor, setAnchor] = React.useState(ymdLocal());
  const [hidden, setHidden] = React.useState<string[]>(readHidden);
  const [sel, setSel] = React.useState<string | null>(null);
  const sp = span(view, anchor);
  const q = trpc.calendar.range.useQuery({ organizationId: currentOrgId, from: sp.from, days: sp.days }, { enabled: currentOrgId > 0 && view !== "who", refetchInterval: 5 * 60_000, placeholderData: (prev) => prev });
  const r = q.data;
  const tz = r?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = r?.today ?? ymdLocal();

  const go = (v: View) => {
    setView(v);
    setSel(null);
    const u = new URL(window.location.href);
    u.searchParams.set("view", v);
    window.history.replaceState(null, "", u.toString());
  };
  const step = (dir: number) => {
    setSel(null);
    if (view === "day") setAnchor(addDays(anchor, dir));
    else if (view === "week") setAnchor(addDays(anchor, 7 * dir));
    else {
      const { y, m } = partsOf(anchor);
      const t = new Date(Date.UTC(y, m - 1 + dir, 1, 12));
      setAnchor(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-01`);
    }
  };
  const toggle = (key: string) => {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
    setHidden(next);
    try {
      localStorage.setItem("ld-cal-hidden", JSON.stringify(next));
    } catch {
      /* the choice just isn't remembered */
    }
  };
  const items = (r?.items ?? []).filter((i) => !hidden.includes(i.source));
  const selected = items.find((i) => i.key === sel) ?? null;
  const openDay = (ymd: string) => {
    setAnchor(ymd);
    go("day");
  };

  return (
    <Page rail="calendar">
      <div className="ld-between" style={{ flexWrap: "wrap" }}>
        <h1 className="ld-h1">Calendar</h1>
        {view !== "who" && (
          <div className="ld-row">
            <button type="button" className="ld-btn sm" style={{ width: 80 }} onClick={() => { setAnchor(today); setSel(null); }}>Today</button>
            <button type="button" className="ld-btn sm" style={{ width: 36, padding: 0 }} aria-label="Previous" onClick={() => step(-1)}>‹</button>
            <button type="button" className="ld-btn sm" style={{ width: 36, padding: 0 }} aria-label="Next" onClick={() => step(1)}>›</button>
            <b style={{ fontSize: 15, marginLeft: 6 }}>{title(view, anchor)}</b>
          </div>
        )}
      </div>
      <NextBar />
      <UnderlineTabs<View>
        tabs={[
          { key: "day", label: "Day" },
          { key: "week", label: "Week" },
          { key: "month", label: "Month" },
          { key: "who", label: "Who's on what" },
        ]}
        value={view}
        onChange={go}
      />
      {view === "who" ? (
        <WhoView />
      ) : (
        <>
          <div className="ld-cal-legend">
            {(r?.sources ?? []).map((s) => (
              <label key={s.key}>
                <input type="checkbox" checked={!hidden.includes(s.key)} onChange={() => toggle(s.key)} />
                <span className="ld-cal-sq" style={{ background: s.color }} />
                {s.name}
              </label>
            ))}
          </div>
          <ErrorLine error={q.error} />
          {r && !r.connected && (
            <div className="ld-card ld-small" style={{ padding: "12px 16px" }}>
              No calendar is connected yet. <Link href="/integrations">Add your calendars on Integrations</Link> to see your events here.
            </div>
          )}
          {r && r.failed.length > 0 && (
            <p role="alert" className="ld-small" style={{ color: "var(--ld-bad)", margin: 0 }}>
              Couldn't read {r.failed.join(" and ")}. <Link href="/integrations">Reconnect on Integrations</Link>.
            </p>
          )}
          <div className="ld-cal-wrap">
            <div style={{ flex: 1, minWidth: 0 }}>
              {view === "month" ? (
                <MonthGrid from={sp.from} days={sp.days} anchor={anchor} today={today} tz={tz} items={items} sel={sel} onPick={setSel} onDay={openDay} />
              ) : (
                <TimeGrid days={view === "day" ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(sp.from, i))} today={today} tz={tz} items={items} sel={sel} onPick={setSel} onDay={openDay} />
              )}
            </div>
            {selected ? (
              <Detail item={selected} tz={tz} onClose={() => setSel(null)} />
            ) : view === "day" && !mobile ? (
              <DaySide ymd={anchor} today={today} tz={tz} items={items} onWho={() => go("who")} onPick={setSel} />
            ) : null}
          </div>
        </>
      )}
    </Page>
  );
}

// ==========================================
// The next meeting
// ==========================================

function useNow(ms: number) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function NextBar() {
  const { currentOrgId } = useTenant();
  const q = trpc.calendar.next.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 60_000 });
  const start = trpc.calendar.start.useMutation();
  const now = useNow(15_000);
  const m = q.data?.meeting;
  if (!m || !m.meeting) return null;
  const tz = q.data!.tz;
  const s = new Date(m.start).getTime();
  const e = new Date(m.end).getTime();
  const mins = Math.round((s - now) / 60_000);
  const sameDay = inTz(m.start, tz).ymd === inTz(new Date(now), tz).ymd;
  const tomorrow = inTz(m.start, tz).ymd === addDays(inTz(new Date(now), tz).ymd, 1);
  const badge = now >= e ? "Ended" : now >= s ? `Started ${Math.max(0, -mins)} min ago` : mins <= 60 ? `Starts in ${Math.max(1, mins)} min` : sameDay ? `Today, ${timeText(m.start, tz)}` : tomorrow ? `Tomorrow, ${timeText(m.start, tz)}` : dateText(m.start, tz);
  const soon = now >= s - 60 * 60_000;
  const platform = PLATFORM_NAMES[m.meeting.platform];
  const avery = m.notes ? (m.notes.status === "in_call" || m.notes.status === "joining" ? "Avery is in the call" : m.notes.status === "scheduled" ? "Avery sits in" : m.notes.choice === "skip" || m.notes.locked ? "Avery skips" : null) : null;
  const facts = [rangeText(m.start, m.end, tz), platform, m.host ? "you're the host" : null, avery].filter(Boolean).join(" · ");
  const startZoom = m.meeting.platform === "zoom" && m.host;
  const label = startZoom ? "Start on Zoom" : `Join on ${PLATFORM_SHORT[m.meeting.platform]}`;
  const open = () => {
    // The tab opens on the click so the browser doesn't block it; the link follows.
    const w = window.open("about:blank", "_blank");
    start.mutate(
      { organizationId: currentOrgId, url: m.meeting!.url },
      {
        onSuccess: (r) => {
          const url = r.url ?? m.meeting!.url;
          if (w) w.location.href = url;
          else window.location.href = url;
        },
        onError: () => {
          if (w) w.location.href = m.meeting!.url;
        },
      }
    );
  };
  return (
    <div className="ld-cal-next">
      <span className="ld-cal-badge" style={soon ? undefined : { background: "#24403a", color: "#fff" }}>{badge}</span>
      <span className="ld-cal-next-text">
        <b>Next meeting: {m.title}</b>
        <span style={{ color: "#a9c0b6" }}> · {facts}</span>
      </span>
      <span className="ld-cal-next-btns">
        {m.precallId ? (
          <Link href={`/chats/outreach/work?tab=precall&report=${m.precallId}`} className="ld-btn" style={{ background: "#24403a", borderColor: "#24403a", color: "#fff" }}>
            Pre-call report
          </Link>
        ) : null}
        {startZoom ? (
          <button type="button" className="ld-btn p ld-cal-go" disabled={start.isPending} onClick={open}>
            {start.isPending ? "Opening" : label}
          </button>
        ) : (
          <a href={m.meeting.url} target="_blank" rel="noreferrer" className="ld-btn p ld-cal-go">
            {label}
          </a>
        )}
      </span>
    </div>
  );
}

// ==========================================
// Day and Week: hours down the side
// ==========================================

type Placed = { item: Item; top: number; height: number; col: number; cols: number };

/** Overlapping events sit side by side. */
function place(list: Item[], tz: string, ymd: string, first: number): Placed[] {
  const rows = list
    .map((item) => {
      const a = inTz(item.start, tz);
      const b = inTz(item.end, tz);
      const sh = a.ymd < ymd ? 0 : a.hours;
      const eh = b.ymd > ymd ? 24 : b.hours;
      return { item, sh, eh: Math.max(eh, sh + 0.25) };
    })
    .sort((x, y) => x.sh - y.sh || y.eh - x.eh);
  const out: Placed[] = [];
  let group: { r: (typeof rows)[number]; col: number }[] = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...group.map((g) => g.col + 1));
    for (const g of group) out.push({ item: g.r.item, top: (g.r.sh - first) * HOUR, height: Math.max(22, (g.r.eh - g.r.sh) * HOUR - 2), col: g.col, cols });
    group = [];
  };
  for (const r of rows) {
    if (group.length && r.sh >= groupEnd) flush();
    const taken = new Set(group.filter((g) => g.r.eh > r.sh).map((g) => g.col));
    let col = 0;
    while (taken.has(col)) col++;
    group.push({ r, col });
    groupEnd = Math.max(groupEnd, r.eh);
  }
  if (group.length) flush();
  return out;
}

function onDay(i: Item, ymd: string, tz: string) {
  const a = inTz(i.start, tz).ymd;
  // An all-day item ends at the next midnight; a timed one belongs to each day it touches.
  const endAt = new Date(new Date(i.end).getTime() - (i.allDay ? 60_000 : 1));
  const b = inTz(endAt, tz).ymd;
  return a <= ymd && b >= ymd;
}

function Chip({ item, sel, onPick }: { item: Item; sel: boolean; onPick: (k: string) => void }) {
  const late = item.late ? { background: "#fdecea", color: "var(--ld-bad)" } : null;
  return (
    <button
      type="button"
      className={`ld-cal-chip ${sel ? "sel" : ""}`}
      style={late ?? { background: tint(item.color), color: item.kind === "team" ? "var(--ld-text2)" : item.color }}
      title={item.title}
      onClick={() => onPick(item.key)}
    >
      {item.title}
    </button>
  );
}

function TimeGrid({ days, today, tz, items, sel, onPick, onDay: openDay }: { days: string[]; today: string; tz: string; items: Item[]; sel: string | null; onPick: (k: string) => void; onDay: (ymd: string) => void }) {
  const now = useNow(60_000);
  const timed = items.filter((i) => !i.allDay && days.some((d) => onDay(i, d, tz)));
  let first = 7;
  let last = 19;
  for (const i of timed) {
    const a = inTz(i.start, tz);
    const b = inTz(i.end, tz);
    if (days.includes(a.ymd)) first = Math.min(first, Math.floor(a.hours));
    if (days.includes(b.ymd)) last = Math.max(last, Math.ceil(b.hours));
  }
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const cols = `64px repeat(${days.length}, minmax(0, 1fr))`;
  const nowAt = inTz(new Date(now), tz);
  return (
    <div className="ld-cal-grid">
      <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: cols }}>
        <div className="ld-cal-dh" style={{ borderLeft: 0 }} />
        {days.map((d) => (
          <button type="button" key={d} className={`ld-cal-dh ${d === today ? "today" : ""}`} onClick={() => days.length > 1 && openDay(d)} style={{ cursor: days.length > 1 ? "pointer" : "default" }}>
            {DAY_NAMES[weekday(d)]}
            <b>{partsOf(d).d}</b>
          </button>
        ))}
        <div className="ld-cal-tl" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", borderBottom: "1px solid #e3e9e6" }}>All day</div>
        {days.map((d) => (
          <div key={d} className="ld-cal-ad" style={days.length === 1 ? { flexDirection: "row", flexWrap: "wrap" } : undefined}>
            {items
              .filter((i) => i.allDay && onDay(i, d, tz))
              .map((i) => (
                <Chip key={i.key} item={i} sel={sel === i.key} onPick={onPick} />
              ))}
          </div>
        ))}
      </div>
      <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: cols }}>
        <div style={{ position: "relative", height: hours.length * HOUR }}>
          {hours.map((h, n) => (
            <span key={h} className="ld-cal-tl" style={{ position: "absolute", right: 0, top: n * HOUR - 7 }}>
              {n === 0 ? "" : `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`}
            </span>
          ))}
        </div>
        {days.map((d) => (
          <div key={d} className="ld-cal-col" style={{ height: hours.length * HOUR }}>
            {place(timed.filter((i) => onDay(i, d, tz)), tz, d, first).map((p) => {
              const i = p.item;
              const short = p.height < 40;
              return (
                <button
                  type="button"
                  key={i.key}
                  className={`ld-cal-ev ${sel === i.key ? "sel" : ""}`}
                  style={{
                    top: p.top,
                    height: p.height,
                    left: `calc(${(100 / p.cols) * p.col}% + 3px)`,
                    width: `calc(${100 / p.cols}% - 6px)`,
                    background: i.busy || i.kind === "focus" ? "#f1f3f2" : tint(i.color),
                    borderLeftColor: i.color,
                    borderStyle: i.kind === "focus" ? "dashed" : undefined,
                  }}
                  onClick={() => onPick(i.key)}
                >
                  <b>{i.title}</b>
                  {!short && <span>{rangeText(i.start, i.end, tz)}{i.meeting ? ` · ${PLATFORM_SHORT[i.meeting.platform]}` : ""}</span>}
                </button>
              );
            })}
            {d === nowAt.ymd && nowAt.hours >= first && nowAt.hours <= last && <div className="ld-cal-now" style={{ top: (nowAt.hours - first) * HOUR }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// Month
// ==========================================

function MonthGrid({ from, days, anchor, today, tz, items, sel, onPick, onDay: openDay }: { from: string; days: number; anchor: string; today: string; tz: string; items: Item[]; sel: string | null; onPick: (k: string) => void; onDay: (ymd: string) => void }) {
  const month = partsOf(anchor).m;
  const cells = Array.from({ length: days }, (_, i) => addDays(from, i));
  return (
    <div className="ld-cal-mo">
      {DAY_NAMES.map((d) => (
        <div key={d} className="ld-cal-moh">{d}</div>
      ))}
      {cells.map((d) => {
        const list = items.filter((i) => onDay(i, d, tz)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || new Date(a.start).getTime() - new Date(b.start).getTime());
        const shown = list.slice(0, 3);
        return (
          <div key={d} className={`ld-cal-mc ${partsOf(d).m !== month ? "out" : ""} ${d === today ? "today" : ""}`}>
            <button type="button" className="ld-cal-mn" onClick={() => openDay(d)} aria-label={longDay(d)}>
              {partsOf(d).d}
            </button>
            {shown.map((i) => (
              <button type="button" key={i.key} className={`ld-cal-dot ${sel === i.key ? "sel" : ""}`} title={i.title} onClick={() => onPick(i.key)}>
                <i style={{ background: i.late ? "var(--ld-bad)" : i.color }} />
                <span className="ld-clip">{i.allDay ? i.title : `${timeText(i.start, tz).replace(/ (AM|PM)$/, "")} ${i.title}`}</span>
              </button>
            ))}
            {list.length > shown.length && (
              <button type="button" className="ld-cal-more" onClick={() => openDay(d)}>
                +{list.length - shown.length} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ==========================================
// Side panels
// ==========================================

function Detail({ item, tz, onClose }: { item: Item; tz: string; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const start = trpc.calendar.start.useMutation();
  const setJoin = trpc.coo.setJoin.useMutation({ onSuccess: () => Promise.all([utils.calendar.range.invalidate(), utils.calendar.next.invalidate()]) });
  const now = Date.now();
  const upcoming = new Date(item.end).getTime() > now;
  const row = (k: string, v: React.ReactNode) =>
    v ? (
      <div className="ld-cal-kv">
        <span className="ld-strong">{k}</span>
        <span>{v}</span>
      </div>
    ) : null;
  const when = item.allDay ? `${dateText(item.start, tz)}, all day` : (
    <>
      {dateText(item.start, tz)}
      <br />
      {rangeText(item.start, item.end, tz)}
    </>
  );
  const where = item.meeting ? PLATFORM_NAMES[item.meeting.platform] : item.location || null;
  const n = item.notes;
  const sitting = n && (n.status === "scheduled" || n.status === "joining" || n.status === "in_call");
  const notesPill = n ? (n.locked ? <span className="ld-pill gray">Never joins this one</span> : sitting ? <span className="ld-pill green">Avery sits in</span> : n.status === "ready" ? <span className="ld-pill green">Notes ready</span> : <span className="ld-pill gray">Avery skips</span>) : null;
  const startZoom = item.meeting?.platform === "zoom" && item.host;
  const go = () => {
    const w = window.open("about:blank", "_blank");
    start.mutate(
      { organizationId: currentOrgId, url: item.meeting!.url },
      {
        onSuccess: (r) => {
          const url = r.url ?? item.meeting!.url;
          if (w) w.location.href = url;
          else window.location.href = url;
        },
        onError: () => {
          if (w) w.location.href = item.meeting!.url;
        },
      }
    );
  };
  return (
    <aside className="ld-cal-side" aria-label="Event">
      <div className="ld-between">
        <span className="ld-pill" style={{ background: tint(item.color), color: item.color }}>{item.calendar}</span>
        <button type="button" className="ld-btn sm" style={{ width: 32, height: 32, padding: 0 }} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{item.title}</h2>
      {row("When", when)}
      {row(item.kind === "event" ? "Where" : "", item.kind === "event" ? where : null)}
      {row("Guests", item.guests.length ? item.guests.join(", ") : null)}
      {row(item.kind === "task" ? "Who" : "Whose", item.kind !== "event" && item.who ? item.who : null)}
      {row("Notes", notesPill)}
      {row("Prep", item.precallId ? "The pre-call report is ready" : null)}
      {item.kind === "focus" && <p className="ld-small ld-muted" style={{ margin: 0 }}>From Avery's rules. He keeps meetings out of it.</p>}
      <ErrorLine error={start.error ?? setJoin.error} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {item.meeting && upcoming && (startZoom ? (
          <button type="button" className="ld-btn p" style={{ width: "100%" }} disabled={start.isPending} onClick={go}>
            {start.isPending ? "Opening" : "Start on Zoom"}
          </button>
        ) : (
          <a href={item.meeting.url} target="_blank" rel="noreferrer" className="ld-btn p" style={{ width: "100%" }}>
            {`Join on ${PLATFORM_SHORT[item.meeting.platform]}`}
          </a>
        ))}
        {item.precallId ? (
          <Link href={`/chats/outreach/work?tab=precall&report=${item.precallId}`} className="ld-btn" style={{ width: "100%" }}>
            Pre-call report
          </Link>
        ) : null}
        {n && !n.locked && upcoming && n.status !== "ready" && (
          <button type="button" className="ld-btn" style={{ width: "100%" }} disabled={setJoin.isPending} onClick={() => setJoin.mutate({ organizationId: currentOrgId, id: n.id, choice: sitting ? "skip" : "join" })}>
            {sitting ? "Skip notes" : "Take notes"}
          </button>
        )}
        {n && n.status === "ready" && (
          <Link href="/chats/coo/work" className="ld-btn" style={{ width: "100%" }}>
            Read the notes
          </Link>
        )}
        {item.link && item.kind !== "event" && (
          <Link href={item.link} className="ld-btn" style={{ width: "100%" }}>
            Open
          </Link>
        )}
      </div>
    </aside>
  );
}

function DaySide({ ymd, today, tz, items, onWho, onPick }: { ymd: string; today: string; tz: string; items: Item[]; onWho: () => void; onPick: (k: string) => void }) {
  const due = items.filter((i) => i.kind === "task" && onDay(i, ymd, tz));
  const team = items.filter((i) => i.kind === "team" && onDay(i, ymd, tz));
  const line = (i: Item, who: string | null) => (
    <button type="button" key={i.key} className="ld-cal-line" onClick={() => onPick(i.key)}>
      <span className="ld-clip">{i.title}</span>
      {who && <span className={`ld-pill ${i.late ? "red" : "gray"}`}>{firstName(who)}</span>}
    </button>
  );
  return (
    <aside className="ld-cal-side" aria-label="This day">
      <span className="ld-lbl">Due {ymd === today ? "today" : shortDay(ymd)}</span>
      {due.length ? due.map((i) => line(i, i.who)) : <span className="ld-small ld-muted">Nothing due.</span>}
      <span className="ld-lbl" style={{ marginTop: 6 }}>Team</span>
      {team.length ? team.map((i) => line({ ...i, title: i.title.replace(/^[^:]+:\s*/, "") }, i.who)) : <span className="ld-small ld-muted">Nothing scheduled.</span>}
      <button type="button" className="ld-btn" style={{ width: "100%" }} onClick={onWho}>
        Who's on what
      </button>
    </aside>
  );
}

// ==========================================
// Who's on what
// ==========================================

type WhoTab = "all" | "people" | "ai" | "needs";

function WhoView() {
  const { currentOrgId } = useTenant();
  const q = trpc.calendar.who.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 2 * 60_000 });
  const [tab, setTab] = React.useState<WhoTab>("all");
  const [open, setOpen] = React.useState<string | null>(null);
  const rows = q.data?.rows ?? [];
  const needs = rows.filter((r) => r.needsYou > 0 || r.status.label === "Behind");
  const shown = tab === "people" ? rows.filter((r) => r.group === "people") : tab === "ai" ? rows.filter((r) => r.group === "ai") : tab === "needs" ? needs : rows;
  const tz = q.data?.tz ?? "America/Chicago";
  return (
    <>
      <ErrorLine error={q.error} />
      <FolderTabs<WhoTab>
        tabs={[
          { key: "all", label: "Everyone" },
          { key: "people", label: "People" },
          { key: "ai", label: "AI team" },
          { key: "needs", label: `Needs you (${needs.length})` },
        ]}
        value={tab}
        onChange={(k) => {
          setTab(k);
          setOpen(null);
        }}
      >
        <div className="ld-hd ld-who-cols">
          <span>Who</span>
          <span>Working on now</span>
          <span>Next</span>
          <span>Status</span>
          <span />
        </div>
        {q.isLoading && <div className="ld-rw ld-small ld-muted">Loading</div>}
        {!q.isLoading && !shown.length && <div className="ld-rw ld-small ld-muted">Nobody here right now.</div>}
        {shown.map((r) => (
          <WhoLine key={r.key} r={r} tz={tz} open={open === r.key} onToggle={() => setOpen(open === r.key ? null : r.key)} />
        ))}
      </FolderTabs>
    </>
  );
}

function WhoLine({ r, tz, open, onToggle }: { r: WhoRow; tz: string; open: boolean; onToggle: () => void }) {
  const tone = r.status.tone === "grey" ? "gray" : r.status.tone;
  const kv = (k: string, v: React.ReactNode) => (
    <div className="ld-who-kv">
      <span className="ld-strong">{k}</span>
      <span>{v}</span>
    </div>
  );
  return (
    <>
      <div className={`ld-rw ld-who-cols ${open ? "open" : ""}`}>
        <span className="ld-row" style={{ gap: 10, minWidth: 0 }}>
          {r.group === "ai" ? <Avatar name={r.name} kind={r.kind ?? undefined} src={r.avatarUrl} size={30} /> : <PersonAvatar name={r.name} src={r.avatarUrl} size={30} />}
          <span style={{ minWidth: 0 }}>
            <span className="ld-strong ld-clip" style={{ display: "block", whiteSpace: "nowrap" }}>{r.name}</span>
            <span className="ld-small ld-muted ld-clip" style={{ display: "block", whiteSpace: "nowrap", fontSize: 12 }}>{r.role}</span>
          </span>
        </span>
        <span className="ld-clip">{r.now}</span>
        <span className="ld-muted ld-clip">{r.next}</span>
        <span className={`ld-pill ${tone}`}>{r.status.label}</span>
        <button type="button" className="ld-btn" onClick={onToggle} aria-expanded={open}>
          {open ? "Close" : "Open"}
        </button>
      </div>
      {open && (
        <div className="ld-expand ld-who-open">
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            {kv("Due", r.due.length ? r.due.map((d) => `${shortDayOf(d.at, tz)}: ${d.title}`).join("; ") : "Nothing due")}
            {kv("Waiting on", r.waiting.length ? r.waiting.join("; ") : "Nothing")}
            {kv("Done this week", r.done.length ? `${r.done.join("; ")}${r.doneCount > r.done.length ? `, and ${r.doneCount - r.done.length} more` : ""}` : "Nothing yet")}
            {kv("On the calendar", r.calendar.length ? r.calendar.map((c) => `${new Date(c.at).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}: ${c.title}`).join("; ") : "Nothing scheduled")}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {r.chat && (
              <Link href={r.chat} className="ld-btn p">
                Open chat
              </Link>
            )}
            {r.work && (
              <Link href={r.work} className="ld-btn">
                See work
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** "Dr. Ashley Bryant" to "Ashley". */
function firstName(n: string) {
  return n.replace(/^(dr|mr|mrs|ms|mx)\.?\s+/i, "").split(" ")[0];
}

function shortDayOf(at: Date | string, tz: string) {
  return new Date(at).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
