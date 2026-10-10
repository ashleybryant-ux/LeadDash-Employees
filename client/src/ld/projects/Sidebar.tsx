import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";

/**
 * Customize sidebar: every item the Projects sidebar can show as a card with
 * an on/off switch, drag to reorder. The items turned off sit under More.
 * Each person has their own order.
 */

export type NavKey = "home" | "mine" | "everything" | "docs" | "portfolios" | "dash" | "time" | "templates" | "boards" | "forms" | "goals" | "import";
export const NAV: { key: NavKey; label: string; icon: string }[] = [
  { key: "home", label: "Home", icon: "⌂" },
  { key: "mine", label: "My tasks", icon: "☆" },
  { key: "everything", label: "Everything", icon: "▤" },
  { key: "docs", label: "Docs", icon: "📄" },
  { key: "portfolios", label: "Portfolios", icon: "▦" },
  { key: "dash", label: "Dashboards", icon: "▥" },
  { key: "time", label: "Timesheets", icon: "◷" },
  { key: "templates", label: "Templates", icon: "❏" },
  { key: "boards", label: "Whiteboards", icon: "▢" },
  { key: "forms", label: "Forms", icon: "☰" },
  { key: "goals", label: "Goals", icon: "◎" },
  { key: "import", label: "Import from ClickUp", icon: "⇩" },
];
export const navLabel = (k: NavKey) => NAV.find((n) => n.key === k)?.label ?? k;
export const navIcon = (k: NavKey) => NAV.find((n) => n.key === k)?.icon ?? "";

export function SidebarPage({ orgId, onDone }: { orgId: number; onDone: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.pj.nav.useQuery({ organizationId: orgId });
  const save = trpc.pj.setNav.useMutation({ onSuccess: async () => { await utils.pj.nav.invalidate(); onDone(); } });
  const [shown, setShown] = React.useState<NavKey[] | null>(null);
  const [drag, setDrag] = React.useState<NavKey | null>(null);
  const [over, setOver] = React.useState<NavKey | null>(null);
  const order: NavKey[] = shown ?? (q.data ? [...(q.data.shown as NavKey[]), ...(q.data.more as NavKey[])] : []);
  // The cards keep one order: the items that are on, then the ones under More; the switch says which side each is on.
  const serverOn = new Set((q.data?.shown as NavKey[]) ?? []);
  const [onSet, setOnSet] = React.useState<Set<NavKey> | null>(null);
  const isOn = (k: NavKey) => (onSet ?? serverOn).has(k);
  const toggle = (k: NavKey) => {
    const n = new Set(onSet ?? serverOn);
    n.has(k) ? n.delete(k) : n.add(k);
    setOnSet(n);
    if (!shown) setShown(order);
  };
  const drop = (to: NavKey) => {
    if (!drag || drag === to) return;
    const list = [...order].filter((k) => k !== drag);
    list.splice(list.indexOf(to), 0, drag);
    setShown(list);
  };
  const result = order.filter((k) => isOn(k));
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 14 }}>
        <div className="gp-hrow">
          <span className="gp-ttl" style={{ fontSize: 18 }}>Customize sidebar</span>
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={save.isPending || !q.data} onClick={() => save.mutate({ organizationId: orgId, shown: result })}>Save</button>
          </span>
        </div>
      </div>
      <div className="gp-canvas" style={{ display: "block" }}>
        <p className="ld-small ld-muted" style={{ margin: "0 0 12px" }}>Drag to reorder. Items you turn off move under More.</p>
        <div className="gp-navgrid">
          {order.map((k) => (
            <div
              key={k}
              className={`gp-navcard ${isOn(k) ? "on" : ""} ${over === k && drag && drag !== k ? "over" : ""}`}
              draggable
              onDragStart={(e) => { setDrag(k); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { e.preventDefault(); setOver(k); }}
              onDragLeave={() => setOver((o) => (o === k ? null : o))}
              onDrop={(e) => { e.preventDefault(); drop(k); setDrag(null); setOver(null); }}
              onDragEnd={() => { setDrag(null); setOver(null); }}
            >
              <i aria-hidden="true">{navIcon(k)}</i>
              <span className="ld-row" style={{ gap: 8 }}>
                <b>{navLabel(k)}</b>
                <button type="button" role="switch" aria-checked={isOn(k)} aria-label={`Show ${navLabel(k)}`} className={`gp-switch ${isOn(k) ? "on" : ""}`} onClick={() => toggle(k)}>
                  <span />
                </button>
              </span>
            </div>
          ))}
        </div>
        <ErrorLine error={q.error || save.error} />
      </div>
    </>
  );
}
