import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs, UnderlineTabs } from "../ui";
import { APP_STATUS, CHANNEL_LABEL, OPP_TABS, fmtDate, openDownload, parseJson, uploadFile } from "../meta";
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
export default function ApplyWork({ emp }: { emp: EmployeeRow }) {
  const empKind: EmpKind = emp.kind === "speaking" ? "speaking" : "grants";
  const { currentOrgId } = useTenant();
  const initial = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
  const [tab, setTab] = React.useState<"opps" | "apps" | "awards">(initial === "applications" ? "apps" : initial === "awards" ? "awards" : "opps");
  const [kind, setKind] = React.useState<OppKind>(OPP_TABS[empKind][0].key);
  const [adding, setAdding] = React.useState(false);
  const linkedOpp = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("opp")) || null : null;
  const opps = trpc.opps.list.useQuery({ organizationId: currentOrgId, employee: empKind }, { refetchInterval: (q) => ((q.state.data ?? []).some((o) => o.packageStatus === "fetching") ? 5000 : false) });
  const apps = trpc.applications.list.useQuery({ organizationId: currentOrgId, employee: empKind }, { refetchInterval: (q) => ((q.state.data ?? []).some((a) => a.status === "writing") ? 5000 : 30_000) });
  const utils = trpc.useUtils();
  const find = trpc.opps.find.useMutation({ onSuccess: () => utils.opps.list.invalidate() });

  const oppList = opps.data ?? [];
  // A chat card's Details button opens that row on the right folder tab.
  const linkedKind = linkedOpp ? oppList.find((o) => o.id === linkedOpp)?.kind : undefined;
  React.useEffect(() => {
    if (linkedKind && OPP_TABS[empKind].some((t) => t.key === linkedKind)) setKind(linkedKind as OppKind);
  }, [linkedKind, empKind]);
  const appList = (apps.data ?? []).filter((a) => a.status !== "awarded" && a.status !== "declined");
  const awardList = (apps.data ?? []).filter((a) => a.status === "awarded" || a.status === "declined");

  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      <div className="ld-row" style={{ justifyContent: "flex-end" }}>
        {find.data && !find.isPending && (
          <span className="ld-small ld-muted">{find.data.added ? `Added ${find.data.added} from ${find.data.queries.length} searches.` : `Nothing new from ${find.data.queries.length} searches.`}</span>
        )}
        <button type="button" className="ld-btn" onClick={() => { setTab("opps"); setAdding((v) => !v); }}>
          Add
        </button>
        <button type="button" className="ld-btn p" disabled={find.isPending} onClick={() => { setTab("opps"); find.mutate({ organizationId: currentOrgId, employee: empKind, kind }); }}>
          {find.isPending ? "Searching..." : kind === "media" ? "Find press" : empKind === "speaking" ? "Find events" : "Find more"}
        </button>
      </div>
      <ErrorLine error={find.error} />

      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "opps", label: `Opportunities (${oppList.length})` },
          { key: "apps", label: `Applications (${appList.length})` },
          { key: "awards", label: `${empKind === "speaking" ? "Results" : "Awards"} (${awardList.length})` },
        ]}
      />

      {tab === "opps" &&
        (OPP_TABS[empKind].length > 1 ? (
          <FolderTabs
            value={kind}
            onChange={setKind}
            tabs={OPP_TABS[empKind].map((t) => ({ key: t.key, label: `${t.label} (${oppList.filter((o) => o.kind === t.key).length})` }))}
          >
            {adding && <AddPanel empKind={empKind} onDone={() => setAdding(false)} />}
            <OppTable initialOpen={linkedOpp} list={oppList.filter((o) => o.kind === kind)} kind={kind} loading={opps.isLoading} apps={apps.data ?? []} emp={emp} onOpenApps={() => setTab("apps")} />
          </FolderTabs>
        ) : (
          <div className="ld-card" style={{ overflow: "hidden" }}>
            {adding && <AddPanel empKind={empKind} onDone={() => setAdding(false)} />}
            <OppTable initialOpen={linkedOpp} list={oppList} kind={kind} loading={opps.isLoading} apps={apps.data ?? []} emp={emp} onOpenApps={() => setTab("apps")} />
          </div>
        ))}
      {tab === "apps" && <AppTable list={appList} loading={apps.isLoading} emp={emp} />}
      {tab === "awards" && <AwardTable list={awardList} loading={apps.isLoading} emp={emp} />}
    </main>
  );
}

// ==========================================
// Add an opportunity from a link or the RFP file
// ==========================================

