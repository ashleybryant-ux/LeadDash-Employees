import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { Menu, VIEW_ICONS } from "../goals/shared";
import { Pop } from "./Quick";
import type { Outputs } from "../types";

/**
 * The view tabs on a list or a folder: the built-in kinds, then saved views
 * (pinned first), then "+ View" which adds a view of any kind, or a doc,
 * whiteboard, form or dashboard that lives with this list.
 */

export type ViewKind = "list" | "board" | "calendar" | "gantt" | "table" | "workload" | "timeline" | "mindmap";
export type ViewsOut = Outputs["pj"]["views"];
export type SavedView = ViewsOut["saved"][number];
export type ViewSettings = SavedView["settings"];
export type Current = { kind: ViewKind; savedId: number | null };

export const KINDS: { key: ViewKind; label: string; blurb: string; color: string }[] = [
  { key: "list", label: "List", blurb: "Tasks grouped by status, person or priority", color: "#1b6b4a" },
  { key: "board", label: "Board", blurb: "Cards in columns you drag", color: "#2563eb" },
  { key: "calendar", label: "Calendar", blurb: "Tasks by due date", color: "#b45309" },
  { key: "gantt", label: "Gantt", blurb: "Bars, dependencies and the critical path", color: "#c2253c" },
  { key: "table", label: "Table", blurb: "A spreadsheet of every field", color: "#0f766e" },
  { key: "timeline", label: "Timeline", blurb: "One row per person", color: "#d97706" },
  { key: "workload", label: "Workload", blurb: "Hours per person per week", color: "#0f766e" },
  { key: "mindmap", label: "Mind map", blurb: "Tasks and subtasks as a tree", color: "#7c3aed" },
];
type ItemKey = "doc" | "whiteboard" | "form" | "dash";
const ITEMS: { key: ItemKey; label: string; blurb: string; color: string }[] = [
  { key: "doc", label: "Doc", blurb: "Write next to the tasks", color: "#2563eb" },
  { key: "whiteboard", label: "Whiteboard", blurb: "Sticky notes that become tasks", color: "#d97706" },
  { key: "form", label: "Form", blurb: "A public page that makes tasks", color: "#7c3aed" },
  { key: "dash", label: "Dashboard", blurb: "Cards and charts", color: "#1b6b4a" },
];

export function ViewTabsPlus({ kinds, current, saved, onPick, onAdd, onRename, onRemove, extra, canAdd }: { kinds: ViewKind[]; current: Current | null; saved: SavedView[]; onPick: (c: Current) => void; onAdd: () => void; onRename: (v: SavedView) => void; onRemove: (v: SavedView) => void; extra?: React.ReactNode; canAdd: boolean }) {
  return (
    <div className="gp-views" role="tablist" aria-label="Views">
      {extra}
      {kinds.map((k) => (
        <button key={k} type="button" role="tab" aria-selected={!!current && current.kind === k && !current.savedId} className={`gp-vw ${current && current.kind === k && !current.savedId ? "on" : ""}`} onClick={() => onPick({ kind: k, savedId: null })}>
          {VIEW_ICONS[k]}
          {KINDS.find((x) => x.key === k)?.label}
        </button>
      ))}
      {saved.map((v) => (
        <span key={v.id} className={`gp-vw gp-vsaved ${current?.savedId === v.id ? "on" : ""}`} role="tab" aria-selected={current?.savedId === v.id}>
          <button type="button" className="gp-vwbtn" onClick={() => onPick({ kind: v.kind, savedId: v.id })}>
            {v.pinned ? "📌 " : v.private ? "🔒 " : ""}
            {v.name}
          </button>
          {v.mine && (
            <Menu label={`Options for the ${v.name} view`}>
              {(close) => (
                <>
                  <button type="button" role="menuitem" onClick={() => { onRename(v); close(); }}>Rename or change</button>
                  <button type="button" role="menuitem" className="danger" onClick={() => { onRemove(v); close(); }}>Delete view</button>
                </>
              )}
            </Menu>
          )}
        </span>
      ))}
      {canAdd && (
        <button type="button" className="gp-vw gp-vadd" onClick={onAdd}>+ View</button>
      )}
    </div>
  );
}

