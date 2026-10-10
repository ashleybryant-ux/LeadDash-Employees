import React from "react";
import type { Outputs } from "../types";

/**
 * Add a card: the library, by category, with a search, the way ClickUp's
 * dashboard library works. Picking a card opens the editor with the right
 * choices filled in. The thumbnails are drawn here too.
 */

export type Card = Outputs["pj"]["dashboards"]["dashboards"][number]["cards"][number];
type Thumb = "ai" | "pie" | "donut" | "bar" | "battery" | "line" | "number" | "table" | "embed" | "notes";
export type Template = { key: string; cat: string; title: string; blurb: string; thumb: Thumb; label?: string; color?: string; card: Omit<Card, "id" | "scope"> & { scope?: Card["scope"] } };

export const CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: "featured", label: "Featured", color: "#1b6b4a" },
  { key: "ai", label: "AI cards", color: "#7c3aed" },
  { key: "charts", label: "Charts", color: "#2563eb" },
  { key: "statuses", label: "Statuses", color: "#0f766e" },
  { key: "tags", label: "Tags", color: "#d97706" },
  { key: "assignees", label: "Assignees", color: "#2563eb" },
  { key: "priorities", label: "Priorities", color: "#4f46e5" },
  { key: "time", label: "Time tracking", color: "#7c3aed" },
  { key: "tables", label: "Tables", color: "#4b5563" },
  { key: "embeds", label: "Embeds", color: "#4b5563" },
];

const chart = (title: string, blurb: string, cat: string, thumb: Thumb, options: NonNullable<Card["options"]>, size: 1 | 2 | 3 = 1, color?: string): Template => ({ key: `${cat}:${title}:${thumb}`, cat, title, blurb, thumb, color, card: { type: "chart", title, options, size } });
const table = (title: string, blurb: string, cat: string, kind: NonNullable<Card["options"]>["table"], label: string, color: string, size: 1 | 2 | 3 = 2): Template => ({ key: `${cat}:${title}`, cat, title, blurb, thumb: "table", label, color, card: { type: "table", title, options: { table: kind }, size } });
const aiT = (title: string, blurb: string, kind: NonNullable<Card["options"]>["ai"]): Template => ({ key: `ai:${kind}`, cat: "ai", title, blurb, thumb: "ai", card: { type: "ai", title, options: { ai: kind }, size: 2 } });
const emb = (title: string, blurb: string, kind: NonNullable<Card["options"]>["embed"], glyph: string): Template => ({ key: `embed:${kind}`, cat: "embeds", title, blurb, thumb: "embed", label: glyph, card: { type: "embed", title, options: { embed: kind }, size: kind === "calendar" ? 3 : 2 } });

