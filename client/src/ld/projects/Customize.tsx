import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { Pop } from "./Quick";
import { BUILTIN, columnLabel, type ColKey } from "./Columns";
import type { FieldDef } from "./fields";
import type { PjCtx } from "../pages/Projects";
import type { SavedView, ViewKind, ViewSettings, ViewsOut } from "./Views";

/**
 * Customize view: the panel on the right of a List, Board, Calendar or Gantt,
 * the way ClickUp's works. View options (empty statuses, wrap, locations,
 * parent names, closed tasks, estimate totals), then Fields, Filter, Group,
 * Sort, Subtasks and Templates, then Autosave for me, Pin, Private, Protect
 * and Set as default, then Copy link, Favorite, Export and Sharing.
 */

export type GroupKey = string;
export const GROUP_CHOICES: { key: GroupKey; label: string; icon: string; many?: boolean }[] = [
  { key: "status", label: "Status", icon: "◎" },
  { key: "assignee", label: "Assignee", icon: "◯" },
  { key: "priority", label: "Priority", icon: "⚑" },
  { key: "tags", label: "Tags", icon: "#" },
  { key: "due", label: "Due date", icon: "▭" },
  { key: "project", label: "Project", icon: "▤", many: true },
  { key: "none", label: "None", icon: "—" },
];
export const SORT_CHOICES: { key: PjCtx["sort"]; label: string }[] = [
  { key: "manual", label: "Manual" },
  { key: "due", label: "Due date" },
  { key: "priority", label: "Priority" },
  { key: "name", label: "Name" },
];
const SUBTASK_CHOICES: { key: NonNullable<ViewSettings["subtasks"]>; label: string; blurb: string }[] = [
  { key: "collapsed", label: "Collapsed", blurb: "Only the parent shows, with a count" },
  { key: "expanded", label: "Expanded", blurb: "Subtasks show under their parent" },
  { key: "separate", label: "As separate tasks", blurb: "Subtasks are rows of their own" },
];

export function groupLabel(key: GroupKey, fields: FieldDef[]) {
  if (key.startsWith("f:")) return fields.find((f) => `f:${f.id}` === key)?.name ?? "Field";
  return GROUP_CHOICES.find((g) => g.key === key)?.label ?? "Status";
}

/** The fields a list can be grouped by: dropdowns, labels, checkboxes and people. */
const groupable = (fields: FieldDef[]) => fields.filter((f) => ["dropdown", "labels", "checkbox", "people", "rating"].includes(f.type));

/** Group by: the choices, plus Ascending / Descending and a clear button. Used in the toolbar popover and in the panel. */
export function GroupChoices({ c, group, dir, onGroup, onDir, many }: { c: PjCtx; group: GroupKey; dir: "asc" | "desc"; onGroup: (g: GroupKey) => void; onDir: (d: "asc" | "desc") => void; many: boolean }) {
  const fields = groupable(c.data.fields);
  return (
    <>
      <span className="gp-qh">Group by</span>
      <div className="ld-row gp-gdir">
        <span className="gp-fb sel gp-ell">{GROUP_CHOICES.find((g) => g.key === group)?.icon ?? "◆"} {groupLabel(group, c.data.fields)}</span>
        <select className="gp-fb" aria-label="Direction" value={dir} onChange={(e) => onDir(e.target.value as "asc" | "desc")}>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
        <button type="button" className="gp-fb" aria-label="Clear grouping" title="Clear grouping" onClick={() => onGroup("none")}>🗑</button>
      </div>
      {GROUP_CHOICES.filter((g) => !g.many || many).map((g) => (
        <button key={g.key} type="button" className={`gp-qi ${group === g.key ? "on" : ""}`} onClick={() => onGroup(g.key)}>
          <span className="ld-muted" style={{ width: 16, textAlign: "center" }}>{g.icon}</span>
          {g.label}
          {group === g.key && <span className="tick">✓</span>}
        </button>
      ))}
      {fields.length > 0 && <span className="gp-qh">Custom fields</span>}
      {fields.map((f) => (
        <button key={f.id} type="button" className={`gp-qi ${group === `f:${f.id}` ? "on" : ""}`} onClick={() => onGroup(`f:${f.id}`)}>
          <span className="ld-muted" style={{ width: 16, textAlign: "center" }}>◆</span>
          {f.name}
          {group === `f:${f.id}` && <span className="tick">✓</span>}
        </button>
      ))}
    </>
  );
}

