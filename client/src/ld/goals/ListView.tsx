import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { Bar, fmtAt, OwnerAvatar, OwnerSelect, ownerKey, parseOwnerKey, StatusPill } from "./shared";
import type { GoalRow, GoalsCtx } from "../pages/Goals";

/** List view (like Asana's goals list): year goals with their sub-goals under them, or grouped by folder. */
export function ListView({ c, openId }: { c: GoalsCtx; openId: number | null }) {
  const drafts = c.data.goals.filter((g) => g.goal.state === "draft");
  const [reviewing, setReviewing] = React.useState(false);
  const draftYear = drafts[0]?.goal.period ?? "";
  if (reviewing && drafts.length) return <YearReview c={c} drafts={drafts} onDone={() => setReviewing(false)} />;
  const rows = c.shown.filter((g) => g.goal.state !== "draft");
  const ids = new Set(rows.map((g) => g.goal.id));
  const roots = rows.filter((g) => !g.goal.parentId || !ids.has(g.goal.parentId));
  const kids = (id: number) => rows.filter((g) => g.goal.parentId === id);
  const out: React.ReactNode[] = [];
  const walk = (g: GoalRow, depth: number) => {
    out.push(<Row key={g.goal.id} c={c} g={g} depth={depth} sel={openId === g.goal.id} kids={kids(g.goal.id).length} />);
    if (depth < 4) for (const k of kids(g.goal.id)) walk(k, depth + 1);
  };
  if (c.filters.group === "parent") roots.forEach((g) => walk(g, 0));
  else if (c.filters.group === "none") rows.forEach((g) => out.push(<Row key={g.goal.id} c={c} g={g} depth={0} sel={openId === g.goal.id} kids={0} />));
  else {
    const folders = [...c.data.folders.map((f) => ({ id: f.id as number | null, name: f.name, color: f.color })), { id: null, name: "Not in a folder", color: "#9aa8a2" }];
    for (const f of folders) {
      const inF = rows.filter((g) => (g.goal.folderId ?? null) === f.id || (f.id === null && g.goal.folderId && !c.data.folders.some((x) => x.id === g.goal.folderId)));
      if (!inF.length) continue;
      out.push(
        <div key={`f${f.id}`} className="gp-grp">
          <span className="gp-fi" style={{ background: f.color }} />
          {f.name}
          <span className="ld-muted">{inF.length}</span>
        </div>
      );
      inF.forEach((g) => out.push(<Row key={g.goal.id} c={c} g={g} depth={0} sel={openId === g.goal.id} kids={0} />));
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      {drafts.length > 0 && (
        <div className="gp-note sugg">
          <span className="gp-sav">S</span>
          <span style={{ flex: 1 }}>
            <b>Simone drafted the {draftYear} goals</b> from this year's numbers, your Brain and this year's plan: {drafts.map((d) => d.goal.title).join(", ")}. They stay drafts until you approve them.
          </span>
          <span className="gp-col-btns">
            <button type="button" className="ld-btn p" onClick={() => setReviewing(true)}>Review</button>
          </span>
        </div>
      )}
      <div className="gp-gl">
        <div className="gp-glh">
          <span>Goal</span>
          <span>Progress</span>
          <span>Status</span>
          <span>Owner</span>
          <span>Time period</span>
          <span>Last update</span>
        </div>
        {out.length ? out : <div className="gp-empty">{c.data.goals.length ? "No goals match these filters." : "No goals yet. Add your first goal, or ask Simone to draft them from your Brain."}</div>}
        <button type="button" className="gp-addrow" onClick={() => c.edit("new")}>+ Add a goal</button>
      </div>
    </div>
  );
}

function Row({ c, g, depth, sel, kids }: { c: GoalsCtx; g: GoalRow; depth: number; sel: boolean; kids: number }) {
  const waiting = g.goal.state === "suggested";
  const last = g.lastUpdate ? `${g.lastUpdate.author} · ${fmtAt(g.lastUpdate.at).split(",").slice(0, 2).join(",")}` : waiting ? `Suggested by ${g.goal.setBy}` : kids ? `${kids} sub-goal${kids === 1 ? "" : "s"}` : "";
  return (
    <button type="button" className={`gp-glr ${sel ? "sel" : ""} ${depth === 0 ? "top" : ""}`} onClick={() => c.open(g.goal.id)} aria-label={`Open ${g.goal.title}`}>
      <span className="gp-gnm" style={{ paddingLeft: depth * 26 }}>
        {depth === 0 && kids > 0 ? <span className="tw">▼</span> : <span className="tw" />}
        <span className="ic" style={{ background: g.goal.color }}>◎</span>
        <span className={depth === 0 ? "t b" : "t"}>{g.goal.title}</span>
        {waiting && <span className="gp-chip warn">Needs your OK</span>}
      </span>
      <Bar p={g.progress} color={g.goal.color} red={g.status === "off"} />
      <span>{waiting ? <span className="gp-sd s-none">Suggested</span> : <StatusPill s={g.status} />}</span>
      <span>
        <OwnerAvatar o={g.owner} />
      </span>
      <span>{g.goal.period}</span>
      <span className="ld-small ld-muted gp-ell">{last}</span>
    </button>
  );
}

/** Reviewing Simone's draft of next year's goals: change any, add your own, then Approve. */
function YearReview({ c, drafts, onDone }: { c: GoalsCtx; drafts: GoalRow[]; onDone: () => void }) {
  const save = trpc.goals.save.useMutation();
  const approve = trpc.goals.approve.useMutation();
  const dismiss = trpc.goals.dismiss.useMutation();
  const [rows, setRows] = React.useState(() =>
    drafts.map((d) => ({ id: d.goal.id, title: d.goal.title, target: d.targets[0]?.targetValue ?? 0, owner: d.goal.ownerType ? `${d.goal.ownerType}:${d.goal.ownerId}` : "", why: d.goal.why, keep: true, row: d }))
  );
  const [mine, setMine] = React.useState({ title: "", target: "", owner: "" });
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const period = drafts[0].goal.period;
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      for (const r of rows) {
        if (!r.keep) {
          await dismiss.mutateAsync({ organizationId: c.orgId, id: r.id });
          continue;
        }
        const g = r.row.goal;
        const o = parseOwnerKey(r.owner);
        const t = r.row.targets[0];
        await save.mutateAsync({ organizationId: c.orgId, goal: { id: g.id, title: r.title, description: g.description, level: g.level, parentId: g.parentId, folderId: g.folderId, ownerType: o?.type ?? null, ownerId: o?.id ?? null, startDate: g.startDate, dueDate: g.dueDate, period: g.period, color: g.color, status: null, manualProgress: g.manualProgress, targets: t ? [{ id: t.id, kind: t.kind, name: t.name, startValue: t.startValue, currentValue: t.currentValue, targetValue: Number(r.target) || 0, done: t.done, listId: t.listId, measureId: t.measureId }] : undefined } });
        await approve.mutateAsync({ organizationId: c.orgId, id: g.id });
      }
      if (mine.title.trim()) {
        const o = parseOwnerKey(mine.owner);
        const g = drafts[0].goal;
        await save.mutateAsync({ organizationId: c.orgId, goal: { title: mine.title, description: "", level: "year", parentId: null, folderId: null, ownerType: o?.type ?? null, ownerId: o?.id ?? null, startDate: g.startDate, dueDate: g.dueDate, period: g.period, color: "#475569", status: null, manualProgress: null, targets: Number(mine.target) ? [{ kind: "number", name: mine.title, startValue: 0, currentValue: 0, targetValue: Number(mine.target), done: false, listId: null, measureId: null }] : [] } });
      }
      await c.refresh();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <h3>{period} goals · Simone's draft</h3>
        <span className="ld-row">
          <button type="button" className="ld-btn" onClick={onDone} disabled={busy}>Cancel</button>
          <button type="button" className="ld-btn p" onClick={submit} disabled={busy}>{busy ? "Saving" : "Approve"}</button>
        </span>
      </div>
      <div className="gp-note" style={{ margin: "14px 18px" }}>
        <span className="gp-sav">S</span>
        <span>Change anything, then Approve. Once approved, I break each goal into the first quarter's goals for you to approve the same way.</span>
      </div>
      <div className="gp-rvh">
        <span>Goal</span>
        <span>Target</span>
        <span>Owner</span>
        <span>Why Simone suggests it</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div key={r.id} className={`gp-rv ${r.keep ? "" : "off"}`}>
          <input className="ld-in xs" aria-label="Goal" value={r.title} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} disabled={!r.keep} />
          <input className="ld-in xs" aria-label="Target" inputMode="decimal" value={String(r.target)} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, target: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 } : x)))} disabled={!r.keep} />
          <OwnerSelect label="Owner" people={c.data.people} value={r.owner} onChange={(v) => setRows(rows.map((x, k) => (k === i ? { ...x, owner: v } : x)))} />
          <span className="ld-small ld-muted">{r.why}</span>
          <button type="button" className="ld-btn sm" onClick={() => setRows(rows.map((x, k) => (k === i ? { ...x, keep: !x.keep } : x)))}>{r.keep ? "Leave out" : "Keep"}</button>
        </div>
      ))}
      <div className="gp-rv">
        <input className="ld-in xs" aria-label="Your own goal" placeholder="Add your own goal" value={mine.title} onChange={(e) => setMine({ ...mine, title: e.target.value })} />
        <input className="ld-in xs" aria-label="Target" placeholder="Target" inputMode="decimal" value={mine.target} onChange={(e) => setMine({ ...mine, target: e.target.value.replace(/[^\d.]/g, "") })} />
        <OwnerSelect label="Owner" people={c.data.people} value={mine.owner} onChange={(v) => setMine({ ...mine, owner: v })} none="Pick an owner" />
        <span />
        <span />
      </div>
      <div style={{ padding: "0 18px 14px" }}>
        <ErrorLine error={err ? { message: err } : null} />
      </div>
    </div>
  );
}

export { ownerKey };