function AddPanel({ empKind, onDone }: { empKind: EmpKind; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [url, setUrl] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const addLink = trpc.opps.addLink.useMutation();
  const fileRef = React.useRef<HTMLInputElement>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (file) await uploadFile("rfp", file, { organizationId: currentOrgId, employee: empKind });
      else if (url.trim()) await addLink.mutateAsync({ organizationId: currentOrgId, employee: empKind, url: url.trim() });
      else throw new Error("Paste a link or choose a file.");
      await utils.opps.list.invalidate();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: "#f4f8f6", padding: "16px 18px", borderBottom: "1px solid #e3e9e6", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="ld-st">{empKind === "speaking" ? "Add an event or media request" : "Add an opportunity"}</span>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)", gap: 12, alignItems: "end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label htmlFor="add-link" className="ld-lbl">{empKind === "speaking" ? "Call for proposals or request link" : "Page link"}</label>
            <input id="add-link" className="ld-in lg" type="text" value={url} disabled={Boolean(file)} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="ld-lbl">Or the RFP file</span>
            <div className="ld-row">
              <input ref={fileRef} type="file" className="ld-sr" id="add-file" accept=".pdf,.docx,.xlsx,.pptx,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <button type="button" className="ld-btn" style={{ width: 112, height: 34 }} onClick={() => fileRef.current?.click()}>
                Choose file
              </button>
              <span className="ld-small ld-muted ld-clip" style={{ whiteSpace: "nowrap" }}>{file ? file.name : "PDF or Word"}</span>
            </div>
          </div>
        </div>
        {error && <span className="ld-small" role="alert" style={{ color: "#b42318" }}>{error}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={busy} onClick={submit}>{busy ? "Reading..." : "Add"}</button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

// ==========================================
// Opportunities
// ==========================================

function OppTable({ list, kind, loading, apps, emp, onOpenApps, initialOpen }: { list: OppRow[]; kind: OppKind; loading: boolean; apps: AppRow[]; emp: EmployeeRow; onOpenApps: () => void; initialOpen?: number | null }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [open, setOpen] = React.useState<number | null>(initialOpen ?? null);
  const [asking, setAsking] = React.useState<number | null>(null);
  const start = trpc.applications.start.useMutation({ onSuccess: async () => { await utils.applications.list.invalidate(); await utils.opps.list.invalidate(); onOpenApps(); } });
  const skip = trpc.opps.skip.useMutation({ onSuccess: () => utils.opps.list.invalidate() });
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
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : `Nothing here yet. Press ${kind === "media" ? "Find press" : emp.kind === "speaking" ? "Find events" : "Find more"}, add one, or ask ${emp.name} in Chat.`}</div>}
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
              </span>
              <span>{o.host}</span>
              <span>{o.deadline || reqs.due || "Not posted"}</span>
              <span>{o.kind === "bid" ? goesIn(reqs) : o.amount || "Not listed"}</span>
              {app ? <span className={`ld-pill ${APP_STATUS[app.status]?.cls ?? "gray"}`}>{APP_STATUS[app.status]?.label ?? app.status}</span> : o.fitScore > 0 || o.fitReason ? callPill(o) : <span className="ld-pill gray">Not scored</span>}
              {app ? (
                <button type="button" className="ld-btn" onClick={onOpenApps}>Open</button>
              ) : (
                <button type="button" className={`ld-btn ${o.fitCall === "skip" ? "" : "p"}`} disabled={start.isPending} onClick={() => start.mutate({ organizationId: currentOrgId, opportunityId: o.id })}>
                  Apply
                </button>
              )}
            </div>
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
                  <button type="button" className="ld-btn" onClick={() => skip.mutate({ organizationId: currentOrgId, id: o.id })}>Skip</button>
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
      <div className="ld-between" style={{ background: "#f4f8f6", padding: "12px 16px", borderRadius: 8 }}>
        <span className="ld-body">The question is in Approvals as an email draft{to ? ` to ${to}` : ""}.</span>
        <button type="button" className="ld-btn sm" onClick={onDone}>Close</button>
      </div>
    );
  return (
    <div style={{ background: "#f4f8f6", padding: "14px 16px", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
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
            <span style={{ color: "#3d4c45" }}>{unit(f)}</span>
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
                <span style={{ color: "#5b6b64", fontWeight: 600 }}>{k}</span>
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

  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {a.status === "submitted" ? (
          <>
            <KV label="Confirmation">{a.confirmation || "Not recorded"}</KV>
            <KV label="Submitted">{`${fmtDate(a.submittedAt)}, through ${CHANNEL_LABEL[a.channel] ?? a.channel}`}</KV>
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
  const seg = (on: boolean): React.CSSProperties => ({ height: 32, padding: "0 16px", border: 0, borderRight: "1px solid #cfd9d4", background: on ? "#e6f2ec" : "#fff", color: on ? "#155c3e" : "#3d4c45", font: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" });
  return (
    <div className="ld-card editing" style={{ gridColumn: "1 / -1", padding: "14px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div role="group" aria-label="Result" style={{ display: "flex", border: "1px solid #cfd9d4", borderRadius: 8, overflow: "hidden", width: "max-content" }}>
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
            <div style={{ height: 8, borderRadius: 999, background: "#e3e9e6", overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${pct}%`, background: "#1b6b4a" }} /></div>
          </>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "6px 12px", fontSize: 13, color: "#3d4c45", marginTop: 4 }}>
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
        {letterErr && <span className="ld-small" style={{ color: "#b42318" }}>{letterErr}</span>}
      </div>
      <span />
      <div style={{ gridColumn: "1 / -1" }}><ErrorLine error={draft.error || dl.error || save.error} /></div>
    </div>
  );
}
