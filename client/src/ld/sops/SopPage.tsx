import React from "react";
import { Link, useLocation, useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, Page } from "../ui";
import { fmtDate } from "../meta";
import { StatusActions, StatusPill, StepList, longDate, mdy, type SopFull, type SopStep } from "./shared";

const AREAS = [
  { key: "front_desk", label: "Front desk" },
  { key: "billing", label: "Billing" },
  { key: "clinical", label: "Clinical" },
  { key: "marketing", label: "Marketing" },
  { key: "admin", label: "Admin" },
] as const;
type Area = (typeof AREAS)[number]["key"];

/** One SOP: the read view with Edit, the edit state with Save and Cancel, and History. */
export default function SopPage() {
  const [, params] = useRoute("/handbook/sop/:id");
  const id = Number(params?.id ?? 0);
  const { currentOrgId } = useTenant();
  const q = trpc.sops.get.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0 && id > 0 });
  const list = trpc.sops.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const wantEdit = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("edit") === "1";
  const [editing, setEditing] = React.useState(wantEdit);
  const [history, setHistory] = React.useState(false);
  const s = q.data;
  const canEdit = Boolean(list.data?.canEdit);
  return (
    <Page rail="workspace" maxWidth={1140}>
      {!s && <div className="ld-empty">{q.isLoading ? "Loading..." : "That SOP is gone."}</div>}
      {s && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div className="ld-small ld-muted" style={{ marginBottom: 4 }}><Link href="/handbook?tab=sops">Handbook</Link> · SOPs · {s.areaLabel}</div>
              <h1 className="ld-h1" style={{ margin: 0 }}>{s.title}</h1>
            </div>
            {!editing && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="ld-btn" onClick={() => setHistory((v) => !v)}>{history ? "Close history" : "History"}</button>
                {canEdit && <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit</button>}
                {canEdit && <StatusActions sop={s} reviewerName={s.reviewerName} />}
              </div>
            )}
          </div>
          {editing ? (
            <Editor s={s} onDone={() => setEditing(false)} />
          ) : (
            <>
              <section className="ld-card" style={{ padding: "14px 18px" }}>
                <div className="sop-kv wide">
                  <b>Owner</b>
                  <span>{s.ownerName}</span>
                  <b>Status</b>
                  <span><StatusPill s={s} />{s.status === "review" && s.reviewerName ? <span className="ld-small ld-muted"> waiting on {s.reviewerName}</span> : null}</span>
                  <b>Who follows it</b>
                  <span>{s.follows || <span className="ld-muted">Not set</span>}</span>
                  <b>Next review</b>
                  <span>{s.nextReview ? longDate(s.nextReview) : <span className="ld-muted">When it is current</span>}</span>
                  <b>When</b>
                  <span>{s.when || <span className="ld-muted">Not set</span>}</span>
                  <b>Reviewed</b>
                  <span>{s.reviewedAt ? longDate(s.reviewedAt) : <span className="ld-muted">Not yet</span>}</span>
                  <b>Source</b>
                  <span>{s.sourceNote || "Typed"}{s.sourceUrl && s.sourceKind === "record" ? <> · <a href={s.sourceUrl} target="_blank" rel="noreferrer noopener">Recording</a></> : null}</span>
                  <b>Version</b>
                  <span>{s.version}</span>
                </div>
              </section>
              {history && (
                <section className="ld-card">
                  <div className="sop-hd"><b>History</b><span className="ld-small ld-muted">{s.history.length} version{s.history.length === 1 ? "" : "s"}</span></div>
                  {s.history.map((h) => (
                    <div key={h.id} className="sop-hrow">
                      <span className="ld-strong">Version {h.version}</span>
                      <span>{h.note}</span>
                      <span>{h.changedBy}</span>
                      <span className="ld-muted">{fmtDate(h.createdAt)}</span>
                      <span className="ld-muted">{h.stepCount} step{h.stepCount === 1 ? "" : "s"}</span>
                    </div>
                  ))}
                </section>
              )}
              <section className="ld-card">
                <div className="sop-hd"><b>Steps</b><span className="ld-small ld-muted">{s.steps.length}</span></div>
                <div style={{ padding: "14px 18px" }}>
                  {s.steps.length === 0 ? <span className="ld-muted">No steps yet. Press Edit to add them.</span> : <StepList steps={s.steps} />}
                </div>
              </section>
            </>
          )}
          <ErrorLine error={q.error} />
        </div>
      )}
    </Page>
  );
}