/** "Add a view": pick a kind, name it, private or pinned. Also makes a doc, whiteboard, form or dashboard here. */
export function AddView({ orgId, listId, folderId, listName, settings, editing, canShare, onClose, onMade, onItem }: { orgId: number; listId: number | null; folderId: number | null; listName: string; settings: ViewSettings; editing: SavedView | null; canShare: boolean; onClose: () => void; onMade: (v: Current) => void; onItem: (kind: "doc" | "board" | "form" | "dash", title: string) => void }) {
  const [kind, setKind] = React.useState<ViewKind | ItemKey>(editing?.kind ?? "list");
  const [name, setName] = React.useState(editing?.name ?? "");
  const [priv, setPriv] = React.useState(editing ? editing.private : !canShare);
  const [pin, setPin] = React.useState(editing?.pinned ?? false);
  const save = trpc.pj.saveView.useMutation({ onSuccess: (v) => onMade({ kind: v.kind as ViewKind, savedId: v.id }) });
  const isItem = ITEMS.some((i) => i.key === kind);
  const go = () => {
    if (!name.trim()) return;
    if (isItem) return onItem(kind === "whiteboard" ? "board" : (kind as "doc" | "form" | "dash"), name.trim());
    save.mutate({ organizationId: orgId, id: editing?.id, listId, folderId, name, kind: kind as ViewKind, settings: editing ? editing.settings : settings, private: priv, pinned: pin });
  };
  const tile = (key: string, label: string, blurb: string, color: string) => (
    <button key={key} type="button" className={`gp-vtile ${kind === key ? "on" : ""}`} onClick={() => setKind(key as ViewKind)}>
      <span className="gp-vic" style={{ background: color }}>{VIEW_ICONS[key === "whiteboard" ? "" : key] ?? label[0]}</span>
      <span>
        <b>{label}</b>
        <span className="ld-small ld-muted" style={{ display: "block" }}>{blurb}</span>
      </span>
    </button>
  );
  return (
    <Pop onClose={onClose} width={620}>
      <div className="ld-between" style={{ padding: "4px 6px" }}>
        <b style={{ fontSize: 15 }}>{editing ? "Change the view" : "Add a view"}</b>
        <span className="ld-small ld-muted">to {listName}</span>
      </div>
      <input className="ld-in xs" autoFocus aria-label="View name" placeholder={isItem ? `${ITEMS.find((i) => i.key === kind)?.label} name` : 'View name, like "Angela\'s week"'} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      <div className="gp-vgrid">
        {KINDS.map((k) => tile(k.key, k.label, k.blurb, k.color))}
        {!editing && ITEMS.map((i) => tile(i.key, i.label, i.blurb, i.color))}
      </div>
      {!isItem && (
        <div className="ld-row" style={{ gap: 14, padding: "6px 6px 0", borderTop: "1px solid #eef2f0" }}>
          <label className="ld-row ld-small" style={{ gap: 6 }}><input type="checkbox" checked={priv} disabled={!canShare} onChange={(e) => setPriv(e.target.checked)} /> Only I see it</label>
          <label className="ld-row ld-small" style={{ gap: 6 }}><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> Pin it as the first tab</label>
          {!editing && <span className="ld-small ld-muted">Keeps the filters and columns you have on now.</span>}
        </div>
      )}
      <span className="ld-row" style={{ justifyContent: "flex-end", padding: "6px 4px 0" }}>
        <button type="button" className="ld-btn sm" onClick={onClose}>Cancel</button>
        <button type="button" className="ld-btn p sm" disabled={!name.trim() || save.isPending} onClick={go}>{editing ? "Save" : isItem ? `Add ${ITEMS.find((i) => i.key === kind)?.label.toLowerCase()}` : "Add view"}</button>
      </span>
      <ErrorLine error={save.error} />
    </Pop>
  );
}