export const LIBRARY: Template[] = [
  // Featured
  { ...aiT("AI team update", "What each employee did, time, handoffs", "team"), key: "f:ai", cat: "featured" },
  { ...table("Task list", "A List view of tasks from any place", "featured", "tasks", "To do", "#87909e"), key: "f:tasks" },
  { ...chart("Tasks by status", "A pie chart of statuses across a place", "featured", "pie", { chart: "pie", by: "status" }), key: "f:status" },
  { ...chart("Number", "A count, sum or average of tasks", "featured", "number", { chart: "number", which: "open" }), key: "f:number" },
  { ...table("Time reporting", "Tasks with time tracked, by person", "featured", "timereport", "Tracked", "#7c3aed"), key: "f:time" },
  { ...table("Portfolio", "Progress of projects and folders", "featured", "portfolio", "Projects", "#2563eb"), key: "f:portfolio" },
  { ...chart("Tasks by person", "A pie chart of tasks by assignee", "featured", "pie", { chart: "pie", by: "assignee" }, 1, "#2563eb"), key: "f:person" },
  { key: "f:notes", cat: "featured", title: "Notes", blurb: "Text, links and checklists on the dashboard", thumb: "notes", label: "Notes", color: "#d97706", card: { type: "notes", title: "Notes", options: { text: "" }, size: 1 } },
  { ...table("Overdue tasks", "A list of overdue tasks", "featured", "overdue", "Overdue", "#c2253c"), key: "f:overdue" },
  { ...table("Tasks due soon", "Tasks due in the next 14 days", "featured", "soon", "Due soon", "#d97706"), key: "f:soon" },
  { key: "f:goal", cat: "featured", title: "Goal progress", blurb: "Progress on a goal and its targets", thumb: "number", label: "82%", color: "#0f766e", card: { type: "goal", title: "Goal progress", size: 1 } },
  { key: "f:doc", cat: "featured", title: "A doc", blurb: "The first lines of a doc, with a link", thumb: "table", label: "Doc", color: "#4b5563", card: { type: "doc", title: "A doc", size: 1 } },
  // AI cards
  aiT("AI team update", "What each employee did, time, handoffs", "team"),
  aiT("AI standup", "Done, doing, stuck, for today", "standup"),
  aiT("AI project update", "Where a project stands and what is next", "project"),
  aiT("AI executive summary", "A summary of a list, folder or everything", "summary"),
  { ...aiT("AI brain", "Nora answers your prompt from the tasks", "brain"), card: { type: "ai", title: "AI brain", options: { ai: "brain", prompt: "" }, size: 2 } },
  // Charts
  chart("Line chart", "Any measure over time", "charts", "line", { chart: "line", by: "status", period: "quarter" }, 2),
  chart("Bar chart", "Any measure by status, person, priority, tag, list or field", "charts", "bar", { chart: "bar", by: "status" }, 1, "#d97706"),
  chart("Pie or donut", "Any measure split up", "charts", "donut", { chart: "donut", by: "assignee" }, 1, "#0f766e"),
  chart("Battery", "Any measure as one stacked bar", "charts", "battery", { chart: "battery", by: "status" }),
  chart("Number", "Count, sum or average of a field", "charts", "number", { chart: "number", measure: "count", which: "open" }, 1, "#7c3aed"),
  // Statuses
  chart("Tasks by status", "Pie chart", "statuses", "pie", { chart: "pie", by: "status" }, 1, "#0f766e"),
  chart("Tasks by status", "Battery", "statuses", "battery", { chart: "battery", by: "status" }, 1, "#0f766e"),
  chart("Tasks by status", "Bar chart", "statuses", "bar", { chart: "bar", by: "status" }, 1, "#0f766e"),
  chart("Status over time", "Task count per status, by week", "statuses", "line", { chart: "line", by: "status", period: "quarter" }, 2, "#0f766e"),
  chart("Tasks in progress", "How many are active", "statuses", "number", { chart: "number", which: "active" }, 1, "#0f766e"),
  chart("Tasks closed", "How many are closed", "statuses", "number", { chart: "number", which: "closed" }, 1, "#0f766e"),
  chart("Tasks completed", "How many are done this week", "statuses", "number", { chart: "number", which: "done" }, 1, "#0f766e"),
  table("Time in status", "What has sat in a status longest", "statuses", "instatus", "Status", "#0f766e"),
  // Tags
  chart("Tag usage", "Pie chart", "tags", "pie", { chart: "pie", by: "tag" }, 1, "#d97706"),
  chart("Tag usage", "Battery", "tags", "battery", { chart: "battery", by: "tag" }, 1, "#d97706"),
  chart("Tag usage", "Bar chart", "tags", "bar", { chart: "bar", by: "tag" }, 1, "#d97706"),
  chart("Tag usage over time", "Tags by week", "tags", "line", { chart: "line", by: "tag", period: "quarter" }, 2, "#d97706"),
  // Assignees
  chart("Tasks by assignee", "Pie chart", "assignees", "pie", { chart: "pie", by: "assignee" }, 1, "#2563eb"),
  chart("Tasks by assignee", "Battery", "assignees", "battery", { chart: "battery", by: "assignee" }, 1, "#2563eb"),
  chart("Tasks by assignee", "Bar chart", "assignees", "bar", { chart: "bar", by: "assignee" }, 1, "#2563eb"),
  chart("Unassigned tasks", "How many have no owner", "assignees", "number", { chart: "number", which: "unassigned" }, 1, "#2563eb"),
  chart("Assigned, not complete", "Open tasks with an owner", "assignees", "number", { chart: "number", which: "assigned" }, 1, "#2563eb"),
  { key: "assignees:workload", cat: "assignees", title: "Workload", blurb: "Hours per person this week", thumb: "bar", color: "#2563eb", card: { type: "workload", title: "Workload this week", size: 1 } },
  // Priorities
  { key: "priorities:goal", cat: "priorities", title: "Goals", blurb: "Progress on a goal and its targets", thumb: "number", label: "82%", color: "#4f46e5", card: { type: "goal", title: "Goal progress", size: 1 } },
  chart("Priority breakdown", "Pie chart", "priorities", "pie", { chart: "pie", by: "priority" }, 1, "#4f46e5"),
  chart("Priority breakdown", "Battery", "priorities", "battery", { chart: "battery", by: "priority" }, 1, "#4f46e5"),
  chart("Priority breakdown", "Bar chart", "priorities", "bar", { chart: "bar", by: "priority" }, 1, "#4f46e5"),
  chart("Priority over time", "By week", "priorities", "line", { chart: "line", by: "priority", period: "quarter" }, 2, "#4f46e5"),
  chart("Urgent tasks", "Total urgent, by place", "priorities", "number", { chart: "number", which: "urgent" }, 1, "#4f46e5"),
  chart("High tasks", "Total high, by place", "priorities", "number", { chart: "number", which: "high" }, 1, "#4f46e5"),
  chart("Normal tasks", "Total normal, by place", "priorities", "number", { chart: "number", which: "normal" }, 1, "#4f46e5"),
  chart("Low tasks", "Total low, by place", "priorities", "number", { chart: "number", which: "low" }, 1, "#4f46e5"),
  chart("No priority", "Total with no priority", "priorities", "number", { chart: "number", which: "none" }, 1, "#4f46e5"),
  table("Priority tasks", "A list of urgent and high tasks", "priorities", "priority", "Urgent", "#c2253c"),
  // Time tracking
  table("Time reporting", "Tasks with time tracked this week", "time", "timereport", "Tracked", "#7c3aed"),
  table("Timesheet", "A week of time per person", "time", "timesheet", "Mon Tue Wed", "#7c3aed", 3),
  table("Billable report", "Billable time this week", "time", "billable", "Billable", "#7c3aed"),
  table("Time estimated", "Estimated against tracked, and what is left", "time", "estimates", "Estimate", "#7c3aed"),
  chart("Time tracked", "Total tracked, by person", "time", "bar", { chart: "bar", measure: "time", by: "assignee", period: "week" }, 1, "#7c3aed"),
  chart("Time by status", "Minutes tracked per status", "time", "donut", { chart: "donut", measure: "time", by: "status", period: "month" }, 1, "#7c3aed"),
  // Tables
  table("Task list", "Tasks from any place", "tables", "tasks", "To do", "#87909e"),
  table("Overdue tasks", "Overdue, oldest first", "tables", "overdue", "Overdue", "#c2253c"),
  table("Tasks due soon", "The next 14 days", "tables", "soon", "Due soon", "#d97706"),
  table("Milestones", "Tasks tagged milestone", "tables", "milestones", "Milestones", "#1b6b4a"),
  table("Completed report", "Done in the last 30 days, by person", "tables", "completed", "Done", "#1b6b4a", 1),
  table("Worked on", "What each person touched this week", "tables", "workedon", "Worked on", "#2563eb", 1),
  table("Who is behind", "Overdue and due this week, by person", "tables", "behind", "Behind", "#c2253c", 1),
  table("Activity", "The latest activity in a place", "tables", "activity", "Activity", "#4b5563"),
  table("New content", "Docs, forms and whiteboards made lately", "tables", "newcontent", "New", "#4b5563"),
  table("Portfolio", "Projects with status and progress", "tables", "portfolio", "Projects", "#2563eb"),
  // Embeds
  emb("Custom embed", "Any page by URL", "url", "‹ / ›"),
  emb("Doc", "A doc from this workspace", "doc", "D"),
  emb("Whiteboard", "A whiteboard from this workspace", "board", "W"),
  emb("Form", "A form and how many answers it has", "form", "F"),
  emb("Google Doc", "A Google Doc by link", "gdoc", "G"),
  emb("Google Sheet", "A Google Sheet by link", "gsheet", "G"),
  emb("Google Slides", "Google Slides by link", "gslides", "G"),
  emb("YouTube", "A video by link", "youtube", "▶"),
  emb("Calendar", "This week's tasks on a calendar", "calendar", "▦"),
];

