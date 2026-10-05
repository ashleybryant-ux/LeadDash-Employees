import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";

/** Importing from ClickUp: pick the Spaces and the workspace each goes to; everything comes over, and ClickUp doesn't change. */
export function ImportPage({ orgId, onDone }: { orgId: number; onDone: () => void }) {
  const q = trpc.pj.clickupSpaces.useQuery({ organizationId: orgId }, { retry: false });
  const status = trpc.pj.importStatus.useQuery({ organizationId: orgId }, { refetchInterval: (d) => ((d as { state?: { data?: { status?: string } } })?.state?.data?.status === "running" ? 2000 : false) });
  const start = trpc.pj.startImport.useMutation({ onSuccess: () => void status.refetch() });
  const [picks, setPicks] = React.useState<Record<string, { on: boolean; orgId: number; mode: "projects" | "goals" }>>({});
  React.useEffect(() => {
    if (!q.data) return;
    setPicks(Object.fromEntries(q.data.spaces.map((s, i) => [s.id, { on: i === 0 || s.goalsLike, orgId, mode: s.goalsLike ? "goals" : "projects" }])));
  }, [q.data, orgId]);
  const run = status.data;
  const running = run?.status === "running" || start.isPending;
  const counts = run ? (JSON.parse(run.counts || "{}") as Record<string, number>) : {};
  if (q.error)
    return (
      <div className="gp-gl" style={{ padding: 24, maxWidth: 720, display: "flex", flexDirection: "column", gap: 12 }}>
        <b style={{ fontSize: 15 }}>ClickUp</b>
        <ErrorLine error={q.error} />
        <button type="button" className="ld-btn" style={{ alignSelf: "flex-start" }} onClick={() => void q.refetch()}>Try again</button>
      </div>
    );
  if (q.data && !q.data.connected)
    return (
      <div className="gp-gl" style={{ padding: 24, maxWidth: 720, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="ld-between">
          <b style={{ fontSize: 15 }}>ClickUp</b>
          <span className="gp-sd">Not connected</span>
        </div>
        <span className="ld-small ld-muted">Connect ClickUp once, then come back here and pick what to bring over. Nothing in ClickUp changes.</span>
        <a className="ld-btn p" style={{ alignSelf: "flex-start" }} href={`/api/oauth/clickup/start?organizationId=${orgId}`}>Connect ClickUp</a>
      </div>
    );
  return (
    <div className="gp-imp">
      <div className="gp-gl" style={{ padding: "16px 18px" }}>
        <div className="ld-between">
          <b style={{ fontSize: 15 }}>ClickUp</b>
          {q.data && <span className="gp-sd s-on">{q.data.from ? `Connected in ${q.data.from}` : "Connected"}</span>}
        </div>
        <p className="ld-small ld-muted" style={{ margin: "6px 0 10px" }}>Pick the Spaces to bring over and the workspace each one goes to. Nothing in ClickUp changes.</p>
        <div className="gp-imh">
          <span />
          <span>ClickUp Space</span>
          <span>Has</span>
          <span>Goes to</span>
          <span>As</span>
        </div>
        {!q.data && <p className="ld-small ld-muted">Reading your ClickUp Spaces. This can take a minute.</p>}
        {q.data?.connected && !q.data.spaces.length && <p className="ld-small ld-muted">No Spaces found in the connected ClickUp.</p>}
        {q.data?.spaces.map((s) => {
          const p = picks[s.id] ?? { on: false, orgId, mode: "projects" as const };
          return (
            <div key={s.id} className="gp-im">
              <input type="checkbox" aria-label={`Bring over ${s.name}`} checked={p.on} onChange={(e) => setPicks({ ...picks, [s.id]: { ...p, on: e.target.checked } })} />
              <b style={{ fontWeight: 700 }}>{s.name}</b>
              <span className="ld-small ld-muted">{s.folders} folder{s.folders === 1 ? "" : "s"} · {s.lists} list{s.lists === 1 ? "" : "s"}</span>
              <select className="ld-in xs" aria-label={`Workspace for ${s.name}`} value={p.orgId} disabled={!p.on} onChange={(e) => setPicks({ ...picks, [s.id]: { ...p, orgId: Number(e.target.value) } })}>
                {q.data!.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
              <select className="ld-in xs" aria-label={`How to bring over ${s.name}`} value={p.mode} disabled={!p.on} onChange={(e) => setPicks({ ...picks, [s.id]: { ...p, mode: e.target.value as "projects" | "goals" } })}>
                <option value="projects">Projects</option>
                <option value="goals">Goals and Projects</option>
              </select>
            </div>
          );
        })}
      </div>
      <div className="gp-gl" style={{ padding: "16px 18px" }}>
        <b>What comes over</b>
        <ul className="gp-checks">
          <li>Folders and lists, in the same order</li>
          <li>Tasks and subtasks, with each list's own statuses</li>
          <li>Assignees, matched to your team by email or first name</li>
          <li>Due dates, start dates, time estimates, priorities and tags</li>
          <li>Custom fields, like Progress</li>
          <li>Descriptions, checklists, comments and attachments</li>
          <li>"Goals and Projects": goals in a Goals list (like the 12 Week Year) also become goals, and weekly execution scores go on the scorecard</li>
        </ul>
        <span className="ld-small ld-muted">Running it again updates what came over before instead of copying it twice.</span>
      </div>
      {run && (
        <div className="gp-gl" style={{ padding: "16px 18px" }}>
          <div className="ld-between">
            <b>{run.status === "running" ? "Bringing it over" : run.status === "done" ? "Done" : "It stopped"}</b>
            <span className={`ld-pill ${run.status === "done" ? "green" : run.status === "failed" ? "red" : "amber"}`}>{run.status === "running" ? run.progress : run.status === "done" ? "Finished" : "Stopped"}</span>
          </div>
          <p className="ld-small" style={{ margin: "8px 0 0" }}>
            {counts.folders ?? 0} folders, {counts.lists ?? 0} lists, {counts.tasks ?? 0} tasks, {counts.comments ?? 0} comments, {counts.files ?? 0} files, {counts.goals ?? 0} goals so far.
          </p>
          {run.error && <p className="ld-small" style={{ color: "#b42318", margin: "6px 0 0" }}>{run.error}</p>}
          {run.status === "running" && <p className="ld-small ld-muted" style={{ margin: "6px 0 0" }}>ClickUp lets the app read about 100 things a minute, so a big workspace takes a while. You can leave this page.</p>}
        </div>
      )}
      <span className="ld-row">
        <button
          type="button"
          className="ld-btn p"
          disabled={running || !Object.values(picks).some((p) => p.on)}
          onClick={() => start.mutate({ organizationId: orgId, picks: (q.data?.spaces ?? []).filter((s) => picks[s.id]?.on).map((s) => ({ spaceId: s.id, name: s.name, orgId: picks[s.id].orgId, mode: picks[s.id].mode })) })}
        >
          {running ? "Importing" : run?.status === "done" ? "Import again" : "Import"}
        </button>
        {run?.status === "done" && <button type="button" className="ld-btn" onClick={onDone}>See the lists</button>}
      </span>
      <ErrorLine error={start.error} />
    </div>
  );
}
