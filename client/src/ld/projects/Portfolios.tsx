import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtYmd, Menu, OwnerAvatar } from "../goals/shared";
import { NobodyAvatar, PRIORITY_COLOR, PRIORITY_TEXT, dueText } from "./bits";
import { DEFAULT_COLUMNS } from "./Columns";
import { WorkloadView } from "./MoreViews";
import { StatusHistory, StatusPill, StatusUpdate, STATUS_TEXT, type StatusKey } from "./StatusUpdate";
import type { Outputs } from "../types";
import type { PjCtx, Where } from "../pages/Projects";

/**
 * Portfolios, the way Asana does them: a set of projects from any folders (or
 * other portfolios) watched together. The list shows each project's last
 * status update, task progress, owner, dates and top priority; Timeline draws
 * a bar per project; Dashboard counts the tasks; Progress holds the
 * portfolio's own status updates; Workload shows hours per person across it.
 */

type Portfolio = Outputs["pj"]["portfolio"];
type Row = Portfolio["rows"][number];
type Tab = "list" | "timeline" | "dashboard" | "progress" | "workload";
const TABS: [Tab, string][] = [["list", "☰ List"], ["timeline", "▭ Timeline"], ["dashboard", "▥ Dashboard"], ["progress", "◔ Progress"], ["workload", "⚖ Workload"]];
const COLORS = ["#1b6b4a", "#b45309", "#7c3aed", "#2563eb", "#0f766e", "#9a4f2c", "#c2253c", "#4b5563"];

export function PortfoliosPage({ orgId, onPick }: { orgId: number; onPick: (w: Where) => void }) {
  const q = trpc.pj.portfolios.useQuery({ organizationId: orgId });
  const [making, setMaking] = React.useState(false);
  const rows = q.data ?? [];
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 14 }}>
        <div className="gp-hrow">
          <span className="gp-ttl" style={{ fontSize: 18 }}>Portfolios</span>
          <button type="button" className="ld-btn p gp-auto" onClick={() => setMaking(true)}>+ New portfolio</button>
        </div>
      </div>
      <div className="gp-canvas" style={{ flexDirection: "column" }}>
        <ErrorLine error={q.error} />
        <div className="gp-pcards">
          {rows.map((p) => (
            <button key={p.id} type="button" className="gp-pcard" onClick={() => onPick({ scope: "portfolio", id: p.id })}>
              <span className="gp-fi" style={{ background: p.color, width: 12, height: 12 }} />
              <b className="gp-ell">{p.name}</b>
              <span className="ld-small ld-muted">{[p.projects ? `${p.projects} project${p.projects === 1 ? "" : "s"}` : "", p.portfolios ? `${p.portfolios} portfolio${p.portfolios === 1 ? "" : "s"}` : "", p.owner?.name ?? ""].filter(Boolean).join(" · ") || "Empty"}</span>
              <span className="ld-row" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                <StatusPill status={p.status?.status ?? null} />
                {p.on > 0 && <span className="gp-status on sm">On track {p.on}</span>}
                {p.risk > 0 && <span className="gp-status risk sm">At risk {p.risk}</span>}
                {p.off > 0 && <span className="gp-status off sm">Off track {p.off}</span>}
                {p.hold > 0 && <span className="gp-status hold sm">On hold {p.hold}</span>}
              </span>
            </button>
          ))}
          <button type="button" className="gp-pcard add" onClick={() => setMaking(true)}>+ New portfolio</button>
        </div>
        {!rows.length && !q.isLoading && <p className="ld-muted" style={{ marginTop: 14 }}>A portfolio holds projects from any folder, so you can watch their status, progress, owners and dates in one place.</p>}
      </div>
      {making && <EditPortfolio orgId={orgId} onClose={() => setMaking(false)} onMade={(id) => { setMaking(false); void q.refetch(); onPick({ scope: "portfolio", id }); }} />}
    </>
  );
}

