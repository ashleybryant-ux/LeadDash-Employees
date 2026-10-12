import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { BIG_JOB, useHoursAsk } from "../HoursAsk";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs, UnderlineTabs } from "../ui";
import { APP_STATUS, CHANNEL_LABEL, OPP_TABS, fmtDate, openDownload, parseJson, uploadFile } from "../meta";
import CapabilityTab from "./Capability";
import type { AppRow, Award, OppRow, Question, Requirements, Attachment } from "../types";

type EmpKind = "grants" | "speaking";
type OppKind = "grant" | "pitch" | "accelerator" | "speaking" | "bid" | "media";

const HOST_LABEL: Record<OppKind, string> = { grant: "Funder", pitch: "Host", accelerator: "Program", speaking: "Organizer", bid: "Agency", media: "Outlet" };
const AMOUNT_LABEL: Record<OppKind, string> = { grant: "Award", pitch: "Prize", accelerator: "Offer", speaking: "Pays", bid: "Goes in", media: "Audience" };
const THING: Record<OppKind, string> = { grant: "Opportunity", pitch: "Competition", accelerator: "Program", speaking: "Event", bid: "Bid", media: "Media" };

const OPP_COLS = "minmax(0,2.2fr) minmax(0,1.3fr) 130px 140px 130px 128px";
const APP_COLS = "minmax(0,2.4fr) minmax(0,1.4fr) 130px 160px 128px";
const AWARD_COLS = "minmax(0,2.2fr) minmax(0,1.4fr) 130px 120px 160px 128px";

/** "04/15/2027" typed in becomes "Apr 15, 2027" on screen. */
function showDate(v: string) {
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? fmtDate(new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]))) : v;
}

function callPill(o: { fitCall: string; fitScore: number }) {
  const label = o.fitCall === "skip" ? "Skip" : o.fitCall === "partner" ? "Partner" : "Apply";
  return <span className={`ld-pill ${o.fitCall === "skip" ? "gray" : o.fitCall === "partner" ? "amber" : "green"}`}>{`${label} · ${o.fitScore}`}</span>;
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body" style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

/** Morgan's and Taylor's Work tab: Opportunities, Applications, Awards. */
export default function ApplyWork({ emp, embedded }: { emp: EmployeeRow; embedded?: boolean }) {
  const empKind: EmpKind = emp.kind === "speaking" ? "speaking" : "grants";
  const { currentOrgId } = useTenant();
  const initial = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
  const [tab, setTab] = React.useState<"opps" | "apps" | "awards" | "cap">(initial === "applications" ? "apps" : initial === "awards" ? "awards" : initial === "capability" && empKind === "grants" ? "cap" : "opps");
  const [kind, setKind] = React.useState<OppKind | "skipped">(OPP_TABS[empKind][0].key);
  const [adding, setAdding] = React.useState<null | "link" | "upload">(null);
  const linkedOpp = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("opp")) || null : null;
  const opps = trpc.opps.list.useQuery({ organizationId: currentOrgId, employee: empKind }, { refetchInterval: (q) => ((q.state.data ?? []).some((o) => o.packageStatus === "fetching") ? 5000 : false) });
  const apps = trpc.applications.list.useQuery({ organizationId: currentOrgId, employee: empKind }, { refetchInterval: (q) => ((q.state.data ?? []).some((a) => a.status === "writing") ? 5000 : 30_000) });
  const utils = trpc.useUtils();
  const find = trpc.opps.find.useMutation({ onSuccess: () => utils.opps.list.invalidate() });

  const oppList = opps.data ?? [];
  // Skipped ones (the employee's call, or yours) sit on their own tab so you never review the same thing twice.
  const isSkipped = (o: OppRow) => o.status === "dismissed" || (o.fitCall === "skip" && (o.fitScore > 0 || !!o.fitReason));
  const skipped = oppList.filter(isSkipped);
  const live = oppList.filter((o) => !isSkipped(o));
  // A chat card's Details button opens that row on the right folder tab.
  const linkedKind = linkedOpp ? oppList.find((o) => o.id === linkedOpp)?.kind : undefined;
  React.useEffect(() => {
    if (linkedKind && OPP_TABS[empKind].some((t) => t.key === linkedKind)) setKind(linkedKind as OppKind);
  }, [linkedKind, empKind]);
  const appList = (apps.data ?? []).filter((a) => a.status !== "awarded" && a.status !== "declined");
  const awardList = (apps.data ?? []).filter((a) => a.status === "awarded" || a.status === "declined");

  const Shell = embedded ? EmbeddedShell : MainShell;
  return (
    <Shell>
      <div className="ld-row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
        {find.data && !find.isPending && (
          <span className="ld-small ld-muted">{find.data.added ? `Added ${find.data.added} from ${find.data.queries.length} searches.` : `Nothing new from ${find.data.queries.length} searches.`}</span>
        )}
        <button type="button" className="ld-btn" onClick={() => { setTab("opps"); setAdding((v) => (v === "link" ? null : "link")); }}>
          Add link
        </button>
        <button type="button" className="ld-btn" onClick={() => { setTab("opps"); setAdding((v) => (v === "upload" ? null : "upload")); }}>
          Upload RFP
        </button>
        <button type="button" className="ld-btn p" disabled={find.isPending} onClick={() => { setTab("opps"); find.mutate({ organizationId: currentOrgId, employee: empKind, kind: kind === "skipped" ? OPP_TABS[empKind][0].key : kind }); }}>
          {find.isPending ? "Searching..." : kind === "media" ? "Find press" : empKind === "speaking" ? "Find events" : "Find more"}
        </button>
      </div>
      <ErrorLine error={find.error} />

      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "opps", label: `Opportunities (${live.length})` },
          { key: "apps", label: `Applications (${appList.length})` },
          { key: "awards", label: `${empKind === "speaking" ? "Results" : "Awards"} (${awardList.length})` },
          ...(empKind === "grants" ? [{ key: "cap" as const, label: "Capability statement" }] : []),
        ]}
      />

      {tab === "opps" &&
        (OPP_TABS[empKind].length > 1 ? (
          <FolderTabs
            value={kind}
            onChange={setKind}
            tabs={[...OPP_TABS[empKind].map((t) => ({ key: t.key, label: `${t.label} (${live.filter((o) => o.kind === t.key).length})` })), { key: "skipped", label: `Skipped (${skipped.length})` }]}
          >
            {adding === "link" && kind !== "skipped" && <AddPanel empKind={empKind} onDone={() => setAdding(null)} />}
            {adding === "upload" && kind !== "skipped" && <UploadPanel empKind={empKind} onDone={() => setAdding(null)} onStarted={() => { setAdding(null); setTab("apps"); }} />}
            {kind === "skipped" ? (
              <OppTable initialOpen={linkedOpp} list={skipped} kind={OPP_TABS[empKind][0].key} skippedTab loading={opps.isLoading} apps={apps.data ?? []} emp={emp} onOpenApps={() => setTab("apps")} />
            ) : (
              <OppTable initialOpen={linkedOpp} list={live.filter((o) => o.kind === kind)} kind={kind} loading={opps.isLoading} apps={apps.data ?? []} emp={emp} onOpenApps={() => setTab("apps")} />
            )}
          </FolderTabs>
        ) : (
          <FolderTabs
            value={kind}
            onChange={setKind}
            tabs={[{ key: OPP_TABS[empKind][0].key, label: `${OPP_TABS[empKind][0].label} (${live.length})` }, { key: "skipped", label: `Skipped (${skipped.length})` }]}
          >
            {adding === "link" && kind !== "skipped" && <AddPanel empKind={empKind} onDone={() => setAdding(null)} />}
            {adding === "upload" && kind !== "skipped" && <UploadPanel empKind={empKind} onDone={() => setAdding(null)} onStarted={() => { setAdding(null); setTab("apps"); }} />}
            {kind === "skipped" ? (
              <OppTable initialOpen={linkedOpp} list={skipped} kind={OPP_TABS[empKind][0].key} skippedTab loading={opps.isLoading} apps={apps.data ?? []} emp={emp} onOpenApps={() => setTab("apps")} />
            ) : (
              <OppTable initialOpen={linkedOpp} list={live} kind={kind} loading={opps.isLoading} apps={apps.data ?? []} emp={emp} onOpenApps={() => setTab("apps")} />
            )}
          </FolderTabs>
        ))}
      {tab === "apps" && <AppTable list={appList} loading={apps.isLoading} emp={emp} />}
      {tab === "awards" && <AwardTable list={awardList} loading={apps.isLoading} emp={emp} />}
      {tab === "cap" && <CapabilityTab />}
    </Shell>
  );
}