const T = {
  pie: (c: string) => (
    <svg viewBox="0 0 100 60"><circle cx="50" cy="30" r="22" fill={c} opacity="0.3" /><path d="M50 30 L50 8 A22 22 0 0 1 72 30 Z" fill={c} /><path d="M50 30 L72 30 A22 22 0 0 1 40 50 Z" fill={c} opacity="0.65" /></svg>
  ),
  donut: (c: string) => (
    <svg viewBox="0 0 100 60"><circle cx="50" cy="30" r="20" fill="none" stroke={c} strokeOpacity="0.3" strokeWidth="10" /><circle cx="50" cy="30" r="20" fill="none" stroke={c} strokeWidth="10" strokeDasharray="50 126" transform="rotate(-90 50 30)" /><circle cx="50" cy="30" r="20" fill="none" stroke={c} strokeOpacity="0.65" strokeWidth="10" strokeDasharray="30 126" strokeDashoffset="-50" transform="rotate(-90 50 30)" /></svg>
  ),
  bar: (c: string) => (
    <svg viewBox="0 0 100 60"><rect x="12" y="26" width="14" height="28" rx="2" fill={c} /><rect x="33" y="12" width="14" height="42" rx="2" fill={c} /><rect x="54" y="20" width="14" height="34" rx="2" fill={c} /><rect x="75" y="34" width="14" height="20" rx="2" fill={c} opacity="0.5" /></svg>
  ),
  battery: (c: string) => (
    <svg viewBox="0 0 100 60"><rect x="8" y="20" width="44" height="20" rx="3" fill={c} /><rect x="52" y="20" width="26" height="20" fill={c} opacity="0.65" /><rect x="78" y="20" width="14" height="20" rx="3" fill={c} opacity="0.3" /></svg>
  ),
  line: (c: string) => (
    <svg viewBox="0 0 100 60"><path d="M6 44 L24 30 L42 36 L60 18 L78 24 L94 12" fill="none" stroke={c} strokeWidth="2.5" /><path d="M6 50 L24 46 L42 48 L60 40 L78 42 L94 36" fill="none" stroke={c} strokeWidth="2" strokeDasharray="4 3" opacity="0.6" /></svg>
  ),
};

