import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtYmd, Menu } from "../goals/shared";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";
import { fmtMin } from "./TaskModal";

/** Projects dashboards: cards over any list, folder, everything, or just me. */

type Dash = Outputs["pj"]["dashboards"][number];
type Card = Dash["cards"][number];
type CardData = Outputs["pj"]["dashboardData"]["cards"][number];
const TYPES: { type: Card["type"]; label: string; title: string }[] = [
  { type: "count", label: "Number (count of tasks)", title: "Open tasks" },
  { type: "status", label: "Tasks by status", title: "Tasks by status" },
  { type: "person", label: "Tasks by person", title: "Open tasks by person" },
  { type: "overdue", label: "Overdue", title: "Overdue by person" },
  { type: "time", label: "Time tracked", title: "Time tracked" },
  { type: "workload", label: "Workload", title: "Workload this week" },
  { type: "trend", label: "Done vs. added", title: "Done vs. added" },
  { type: "burndown", label: "Burndown for a list", title: "Burndown" },
  { type: "tasks", label: "Task list", title: "Due this week" },
  { type: "goal", label: "Goal progress", title: "Goal progress" },
  { type: "doc", label: "A doc", title: "A doc" },
  { type: "fieldsum", label: "Custom field total (money, number)", title: "Total" },
];

