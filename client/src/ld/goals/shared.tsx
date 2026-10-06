import React from "react";
import { Avatar, PersonAvatar } from "../ui";
import { uploadFile } from "../meta";

/**
 * Pieces Goals and Projects share: owners (people and employees), status
 * pills, progress bars, dates with the year, money, the view tabs, and
 * attachments.
 */

export type Owner = { type: "user" | "employee" | "name"; id: number; name: string; avatarUrl?: string | null; kind?: string };
export type Status = "on" | "risk" | "off" | "done";

export const STATUS_TEXT: Record<Status, string> = { on: "On track", risk: "At risk", off: "Off track", done: "Done" };
export const COLORS = ["#1b6b4a", "#2563eb", "#7c3aed", "#d97706", "#c2253c", "#0f766e", "#9a4f2c", "#475569"];

export function StatusPill({ s }: { s: Status | null | undefined }) {
  if (!s) return <span className="gp-sd s-none">No number yet</span>;
  return <span className={`gp-sd s-${s}`}>{STATUS_TEXT[s]}</span>;
}

export function Bar({ p, color, red }: { p: number; color?: string; red?: boolean }) {
  return (
    <span className="gp-pb" aria-label={`${p}%`}>
      <span className="t">
        <i style={{ width: `${Math.max(0, Math.min(100, p))}%`, background: red ? "#e8384f" : color ?? "#1b6b4a" }} />
      </span>
      <span className="n">{p}%</span>
    </span>
  );
}

export function OwnerAvatar({ o, size = 24 }: { o: Owner | null | undefined; size?: number }) {
  if (!o) return <span className="gp-noone" style={{ width: size, height: size }} aria-label="No owner" />;
  if (o.type === "employee") return <Avatar name={o.name} kind={o.kind} src={o.avatarUrl} size={size} />;
  return <PersonAvatar name={o.name} src={o.avatarUrl} size={size} />;
}

export function OwnerName({ o, size = 24 }: { o: Owner | null | undefined; size?: number }) {
  return (
    <span className="gp-own">
      <OwnerAvatar o={o} size={size} />
      <span className="nm">{o?.name ?? "No owner"}</span>
    </span>
  );
}

export const ownerKey = (o: { type: string; id: number } | null | undefined) => (o ? `${o.type}:${o.id}` : "");