function Thumb({ t }: { t: Template }) {
  const c = t.color ?? CATEGORIES.find((x) => x.key === t.cat)?.color ?? "#1b6b4a";
  if (t.thumb === "pie" || t.thumb === "donut" || t.thumb === "bar" || t.thumb === "battery" || t.thumb === "line") return T[t.thumb](c);
  if (t.thumb === "number") return (
    <div className="gp-lbnum"><b style={{ color: c }}>{t.label ?? "1,380"}</b><span>{t.title}</span></div>
  );
  if (t.thumb === "ai") return (
    <div className="gp-lbtab"><span style={{ background: "#7c3aed" }}>✦ Nora</span><i /><i style={{ width: "85%" }} /><i style={{ width: "55%" }} /></div>
  );
  if (t.thumb === "embed") return <div className="gp-lbemb">{t.label}</div>;
  return (
    <div className="gp-lbtab"><span style={{ background: c }}>{t.label ?? t.title}</span><i /><i style={{ width: "60%" }} /><i style={{ width: "75%" }} /></div>
  );
}

export function CardLibrary({ onPick, onClose }: { onPick: (t: Template) => void; onClose: () => void }) {
  const [cat, setCat] = React.useState("featured");
  const [q, setQ] = React.useState("");
  const words = q.trim().toLowerCase();
  const shown = words ? LIBRARY.filter((t) => `${t.title} ${t.blurb} ${t.cat}`.toLowerCase().includes(words)) : LIBRARY;
  const cats = words ? CATEGORIES.filter((c) => shown.some((t) => t.cat === c.key)) : CATEGORIES;
  const refs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const jump = (k: string) => {
    setCat(k);
    refs.current[k]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label="Add a card" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox gp-lib">
        <div className="gp-libhead">
          <b style={{ fontSize: 17 }}>Add a card</b>
          <input className="ld-in xs" style={{ width: 260, marginLeft: "auto" }} autoFocus placeholder="Search cards" aria-label="Search cards" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="ld-btn sm gp-auto" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="gp-libbody">
          <div className="gp-libnav">
            {cats.map((c) => (
              <button key={c.key} type="button" className={`gp-libcat ${cat === c.key ? "on" : ""}`} onClick={() => jump(c.key)}>
                <i style={{ background: c.color }} />
                {c.label}
              </button>
            ))}
          </div>
          <div className="gp-libsecs">
            {cats.map((c) => (
              <div key={c.key} ref={(el) => { refs.current[c.key] = el; }} className="gp-libsec">
                <h4>{c.label}</h4>
                <div className="gp-libgrid">
                  {shown.filter((t) => t.cat === c.key).map((t) => (
                    <button key={t.key} type="button" className="gp-libcard" onClick={() => onPick(t)}>
                      <span className="gp-libthumb" style={{ background: t.color ?? c.color }}>
                        <span className="gp-libscr"><Thumb t={t} /></span>
                      </span>
                      <b>{t.title}</b>
                      <span>{t.blurb}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!shown.length && <div className="gp-empty">No card matches that.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// Chart drawings the cards use
// ==========================================

export type Series = { label: string; value: number; color: string };

export function PieChart({ series, donut, unit }: { series: Series[]; donut?: boolean; unit?: string }) {
  const total = series.reduce((s, x) => s + x.value, 0);
  if (!total) return <span className="ld-small ld-muted">Nothing yet.</span>;
  let a = -Math.PI / 2;
  const R = 46;
  const arcs = series.map((s) => {
    const frac = s.value / total;
    const a0 = a;
    a += frac * Math.PI * 2;
    const x0 = 50 + R * Math.cos(a0);
    const y0 = 50 + R * Math.sin(a0);
    const x1 = 50 + R * Math.cos(a);
    const y1 = 50 + R * Math.sin(a);
    const big = frac > 0.5 ? 1 : 0;
    const d = frac >= 0.999 ? `M50 ${50 - R} A${R} ${R} 0 1 1 49.99 ${50 - R} Z` : `M50 50 L${x0} ${y0} A${R} ${R} 0 ${big} 1 ${x1} ${y1} Z`;
    return { ...s, d, frac };
  });
  return (
    <div className="gp-piewrap">
      <svg viewBox="0 0 100 100" className="gp-pie" role="img" aria-label="Chart">
        {arcs.map((x) => (
          <path key={x.label} d={x.d} fill={x.color} stroke="var(--ld-surface)" strokeWidth="1" />
        ))}
        {donut && <circle cx="50" cy="50" r="27" fill="var(--ld-surface)" />}
        {donut && <text x="50" y="54" textAnchor="middle" fontSize="13" fontWeight="800" fill="var(--ld-ink)">{total}</text>}
      </svg>
      <div className="gp-legend">
        {arcs.map((x) => (
          <span key={x.label}><i style={{ background: x.color }} />{x.label} <b>{Math.round(x.value * 100) / 100}</b> <em>{Math.round(x.frac * 100)}%</em></span>
        ))}
        {unit === "minutes" && <span className="ld-small ld-muted">In minutes</span>}
      </div>
    </div>
  );
}

export function Battery({ series }: { series: Series[] }) {
  const total = series.reduce((s, x) => s + x.value, 0);
  if (!total) return <span className="ld-small ld-muted">Nothing yet.</span>;
  return (
    <div className="gp-battwrap">
      <div className="gp-batt">
        {series.map((s) => (
          <span key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />
        ))}
      </div>
      <div className="gp-legend">
        {series.map((s) => (
          <span key={s.label}><i style={{ background: s.color }} />{s.label} <b>{s.value}</b></span>
        ))}
      </div>
    </div>
  );
}

export function BarChart({ series }: { series: Series[] }) {
  const top = Math.max(1, ...series.map((b) => b.value));
  if (!series.length) return <span className="ld-small ld-muted">Nothing yet.</span>;
  return (
    <div className="gp-hbs">
      {series.map((b) => (
        <div key={b.label} className="gp-hb">
          <span className="gp-ell">{b.label}</span>
          <span className="t"><i style={{ width: `${Math.max(2, (b.value / top) * 100)}%`, background: b.color }} /></span>
          <b>{b.value}</b>
        </div>
      ))}
    </div>
  );
}

export function LineChart({ weeks, lines }: { weeks: string[]; lines: { label: string; color: string; values: number[] }[] }) {
  const max = Math.max(1, ...lines.flatMap((s) => s.values));
  const n = weeks.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 580 + 10 : 300);
  const y = (v: number) => 130 - (v / max) * 110;
  const fmt = (w: string) => new Date(`${w}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (!lines.length) return <span className="ld-small ld-muted">Nothing in that time.</span>;
  return (
    <>
      <svg viewBox="0 0 600 150" className="gp-line" role="img" aria-label="Chart">
        <g stroke="var(--ld-line2)"><path d="M0 20H600M0 75H600M0 130H600" /></g>
        {lines.map((s) => (
          <path key={s.label} d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)} ${y(v)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2.5} />
        ))}
        <text x="4" y="146" fontSize="11" fill="var(--ld-muted)">{fmt(weeks[0])}</text>
        <text x="596" y="146" fontSize="11" fill="var(--ld-muted)" textAnchor="end">{fmt(weeks[n - 1])}</text>
        <text x="4" y="16" fontSize="11" fill="var(--ld-muted)">{max}</text>
      </svg>
      <div className="gp-legend">
        {lines.map((s) => (
          <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
    </>
  );
}