function Editor({ s, onDone }: { s: SopFull; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const emps = trpc.employees.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [title, setTitle] = React.useState(s.title);
  const [area, setArea] = React.useState<Area>(s.area);
  const [owner, setOwner] = React.useState(s.ownerKind);
  const [follows, setFollows] = React.useState(s.follows);
  const [when, setWhen] = React.useState(s.when);
  const [next, setNext] = React.useState(mdy(s.nextReview));
  const [steps, setSteps] = React.useState<SopStep[]>(s.steps.length ? s.steps : [{ title: "", detail: "", imageUrl: null }]);
  const [error, setError] = React.useState<string | null>(null);
  const save = trpc.sops.save.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.sops.get.invalidate(), utils.sops.list.invalidate()]);
      navigate(`/handbook/sop/${s.id}`, { replace: true });
      onDone();
    },
    onError: (e) => setError(e.message),
  });
  const set = (i: number, patch: Partial<SopStep>) => setSteps((all) => all.map((st, k) => (k === i ? { ...st, ...patch } : st)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((all) => {
      const j = i + d;
      if (j < 0 || j >= all.length) return all;
      const copy = [...all];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  const replace = async (i: number, file: File | undefined) => {
    if (!file) return;
    const { uploadFile } = await import("../meta");
    try {
      const r = await uploadFile("work", file, { organizationId: currentOrgId });
      set(i, { imageUrl: r.url ?? null });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: -58 }}>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
        <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: s.id, title: title.trim(), area, ownerKind: owner, follows, when, nextReview: next, steps })}>Save</button>
      </div>
      <section className="ld-card" style={{ padding: "14px 18px" }}>
        <div className="sop-form">
          <label className="ld-lbl" htmlFor="sop-title">Title</label>
          <input id="sop-title" className="ld-in" value={title} onChange={(e) => setTitle(e.target.value)} />
          <label className="ld-lbl" htmlFor="sop-area">Area</label>
          <select id="sop-area" className="ld-in" value={area} onChange={(e) => setArea(e.target.value as Area)}>
            {AREAS.map((a) => (
              <option key={a.key} value={a.key}>{a.label}</option>
            ))}
          </select>
          <label className="ld-lbl" htmlFor="sop-owner">Owner</label>
          <select id="sop-owner" className="ld-in" value={owner} onChange={(e) => setOwner(e.target.value)}>
            {(emps.data ?? []).map((e) => (
              <option key={e.id} value={e.kind}>{e.name}, {e.roleTitle}</option>
            ))}
          </select>
          <label className="ld-lbl" htmlFor="sop-next">Next review</label>
          <input id="sop-next" className="ld-in" style={{ width: 140 }} value={next} onChange={(e) => setNext(e.target.value)} placeholder="MM/DD/YYYY" />
          <label className="ld-lbl" htmlFor="sop-follows">Who follows it</label>
          <input id="sop-follows" className="ld-in" style={{ gridColumn: "2 / 5" }} value={follows} onChange={(e) => setFollows(e.target.value)} placeholder="Front desk, and Malik when he books" />
          <label className="ld-lbl" htmlFor="sop-when">When</label>
          <input id="sop-when" className="ld-in" style={{ gridColumn: "2 / 5" }} value={when} onChange={(e) => setWhen(e.target.value)} placeholder="Every new client inquiry" />
        </div>
      </section>
      <section className="ld-card">
        <div className="sop-hd"><b>Steps</b><button type="button" className="ld-btn" onClick={() => setSteps((all) => [...all, { title: "", detail: "", imageUrl: null }])}>Add step</button></div>
        <div style={{ padding: "4px 18px 14px" }}>
          {steps.map((st, i) => (
            <div key={i} className="sop-estep">
              <span className="sop-n">{i + 1}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                <input className="ld-in" value={st.title} onChange={(e) => set(i, { title: e.target.value })} placeholder="What to do, starting with a verb" aria-label={`Step ${i + 1}`} />
                <textarea className="ld-ta" rows={2} value={st.detail} onChange={(e) => set(i, { detail: e.target.value })} placeholder="What to watch for, if anything" aria-label={`Step ${i + 1} detail`} />
              </div>
              <div className="sop-eshot">{st.imageUrl ? <img src={st.imageUrl} alt="" /> : <span className="ld-small ld-muted">No screenshot</span>}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label className="ld-btn xs" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  Replace
                  <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => void replace(i, e.target.files?.[0])} />
                </label>
                <button type="button" className="ld-btn xs" onClick={() => set(i, { imageUrl: null })} disabled={!st.imageUrl}>No shot</button>
                <button type="button" className="ld-btn xs" onClick={() => move(i, -1)} disabled={i === 0}>Up</button>
                <button type="button" className="ld-btn xs" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>Down</button>
                <button type="button" className="ld-btn xs" style={{ color: "#b42318" }} onClick={() => setSteps((all) => all.filter((_, k) => k !== i))}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      </section>
      {error && <span className="ld-small" style={{ color: "#b42318" }}>{error}</span>}
    </>
  );
}
