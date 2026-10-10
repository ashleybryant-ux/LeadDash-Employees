import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";

/**
 * Customize sidebar: every item the Projects sidebar can show as a card with
 * an on/off switch, drag to reorder. The items turned off sit under More.
 * Each person has their own order.
 */

export type NavKey = "home" | "mine" | "everything" | "docs" | "portfolios" | "dash" | "time" | "templates" | "boards" | "forms" | "goals" | "import";
const I = (d: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
/** Line icons for the sidebar, drawn like the rail's. */
export const NAV_ICONS: Record<NavKey | "more" | "settings", React.ReactNode> = {
  home: I(<><path d="M4 11l8-7 8 7" /><path d="M6 10v10h12V10" /><path d="M10 20v-6h4v6" /></>),
  mine: I(<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" />),
  everything: I(<><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" fill="currentColor" /><circle cx="4" cy="12" r="1" fill="currentColor" /><circle cx="4" cy="18" r="1" fill="currentColor" /></>),
  docs: I(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>),
  portfolios: I(<><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" /></>),
  dash: I(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>),
  time: I(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  templates: I(<><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>),
  boards: I(<><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v4M8 21h8M7 9h4M7 12h7" /></>),
  forms: I(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>),
  goals: I(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></>),
  import: I(<><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>),
  more: I(<><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" /></>),
  settings: I(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>),
};
export const NAV: { key: NavKey; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "mine", label: "My tasks" },
  { key: "everything", label: "Everything" },
  { key: "docs", label: "Docs" },
  { key: "portfolios", label: "Portfolios" },
  { key: "dash", label: "Dashboards" },
  { key: "time", label: "Timesheets" },
  { key: "templates", label: "Templates" },
  { key: "boards", label: "Whiteboards" },
  { key: "forms", label: "Forms" },
  { key: "goals", label: "Goals" },
  { key: "import", label: "Import from ClickUp" },
];
export const navLabel = (k: NavKey) => NAV.find((n) => n.key === k)?.label ?? k;
export const navIcon = (k: NavKey) => NAV_ICONS[k];

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