export function DashboardsPage({ orgId, id, onPick, onOpenTask }: { orgId: number; id?: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void }) {
  const list = trpc.pj.dashboards.useQuery({ organizationId: orgId });
  const save = trpc.pj.saveDashboard.useMutation({ onSuccess: async (d) => { await list.refetch(); await data.refetch(); onPick({ scope: "dash", id: d.id }); } });
  const remove = trpc.pj.removeDashboard.useMutation({ onSuccess: async () => { await list.refetch(); onPick({ scope: "dash" }); } });
  const dash = list.data?.find((d) => d.id === id) ?? list.data?.[0];
  const data = trpc.pj.dashboardData.useQuery({ organizationId: orgId, id: dash?.id ?? 0 }, { enabled: !!dash, refetchInterval: 60_000 });
  const [editCard, setEditCard] = React.useState<Card | null>(null);
  const [naming, setNaming] = React.useState<{ id?: number; name: string } | null>(null);
  const setCards = (cards: Card[]) => dash && save.mutate({ organizationId: orgId, id: dash.id, name: dash.name, cards: cards.map((c) => ({ ...c, scope: { kind: c.scope.kind, ...(c.scope.id ? { id: c.scope.id } : {}) } })) });
  const cards = dash?.cards ?? [];
  const move = (i: number, by: number) => {
    const next = cards.slice();
    const [c] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, c);
    setCards(next);
  };
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 14 }}>
        <div className="gp-hrow">
          {naming ? (
            <span className="ld-row">
              <input className="ld-in xs" style={{ width: 280 }} autoFocus aria-label="Dashboard name" value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} />
              <button type="button" className="ld-btn sm" onClick={() => setNaming(null)}>Cancel</button>
              <button type="button" className="ld-btn p sm" disabled={!naming.name.trim() || save.isPending} onClick={() => { save.mutate({ organizationId: orgId, id: naming.id, name: naming.name, ...(naming.id ? { cards: cards } : {}) }); setNaming(null); }}>Save</button>
            </span>
          ) : (
            <span className="gp-ttl" style={{ fontSize: 18 }}>
              <span className="crumb" style={{ fontSize: 14, marginLeft: 0 }}>Dashboards /</span>
              {dash?.name ?? "No dashboards yet"}
            </span>
          )}
          {dash && !naming && (
            <Menu label="Dashboard options">
              {(close) => (
                <>
                  <button type="button" role="menuitem" onClick={() => { setNaming({ id: dash.id, name: dash.name }); close(); }}>Rename</button>
                  <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete the dashboard "${dash.name}"?`)) remove.mutate({ organizationId: orgId, id: dash.id }); close(); }}>Delete dashboard</button>
                </>
              )}
            </Menu>
          )}
        </div>
      </div>
      <div className="gp-tool">
        <span className="gp-tool-l">
          {(list.data?.length ?? 0) > 0 && (
            <select className="gp-fb sel" aria-label="Dashboard" value={dash?.id ?? ""} onChange={(e) => onPick({ scope: "dash", id: Number(e.target.value) })}>
              {list.data!.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
          <span className="ld-small ld-muted">This week · {data.data ? fmtYmd(data.data.today) : ""}</span>
        </span>
        <span className="gp-tool-r">
          {dash && (
            <Menu label="Add a card" button="+ Add card">
              {(close) => (
                <>
                  <span className="gp-menu-h">Add a card</span>
                  {TYPES.map((t) => (
                    <button key={t.type} type="button" role="menuitem" onClick={() => { setEditCard({ id: `c${Date.now().toString(36)}`, type: t.type, title: t.title, scope: { kind: "everything" }, size: t.type === "trend" || t.type === "burndown" ? 2 : 1, options: t.type === "count" ? { which: "open" } : undefined }); close(); }}>
                      {t.label}
                    </button>
                  ))}
                </>
              )}
            </Menu>
          )}
          <button type="button" className="ld-btn" onClick={() => setNaming({ name: "" })}>New dashboard</button>
        </span>
      </div>
      <div className="gp-canvas" style={{ display: "block" }}>
        <ErrorLine error={list.error || data.error || save.error || remove.error} />
        {list.data && !list.data.length && !naming && (
          <div className="gp-gl" style={{ padding: 24, maxWidth: 560, display: "flex", flexDirection: "column", gap: 10 }}>
            <b>No dashboards yet</b>
            <span className="ld-small ld-muted">A new dashboard starts with open tasks, done this week, time tracked, overdue by person, workload, what's due, and done vs. added.</span>
            <button type="button" className="ld-btn p" style={{ alignSelf: "flex-start" }} onClick={() => save.mutate({ organizationId: orgId, name: "This week" })}>Make one</button>
          </div>
        )}
        <div className="gp-pdash">
          {data.data?.cards.map((c, i) => (
            <div key={c.id} className="gp-w" style={{ gridColumn: `span ${c.size ?? 1}` }}>
              <h5>
                <span className="gp-ell">{c.title}</span>
                <span className="ld-row" style={{ gap: 6 }}>
                  <span className="ld-small ld-muted gp-ell">{c.scopeName}</span>
                  <Menu label={`Options for ${c.title}`}>
                    {(close) => (
                      <>
                        <button type="button" role="menuitem" onClick={() => { const cc = cards.find((x) => x.id === c.id); if (cc) setEditCard(cc); close(); }}>Edit</button>
                        <button type="button" role="menuitem" onClick={() => { setCards(cards.map((x) => (x.id === c.id ? { ...x, size: (((x.size ?? 1) % 3) + 1) as 1 | 2 | 3 } : x))); close(); }}>{(c.size ?? 1) === 3 ? "Make it narrow" : "Make it wider"}</button>
                        {i > 0 && <button type="button" role="menuitem" onClick={() => { move(i, -1); close(); }}>Move earlier</button>}
                        {i < cards.length - 1 && <button type="button" role="menuitem" onClick={() => { move(i, 1); close(); }}>Move later</button>}
                        <button type="button" role="menuitem" className="danger" onClick={() => { setCards(cards.filter((x) => x.id !== c.id)); close(); }}>Remove</button>
                      </>
                    )}
                  </Menu>
                </span>
              </h5>
              <CardBody c={c} onOpenTask={onOpenTask} onPick={onPick} />
            </div>
          ))}
        </div>
      </div>
      {editCard && dash && (
        <CardEditor
          orgId={orgId}
          card={editCard}
          onClose={() => setEditCard(null)}
          onSave={(c) => {
            setCards(cards.some((x) => x.id === c.id) ? cards.map((x) => (x.id === c.id ? c : x)) : [...cards, c]);
            setEditCard(null);
          }}
        />
      )}
    </>
  );
}

function Bars({ bars }: { bars: { label: string; value: number; color: string; max?: number | null }[] }) {
  const top = Math.max(1, ...bars.map((b) => b.max ?? b.value));
  if (!bars.length) return <span className="ld-small ld-muted">Nothing yet.</span>;
  return (
    <div className="gp-hbs">
      {bars.map((b) => (
        <div key={b.label} className="gp-hb">
          <span className="gp-ell">{b.label}</span>
          <span className="t"><i style={{ width: `${Math.max(2, (b.value / top) * 100)}%`, background: b.color }} /></span>
          <b>{b.value}{b.max ? ` / ${b.max}` : ""}</b>
        </div>
      ))}
    </div>
  );
}

function Line({ series, labels }: { series: { values: number[]; color: string; dash?: boolean }[]; labels: string[] }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = labels.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 580 + 10 : 300);
  const y = (v: number) => 130 - (v / max) * 110;
  return (
    <svg viewBox="0 0 600 150" className="gp-line" role="img" aria-label="Chart">
      <g stroke="#eef2f0">
        <path d="M0 20H600M0 75H600M0 130H600" />
      </g>
      {series.map((s, k) => (
        <path key={k} d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)} ${y(v)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={s.dash ? 2 : 3} strokeDasharray={s.dash ? "5 4" : undefined} />
      ))}
      <text x="4" y="146" fontSize="11" fill="#5b6b64">{labels[0]}</text>
      <text x="596" y="146" fontSize="11" fill="#5b6b64" textAnchor="end">{labels[n - 1]}</text>
      <text x="4" y="16" fontSize="11" fill="#5b6b64">{max}</text>
    </svg>
  );
}

function CardBody({ c, onOpenTask, onPick }: { c: CardData; onOpenTask: (id: number) => void; onPick: (w: Where) => void }) {
  const x = c as CardData & Record<string, unknown>;
  if (c.type === "count" || c.type === "fieldsum")
    return (
      <>
        <span className="num">{c.type === "fieldsum" && x.money ? `$${Number(x.number).toLocaleString("en-US")}` : Number(x.number).toLocaleString("en-US")}</span>
        <span className="ld-small ld-muted">{String(x.sub ?? "")}</span>
      </>
    );
  if (c.type === "time")
    return (
      <>
        <span className="num">{fmtMin(Number(x.minutes))}</span>
        <span className="ld-small ld-muted">{String(x.sub ?? "")}</span>
      </>
    );
  if (c.type === "status" || c.type === "person" || c.type === "overdue" || c.type === "workload") return <Bars bars={(x.bars as { label: string; value: number; color: string; max?: number | null }[]) ?? []} />;
  if (c.type === "trend") {
    const weeks = (x.weeks as string[]) ?? [];
    return (
      <>
        <Line labels={weeks.map((w) => fmtYmd(w))} series={[{ values: (x.done as number[]) ?? [], color: "#1b6b4a" }, { values: (x.added as number[]) ?? [], color: "#9aa8a2", dash: true }]} />
        <span className="ld-small ld-muted">Green: tasks done. Gray: tasks added. Weekly, last 8 weeks.</span>
      </>
    );
  }
  if (c.type === "burndown") {
    const days = (x.days as string[]) ?? [];
    return (
      <>
        <Line labels={days.map((d) => fmtYmd(d))} series={[{ values: (x.open as number[]) ?? [], color: "#2563eb" }]} />
        <span className="ld-small ld-muted">Open tasks each day, last 14 days.</span>
      </>
    );
  }
  if (c.type === "tasks") {
    const ts = (x.tasks as { id: number; name: string; dueDate: string | null; overdue: boolean }[]) ?? [];
    return ts.length ? (
      <div className="gp-dtasks">
        {ts.map((t) => (
          <button key={t.id} type="button" onClick={() => onOpenTask(t.id)}>
            <span className="gp-ell">{t.name}</span>
            <span style={t.overdue ? { color: "#c2253c", fontWeight: 700 } : undefined}>{t.dueDate ? fmtYmd(t.dueDate) : ""}</span>
          </button>
        ))}
      </div>
    ) : (
      <span className="ld-small ld-muted">Nothing due this week.</span>
    );
  }
  if (c.type === "goal") {
    const g = x.goal as { title: string; progress: number; status: string | null } | null;
    return g ? (
      <>
        <b>{g.title}</b>
        <span className="gp-pbar"><span className="t"><i style={{ width: `${g.progress}%` }} /></span><span>{g.progress}%</span></span>
      </>
    ) : (
      <span className="ld-small ld-muted">Pick a goal in Edit.</span>
    );
  }
  const doc = x.doc as { id: number; title: string; lines: string[] } | null;
  return doc ? (
    <>
      <button type="button" className="gp-link" style={{ alignSelf: "flex-start", fontWeight: 800 }} onClick={() => onPick({ scope: "doc", id: doc.id })}>{doc.title}</button>
      {doc.lines.map((l, i) => (
        <span key={i} className="ld-small">{l.replace(/\*+/g, "")}</span>
      ))}
    </>
  ) : (
    <span className="ld-small ld-muted">Pick a doc in Edit.</span>
  );
}

function CardEditor({ orgId, card, onClose, onSave }: { orgId: number; card: Card; onClose: () => void; onSave: (c: Card) => void }) {
  const ch = trpc.pj.cardChoices.useQuery({ organizationId: orgId });
  const [c, setC] = React.useState<Card>(card);
  const put = (p: Partial<Card>) => setC({ ...c, ...p });
  const opt = (p: NonNullable<Card["options"]>) => setC({ ...c, options: { ...(c.options ?? {}), ...p } });
  const needsScope = !["goal", "doc"].includes(c.type);
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label="Card">
      <div className="gp-mbox" style={{ width: 600 }}>
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>{TYPES.find((t) => t.type === c.type)?.label}</b>
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={!c.title.trim()} onClick={() => onSave(c)}>Save</button>
          </span>
        </div>
        <div className="gp-xedit" style={{ padding: "4px 20px 20px" }}>
          <label htmlFor="ce-title">Title</label>
          <input id="ce-title" className="ld-in xs" value={c.title} onChange={(e) => put({ title: e.target.value })} />
          {needsScope && (
            <>
              <label htmlFor="ce-scope">Tasks from</label>
              <select
                id="ce-scope"
                className="ld-in xs"
                value={`${c.scope.kind}:${c.scope.id ?? ""}`}
                onChange={(e) => {
                  const [kind, id] = e.target.value.split(":");
                  put({ scope: { kind: kind as Card["scope"]["kind"], ...(id ? { id: Number(id) } : {}) } });
                }}
              >
                <option value="everything:">Everything</option>
                <option value="me:">Me</option>
                {ch.data?.folders.map((f) => (
                  <option key={`f${f.id}`} value={`folder:${f.id}`}>Folder: {f.name}</option>
                ))}
                {ch.data?.lists.map((l) => (
                  <option key={`l${l.id}`} value={`list:${l.id}`}>List: {l.name}</option>
                ))}
              </select>
            </>
          )}
          {c.type === "count" && (
            <>
              <label htmlFor="ce-which">Count</label>
              <select id="ce-which" className="ld-in xs" value={c.options?.which ?? "open"} onChange={(e) => opt({ which: e.target.value as "open" })}>
                <option value="open">Open tasks</option>
                <option value="overdue">Overdue tasks</option>
                <option value="done">Done this week</option>
                <option value="all">All tasks</option>
              </select>
            </>
          )}
          {c.type === "fieldsum" && (
            <>
              <label htmlFor="ce-field">Field</label>
              <select id="ce-field" className="ld-in xs" value={c.options?.field ?? ""} onChange={(e) => opt({ field: e.target.value })}>
                <option value="">Pick a field</option>
                {ch.data?.fields.map((f) => (
                  <option key={f.id} value={f.id}>{f.name} ({f.listName})</option>
                ))}
              </select>
            </>
          )}
          {c.type === "goal" && (
            <>
              <label htmlFor="ce-goal">Goal</label>
              <select id="ce-goal" className="ld-in xs" value={c.options?.goalId ?? ""} onChange={(e) => opt({ goalId: Number(e.target.value) })}>
                <option value="">Pick a goal</option>
                {ch.data?.goals.map((g) => (
                  <option key={g.id} value={g.id}>{g.title}</option>
                ))}
              </select>
            </>
          )}
          {c.type === "doc" && (
            <>
              <label htmlFor="ce-doc">Doc</label>
              <select id="ce-doc" className="ld-in xs" value={c.options?.docId ?? ""} onChange={(e) => opt({ docId: Number(e.target.value) })}>
                <option value="">Pick a doc</option>
                {ch.data?.docs.map((d) => (
                  <option key={d.id} value={d.id}>{d.title}</option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="ce-size">Width</label>
          <select id="ce-size" className="ld-in xs" value={c.size ?? 1} onChange={(e) => put({ size: Number(e.target.value) as 1 | 2 | 3 })}>
            <option value={1}>One column</option>
            <option value={2}>Two columns</option>
            <option value={3}>Full width</option>
          </select>
          <ErrorLine error={ch.error} />
        </div>
      </div>
    </div>
  );
}