export function OwnerSelect({ people, value, onChange, none = "No owner", label }: { people: Owner[]; value: string; onChange: (key: string) => void; none?: string; label: string }) {
  const users = people.filter((p) => p.type === "user");
  const emps = people.filter((p) => p.type === "employee");
  return (
    <select className="ld-in xs" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {users.length > 0 && (
        <optgroup label="People">
          {users.map((p) => (
            <option key={ownerKey(p)} value={ownerKey(p)}>{p.name}</option>
          ))}
        </optgroup>
      )}
      {emps.length > 0 && (
        <optgroup label="Employees">
          {emps.map((p) => (
            <option key={ownerKey(p)} value={ownerKey(p)}>{p.name}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
export function parseOwnerKey(k: string): { type: "user" | "employee"; id: number } | null {
  const m = /^(user|employee):(\d+)$/.exec(k);
  return m ? { type: m[1] as "user" | "employee", id: Number(m[2]) } : null;
}

// ==========================================
// Dates and numbers
// ==========================================

export function fmtYmd(ymd: string | null | undefined) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
export function fmtAt(at: Date | string) {
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
export function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}
export function money(n: number) {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
export function short(n: number, kind?: string) {
  const abs = Math.abs(n);
  const v = abs >= 1_000_000 ? `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 2)}M` : abs >= 10_000 ? `${Math.round(n / 1000)}k` : abs >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n * 10) / 10}`;
  return kind === "currency" ? `$${v}` : v;
}
export function valueText(v: number | null | undefined, unit: string) {
  if (v === null || v === undefined) return "";
  if (unit === "currency") return money(v);
  if (unit === "percent") return `${Math.round(v * 10) / 10}%`;
  if (unit === "hours") return `${Math.round(v * 10) / 10} ${v === 1 ? "hour" : "hours"}`;
  return (Math.round(v * 10) / 10).toLocaleString("en-US");
}

// ==========================================
// Sparkline
// ==========================================

export function Spark({ values, goal, w = 120, h = 30, color = "#1b6b4a" }: { values: (number | null)[]; goal: number | null; w?: number; h?: number; color?: string }) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2) return <span className="ld-small ld-muted">Not enough weeks</span>;
  const all = [...pts.map((p) => p.v), ...(goal !== null ? [goal] : [])];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const sp = hi - lo || 1;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 3 - ((v - lo) / sp) * (h - 6);
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {goal !== null && <line x1="0" x2={w} y1={y(goal)} y2={y(goal)} stroke="#9aa8a2" strokeDasharray="3 3" />}
      <polyline points={pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} fill="none" stroke={color} strokeWidth="2" />
      <circle cx={x(last.i)} cy={y(last.v)} r="3" fill={color} />
    </svg>
  );
}
export const STATUS_COLOR: Record<string, string> = { on: "#1e8a5a", risk: "#c98a1b", off: "#c2253c", done: "#4b5563" };

// ==========================================
// View tabs (List, Cards, Dashboard...)
// ==========================================

const I = (d: React.ReactNode) => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    {d}
  </svg>
);
export const VIEW_ICONS: Record<string, React.ReactNode> = {
  list: I(<path d="M5 4h9M5 8h9M5 12h9M2 4h.5M2 8h.5M2 12h.5" />),
  cards: I(<><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>),
  board: I(<><rect x="2" y="2" width="3.5" height="12" rx="1" /><rect x="6.3" y="2" width="3.5" height="8" rx="1" /><rect x="10.6" y="2" width="3.5" height="10" rx="1" /></>),
  dashboard: I(<path d="M2 14V8M6 14V4M10 14V9M14 14V2" />),
  gantt: I(<path d="M2 3h7M5 7h8M3 11h6M2 14h12" />),
  map: I(<><circle cx="3" cy="8" r="1.8" /><circle cx="13" cy="3.5" r="1.8" /><circle cx="13" cy="12.5" r="1.8" /><path d="M4.6 7.3 11.4 4.2M4.6 8.7l6.8 3.1" /></>),
  scorecard: I(<><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M2 6h12M6 6v8" /></>),
  table: I(<><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M2 6h12M2 10h12M6 2v12" /></>),
  people: I(<><circle cx="6" cy="6" r="2.5" /><path d="M1.5 14c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4M11 3.5a2.3 2.3 0 0 1 0 4.5M12.5 10c1.2.6 1.9 2 2 4" /></>),
  today: I(<><rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 7h12M5 1.5v3M11 1.5v3" /></>),
  calendar: I(<><rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 7h12M5 1.5v3M11 1.5v3" /></>),
  workload: I(<><circle cx="6" cy="6" r="2.5" /><path d="M1.5 14c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4M11 3.5a2.3 2.3 0 0 1 0 4.5M12.5 10c1.2.6 1.9 2 2 4" /></>),
  timeline: I(<path d="M2 14V8M6 14V4M10 14V9M14 14V2" />),
  mindmap: I(<><circle cx="3" cy="8" r="1.8" /><circle cx="13" cy="3.5" r="1.8" /><circle cx="13" cy="12.5" r="1.8" /><path d="M4.6 7.3 11.4 4.2M4.6 8.7l6.8 3.1" /></>),
};

export function ViewTabs<T extends string>({ views, value, onChange }: { views: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="gp-views" role="tablist" aria-label="Views">
      {views.map((v) => (
        <button key={v.key} type="button" role="tab" aria-selected={value === v.key} className={`gp-vw ${value === v.key ? "on" : ""}`} onClick={() => onChange(v.key)}>
          {VIEW_ICONS[v.key]}
          {v.label}
        </button>
      ))}
    </div>
  );
}

// ==========================================
// Attachments
// ==========================================

export type FileRow = { linkId?: number; id: number; name: string; url: string; kind: string; size?: number };

const EXT_COLOR: Record<string, string> = { PDF: "#c2253c", DOC: "#2563eb", DOCX: "#2563eb", XLS: "#0f766e", XLSX: "#0f766e", CSV: "#0f766e", PPT: "#d97706", PPTX: "#d97706", HTML: "#0f766e", TXT: "#475569" };
export const extOf = (name: string) => (name.split(".").pop() || "FILE").toUpperCase().slice(0, 4);

/** File tiles. With `onOpen`, clicking a tile previews the file in the app; otherwise it opens in a new tab. */
export function FileTiles({ files, onRemove, cols = 4, onOpen }: { files: FileRow[]; onRemove?: (f: FileRow) => void; cols?: number; onOpen?: (f: FileRow) => void }) {
  if (!files.length) return null;
  return (
    <div className="gp-att" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {files.map((f) => (
        <div key={`${f.linkId ?? f.id}`} className="gp-af">
          {onOpen ? (
            <button type="button" className="p" style={f.kind === "image" ? undefined : { background: EXT_COLOR[extOf(f.name)] ?? "#475569" }} onClick={() => onOpen(f)} aria-label={`Preview ${f.name}`}>
              {f.kind === "image" ? <img src={f.url} alt="" /> : extOf(f.name)}
            </button>
          ) : (
            <a href={f.url} target="_blank" rel="noreferrer" className="p" style={f.kind === "image" ? undefined : { background: EXT_COLOR[extOf(f.name)] ?? "#475569" }}>
              {f.kind === "image" ? <img src={f.url} alt="" /> : extOf(f.name)}
            </a>
          )}
          <span className="nm" title={f.name}>{f.name}</span>
          {onRemove && f.linkId && (
            <button type="button" className="gp-x" aria-label={`Remove ${f.name}`} onClick={() => onRemove(f)}>
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** "+ Add" that uploads files and hands back their ids. */
export function AddFiles({ orgId, onAdded, label = "+ Add", disabled }: { orgId: number; onAdded: (ids: number[]) => void; label?: string; disabled?: boolean }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setErr(null);
    const ids: number[] = [];
    for (const f of Array.from(list).slice(0, 10)) {
      if (f.size > 20_000_000) {
        setErr("Files must be under 20 MB.");
        continue;
      }
      try {
        const r = await uploadFile("work", f, { organizationId: orgId, employeeId: 0 });
        ids.push(r.id);
      } catch (e) {
        setErr((e as Error).message);
      }
    }
    setBusy(false);
    if (ids.length) onAdded(ids);
  };
  return (
    <span className="gp-addf">
      <input ref={input} type="file" multiple style={{ display: "none" }} onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
      <button type="button" className="gp-link" disabled={busy || disabled} onClick={() => input.current?.click()}>
        {busy ? "Uploading" : label}
      </button>
      {err && <span className="ld-small" role="alert" style={{ color: "#b42318" }}>{err}</span>}
    </span>
  );
}

/** A small menu that opens from a "···" button. */
export function Menu({ label, children, align = "right", button, buttonClass }: { label: string; children: (close: () => void) => React.ReactNode; align?: "left" | "right"; button?: string; buttonClass?: string }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" className={buttonClass ?? (button ? "ld-btn p gp-auto" : "gp-dots")} aria-label={button && button.length > 2 ? undefined : label} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {button ?? "···"}
      </button>
      {open && (
        <span className="gp-menu" style={align === "right" ? { right: 0 } : { left: 0 }} role="menu">
          {children(() => setOpen(false))}
        </span>
      )}
    </span>
  );
}