export function GroupPop(props: { c: PjCtx; group: GroupKey; dir: "asc" | "desc"; onGroup: (g: GroupKey) => void; onDir: (d: "asc" | "desc") => void; many: boolean; onClose: () => void }) {
  return (
    <Pop onClose={props.onClose} width={300}>
      <GroupChoices {...props} />
    </Pop>
  );
}

export function SortChoices({ sort, dir, onSort, onDir }: { sort: PjCtx["sort"]; dir: "asc" | "desc"; onSort: (s: PjCtx["sort"]) => void; onDir: (d: "asc" | "desc") => void }) {
  return (
    <>
      <span className="gp-qh">Sort by</span>
      <div className="ld-row gp-gdir">
        <span className="gp-fb sel gp-ell">⇅ {SORT_CHOICES.find((s) => s.key === sort)?.label}</span>
        <select className="gp-fb" aria-label="Sort direction" value={dir} disabled={sort === "manual"} onChange={(e) => onDir(e.target.value as "asc" | "desc")}>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>
      {SORT_CHOICES.map((s) => (
        <button key={s.key} type="button" className={`gp-qi ${sort === s.key ? "on" : ""}`} onClick={() => onSort(s.key)}>
          {s.label}
          {sort === s.key && <span className="tick">✓</span>}
        </button>
      ))}
      {sort === "manual" && <span className="ld-small ld-muted" style={{ padding: "4px 8px" }}>Manual: drag rows to put them in order.</span>}
    </>
  );
}