/** New portfolio, or its name, color, owner and dates. */
function EditPortfolio({ orgId, existing, onClose, onMade }: { orgId: number; existing?: Portfolio["portfolio"]; onClose: () => void; onMade: (id: number) => void }) {
  const [name, setName] = React.useState(existing?.name ?? "");
  const [color, setColor] = React.useState(existing?.color ?? COLORS[0]);
  const [desc, setDesc] = React.useState(existing?.description ?? "");
  const people = trpc.pj.view.useQuery({ organizationId: orgId, listId: null, scope: "everything" });
  const [owner, setOwner] = React.useState(existing?.owner ? `${existing.owner.type}:${existing.owner.id}` : "");
  const save = trpc.pj.savePortfolio.useMutation({ onSuccess: (p) => onMade(p.id) });
  const go = () => {
    if (!name.trim()) return;
    const o = people.data?.people.find((p) => `${p.type}:${p.id}` === owner);
    save.mutate({ organizationId: orgId, id: existing?.id, name, color, description: desc, owner: o ? { type: o.type, id: o.id, name: o.name } : null });
  };
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={existing ? "Edit portfolio" : "New portfolio"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox" style={{ width: 480 }}>
        <div className="ld-between gp-mhead"><b>{existing ? "Edit portfolio" : "New portfolio"}</b></div>
        <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          <input className="ld-in xs" autoFocus aria-label="Name" placeholder="Portfolio name, like Q4 launches" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
          <span className="ld-row" style={{ flexWrap: "wrap" }} role="radiogroup" aria-label="Color">
            {COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={`gp-sw sm ${color === c ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </span>
          <select className="ld-in xs" aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">No owner</option>
            {(people.data?.people ?? []).map((p) => (
              <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
            ))}
          </select>
          <textarea className="ld-ta" rows={2} aria-label="Description" placeholder="What this portfolio is for (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <span className="ld-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="ld-btn sm" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={!name.trim() || save.isPending} onClick={go}>{existing ? "Save" : "Make it"}</button>
          </span>
          <ErrorLine error={save.error} />
        </div>
      </div>
    </div>
  );
}

export function PortfolioPage({ orgId, id, onPick, onOpenTask }: { orgId: number; id: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void }) {
  const utils = trpc.useUtils();
  const q = trpc.pj.portfolio.useQuery({ organizationId: orgId, id }, { refetchInterval: 30_000 });
  const [tab, setTab] = React.useState<Tab>("list");
  const [status, setStatus] = React.useState<null | { kind: "list" | "portfolio"; itemId: number; name: string }>(null);
  const [editing, setEditing] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const refresh = () => Promise.all([q.refetch(), utils.pj.portfolios.invalidate(), utils.pj.view.invalidate()]);
  const removeWork = trpc.pj.removeWork.useMutation({ onSuccess: refresh });
  const archive = trpc.pj.archivePortfolio.useMutation({ onSuccess: () => onPick({ scope: "portfolios" }) });
  const remove = trpc.pj.removePortfolio.useMutation({ onSuccess: () => onPick({ scope: "portfolios" }) });
  const d = q.data;
  if (!d)
    return (
      <div className="gp-canvas">
        <ErrorLine error={q.error} />
        {q.isLoading && <span className="ld-muted">Opening the portfolio</span>}
      </div>
    );
  const p = d.portfolio;
  const person = (a: { type: string; id: number; name: string } | null) => (a ? d.people.find((x) => x.type === a.type && x.id === a.id) ?? { type: "name" as const, id: 0, name: a.name } : null);
  const highlights = d.rows.filter((r) => r.kind === "list").map((r) => ({ itemId: r.id, name: r.name, status: (r.status?.status ?? (r.overdue && r.progress.total - r.progress.done ? (r.overdue / (r.progress.total - r.progress.done) >= 1 / 3 ? "off" : "risk") : "on")) as StatusKey }));
  const openRow = (r: Row) => (r.kind === "list" ? onPick({ scope: "list", listId: r.id }) : onPick({ scope: "portfolio", id: r.id }));
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 0 }}>
        <div className="gp-hrow">
          <span className="gp-ttl" style={{ fontSize: 18 }}>
            <button type="button" className="gp-link" style={{ fontSize: 14, fontWeight: 600, color: "#5b6b64" }} onClick={() => onPick({ scope: "portfolios" })}>Portfolios /</button>
            <span className="gp-fi" style={{ background: p.color, width: 12, height: 12 }} />
            {p.name}
            <StatusPill status={d.status?.status ?? null} at={d.status?.at} />
          </span>
          <span className="ld-row">
            {d.canEdit && <button type="button" className="ld-btn" onClick={() => setStatus({ kind: "portfolio", itemId: p.id, name: p.name })}>{d.status ? "Update status" : "Set status"}</button>}
            {d.canEdit && <button type="button" className="ld-btn p" onClick={() => setAdding(true)}>+ Add work</button>}
            {d.canEdit && (
              <Menu label="Portfolio options">
                {(close) => (
                  <>
                    <button type="button" role="menuitem" onClick={() => { setEditing(true); close(); }}>Edit name, color or owner</button>
                    <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/projects?page=portfolio&id=${p.id}`); close(); }}>Copy link</button>
                    <button type="button" role="menuitem" onClick={() => { archive.mutate({ organizationId: orgId, id: p.id, on: true }); close(); }}>Archive</button>
                    <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete the ${p.name} portfolio? The projects in it stay.`)) remove.mutate({ organizationId: orgId, id: p.id }); close(); }}>Delete</button>
                  </>
                )}
              </Menu>
            )}
          </span>
        </div>
        <div className="gp-views" role="tablist" aria-label="Portfolio views">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`gp-vw ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="gp-canvas" style={{ flexDirection: "column" }}>
        {p.description && tab === "list" && <p className="ld-muted" style={{ margin: "0 0 12px", fontSize: 13 }}>{p.description}</p>}
        {tab !== "progress" && tab !== "workload" && (
          <div className="gp-tiles">
            <div className="gp-tile"><b>{d.tiles.pct}%</b><span>Tasks done across the portfolio</span></div>
            <div className="gp-tile"><b>{d.tiles.done}</b><span>Complete</span></div>
            <div className="gp-tile"><b>{d.tiles.open}</b><span>Incomplete</span></div>
            <div className="gp-tile"><b style={d.tiles.overdue ? { color: "#c2253c" } : undefined}>{d.tiles.overdue}</b><span>Overdue</span></div>
            <div className="gp-tile"><b>{d.tiles.lastDue ? fmtYmd(d.tiles.lastDue) : "–"}</b><span>Last due date</span></div>
          </div>
        )}
        {tab === "list" && (
          <div className="gp-gl" style={{ width: "100%" }}>
            <div className="gp-prow h"><span>Name</span><span>Status</span><span>Task progress</span><span>Owner</span><span>Dates</span><span>Priority</span><span /></div>
            {d.rows.map((r) => (
              <div key={r.itemId} className="gp-prow" role="button" tabIndex={0} onClick={() => openRow(r)} onKeyDown={(e) => e.key === "Enter" && openRow(r)}>
                <span className="gp-tn">
                  <span className="gp-fi" style={{ background: r.color, marginRight: 0 }} />
                  <span style={{ minWidth: 0 }}>
                    <b className="gp-ell" style={{ display: "block" }}>{r.name}</b>
                    <span className="ld-small ld-muted">{r.kind === "portfolio" ? `Portfolio · ${r.lists} project${r.lists === 1 ? "" : "s"}` : r.folderName ?? "Not in a folder"}</span>
                  </span>
                </span>
                <span><StatusPill status={r.status?.status ?? null} at={r.status?.at} /></span>
                <span className="gp-prog">
                  <i className={r.status?.status ?? ""}><b style={{ width: `${r.progress.pct}%` }} /></i>
                  <span className="ld-small ld-muted">{r.progress.total ? `${r.progress.done} of ${r.progress.total}` : "No tasks"}</span>
                </span>
                <span>{r.owner ? <OwnerAvatar o={person(r.owner)} size={26} /> : <NobodyAvatar size={26} />}</span>
                <span className="ld-small" style={r.end && r.end < d.today && r.progress.done < r.progress.total ? { color: "#c2253c", fontWeight: 700 } : undefined}>{r.start && r.end ? `${fmtYmd(r.start)} to ${fmtYmd(r.end)}` : r.end ? `to ${dueText(r.end, d.today)}` : <span className="ld-muted">No dates</span>}</span>
                <span className="ld-small" style={{ fontWeight: 700, color: r.priority ? PRIORITY_COLOR[r.priority] : "#9aa8a2" }}>{r.priority ? `⚑ ${PRIORITY_TEXT[r.priority]}` : "None"}</span>
                <span onClick={(e) => e.stopPropagation()}>
                  {d.canEdit && (
                    <Menu label={`Options for ${r.name}`}>
                      {(close) => (
                        <>
                          <button type="button" role="menuitem" onClick={() => { openRow(r); close(); }}>Open</button>
                          {r.kind === "list" && (r.level === "edit" || r.level === "full") && <button type="button" role="menuitem" onClick={() => { setStatus({ kind: "list", itemId: r.id, name: r.name }); close(); }}>Update status</button>}
                          <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/projects?${r.kind === "list" ? `list=${r.id}` : `page=portfolio&id=${r.id}`}`); close(); }}>Copy link</button>
                          <button type="button" role="menuitem" className="danger" onClick={() => { removeWork.mutate({ organizationId: orgId, portfolioId: p.id, rowId: r.itemId }); close(); }}>Remove from portfolio</button>
                        </>
                      )}
                    </Menu>
                  )}
                </span>
              </div>
            ))}
            {d.canEdit && <button type="button" className="gp-addrow" onClick={() => setAdding(true)}>+ Add work: an existing project, a new project, or a portfolio</button>}
            {!d.rows.length && !d.canEdit && <div className="gp-empty">Nothing in this portfolio yet.</div>}
          </div>
        )}
        {tab === "timeline" && <Timeline rows={d.rows} today={d.today} onOpen={openRow} />}
        {tab === "dashboard" && <Dashboard rows={d.rows} />}
        {tab === "progress" && (
          <div className="gp-gl" style={{ width: "100%" }}>
            <div className="gp-sec ld-between">
              <span className="ld-row" style={{ gap: 10 }}>
                <b>Portfolio status</b>
                <StatusPill status={d.status?.status ?? null} at={d.status?.at} by={d.status?.by} />
              </span>
              {d.canEdit && <button type="button" className="ld-btn sm gp-auto" onClick={() => setStatus({ kind: "portfolio", itemId: p.id, name: p.name })}>{d.status ? "Update status" : "Set status"}</button>}
            </div>
            <div className="gp-sec ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
              {(["on", "risk", "off", "hold"] as StatusKey[]).map((k) => (
                <span key={k} className={`gp-status ${k} sm`}>{STATUS_TEXT[k]} {d.rows.filter((r) => r.status?.status === k).length}</span>
              ))}
              <span className="gp-status none sm">No status {d.rows.filter((r) => !r.status).length}</span>
            </div>
            <StatusHistory orgId={orgId} kind="portfolio" itemId={p.id} />
          </div>
        )}
        {tab === "workload" && <PortfolioWorkload orgId={orgId} portfolioId={p.id} onOpenTask={onOpenTask} />}
        <ErrorLine error={removeWork.error || archive.error || remove.error} />
      </div>
      {status && <StatusUpdate orgId={orgId} kind={status.kind} itemId={status.itemId} name={status.name} highlights={status.kind === "portfolio" ? highlights : []} onClose={() => { setStatus(null); void refresh(); }} />}
      {editing && <EditPortfolio orgId={orgId} existing={p} onClose={() => setEditing(false)} onMade={() => { setEditing(false); void refresh(); }} />}
      {adding && <AddWork orgId={orgId} d={d} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void refresh(); }} />}
    </>
  );
}

/** Add work: an existing project, a new project, or a portfolio. */
function AddWork({ orgId, d, onClose, onDone }: { orgId: number; d: Portfolio; onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = React.useState<"list" | "new" | "portfolio">("list");
  const [q, setQ] = React.useState("");
  const [name, setName] = React.useState("");
  const add = trpc.pj.addWork.useMutation({ onSuccess: onDone });
  const makeList = trpc.pj.saveList.useMutation({ onSuccess: (l) => l && add.mutate({ organizationId: orgId, portfolioId: d.portfolio.id, kind: "list", itemId: l.id }) });
  const words = q.trim().toLowerCase();
  const lists = d.canAdd.lists.filter((l) => !words || l.name.toLowerCase().includes(words) || (l.folderName ?? "").toLowerCase().includes(words));
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label="Add work" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox" style={{ width: 520 }}>
        <div className="ld-between gp-mhead"><b>Add work to {d.portfolio.name}</b><button type="button" className="ld-btn sm" onClick={onClose}>Close</button></div>
        <div style={{ padding: "4px 20px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="gp-ftabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "list"} className={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>Existing project</button>
            <button type="button" role="tab" aria-selected={tab === "new"} className={tab === "new" ? "on" : ""} onClick={() => setTab("new")}>New project</button>
            <button type="button" role="tab" aria-selected={tab === "portfolio"} className={tab === "portfolio" ? "on" : ""} onClick={() => setTab("portfolio")}>Portfolio</button>
          </div>
          {tab === "list" && (
            <>
              <input className="ld-in xs" autoFocus aria-label="Search projects" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="gp-assign" style={{ maxHeight: 280 }}>
                {lists.map((l) => (
                  <button key={l.id} type="button" className="gp-qi" onClick={() => add.mutate({ organizationId: orgId, portfolioId: d.portfolio.id, kind: "list", itemId: l.id })}>
                    <span className="gp-ell">{l.name}</span>
                    {l.folderName && <span className="ld-small ld-muted">{l.folderName}</span>}
                  </button>
                ))}
                {!lists.length && <span className="ld-small ld-muted">Every project you can see is in it already.</span>}
              </div>
            </>
          )}
          {tab === "new" && (
            <span className="ld-row">
              <input className="ld-in xs" autoFocus style={{ flex: 1 }} aria-label="Project name" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && makeList.mutate({ organizationId: orgId, name, folderId: null })} />
              <button type="button" className="ld-btn p sm gp-auto" disabled={!name.trim() || makeList.isPending || add.isPending} onClick={() => makeList.mutate({ organizationId: orgId, name, folderId: null })}>Make and add</button>
            </span>
          )}
          {tab === "portfolio" && (
            <div className="gp-assign" style={{ maxHeight: 280 }}>
              {d.canAdd.portfolios.map((x) => (
                <button key={x.id} type="button" className="gp-qi" onClick={() => add.mutate({ organizationId: orgId, portfolioId: d.portfolio.id, kind: "portfolio", itemId: x.id })}>{x.name}</button>
              ))}
              {!d.canAdd.portfolios.length && <span className="ld-small ld-muted">No other portfolio to add.</span>}
            </div>
          )}
          <ErrorLine error={add.error || makeList.error} />
        </div>
      </div>
    </div>
  );
}

/** One bar per project, from its first start to its last due date. */
function Timeline({ rows, today, onOpen }: { rows: Row[]; today: string; onOpen: (r: Row) => void }) {
  const dated = rows.filter((r) => r.end);
  if (!dated.length) return <div className="gp-gl gp-empty" style={{ width: "100%" }}>No project has dates yet. Dates come from the tasks' start and due dates.</div>;
  const days = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
  const addD = (s: string, n: number) => new Date(Date.parse(`${s}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const starts = dated.map((r) => r.start ?? r.end!);
  const min = [today, ...starts].sort()[0];
  const max = [today, ...dated.map((r) => r.end!)].sort().at(-1)!;
  const from = addD(min, -3);
  const to = addD(max, 7);
  const span = Math.max(14, days(from, to));
  const pct = (s: string) => `${(days(from, s) / span) * 100}%`;
  const months: string[] = [];
  for (let d = from; d <= to; d = addD(d, 1)) if (d.endsWith("-01") || d === from) months.push(d);
  return (
    <div className="gp-gl" style={{ width: "100%" }}>
      <div className="gp-tlh" style={{ position: "relative" }}>
        <span />
        <span style={{ position: "relative", height: 24 }}>
          {months.map((m) => (
            <span key={m} className="ld-small ld-muted" style={{ position: "absolute", left: pct(m) }}>{new Date(`${m}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}</span>
          ))}
        </span>
      </div>
      {dated.map((r) => (
        <div key={r.itemId} className="gp-tlr" role="button" tabIndex={0} onClick={() => onOpen(r)} onKeyDown={(e) => e.key === "Enter" && onOpen(r)}>
          <span className="gp-ell"><span className="gp-fi" style={{ background: r.color }} />{r.name}</span>
          <span className="gp-tlane">
            <span className="gp-tnow" style={{ left: pct(today) }} />
            <span className={`gp-tbar ${r.status?.status ?? ""}`} style={{ left: pct(r.start ?? r.end!), width: `calc(${(Math.max(1, days(r.start ?? r.end!, r.end!) + 1) / span) * 100}% )` }} title={`${fmtYmd(r.start ?? r.end!)} to ${fmtYmd(r.end!)}`}>
              <b style={{ width: `${r.progress.pct}%` }} />
              <span>{r.progress.pct}%</span>
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Tasks by project, and projects by status, as bars. */
function Dashboard({ rows }: { rows: Row[] }) {
  const maxOpen = Math.max(1, ...rows.map((r) => r.progress.total - r.progress.done));
  const byStatus = (["on", "risk", "off", "hold"] as StatusKey[]).map((k) => ({ k, n: rows.filter((r) => r.status?.status === k).length }));
  const none = rows.filter((r) => !r.status).length;
  return (
    <div className="gp-dash2">
      <div className="gp-gl">
        <div className="gp-sec"><b>Open tasks by project</b></div>
        {rows.map((r) => (
          <div key={r.itemId} className="gp-bar">
            <span className="gp-ell">{r.name}</span>
            <span className="gp-barlane"><i style={{ width: `${((r.progress.total - r.progress.done) / maxOpen) * 100}%`, background: r.color }} /></span>
            <span className="ld-small ld-muted">{r.progress.total - r.progress.done}</span>
          </div>
        ))}
        {!rows.length && <div className="gp-empty">No projects yet.</div>}
      </div>
      <div className="gp-gl">
        <div className="gp-sec"><b>Projects by status</b></div>
        {[...byStatus.map((s) => ({ label: STATUS_TEXT[s.k], n: s.n, k: s.k })), { label: "No status", n: none, k: "none" }].map((s) => (
          <div key={s.k} className="gp-bar">
            <span><span className={`gp-status ${s.k} sm`}>{s.label}</span></span>
            <span className="gp-barlane"><i style={{ width: `${(s.n / Math.max(1, rows.length)) * 100}%`, background: s.k === "on" ? "#1b6b4a" : s.k === "risk" ? "#d97706" : s.k === "off" ? "#c2253c" : "#9aa8a2" }} /></span>
            <span className="ld-small ld-muted">{s.n}</span>
          </div>
        ))}
      </div>
      <div className="gp-gl">
        <div className="gp-sec"><b>Overdue by project</b></div>
        {rows.filter((r) => r.overdue).map((r) => (
          <div key={r.itemId} className="gp-bar">
            <span className="gp-ell">{r.name}</span>
            <span className="gp-barlane"><i style={{ width: `${(r.overdue / Math.max(1, ...rows.map((x) => x.overdue))) * 100}%`, background: "#c2253c" }} /></span>
            <span className="ld-small ld-muted">{r.overdue}</span>
          </div>
        ))}
        {!rows.some((r) => r.overdue) && <div className="gp-empty">Nothing is late.</div>}
      </div>
    </div>
  );
}

/** Hours per person across the portfolio: the Workload view over every task in it. */
function PortfolioWorkload({ orgId, portfolioId, onOpenTask }: { orgId: number; portfolioId: number; onOpenTask: (id: number) => void }) {
  const utils = trpc.useUtils();
  const v = trpc.pj.view.useQuery({ organizationId: orgId, listId: null, portfolioId, scope: "portfolio" });
  if (!v.data) return <div className="gp-gl gp-empty" style={{ width: "100%" }}>{v.isLoading ? "Loading" : ""}<ErrorLine error={v.error} /></div>;
  const noop = () => undefined;
  const c: PjCtx = {
    orgId,
    data: v.data,
    tasks: v.data.tasks,
    open: onOpenTask,
    refresh: () => Promise.all([v.refetch(), utils.pj.workload.invalidate()]),
    group: "project",
    sort: "manual",
    listId: null,
    level: "edit",
    columns: DEFAULT_COLUMNS.list,
    setColumns: noop,
    autoColumns: true,
    selected: new Set(),
    toggle: noop,
    clearSelected: noop,
    compact: false,
    openId: null,
    portfolioId,
  };
  return (
    <div style={{ width: "100%" }}>
      <WorkloadView c={c} />
    </div>
  );
}
