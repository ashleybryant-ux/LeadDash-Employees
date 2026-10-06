import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";

/**
 * Importing from ClickUp, two ways: live through the ClickUp connection, or
 * from the CSV file ClickUp exports. Either way: pick the Spaces and the
 * workspace each one goes to; everything comes over, and ClickUp doesn't change.
 */
type Space = { id: string; name: string; folders: number; lists: number; goalsLike: boolean; tasks?: number };
type Picks = Record<string, { on: boolean; orgId: number; mode: "projects" | "goals" }>;

export function ImportPage({ orgId, onDone }: { orgId: number; onDone: () => void }) {
  const [tab, setTab] = React.useState<"live" | "csv">("live");
  const status = trpc.pj.importStatus.useQuery({ organizationId: orgId }, { refetchInterval: (d) => ((d as { state?: { data?: { status?: string } } })?.state?.data?.status === "running" ? 2000 : false) });
  const run = status.data;
  const counts = run ? (JSON.parse(run.counts || "{}") as Record<string, number>) : {};
  return (
    <div className="gp-imp">
      <div className="ld-row" role="tablist" aria-label="Where to import from">
        <button type="button" role="tab" aria-selected={tab === "live"} className={`gp-fb ${tab === "live" ? "sel" : ""}`} onClick={() => setTab("live")}>From ClickUp</button>
        <button type="button" role="tab" aria-selected={tab === "csv"} className={`gp-fb ${tab === "csv" ? "sel" : ""}`} onClick={() => setTab("csv")}>From a CSV file</button>
      </div>
      {tab === "live" ? <Live orgId={orgId} running={run?.status === "running"} onStarted={() => void status.refetch()} /> : <Csv orgId={orgId} running={run?.status === "running"} onStarted={() => void status.refetch()} />}
      <div className="gp-gl" style={{ padding: "16px 18px" }}>
        <b>What comes over</b>
        <ul className="gp-checks">
          <li>Folders and lists, in the same order</li>
          <li>Tasks and subtasks, with each list's own statuses</li>
          <li>Assignees, matched to your team by email or name</li>
          <li>Due dates, start dates, time estimates, priorities and tags</li>
          <li>Custom fields, like Progress (live import only; the CSV file doesn't include them)</li>
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
          {run.status === "running" && <p className="ld-small ld-muted" style={{ margin: "6px 0 0" }}>Attachments download one at a time, so a big export takes a few minutes. You can leave this page.</p>}
          {run.status === "done" && <button type="button" className="ld-btn" style={{ marginTop: 10 }} onClick={onDone}>See the lists</button>}
        </div>
      )}
    </div>
  );
}