export function SortPop(props: { sort: PjCtx["sort"]; dir: "asc" | "desc"; onSort: (s: PjCtx["sort"]) => void; onDir: (d: "asc" | "desc") => void; onClose: () => void }) {
  return (
    <Pop onClose={props.onClose} width={260}>
      <SortChoices {...props} />
    </Pop>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`gp-switch ${on ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

type Sub = "" | "fields" | "filter" | "group" | "sort" | "subtasks" | "templates";

export type Flags = { protected: boolean; isDefault: boolean; pinned: boolean; private: boolean; starred: boolean; autosave: boolean };

export function Customize({
  c, view, saved, views, listName, settings, patch, flags, onFlag, onAutosave, onStar, onCopyLink, onExport, onShare, onTemplates, onSaveTemplate, onSaveAs, onSaveNow, canChange, canShare, isList, onClose, busy, error,
}: {
  c: PjCtx;
  view: ViewKind;
  saved: SavedView | null;
  views: ViewsOut | undefined;
  listName: string;
  settings: ViewSettings;
  patch: (p: Partial<ViewSettings>) => void;
  flags: Flags;
  onFlag: (p: Partial<Pick<Flags, "protected" | "isDefault" | "pinned" | "private">>) => void;
  onAutosave: (on: boolean) => void;
  onStar: (on: boolean) => void;
  onCopyLink: () => void;
  onExport: (format: "csv" | "xlsx") => void;
  onShare: () => void;
  onTemplates: () => void;
  onSaveTemplate: () => void;
  onSaveAs: () => void;
  onSaveNow: () => void;
  canChange: boolean;
  canShare: boolean;
  isList: boolean;
  onClose: () => void;
  busy?: boolean;
  error?: { message: string } | null;
}) {
  const [sub, setSub] = React.useState<Sub>("");
  const [copied, setCopied] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const fields = c.data.fields;
  const many = !c.listId;
  const kindName = { list: "List", board: "Board", calendar: "Calendar", gantt: "Gantt", table: "Table", workload: "Workload", timeline: "Timeline", mindmap: "Mind map" }[view];
  const columns = c.columns;
  const toggleCol = (k: ColKey) => c.setColumns(columns.includes(k) ? columns.filter((x) => x !== k) : [...columns, k]);
  const assignees = Array.from(new Map(c.data.tasks.flatMap((t) => t.assignees).map((a) => [`${a.type}:${a.id}:${a.name}`, a])).values());
  const row = (icon: string, label: string, value: React.ReactNode, onClick?: () => void, right?: React.ReactNode) =>
    onClick ? (
      <button type="button" className="gp-crow" onClick={onClick}>
        <span className="gp-cic" aria-hidden="true">{icon}</span>
        <span className="gp-cl">{label}</span>
        <span className="gp-cv">{value} ›</span>
      </button>
    ) : (
      <div className="gp-crow">
        <span className="gp-cic" aria-hidden="true">{icon}</span>
        <span className="gp-cl">{label}</span>
        {right}
      </div>
    );
  const toggle = (label: string, key: "showEmpty" | "wrap" | "locations" | "parentNames" | "closed" | "estimates") => (
    <div className="gp-crow">
      <span className="gp-cl">{label}</span>
      <Switch on={!!settings[key]} label={label} onChange={(v) => patch({ [key]: v })} />
    </div>
  );
  const lock = flags.protected && !views?.canProtect && !(saved?.private && saved.mine);
  const head = (title: string) => (
    <div className="gp-chead">
      {sub ? (
        <button type="button" className="gp-cback" onClick={() => setSub("")} aria-label="Back">‹ {title}</button>
      ) : (
        <b style={{ fontSize: 16 }}>{title}</b>
      )}
      <button type="button" className="ld-btn sm gp-auto" onClick={onClose} aria-label="Close">✕</button>
    </div>
  );
  return (
    <aside className="gp-cpanel" aria-label="Customize view">
      {sub === "" && (
        <>
          {head("Customize view")}
          <div className="gp-cname">
            <span className="gp-cbox" aria-hidden="true">{{ list: "☰", board: "▦", calendar: "▭", gantt: "▬", table: "▤", workload: "▥", timeline: "▭", mindmap: "⟡" }[view]}</span>
            <span className="gp-cin gp-ell">{saved ? saved.name : kindName}</span>
            {saved && saved.mine && <button type="button" className="ld-btn sm gp-auto" onClick={onSaveAs}>Rename</button>}
          </div>
          {lock && <div className="gp-cnote">This view is protected. An owner or admin can change it; your changes stay on your screen only.</div>}
          {toggle("Show empty statuses", "showEmpty")}
          {toggle("Wrap text", "wrap")}
          {toggle("Show task locations", "locations")}
          {toggle("Show subtask parent names", "parentNames")}
          {toggle("Show closed tasks", "closed")}
          {toggle("Show time estimates total per group", "estimates")}
          <div className="gp-csep" />
          {row("✎", "Fields", `${columns.length} shown`, () => setSub("fields"))}
          {row("≡", "Filter", [settings.who ? "Assignee" : "", settings.priority ? "Priority" : "", settings.q ? "Search" : ""].filter(Boolean).join(", ") || "None", () => setSub("filter"))}
          {row("◫", "Group", `${groupLabel(settings.group ?? "status", fields)}, ${settings.dir === "desc" ? "descending" : "ascending"}`, () => setSub("group"))}
          {row("⇅", "Sort", `${SORT_CHOICES.find((s) => s.key === (settings.sort ?? "manual"))?.label ?? "Manual"}${settings.sort && settings.sort !== "manual" && settings.sortDir === "desc" ? ", descending" : ""}`, () => setSub("sort"))}
          {row("⤷", "Subtasks", SUBTASK_CHOICES.find((s) => s.key === (settings.subtasks ?? "collapsed"))?.label ?? "Collapsed", () => setSub("subtasks"))}
          {row("❏", "Templates", "", () => setSub("templates"))}
          <div className="gp-csep" />
          {row("💾", "Autosave for me", null, undefined, <Switch on={flags.autosave} label="Autosave for me" onChange={onAutosave} />)}
          {!flags.autosave && canChange && !lock && (
            <div className="gp-crow" style={{ paddingLeft: 32 }}>
              <span className="ld-small ld-muted">Save the filters, grouping and columns you have on now{saved ? ` to ${saved.name}` : " for everyone who opens this tab"}.</span>
              <button type="button" className="ld-btn sm gp-auto" disabled={busy} onClick={onSaveNow}>Save</button>
            </div>
          )}
          {row("📌", "Pin view", null, undefined, <Switch on={flags.pinned} label="Pin view" disabled={!saved || !saved.mine} onChange={(v) => onFlag({ pinned: v })} />)}
          {row("🔒", "Private view", null, undefined, <Switch on={flags.private} label="Private view" disabled={!saved || !saved.mine || (!canShare && flags.private)} onChange={(v) => onFlag({ private: v })} />)}
          {row("🛡", "Protect view", null, undefined, <Switch on={flags.protected} label="Protect view" disabled={!views?.canProtect} onChange={(v) => onFlag({ protected: v })} />)}
          {row("⌂", "Set as default view", null, undefined, <Switch on={flags.isDefault} label="Set as default view" disabled={!canChange} onChange={(v) => onFlag({ isDefault: v })} />)}
          {!saved && <span className="ld-small ld-muted" style={{ padding: "2px 0 6px 32px" }}>Pin and Private need a saved view. Save one with + View.</span>}
          <div className="gp-csep" />
          <button type="button" className="gp-crow" onClick={() => { onCopyLink(); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            <span className="gp-cic" aria-hidden="true">↗</span>
            <span className="gp-cl">{copied ? "Link copied" : "Copy link to view"}</span>
          </button>
          <button type="button" className="gp-crow" onClick={() => onStar(!flags.starred)}>
            <span className="gp-cic" aria-hidden="true" style={flags.starred ? { color: "#d97706" } : undefined}>★</span>
            <span className="gp-cl">{flags.starred ? "Favorited" : "Favorite"}</span>
            {flags.starred && <span className="ld-small ld-muted">In the sidebar</span>}
          </button>
          <div className="gp-crow" style={{ position: "relative" }}>
            <span className="gp-cic" aria-hidden="true">⇩</span>
            <span className="gp-cl">Export view</span>
            <button type="button" className="ld-btn sm gp-auto" disabled={busy} onClick={() => setExporting((v) => !v)} aria-expanded={exporting}>CSV, Excel ▾</button>
            {exporting && (
              <Pop onClose={() => setExporting(false)} width={200} align="right">
                <button type="button" className="gp-qi" onClick={() => { setExporting(false); onExport("csv"); }}>CSV</button>
                <button type="button" className="gp-qi" onClick={() => { setExporting(false); onExport("xlsx"); }}>Excel (.xlsx)</button>
                <span className="ld-small ld-muted" style={{ padding: "4px 8px" }}>The rows and columns on screen now.</span>
              </Pop>
            )}
          </div>
          <button type="button" className="gp-crow" onClick={onShare} disabled={!isList}>
            <span className="gp-cic" aria-hidden="true">👥</span>
            <span className="gp-cl">Sharing and permissions</span>
            {!isList && <span className="ld-small ld-muted">Per list</span>}
          </button>
          <ErrorLine error={error} />
        </>
      )}
      {sub === "fields" && (
        <>
          {head("Fields")}
          <span className="ld-small ld-muted" style={{ padding: "0 0 8px" }}>Tick the columns to show on {listName}.</span>
          {BUILTIN.filter((b) => !b.many || many).map((b) => (
            <label key={b.key} className="gp-crow gp-ccheck">
              <input type="checkbox" checked={columns.includes(b.key)} onChange={() => toggleCol(b.key)} />
              <span className="gp-cl">{b.label}</span>
            </label>
          ))}
          {fields.length > 0 && <span className="gp-qh" style={{ paddingLeft: 0 }}>Custom fields</span>}
          {fields.map((f) => (
            <label key={f.id} className="gp-crow gp-ccheck">
              <input type="checkbox" checked={columns.includes(`f:${f.id}`)} onChange={() => toggleCol(`f:${f.id}`)} />
              <span className="gp-cl">{columnLabel(`f:${f.id}`, fields)}</span>
              {f.scope === "folder" && <span className="ld-small ld-muted">Folder</span>}
            </label>
          ))}
        </>
      )}
      {sub === "filter" && (
        <>
          {head("Filter")}
          <label className="gp-cfield">
            <span>Assignee</span>
            <select className="ld-in xs" value={settings.who ?? ""} onChange={(e) => patch({ who: e.target.value || undefined })}>
              <option value="">Anyone</option>
              <option value="me">Me</option>
              {assignees.map((a) => (
                <option key={`${a.type}:${a.id}:${a.name}`} value={`${a.type}:${a.id}:${a.name}`}>{a.name}</option>
              ))}
            </select>
          </label>
          <label className="gp-cfield">
            <span>Priority</span>
            <select className="ld-in xs" value={settings.priority ?? ""} onChange={(e) => patch({ priority: e.target.value || undefined })}>
              <option value="">Any priority</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
              <option value="none">No priority</option>
            </select>
          </label>
          <label className="gp-cfield">
            <span>Name contains</span>
            <input className="ld-in xs" value={settings.q ?? ""} placeholder="Any word in the task name" onChange={(e) => patch({ q: e.target.value || undefined })} />
          </label>
          <div className="gp-crow">
            <span className="gp-cl">Show closed tasks</span>
            <Switch on={!!settings.closed} label="Show closed tasks" onChange={(v) => patch({ closed: v })} />
          </div>
          <span className="ld-row" style={{ justifyContent: "flex-end", paddingTop: 8 }}>
            <button type="button" className="ld-btn sm gp-auto" onClick={() => patch({ who: undefined, priority: undefined, q: undefined, closed: undefined })}>Clear filters</button>
          </span>
        </>
      )}
      {sub === "group" && (
        <>
          {head("Group")}
          <GroupChoices c={c} group={settings.group ?? "status"} dir={settings.dir ?? "asc"} many={many} onGroup={(g) => patch({ group: g })} onDir={(d) => patch({ dir: d })} />
        </>
      )}
      {sub === "sort" && (
        <>
          {head("Sort")}
          <SortChoices sort={(settings.sort as PjCtx["sort"]) ?? "manual"} dir={settings.sortDir ?? "asc"} onSort={(s) => patch({ sort: s })} onDir={(d) => patch({ sortDir: d })} />
        </>
      )}
      {sub === "subtasks" && (
        <>
          {head("Subtasks")}
          {SUBTASK_CHOICES.map((s) => (
            <button key={s.key} type="button" className={`gp-qi ${(settings.subtasks ?? "collapsed") === s.key ? "on" : ""}`} style={{ alignItems: "flex-start", flexDirection: "column", gap: 2 }} onClick={() => patch({ subtasks: s.key })}>
              <span>{s.label}{(settings.subtasks ?? "collapsed") === s.key ? " ✓" : ""}</span>
              <span className="ld-small ld-muted" style={{ fontWeight: 500 }}>{s.blurb}</span>
            </button>
          ))}
        </>
      )}
      {sub === "templates" && (
        <>
          {head("Templates")}
          {isList && (
            <button type="button" className="gp-crow" onClick={onSaveTemplate}>
              <span className="gp-cic" aria-hidden="true">❏</span>
              <span className="gp-cl">Save {listName} as a template</span>
            </button>
          )}
          <button type="button" className="gp-crow" onClick={onTemplates}>
            <span className="gp-cic" aria-hidden="true">▤</span>
            <span className="gp-cl">Browse templates</span>
          </button>
          <span className="ld-small ld-muted" style={{ padding: "6px 0" }}>A template keeps the statuses, fields, views and tasks of a list so the next one starts the same way.</span>
        </>
      )}
    </aside>
  );
}

/** Builds the CSV or Excel rows the Export view option sends: the columns on screen for the tasks on screen. */
export function exportRows(c: PjCtx, cols: ColKey[], tasks: PjCtx["tasks"]) {
  const fields = c.data.fields;
  const headers = ["Task", ...cols.map((k) => columnLabel(k, fields)), "List"];
  const cell = (t: PjCtx["tasks"][number], k: ColKey): string => {
    if (k === "assignee") return t.assignees.map((a) => a.name).join(", ");
    if (k === "due") return t.dueDate ?? "";
    if (k === "start") return t.startDate ?? "";
    if (k === "priority") return t.priority ?? "";
    if (k === "status") return t.status;
    if (k === "estimate") return t.timeEstimate ? String(Math.round((t.timeEstimate / 60) * 100) / 100) : "";
    if (k === "tracked") return t.minutes ? String(Math.round((t.minutes / 60) * 100) / 100) : "";
    if (k === "tags") return t.tags.join(", ");
    if (k === "goal") return t.goal ?? "";
    if (k === "list") return t.listName;
    if (k.startsWith("f:")) {
      const v = t.fields[k.slice(2)];
      if (v === undefined || v === null) return "";
      if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x && "name" in x ? String((x as { name: string }).name) : String(x))).join(", ");
      if (typeof v === "object") return "name" in v ? String((v as { name: string }).name) : JSON.stringify(v);
      return String(v);
    }
    return "";
  };
  return { headers, rows: tasks.map((t) => [t.name, ...cols.map((k) => cell(t, k)), t.listName]) };
}

/** Downloads the export the server built. */
export function useExport(orgId: number) {
  const m = trpc.pj.exportView.useMutation({
    onSuccess: (out, input) => {
      const bytes = Uint8Array.from(atob(out.base64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: out.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${input.name.replace(/[^\w\- ]+/g, "").trim() || "tasks"}.${out.ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  });
  return { run: (name: string, format: "csv" | "xlsx", headers: string[], rows: string[][]) => m.mutate({ organizationId: orgId, name, format, headers, rows }), busy: m.isPending, error: m.error };
}