function MainShell({ children }: { children: React.ReactNode }) {
  return <main className="ld-main" style={{ padding: "28px 36px" }}>{children}</main>;
}
/** Inside Taylor's Press tab: the same screen without its own page frame. */
function EmbeddedShell({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>;
}

// ==========================================
// Add an opportunity from a link or the RFP file
// ==========================================

function AddPanel({ empKind, onDone }: { empKind: EmpKind; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const addLink = trpc.opps.addLink.useMutation();

  const submit = async () => {
    setError(null);
    try {
      if (!url.trim()) throw new Error("Paste a link.");
      await addLink.mutateAsync({ organizationId: currentOrgId, employee: empKind, url: url.trim() });
      await utils.opps.list.invalidate();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ background: "var(--ld-hover)", padding: "16px 18px", borderBottom: "1px solid var(--ld-line)", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="ld-st">{empKind === "speaking" ? "Add an event or media request" : "Add an opportunity"}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 640 }}>
          <label htmlFor="add-link" className="ld-lbl">{empKind === "speaking" ? "Call for proposals or request link" : "Page link"}</label>
          <input id="add-link" className="ld-in lg" type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </div>
        {error && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>{error}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={addLink.isPending} onClick={submit}>{addLink.isPending ? "Reading..." : "Add"}</button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

/** A file that came with an opportunity, before it goes up: the RFP or rules, or a form Morgan fills in. */
type Picked = { file: File; role: "rfp" | "form" };
const FORM_NAME = /form|attachment|appendix|exhibit|application|budget|template|certif|assurance|worksheet|cover sheet|w-?9|questionnaire/i;
function roleOf(file: File, already: Picked[]): Picked["role"] {
  const hasRfp = already.some((p) => p.role === "rfp");
  const looksLikeForm = /\.(xlsx|xls|docx|doc)$/i.test(file.name) || FORM_NAME.test(file.name);
  if (!hasRfp && !looksLikeForm) return "rfp";
  return looksLikeForm || hasRfp ? "form" : "rfp";
}

/** Upload the RFP (or a competition's rules) and every form that came with it; Complete it starts the application. */
function UploadPanel({ empKind, onDone, onStarted }: { empKind: EmpKind; onDone: () => void; onStarted: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [files, setFiles] = React.useState<Picked[]>([]);
  const [busy, setBusy] = React.useState<null | "complete" | "score">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [over, setOver] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const start = trpc.applications.start.useMutation();
  const hoursAsk = useHoursAsk();

  const pick = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(list)) if (!next.some((p) => p.file.name === f.name && p.file.size === f.size)) next.push({ file: f, role: roleOf(f, next) });
      // The RFP goes up first: it makes the opportunity.
      return next.sort((a, b) => (a.role === b.role ? 0 : a.role === "rfp" ? -1 : 1));
    });
  };

  const send = async (then: "complete" | "score") => {
    setError(null);
    if (!files.length) return setError("Choose the RFP and its forms first.");
    setBusy(then);
    try {
      const first = await uploadFile("rfp", files[0].file, { organizationId: currentOrgId, employee: empKind, role: files[0].role });
      for (const p of files.slice(1)) await uploadFile("rfp", p.file, { organizationId: currentOrgId, employee: empKind, role: p.role, opportunityId: first.id });
      if (then === "complete") await start.mutateAsync({ organizationId: currentOrgId, opportunityId: first.id });
      await Promise.all([utils.opps.list.invalidate(), utils.applications.list.invalidate()]);
      if (then === "complete") onStarted();
      else onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ background: "var(--ld-hover)", padding: "16px 18px", borderBottom: "1px solid var(--ld-line)", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <span className="ld-st">{empKind === "speaking" ? "Upload a call for proposals" : "Upload an RFP, grant or competition"}</span>
        <div
          className={`ld-drop ${over ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
        >
          <input ref={fileRef} type="file" multiple className="ld-sr" id="up-files" accept=".pdf,.docx,.xlsx,.doc,.xls,.pptx,.txt,.md" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
          <span>
            Drop the RFP or rules and every form that came with it, or{" "}
            <button type="button" className="ld-linkbtn" onClick={() => fileRef.current?.click()}>choose files</button>.
          </span>
          {files.length > 0 && (
            <div className="ld-drop-list">
              {files.map((p) => (
                <div key={`${p.file.name}-${p.file.size}`} className="ld-drop-file">
                  <span className="ld-clip">{p.file.name}</span>
                  <span className={`ld-pill ${p.role === "rfp" ? "gray" : "blue"}`}>{p.role === "rfp" ? "The RFP" : "Form to fill"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="ld-small ld-muted">{empKind === "speaking" ? "Taylor reads the requirements and writes the proposal." : "Morgan reads the requirements, fills each form from the Brain, and writes the narrative. A full grant uses 8 work hours; a pitch competition or accelerator uses 3."}</span>
        {hoursAsk.question("upload")}
        {error && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>{error}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={!!busy || hoursAsk.asking("upload")} onClick={() => hoursAsk.confirm("upload", `${BIG_JOB.grant} (a pitch competition or accelerator uses 3)`, () => void send("complete"))}>{busy === "complete" ? "Uploading..." : "Complete it"}</button>
        <button type="button" className="ld-btn" disabled={!!busy} onClick={() => void send("score")}>{busy === "score" ? "Reading..." : "Score fit first"}</button>
        <button type="button" className="ld-btn" disabled={!!busy} onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

// ==========================================
// Opportunities
// ==========================================

function OppTable({ list, kind, loading, apps, emp, onOpenApps, initialOpen, skippedTab }: { skippedTab?: boolean; list: OppRow[]; kind: OppKind; loading: boolean; apps: AppRow[]; emp: EmployeeRow; onOpenApps: () => void; initialOpen?: number | null }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [open, setOpen] = React.useState<number | null>(initialOpen ?? null);
  const [asking, setAsking] = React.useState<number | null>(null);
  const start = trpc.applications.start.useMutation({ onSuccess: async () => { await utils.applications.list.invalidate(); await utils.opps.list.invalidate(); onOpenApps(); } });
  const hours = useHoursAsk();
  const skip = trpc.opps.skip.useMutation({ onSuccess: () => utils.opps.list.invalidate() });
  const restore = trpc.opps.restore.useMutation({ onSuccess: () => utils.opps.list.invalidate() });
  const refresh = trpc.opps.refreshPackage.useMutation({ onSuccess: () => utils.opps.list.invalidate() });
  const dl = trpc.opps.downloadPackage.useMutation({ onSuccess: openDownload });

  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: OPP_COLS }}>
        <span>{THING[kind]}</span>
        <span>{HOST_LABEL[kind]}</span>
        <span>{kind === "bid" ? "Due" : "Deadline"}</span>
        <span>{AMOUNT_LABEL[kind]}</span>
        <span>{kind === "bid" ? "Fit" : `${emp.name}'s call`}</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : skippedTab ? `Nothing skipped. Anything ${emp.name} calls Skip, or you skip, lands here.` : `Nothing here yet. Press ${kind === "media" ? "Find press" : emp.kind === "speaking" ? "Find events" : "Find more"}, add one, or ask ${emp.name} in Chat.`}</div>}
      {list.map((o) => {
        const isOpen = open === o.id;
        const app = apps.find((a) => a.opportunityId === o.id);
        const reqs = parseJson<Requirements>(o.requirements, {});
        return (
          <React.Fragment key={o.id}>
            <div
              className={`ld-rw ${isOpen ? "open" : ""}`}
              style={{ gridTemplateColumns: OPP_COLS, cursor: "pointer" }}
              aria-expanded={isOpen}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button,a,input")) return;
                setOpen(isOpen ? null : o.id);
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span className="ld-strong">{o.title}</span>
                {o.source === "BidPrime" && <span className="ld-small ld-muted">From BidPrime</span>}
                {skippedTab && <span className="ld-small ld-muted">{THING[o.kind as OppKind] ?? o.kind}{o.status === "dismissed" ? " · you skipped it" : ` · ${emp.name}'s call`}</span>}
              </span>
              <span>{o.host}</span>
              <span>{o.deadline || reqs.due || "Not posted"}</span>
              <span>{o.kind === "bid" ? goesIn(reqs) : o.amount || "Not listed"}</span>
              {app ? <span className={`ld-pill ${APP_STATUS[app.status]?.cls ?? "gray"}`}>{APP_STATUS[app.status]?.label ?? app.status}</span> : o.fitScore > 0 || o.fitReason ? callPill(o) : <span className="ld-pill gray">Not scored</span>}
              {app ? (
                <button type="button" className="ld-btn" onClick={onOpenApps}>Open</button>
              ) : skippedTab ? (
                <button type="button" className="ld-btn" disabled={restore.isPending} onClick={() => restore.mutate({ organizationId: currentOrgId, id: o.id })}>Bring back</button>
              ) : (
                <button type="button" className={`ld-btn ${o.fitCall === "skip" ? "" : "p"}`} disabled={start.isPending} onClick={() => hours.confirm(`opp-${o.id}`, o.kind === "grant" ? BIG_JOB.grant : BIG_JOB.application, () => start.mutate({ organizationId: currentOrgId, opportunityId: o.id }))}>
                  Apply
                </button>
              )}
            </div>
            {hours.asking(`opp-${o.id}`) && <div style={{ padding: "0 18px 12px" }}>{hours.question(`opp-${o.id}`)}</div>}
            {isOpen && (
              <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {o.kind === "media" ? (
                    <>
                      {o.audience && <KV label="Audience">{o.audience}</KV>}
                      {o.angle && <KV label="Angle to pitch">{o.angle}</KV>}
                      {o.fitReason && <KV label={o.fitCall === "skip" ? "Why skip" : "Why it fits"}>{o.fitReason}</KV>}
                    </>
                  ) : o.kind === "speaking" ? (
                    <>
                      {o.audience && <KV label="Audience">{o.audience}</KV>}
                      {o.angle && <KV label="Session to pitch">{o.angle}</KV>}
                      {(o.location || o.eventDate) && <KV label="Event">{[o.eventDate, o.location].filter(Boolean).join(", ")}</KV>}
                    </>
                  ) : o.kind === "bid" ? (
                    <>
                      {o.summary && <KV label="What they want">{o.summary}</KV>}
                      {o.fitReason && <KV label={o.fitCall === "skip" ? "Why skip" : "Why it fits"}>{o.fitReason}</KV>}
                      {(reqs.attachments ?? []).some((a) => a.needsSignature) && (
                        <KV label="Needs you">{(reqs.attachments ?? []).filter((a) => a.needsSignature).map((a) => a.name).join(", ")} (signature)</KV>
                      )}
                      {(reqs.questionsDue || reqs.questionsTo) && <KV label="Questions due">{[reqs.questionsDue, reqs.questionsTo].filter(Boolean).join(", to ")}</KV>}
                    </>
                  ) : o.kind === "grant" ? (
                    <>
                      {(reqs.eligibility || o.eligibility) && <KV label="Who can apply">{reqs.eligibility || o.eligibility}</KV>}
                      {o.summary && <KV label="What it funds">{o.summary}</KV>}
                    </>
                  ) : (
                    <>
                      <KV label={AMOUNT_LABEL[o.kind as OppKind]}>{[o.amount, o.equity].filter(Boolean).join(", ") || "Not listed"}</KV>
                      {o.stage && <KV label="Stage">{o.stage}</KV>}
                      {(reqs.eligibility || o.eligibility) && <KV label="Who can apply">{reqs.eligibility || o.eligibility}</KV>}
                      {(o.eventDate || reqs.eventDate) && <KV label={o.kind === "pitch" ? "Pitch day" : "Program dates"}>{[o.eventDate || reqs.eventDate, o.location].filter(Boolean).join(", ")}</KV>}
                    </>
                  )}
                  {o.fitReason && o.kind !== "bid" && <KV label={o.fitCall === "skip" ? "Why skip" : o.fitCall === "partner" ? "Apply with a partner" : "Why apply"}>{o.fitReason}</KV>}
                  {o.funderHistory && (
                    <KV label="Funder history">
                      {o.funderHistory}
                      {o.funderHistoryUrl && (
                        <>
                          {" "}
                          <a href={o.funderHistoryUrl} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600 }}>Source</a>
                        </>
                      )}
                    </KV>
                  )}
                  {reqs.contact && (reqs.contact.name || reqs.contact.phone || reqs.contact.email) && (
                    <KV label="Contact">
                      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {(reqs.contact.name || reqs.contact.title) && <span>{[reqs.contact.name, reqs.contact.title].filter(Boolean).join(", ")}</span>}
                        {reqs.contact.phone && <a href={`tel:${reqs.contact.phone.replace(/[^\d+]/g, "")}`} style={{ fontWeight: 600 }}>{reqs.contact.phone}</a>}
                        {reqs.contact.email && <a href={`mailto:${reqs.contact.email}`} style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{reqs.contact.email}</a>}
                      </span>
                    </KV>
                  )}
                  {o.sourceUrl && (
                    <KV label="Source">
                      <a href={o.sourceUrl} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600 }}>
                        {o.sourceUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                      </a>
                    </KV>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Package opp={o} reqs={reqs} onRetry={() => refresh.mutate({ organizationId: currentOrgId, id: o.id })} />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button type="button" className="ld-btn" disabled={dl.isPending || o.files.length === 0} onClick={() => dl.mutate({ organizationId: currentOrgId, id: o.id })}>
                    Download
                  </button>
                  {(o.kind === "bid" || /@/.test(`${reqs.questionsTo ?? ""} ${reqs.contact?.email ?? ""}`)) && (
                    <button type="button" className="ld-btn" onClick={() => setAsking(asking === o.id ? null : o.id)}>Ask a question</button>
                  )}
                  {skippedTab ? (
                    <button type="button" className="ld-btn" disabled={restore.isPending} onClick={() => restore.mutate({ organizationId: currentOrgId, id: o.id })}>Bring back</button>
                  ) : (
                    <button type="button" className="ld-btn" disabled={skip.isPending} onClick={() => skip.mutate({ organizationId: currentOrgId, id: o.id })}>Skip</button>
                  )}
                  <ErrorLine error={skip.error ?? restore.error} />
                </div>
                {asking === o.id && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <AskPanel oppId={o.id} to={/@/.test(reqs.questionsTo ?? "") ? reqs.questionsTo : reqs.contact?.email || reqs.questionsTo} due={reqs.questionsDue} who={o.kind === "bid" ? "buyer" : "host"} onDone={() => setAsking(null)} />
                  </div>
                )}
                {(dl.error || start.error) && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <ErrorLine error={dl.error || start.error} />
                  </div>
                )}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

/** Where a bid's response goes in, read from the package. */
function goesIn(reqs: Requirements) {
  if (!reqs.channel) return "Not listed";
  if (reqs.channel === "portal" && reqs.channelDetail) {
    const host = reqs.channelDetail.replace(/^https?:\/\//, "");
    if (/bonfire/i.test(host)) return "Bonfire";
    if (/bidnet/i.test(host)) return "BidNet";
    if (/periscope|bidsync/i.test(host)) return "Periscope";
    if (/opengov/i.test(host)) return "OpenGov";
    return host.split("/")[0];
  }
  return CHANNEL_LABEL[reqs.channel] ?? reqs.channel;
}

/** Ask the buyer a question: becomes an email draft in Approvals. */
function AskPanel({ oppId, to, due, who, onDone }: { oppId: number; to?: string; due?: string; who: string; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [q, setQ] = React.useState("");
  const ask = trpc.opps.ask.useMutation({ onSuccess: () => utils.invalidate() });
  if (ask.isSuccess)
    return (
      <div className="ld-between" style={{ background: "var(--ld-hover)", padding: "12px 16px", borderRadius: 8 }}>
        <span className="ld-body">The question is in Approvals as an email draft{to ? ` to ${to}` : ""}.</span>
        <button type="button" className="ld-btn sm" onClick={onDone}>Close</button>
      </div>
    );
  return (
    <div style={{ background: "var(--ld-hover)", padding: "14px 16px", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <label htmlFor={`ask-${oppId}`} className="ld-lbl">
        Question for the {who}{to ? ` (${to}` : ""}{to && due ? `, due ${due})` : to ? ")" : due ? ` (due ${due})` : ""}
      </label>
      <textarea id={`ask-${oppId}`} className="ld-in" rows={3} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Is a hosted (cloud) system acceptable?" />
      <div className="ld-row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
        <button type="button" className="ld-btn p" disabled={ask.isPending || q.trim().length < 5} onClick={() => ask.mutate({ organizationId: currentOrgId, id: oppId, question: q.trim() })}>
          {ask.isPending ? "Drafting..." : "Draft it"}
        </button>
      </div>
      <ErrorLine error={ask.error} />
    </div>
  );
}

function Package({ opp, reqs, onRetry }: { opp: OppRow; reqs: Requirements; onRetry: () => void }) {
  const unit = (f: OppRow["files"][number]) => (f.pages ? `${f.pages} ${f.pagesUnit === "words" ? "words" : f.pagesUnit === "sheets" ? (f.pages === 1 ? "sheet" : "sheets") : f.pagesUnit === "slides" ? (f.pages === 1 ? "slide" : "slides") : f.pages === 1 ? "page" : "pages"}` : "");
  const rows: [string, string | undefined][] = [
    ["Due", reqs.due ? `${reqs.due}${reqs.pages?.due ? ` (${reqs.pages.due})` : ""}` : undefined],
    ["Questions", reqs.questions?.length ? `${reqs.questions.length}${reqs.questions.some((q) => q.limit) ? ", with limits" : ""}` : undefined],
    ["Narrative limit", [reqs.narrativeLimit, reqs.format].filter(Boolean).join(", ") || undefined],
    ["Scoring", reqs.scoring?.length ? reqs.scoring.map((s) => `${s.name} ${s.points}`).join(", ") : undefined],
    ["Attachments", reqs.attachments?.length ? reqs.attachments.map((a) => a.name).join(", ") : undefined],
    ["Submit", reqs.submitWhat || undefined],
    ["Goes in", reqs.channel ? `${CHANNEL_LABEL[reqs.channel] ?? reqs.channel}${reqs.channelDetail ? `, ${reqs.channelDetail}` : ""}` : undefined],
    ...(reqs.terms ?? []).filter((t) => t.label && t.value).map((t) => [t.label, t.value] as [string, string]),
    ["AI rule", reqs.aiPolicy?.restricted ? `${reqs.aiPolicy.note || "Restricted"}${reqs.aiPolicy.citation ? ` (${reqs.aiPolicy.citation})` : ""}` : undefined],
  ];
  return (
    <>
      <div className="ld-card" style={{ padding: "14px 16px" }}>
        <div className="ld-between">
          <span className="ld-lbl">
            {opp.packageStatus === "fetching" ? "Downloading the package..." : `${opp.kind === "bid" ? "Bid documents" : "Host's package"} (${opp.files.length} ${opp.files.length === 1 ? "file" : "files"})`}
          </span>
          {(opp.packageStatus === "none" || opp.packageStatus === "failed") && (
            <button type="button" className="ld-btn sm" onClick={onRetry}>{opp.packageStatus === "none" ? "Get it" : "Try again"}</button>
          )}
        </div>
        {opp.files.map((f, i) => (
          <div key={f.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 70px auto", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: i === opp.files.length - 1 ? 0 : "1px solid #eef2f0", fontSize: 14 }}>
            {f.fileUrl ? (
              <a href={f.fileUrl} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{f.name}</a>
            ) : (
              <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{f.name}</span>
            )}
            <span style={{ color: "var(--ld-text2)" }}>{unit(f)}</span>
            <span className={`ld-pill ${f.status === "read" ? "green" : f.status === "needs_signature" ? "amber" : "red"}`} title={f.note ?? undefined}>
              {f.status === "read" ? (f.note === "from the image" ? "Read from image" : "Read") : f.status === "needs_signature" ? "Needs signature" : "Could not read"}
            </span>
          </div>
        ))}
        {opp.packageNote && <p className="ld-small ld-muted" style={{ margin: "8px 0 0" }}>{opp.packageNote}</p>}
      </div>
      {opp.packageStatus === "ready" && rows.some(([, v]) => v) && (
        <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="ld-lbl">What it requires</span>
          <div style={{ display: "grid", gridTemplateColumns: "130px minmax(0,1fr)", gap: "8px 14px", fontSize: 14, lineHeight: 1.5 }}>
            {rows.filter(([, v]) => v).map(([k, v]) => (
              <React.Fragment key={k}>
                <span style={{ color: "var(--ld-muted)", fontWeight: 600 }}>{k}</span>
                <span style={{ overflowWrap: "anywhere" }}>{v}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ==========================================
// Applications
// ==========================================

function nextButton(a: AppRow, base: string) {
  const href = `${base}/app/${a.id}`;
  if (a.status === "ready") return <Link href={href} className="ld-btn p">Review</Link>;
  if (a.status === "needs_answer") return <Link href={href} className="ld-btn p">Answer</Link>;
  if (a.status === "needs_setup") return <Link href="/integrations?tab=applying" className="ld-btn p">Set up</Link>;
  return <Link href={href} className="ld-btn">Open</Link>;
}

function AppTable({ list, loading, emp }: { list: AppRow[]; loading: boolean; emp: EmployeeRow }) {
  const [open, setOpen] = React.useState<number | null>(null);
  const base = `/chats/${emp.kind}`;
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: APP_COLS }}>
        <span>Application</span>
        <span>Host</span>
        <span>Deadline</span>
        <span>Status</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : "No applications yet. Press Apply on an opportunity."}</div>}
      {list.map((a) => {
        const isOpen = open === a.id;
        const st = APP_STATUS[a.status] ?? { label: a.status, cls: "gray" };
        const qs = parseJson<Question[]>(a.questions, []);
        const label = a.status === "writing" && a.progress ? `${a.progress}` : st.label;
        return (
          <React.Fragment key={a.id}>
            <div
              className={`ld-rw ${isOpen ? "open" : ""}`}
              style={{ gridTemplateColumns: APP_COLS, cursor: "pointer" }}
              aria-expanded={isOpen}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button,a,input")) return;
                setOpen(isOpen ? null : a.id);
              }}
            >
              <span className="ld-strong">{a.title}</span>
              <span>{a.opp?.host ?? ""}</span>
              <span>{a.opp?.deadline || "Not listed"}</span>
              <span className={`ld-pill ${st.cls}`}>{label}</span>
              {nextButton(a, base)}
            </div>
            {isOpen && <AppExpand a={a} qs={qs} base={base} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function AppExpand({ a, qs, base }: { a: AppRow; qs: Question[]; base: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const atts = parseJson<Attachment[]>(a.attachments, []);
  const dl = trpc.applications.download.useMutation({ onSuccess: openDownload });
  const [marking, setMarking] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState("");
  const mark = trpc.applications.markSubmitted.useMutation({ onSuccess: async () => { setMarking(false); await utils.applications.list.invalidate(); } });
  const [deciding, setDeciding] = React.useState(false);
  const m = materialsOf(a, qs);

  if (m.items.length) return <MaterialsExpand a={a} m={m} base={base} marking={marking} setMarking={setMarking} deciding={deciding} setDeciding={setDeciding} />;

  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {a.status === "submitted" ? (
          <>
            <KV label="Confirmation">{a.confirmation || "Not recorded"}</KV>
            <KV label="Submitted">{`${fmtDate(a.submittedAt)}, through ${CHANNEL_LABEL[a.channel] ?? a.channel}`}</KV>
            {a.receiptUrl && (
              <KV label="Receipt">
                <a href={a.receiptUrl} target="_blank" rel="noreferrer noopener" style={{ color: "var(--ld-accent-dark)", fontWeight: 700 }}>{/^https?:\/\//.test(a.receiptUrl) ? "Open the sent email" : "See the page after Submit"}</a>
              </KV>
            )}
          </>
        ) : a.status === "approved" ? (
          <>
            <KV label="Approved">{`${fmtDate(a.certifiedAt)} by ${a.certifiedBy ?? ""}`}</KV>
            <KV label="Goes in through">{CHANNEL_LABEL[a.channel] ?? a.channel}</KV>
          </>
        ) : (
          <>
            <KV label="Status">{a.status === "error" ? a.errorNote ?? "Needs attention" : APP_STATUS[a.status]?.label ?? a.status}</KV>
            {a.blockers.length > 0 && <KV label="Before Submit">{a.blockers.join(". ")}</KV>}
          </>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <KV label="Questions">{a.mode === "outline" ? `${qs.filter((q) => q.answer.trim()).length} of ${qs.length} written by you` : `${qs.filter((q) => q.answer.trim()).length} of ${qs.length} answered`}</KV>
        <KV label="Attachments">{atts.length ? atts.map((x) => x.name).join(", ") : "None asked for"}</KV>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <KV label="Decision expected">{a.decisionExpected || "Not listed"}</KV>
        <KV label="Amount">{a.opp?.amount || "Not listed"}</KV>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn" disabled={dl.isPending} onClick={() => dl.mutate({ organizationId: currentOrgId, id: a.id, what: "zip" })}>Download</button>
        {a.status === "approved" && !marking && <button type="button" className="ld-btn p" onClick={() => setMarking(true)}>Mark sent</button>}
        {a.status === "submitted" && !deciding && <button type="button" className="ld-btn p" onClick={() => setDeciding(true)}>Record result</button>}
      </div>
      {a.status === "approved" && (
        <p className="ld-small ld-muted" style={{ gridColumn: "1 / -1", margin: 0 }}>
          Automatic sending through {CHANNEL_LABEL[a.channel] ?? a.channel} is not switched on yet. Download the package, submit it{a.opp?.sourceUrl ? <> at <a href={a.opp.sourceUrl} target="_blank" rel="noreferrer noopener">the host's page</a></> : " on the host's page"}, then press Mark sent.
        </p>
      )}
      {marking && (
        <div className="ld-card editing" style={{ gridColumn: "1 / -1", padding: "12px 14px", display: "grid", gridTemplateColumns: "minmax(0,320px) auto auto", gap: 10, alignItems: "end", justifyContent: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor={`conf-${a.id}`}>Confirmation number (optional)</label>
            <input id={`conf-${a.id}`} className="ld-in" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
          </div>
          <button type="button" className="ld-btn p sm" disabled={mark.isPending} onClick={() => mark.mutate({ organizationId: currentOrgId, id: a.id, confirmation })}>Save</button>
          <button type="button" className="ld-btn sm" onClick={() => setMarking(false)}>Cancel</button>
        </div>
      )}
      {deciding && <DecisionEditor a={a} onDone={() => setDeciding(false)} />}
      <div style={{ gridColumn: "1 / -1" }}>
        <ErrorLine error={dl.error || mark.error} />
      </div>
    </div>
  );
}

// ==========================================
// The application's materials: the host's forms, the narrative, pitch materials
// ==========================================

type FormEntry = { fileId: number; name: string; kind: string; status: "filled" | "word_copy" | "needs_signature" | "signed" | "failed"; filledUrl: string | null; signedUrl: string | null; note: string };
type Extras = { deck?: { title: string }[]; videoScript?: string; videoUrl?: string | null; financials?: string };
type Item = { name: string; pill: string; tone: "green" | "amber" | "red" };
const FORM_PILL: Record<FormEntry["status"], [string, Item["tone"]]> = { filled: ["Filled", "green"], word_copy: ["Filled in Word", "green"], needs_signature: ["Needs your signature", "amber"], signed: ["Signed", "green"], failed: ["Couldn't fill", "red"] };

/** Everything the application is made of, each with its state, for the row. Empty when there's nothing beyond the answers. */
function materialsOf(a: AppRow, qs: Question[]) {
  const forms = parseJson<FormEntry[]>((a as AppRow & { forms?: string | null }).forms ?? null, []);
  const extras = parseJson<Extras>(a.extras, {});
  const kind = a.opp?.kind;
  const pitch = kind === "pitch" || kind === "accelerator";
  const items: Item[] = [];
  const host = forms.filter((f) => f.fileId !== -1);
  if (!host.length && !pitch && !forms.length) return { items, pitch, toSign: null as FormEntry | null, needsVideo: false, notes: [] as string[] };
  const answered = qs.filter((q) => q.answer.trim()).length;
  const answers: Item = { name: `${pitch ? "Application answers" : "Project narrative"} (${qs.length} ${qs.length === 1 ? "question" : "questions"})`, pill: answered === qs.length && qs.length ? "Written" : `${answered} of ${qs.length}`, tone: answered === qs.length && qs.length ? "green" : "amber" };
  if (pitch) items.push(answers);
  for (const f of host) {
    const [pill, tone] = FORM_PILL[f.status] ?? ["Filled", "green"];
    items.push({ name: pitch ? `${f.name} (from the host)` : f.name, pill, tone });
  }
  if (!pitch) items.push(answers);
  if (pitch) {
    if (extras.deck?.length) items.push({ name: `Pitch deck, ${extras.deck.length} slides`, pill: "Ready", tone: "green" });
    if (extras.videoScript) items.push({ name: `Pitch video script, ${Math.max(1, Math.round(extras.videoScript.split(/\s+/).length / 145))} ${Math.round(extras.videoScript.split(/\s+/).length / 145) > 1 ? "minutes" : "minute"}`, pill: "Written", tone: "green" });
    items.push({ name: "Pitch video", pill: extras.videoUrl ? "Added" : "Needs you", tone: extras.videoUrl ? "green" : "amber" });
    if (extras.financials) items.push({ name: "Financial summary", pill: "Written", tone: "green" });
  }
  if (forms.some((f) => f.fileId === -1)) items.push({ name: "Capability statement", pill: "Attached", tone: "green" });
  const toSign = host.find((f) => f.status === "needs_signature") ?? null;
  const notes = host.filter((f) => f.status === "word_copy" || f.status === "failed").map((f) => `${f.name}: ${f.note}`);
  return { items, pitch, toSign, needsVideo: pitch && !extras.videoUrl, notes };
}

function MaterialsExpand({ a, m, base, marking, setMarking, deciding, setDeciding }: { a: AppRow; m: ReturnType<typeof materialsOf>; base: string; marking: boolean; setMarking: (v: boolean) => void; deciding: boolean; setDeciding: (v: boolean) => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const dl = trpc.applications.download.useMutation({ onSuccess: openDownload });
  const [confirmation, setConfirmation] = React.useState("");
  const mark = trpc.applications.markSubmitted.useMutation({ onSuccess: async () => { setMarking(false); await utils.applications.list.invalidate(); } });
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const upload = async (f: File) => {
    setErr(null);
    setBusy(true);
    try {
      if (m.toSign) await uploadFile("hostform", f, { organizationId: currentOrgId, applicationId: a.id, fileId: m.toSign.fileId });
      else await uploadFile("video", f, { organizationId: currentOrgId, applicationId: a.id });
      await utils.applications.list.invalidate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pitchDay = m.pitch && a.opp?.eventDate ? ` Pitch day is ${a.opp.eventDate}.` : "";
  const hint = m.toSign ? `Sign ${m.toSign.name}, add it here${m.needsVideo ? ", add your pitch video" : ""}, and the package is complete.` : m.needsVideo ? `Record yourself reading the script on your phone and add it here.${pitchDay}` : a.status === "submitted" ? `Submitted ${fmtDate(a.submittedAt)}${a.confirmation ? `, confirmation ${a.confirmation}` : ""}.` : a.blockers.length ? `Before Submit: ${a.blockers.join(". ")}.` : "";

  return (
    <div className="ld-expand ld-mat">
      <div className="ld-mat-main">
        <span className="ld-lbl">{m.pitch ? "Application and pitch materials" : "Forms from the host"}</span>
        <div className="ld-mat-list">
          {m.items.map((it) => (
            <React.Fragment key={it.name}>
              <span className="ld-clip">{it.name}</span>
              <span className={`ld-pill ${it.tone === "green" ? "green" : it.tone === "amber" ? "amber" : "red"}`}>{it.pill}</span>
            </React.Fragment>
          ))}
        </div>
        {hint && <span className="ld-small ld-muted">{hint}</span>}
        {m.notes.map((n) => <span key={n} className="ld-small ld-muted">{n}</span>)}
        {marking && (
          <div className="ld-card editing" style={{ padding: "12px 14px", display: "grid", gridTemplateColumns: "minmax(0,320px) auto auto", gap: 10, alignItems: "end", justifyContent: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label className="ld-lbl" htmlFor={`conf-${a.id}`}>Confirmation number (optional)</label>
              <input id={`conf-${a.id}`} className="ld-in" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
            </div>
            <button type="button" className="ld-btn p sm" disabled={mark.isPending} onClick={() => mark.mutate({ organizationId: currentOrgId, id: a.id, confirmation })}>Save</button>
            <button type="button" className="ld-btn sm" onClick={() => setMarking(false)}>Cancel</button>
          </div>
        )}
        {deciding && <DecisionEditor a={a} onDone={() => setDeciding(false)} />}
        <ErrorLine error={dl.error || mark.error || (err ? new Error(err) : null)} />
      </div>
      <div className="ld-mat-btns">
        <button type="button" className="ld-btn p" disabled={dl.isPending} onClick={() => dl.mutate({ organizationId: currentOrgId, id: a.id, what: "zip" })}>{dl.isPending ? "Zipping..." : "Download all"}</button>
        <Link href={`${base}/app/${a.id}`} className="ld-btn">Open</Link>
        {(m.toSign || m.needsVideo) && (
          <>
            <input ref={fileRef} type="file" className="ld-sr" accept={m.toSign ? ".pdf,.docx,.xlsx,.jpg,.jpeg,.png" : "video/*"} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
            <button type="button" className="ld-btn" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Uploading..." : m.toSign ? "Add signed" : "Add video"}</button>
          </>
        )}
        {a.status === "approved" && !marking && <button type="button" className="ld-btn" onClick={() => setMarking(true)}>Mark sent</button>}
        {a.status === "submitted" && !deciding && <button type="button" className="ld-btn" onClick={() => setDeciding(true)}>Record result</button>}
      </div>
    </div>
  );
}

function DecisionEditor({ a, onDone }: { a: AppRow; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [result, setResult] = React.useState<"awarded" | "declined">("awarded");
  const [amount, setAmount] = React.useState("");
  const [period, setPeriod] = React.useState("");
  const [restrictions, setRestrictions] = React.useState("");
  const [reports, setReports] = React.useState<{ name: string; due: string }[]>([{ name: "Progress report", due: "" }]);
  const [comments, setComments] = React.useState("");
  const [reapply, setReapply] = React.useState("");
  const decide = trpc.applications.decide.useMutation({ onSuccess: async () => { await utils.applications.list.invalidate(); onDone(); } });
  const seg = (on: boolean): React.CSSProperties => ({ height: 32, padding: "0 16px", border: 0, borderRight: "1px solid var(--ld-line3)", background: on ? "var(--ld-accent-bg)" : "var(--ld-surface)", color: on ? "var(--ld-accent-dark)" : "var(--ld-text2)", font: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" });
  return (
    <div className="ld-card editing" style={{ gridColumn: "1 / -1", padding: "14px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div role="group" aria-label="Result" style={{ display: "flex", border: "1px solid var(--ld-line3)", borderRadius: 8, overflow: "hidden", width: "max-content" }}>
          <button type="button" style={seg(result === "awarded")} onClick={() => setResult("awarded")}>Awarded</button>
          <button type="button" style={{ ...seg(result === "declined"), borderRight: 0 }} onClick={() => setResult("declined")}>Declined</button>
        </div>
        {result === "awarded" ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "160px minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
              <Field id="d-amt" label="Amount" value={amount} onChange={setAmount} />
              <Field id="d-per" label="Award period" value={period} onChange={setPeriod} />
              <Field id="d-res" label="Restricted to" value={restrictions} onChange={setRestrictions} />
            </div>
            <span className="ld-lbl">Reports due</span>
            {reports.map((r, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 160px 96px", gap: 10, alignItems: "end" }}>
                <Field id={`r-n-${i}`} label="Report" value={r.name} onChange={(v) => setReports((p) => p.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
                <Field id={`r-d-${i}`} label="Due (MM/DD/YYYY)" value={r.due} onChange={(v) => setReports((p) => p.map((x, j) => (j === i ? { ...x, due: v } : x)))} />
                <button type="button" className="ld-btn sm" onClick={() => setReports((p) => p.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <button type="button" className="ld-btn sm" onClick={() => setReports((p) => [...p, { name: "", due: "" }])}>Add report</button>
          </>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 180px", gap: 10, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label className="ld-lbl" htmlFor="d-com">Reviewer comments (saved to Knowledge)</label>
              <textarea id="d-com" className="ld-ta" rows={4} value={comments} onChange={(e) => setComments(e.target.value)} />
            </div>
            <Field id="d-re" label="Reapply (MM/DD/YYYY)" value={reapply} onChange={setReapply} />
          </div>
        )}
        <ErrorLine error={decide.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          type="button"
          className="ld-btn p"
          disabled={decide.isPending}
          onClick={() =>
            decide.mutate(
              result === "awarded"
                ? { organizationId: currentOrgId, id: a.id, result, amount, period, restrictions, reports: reports.filter((r) => r.name.trim()) }
                : { organizationId: currentOrgId, id: a.id, result, comments, reapplyDate: reapply }
            )
          }
        >
          Save
        </button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function Field({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <label className="ld-lbl" htmlFor={id}>{label}</label>
      <input id={id} className="ld-in" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ==========================================
// Awards
// ==========================================

function AwardTable({ list, loading, emp }: { list: AppRow[]; loading: boolean; emp: EmployeeRow }) {
  const [open, setOpen] = React.useState<number | null>(null);
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: AWARD_COLS }}>
        <span>{emp.kind === "speaking" ? "Event" : "Award"}</span>
        <span>Host</span>
        <span>Amount</span>
        <span>Result</span>
        <span>Next report</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : "No results recorded yet."}</div>}
      {list.map((a) => {
        const isOpen = open === a.id;
        const award = parseJson<Award | null>(a.award, null);
        const next = award?.reports.find((r) => r.status !== "sent");
        return (
          <React.Fragment key={a.id}>
            <div
              className={`ld-rw ${isOpen ? "open" : ""}`}
              style={{ gridTemplateColumns: AWARD_COLS, cursor: "pointer" }}
              aria-expanded={isOpen}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button,a,input")) return;
                setOpen(isOpen ? null : a.id);
              }}
            >
              <span className="ld-strong">{a.title}</span>
              <span>{a.opp?.host ?? ""}</span>
              <span>{award?.amount || a.opp?.amount || ""}</span>
              <span className={`ld-pill ${a.status === "awarded" ? "green" : "gray"}`}>{a.status === "awarded" ? (emp.kind === "speaking" ? "Accepted" : "Awarded") : "Declined"}</span>
              <span>{a.status === "awarded" ? (next?.due ? showDate(next.due) : "None due") : a.reapplyDate ? `Reapply ${showDate(a.reapplyDate)}` : ""}</span>
              {a.status === "awarded" ? (
                <Link href={`/chats/${emp.kind}/app/${a.id}`} className="ld-btn">Open</Link>
              ) : (
                <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : a.id)}>Comments</button>
              )}
            </div>
            {isOpen && (a.status === "awarded" && award ? <AwardExpand a={a} award={award} /> : <div className="ld-expand"><KV label="Reviewer comments">{a.reviewerComments || "None recorded."}</KV></div>)}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function AwardExpand({ a, award }: { a: AppRow; award: Award }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const draft = trpc.applications.draftReport.useMutation({ onSuccess: () => utils.applications.list.invalidate() });
  const dl = trpc.applications.download.useMutation({ onSuccess: openDownload });
  const save = trpc.applications.updateAward.useMutation({ onSuccess: async () => { setEditing(false); await utils.applications.list.invalidate(); } });
  const [editing, setEditing] = React.useState(false);
  const [spent, setSpent] = React.useState(String(award.spent || ""));
  const [total, setTotal] = React.useState(String(award.total || ""));
  const [letterErr, setLetterErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const pct = award.total ? Math.min(100, Math.round((award.spent / award.total) * 100)) : 0;
  const money = (n: number) => `$${n.toLocaleString("en-US")}`;

  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      <div className="ld-card" style={{ padding: "14px 16px" }}>
        <span className="ld-lbl">Reports ({award.reports.length})</span>
        {award.reports.length === 0 && <p className="ld-small ld-muted" style={{ margin: "8px 0 0" }}>No reports recorded.</p>}
        {award.reports.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 12, alignItems: "center", padding: "9px 0", borderBottom: i === award.reports.length - 1 ? 0 : "1px solid #eef2f0", fontSize: 14 }}>
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{r.name}</span>
              <span className="ld-small ld-muted">Due {showDate(r.due)}</span>
            </span>
            {r.status === "ready" ? (
              <button type="button" className="ld-btn" onClick={() => dl.mutate({ organizationId: currentOrgId, id: a.id, what: "report", index: i })}>Download</button>
            ) : (
              <button type="button" className="ld-btn p" disabled={draft.isPending || r.status === "drafting"} onClick={() => draft.mutate({ organizationId: currentOrgId, id: a.id, index: i })}>
                {r.status === "drafting" || (draft.isPending && draft.variables?.index === i) ? "Drafting..." : "Draft report"}
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="ld-between">
          <span className="ld-lbl">Spending</span>
          {!editing && <button type="button" className="ld-btn sm" onClick={() => setEditing(true)}>Edit</button>}
        </div>
        {editing ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "end" }}>
            <Field id={`sp-${a.id}`} label="Spent" value={spent} onChange={setSpent} />
            <Field id={`tt-${a.id}`} label="Award total" value={total} onChange={setTotal} />
            <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: a.id, spent: Number(spent.replace(/[^0-9.]/g, "")) || 0, total: Number(total.replace(/[^0-9.]/g, "")) || 0 })}>Save</button>
            <button type="button" className="ld-btn sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : (
          <>
            <div className="ld-between ld-body"><span>{money(award.spent)} spent</span><span className="ld-muted">of {money(award.total)}</span></div>
            <div style={{ height: 8, borderRadius: 999, background: "var(--ld-line)", overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${pct}%`, background: "var(--ld-accent)" }} /></div>
          </>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "6px 12px", fontSize: 13, color: "var(--ld-text2)", marginTop: 4 }}>
          <span>Award period</span><span>{award.period || "Not recorded"}</span>
          <span>Restricted to</span><span>{award.restrictions || "Not recorded"}</span>
          <span>Award letter</span>
          <span>
            {award.letterUrl ? <a href={award.letterUrl} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600 }}>Open</a> : (
              <>
                <input ref={fileRef} type="file" className="ld-sr" accept=".pdf,.docx" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setLetterErr(null);
                  try { await uploadFile("letter", f, { organizationId: currentOrgId, applicationId: a.id }); await utils.applications.list.invalidate(); } catch (err) { setLetterErr((err as Error).message); }
                }} />
                <button type="button" className="ld-btn sm" onClick={() => fileRef.current?.click()}>Upload</button>
              </>
            )}
          </span>
        </div>
        {letterErr && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{letterErr}</span>}
      </div>
      <span />
      <div style={{ gridColumn: "1 / -1" }}><ErrorLine error={draft.error || dl.error || save.error} /></div>
    </div>
  );
}