/** The Space rows: bring over, where it goes, and as what. */
function SpaceRows({ spaces, workspaces, picks, setPicks, orgId }: { spaces: Space[]; workspaces: { id: number; name: string }[]; picks: Picks; setPicks: (p: Picks) => void; orgId: number }) {
  return (
    <>
      <div className="gp-imh">
        <span />
        <span>ClickUp Space</span>
        <span>Has</span>
        <span>Goes to</span>
        <span>As</span>
      </div>
      {spaces.map((s) => {
        const p = picks[s.id] ?? { on: false, orgId, mode: "projects" as const };
        return (
          <div key={s.id} className="gp-im">
            <input type="checkbox" aria-label={`Bring over ${s.name}`} checked={p.on} onChange={(e) => setPicks({ ...picks, [s.id]: { ...p, on: e.target.checked } })} />
            <b style={{ fontWeight: 700 }}>{s.name}</b>
            <span className="ld-small ld-muted">
              {s.folders} folder{s.folders === 1 ? "" : "s"} · {s.lists} list{s.lists === 1 ? "" : "s"}
              {s.tasks != null ? ` · ${s.tasks} task${s.tasks === 1 ? "" : "s"}` : ""}
            </span>
            <select className="ld-in xs" aria-label={`Workspace for ${s.name}`} value={p.orgId} disabled={!p.on} onChange={(e) => setPicks({ ...picks, [s.id]: { ...p, orgId: Number(e.target.value) } })}>
              {workspaces.map((w) => (
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
    </>
  );
}

/** Picks the workspace each Space goes to by name, with the Annual Planning kind of Space as goals. */
function guessPicks(spaces: Space[], workspaces: { id: number; name: string }[], orgId: number): Picks {
  const clean = (s: string) => s.toLowerCase().replace(/,? (inc|llc)\.?$/, "").trim();
  return Object.fromEntries(
    spaces.map((s, i) => {
      const w = workspaces.find((x) => clean(x.name) === clean(s.name)) ?? workspaces.find((x) => clean(x.name).includes(clean(s.name)) || clean(s.name).includes(clean(x.name)));
      return [s.id, { on: i === 0 || s.goalsLike || !!w, orgId: w?.id ?? orgId, mode: s.goalsLike ? "goals" : "projects" }];
    })
  );
}

const toPicks = (spaces: Space[], picks: Picks) => spaces.filter((s) => picks[s.id]?.on).map((s) => ({ spaceId: s.id, name: s.name, orgId: picks[s.id].orgId, mode: picks[s.id].mode }));

function Live({ orgId, running, onStarted }: { orgId: number; running: boolean; onStarted: () => void }) {
  const q = trpc.pj.clickupSpaces.useQuery({ organizationId: orgId }, { retry: false });
  const start = trpc.pj.startImport.useMutation({ onSuccess: onStarted });
  const [picks, setPicks] = React.useState<Picks>({});
  React.useEffect(() => {
    if (q.data) setPicks(guessPicks(q.data.spaces, q.data.workspaces, orgId));
  }, [q.data, orgId]);
  if (q.error)
    return (
      <div className="gp-gl" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <b style={{ fontSize: 15 }}>ClickUp</b>
        <ErrorLine error={q.error} />
        <button type="button" className="ld-btn" style={{ alignSelf: "flex-start" }} onClick={() => void q.refetch()}>Try again</button>
      </div>
    );
  if (q.data && !q.data.connected)
    return (
      <div className="gp-gl" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="ld-between">
          <b style={{ fontSize: 15 }}>ClickUp</b>
          <span className="gp-sd">Not connected</span>
        </div>
        <span className="ld-small ld-muted">Connect ClickUp once, then come back here and pick what to bring over. Or use the CSV file tab. Nothing in ClickUp changes.</span>
        <a className="ld-btn p" style={{ alignSelf: "flex-start" }} href={`/api/oauth/clickup/start?organizationId=${orgId}`}>Connect ClickUp</a>
      </div>
    );
  return (
    <div className="gp-gl" style={{ padding: "16px 18px" }}>
      <div className="ld-between">
        <b style={{ fontSize: 15 }}>ClickUp</b>
        {q.data && <span className="gp-sd s-on">{q.data.from ? `Connected in ${q.data.from}` : "Connected"}</span>}
      </div>
      <p className="ld-small ld-muted" style={{ margin: "6px 0 10px" }}>Pick the Spaces to bring over and the workspace each one goes to. Nothing in ClickUp changes.</p>
      {!q.data && <p className="ld-small ld-muted">Reading your ClickUp Spaces. This can take a minute.</p>}
      {q.data?.connected && !q.data.spaces.length && <p className="ld-small ld-muted">No Spaces found in the connected ClickUp.</p>}
      {q.data && <SpaceRows spaces={q.data.spaces} workspaces={q.data.workspaces} picks={picks} setPicks={setPicks} orgId={orgId} />}
      <span className="ld-row" style={{ marginTop: 12 }}>
        <button type="button" className="ld-btn p" disabled={running || start.isPending || !Object.values(picks).some((p) => p.on)} onClick={() => q.data && start.mutate({ organizationId: orgId, picks: toPicks(q.data.spaces, picks) })}>
          {running ? "Importing" : "Import"}
        </button>
      </span>
      <ErrorLine error={start.error} />
    </div>
  );
}

function Csv({ orgId, running, onStarted }: { orgId: number; running: boolean; onStarted: () => void }) {
  const read = trpc.pj.csvSpaces.useMutation();
  const start = trpc.pj.startCsvImport.useMutation({ onSuccess: onStarted });
  const [csv, setCsv] = React.useState<{ name: string; text: string } | null>(null);
  const [picks, setPicks] = React.useState<Picks>({});
  const inputRef = React.useRef<HTMLInputElement>(null);
  const load = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setCsv({ name: file.name, text });
    read.mutate({ organizationId: orgId, csv: text }, { onSuccess: (d) => setPicks(guessPicks(d.spaces, d.workspaces, orgId)) });
  };
  const d = read.data;
  return (
    <div className="gp-gl" style={{ padding: "16px 18px" }}>
      <div className="ld-between">
        <b style={{ fontSize: 15 }}>A ClickUp export</b>
        {csv && <span className="gp-sd s-on">{csv.name}</span>}
      </div>
      <p className="ld-small ld-muted" style={{ margin: "6px 0 10px" }}>In ClickUp, open Workspace settings, then Import/Export, and export your tasks as CSV. Upload that file here. One ClickUp Workspace can be split across your workspaces by Space.</p>
      <input ref={inputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} aria-label="ClickUp CSV export" onChange={(e) => void load(e.target.files?.[0])} />
      <span className="ld-row">
        <button type="button" className="ld-btn" onClick={() => inputRef.current?.click()} disabled={read.isPending}>{csv ? "Choose another file" : "Choose the CSV file"}</button>
        {read.isPending && <span className="ld-small ld-muted">Reading the file</span>}
      </span>
      <ErrorLine error={read.error} />
      {d && (
        <>
          <p className="ld-small ld-muted" style={{ margin: "12px 0 10px" }}>{d.rows} tasks in {d.spaces.length} Space{d.spaces.length === 1 ? "" : "s"}. Pick the workspace each one goes to.</p>
          <SpaceRows spaces={d.spaces} workspaces={d.workspaces} picks={picks} setPicks={setPicks} orgId={orgId} />
          <span className="ld-row" style={{ marginTop: 12 }}>
            <button type="button" className="ld-btn p" disabled={running || start.isPending || !csv || !Object.values(picks).some((p) => p.on)} onClick={() => csv && start.mutate({ organizationId: orgId, csv: csv.text, picks: toPicks(d.spaces, picks) })}>
              {running ? "Importing" : "Import"}
            </button>
          </span>
          <ErrorLine error={start.error} />
        </>
      )}
    </div>
  );
}
