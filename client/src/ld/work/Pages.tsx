import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs } from "../ui";
import { fmtDate } from "../meta";

type PageType = "landing" | "website";
type Tab = "all" | "landing" | "website";

const COLS = "minmax(0,1.6fr) 140px 150px 160px 128px";

const STATUS: Record<string, { label: string; cls: string }> = {
  building: { label: "Building", cls: "gray" },
  ready: { label: "Ready for review", cls: "amber" },
  approved: { label: "Approved", cls: "green" },
  failed: { label: "Didn't finish", cls: "red" },
};

/** Jordan's Work tab: landing and website pages built as HTML, previewed, copied into the site builder. */
export default function Pages({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const initial = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("page")) || null : null;
  const [open, setOpen] = React.useState<number | null>(initial);
  const [tab, setTab] = React.useState<Tab>("all");
  const [title, setTitle] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [pageType, setPageType] = React.useState<PageType>("landing");

  const list = trpc.pages.list.useQuery({ organizationId: currentOrgId }, { refetchInterval: (q) => ((q.state.data ?? []).some((p) => p.status === "building") ? 4000 : false) });
  const build = trpc.pages.build.useMutation({
    onSuccess: async (p) => {
      setTitle("");
      setGoal("");
      await utils.pages.list.invalidate();
      setOpen(p.id);
    },
  });

  const all = list.data ?? [];
  const shown = tab === "all" ? all : all.filter((p) => p.pageType === tab);
  const canBuild = title.trim().length >= 2 && goal.trim().length >= 2;

  return (
    <main className="ld-main" style={{ padding: "24px 32px" }}>
      <form
        className="ld-card ld-pg-build"
        onSubmit={(e) => {
          e.preventDefault();
          if (canBuild) build.mutate({ organizationId: currentOrgId, title: title.trim(), pageType, goal: goal.trim() });
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="pg-title" className="ld-lbl">Offer or page</label>
          <input id="pg-title" className="ld-in lg" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="ld-lbl" id="pg-type">Type</span>
          <div className="ld-row" role="group" aria-labelledby="pg-type">
            <button type="button" className={`ld-btn sm ${pageType === "landing" ? "p" : ""}`} style={{ width: 120 }} aria-pressed={pageType === "landing"} onClick={() => setPageType("landing")}>Landing page</button>
            <button type="button" className={`ld-btn sm ${pageType === "website" ? "p" : ""}`} style={{ width: 120 }} aria-pressed={pageType === "website"} onClick={() => setPageType("website")}>Website page</button>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="pg-goal" className="ld-lbl">Goal</label>
          <input id="pg-goal" className="ld-in lg" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </div>
        <button type="submit" className="ld-btn p" disabled={!canBuild || build.isPending}>{build.isPending ? "Starting..." : "Build page"}</button>
      </form>
      <ErrorLine error={build.error} />

      <FolderTabs
        tabs={[
          { key: "all", label: `All pages (${all.length})` },
          { key: "landing", label: `Landing pages (${all.filter((p) => p.pageType === "landing").length})` },
          { key: "website", label: `Website pages (${all.filter((p) => p.pageType === "website").length})` },
        ]}
        value={tab}
        onChange={setTab}
      >
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Page</span>
          <span>Type</span>
          <span>Updated</span>
          <span>Status</span>
          <span />
        </div>
        {shown.length === 0 && <div className="ld-empty">{list.isLoading ? "Loading..." : `No pages yet. Build one above or ask ${emp.name} in Chat.`}</div>}
        {shown.map((p) => {
          const isOpen = open === p.id;
          const st = STATUS[p.status] ?? STATUS.ready;
          return (
            <React.Fragment key={p.id}>
              <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
                <span className="ld-strong">{p.title}</span>
                <span>{p.pageType === "website" ? "Website page" : "Landing page"}</span>
                <span>{fmtDate(p.updatedAt)}</span>
                <span className={`ld-pill ${st.cls}`}>{st.label}</span>
                <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : p.id)}>{isOpen ? "Close" : "Open"}</button>
              </div>
              {isOpen && <PagePanel id={p.id} status={p.status} progress={p.progress} />}
            </React.Fragment>
          );
        })}
      </FolderTabs>
    </main>
  );
}

function PagePanel({ id, status, progress }: { id: number; status: string; progress: string | null }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.pages.get.useQuery({ organizationId: currentOrgId, id }, { refetchInterval: status === "building" ? 4000 : false });
  const [view, setView] = React.useState<"desktop" | "phone">("desktop");
  const [asking, setAsking] = React.useState(false);
  const [request, setRequest] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const refresh = async () => {
    await utils.pages.list.invalidate();
    await utils.pages.get.invalidate({ organizationId: currentOrgId, id });
  };
  const revise = trpc.pages.revise.useMutation({ onSuccess: async () => { setAsking(false); setRequest(""); await refresh(); } });
  const approve = trpc.pages.approve.useMutation({ onSuccess: refresh });
  const restore = trpc.pages.restore.useMutation({ onSuccess: refresh });

  const d = q.data;
  const hasPage = Boolean(d?.html);
  const docUrl = React.useMemo(() => (d?.document ? URL.createObjectURL(new Blob([d.document], { type: "text/html" })) : ""), [d?.document]);
  React.useEffect(() => () => { if (docUrl) URL.revokeObjectURL(docUrl); }, [docUrl]);

  const copy = async () => {
    if (!d?.html) return;
    await navigator.clipboard.writeText(d.html);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const download = () => {
    if (!docUrl || !d) return;
    const a = document.createElement("a");
    a.href = docUrl;
    a.download = `${d.page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page"}.html`;
    a.click();
  };

  return (
    <div className="ld-expand ld-pg-panel">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {status === "building" && <p className="ld-small ld-muted" style={{ margin: 0 }}>{progress || "Building"}... This takes a few minutes.</p>}
        {status !== "building" && progress && <p className="ld-small" style={{ margin: 0, color: "#8a4510" }}>{progress}</p>}
        {hasPage && d && (
          <>
            <div className="ld-between">
              <div className="ld-pg-toggle" role="group" aria-label="Preview size">
                <button type="button" className={view === "desktop" ? "on" : ""} aria-pressed={view === "desktop"} onClick={() => setView("desktop")}>Desktop</button>
                <button type="button" className={view === "phone" ? "on" : ""} aria-pressed={view === "phone"} onClick={() => setView("phone")}>Phone</button>
              </div>
              <span className="ld-small ld-muted">Version {d.page.currentVersion} of {d.versions.length}</span>
            </div>
            {view === "desktop" ? (
              <div className="ld-pg-frame">
                <iframe title={`${d.page.title} desktop preview`} sandbox="" srcDoc={d.document} style={{ width: "100%", height: 720, border: 0, display: "block" }} />
              </div>
            ) : (
              <div className="ld-pg-phone">
                <iframe title={`${d.page.title} phone preview`} sandbox="" srcDoc={d.document} style={{ width: 375, height: 740, border: 0, display: "block" }} />
              </div>
            )}
            {asking && (
              <div className="ld-card" style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 10, alignItems: "end" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label htmlFor={`chg-${id}`} className="ld-lbl">What should change</label>
                  <input id={`chg-${id}`} className="ld-in" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Shorter headline, use a tweed dress photo" />
                </div>
                <button type="button" className="ld-btn p" disabled={request.trim().length < 2 || revise.isPending} onClick={() => revise.mutate({ organizationId: currentOrgId, id, request: request.trim() })}>Send</button>
                <ErrorLine error={revise.error} />
              </div>
            )}
            <Details id={id} html={d.html} buttonUrl={d.page.buttonUrl ?? ""} embedCode={d.page.embedCode ?? ""} onSaved={refresh} />
            <section className="ld-card">
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #e3e9e6" }} className="ld-strong">Versions</div>
              <div style={{ padding: "4px 16px 10px 16px" }}>
                {d.versions.map((v) => (
                  <div key={v.version} className="ld-pg-ver">
                    <span className="ld-strong">v{v.version}</span>
                    <span style={{ overflowWrap: "anywhere" }}>{v.note}</span>
                    <span>{fmtDate(v.createdAt)}</span>
                    {v.version === d.page.currentVersion ? (
                      <span className="ld-pill green">Current</span>
                    ) : (
                      <button type="button" className="ld-btn" disabled={restore.isPending || status === "building"} onClick={() => restore.mutate({ organizationId: currentOrgId, id, version: v.version })}>Restore</button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
        <ErrorLine error={q.error ?? approve.error ?? restore.error} />
      </div>
      <div className="ld-pg-actions">
        <button type="button" className="ld-btn p" disabled={!hasPage} onClick={copy}>{copied ? "Copied" : "Copy HTML"}</button>
        <button type="button" className="ld-btn" disabled={!hasPage} onClick={download}>Download</button>
        <a className={`ld-btn ${hasPage ? "" : "disabled"}`} href={docUrl || undefined} target="_blank" rel="noreferrer" aria-disabled={!hasPage}>Full screen</a>
        <button type="button" className="ld-btn" disabled={!hasPage || status === "building"} onClick={() => setAsking((v) => !v)}>Ask for changes</button>
        <button type="button" className="ld-btn" disabled={!hasPage || status === "building" || d?.page.status === "approved"} onClick={() => approve.mutate({ organizationId: currentOrgId, id })}>{d?.page.status === "approved" ? "Approved" : "Approve"}</button>
      </div>
    </div>
  );
}

function Details({ id, html, buttonUrl, embedCode, onSaved }: { id: number; html: string; buttonUrl: string; embedCode: string; onSaved: () => void }) {
  const { currentOrgId } = useTenant();
  const [editing, setEditing] = React.useState(false);
  const [url, setUrl] = React.useState(buttonUrl);
  const [embed, setEmbed] = React.useState(embedCode);
  const save = trpc.pages.saveDetails.useMutation({ onSuccess: () => { setEditing(false); onSaved(); } });
  const images = (html.match(/<img\b/gi) ?? []).length;
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`} style={editing ? { outline: "2px solid #1b6b4a" } : undefined}>
      <div className="ld-between" style={{ padding: "12px 16px", borderBottom: "1px solid #e3e9e6" }}>
        <span className="ld-strong">Page details</span>
        {editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={() => { setUrl(buttonUrl); setEmbed(embedCode); setEditing(false); }}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id, buttonUrl: url.trim(), embedCode: embed })}>Save</button>
          </span>
        ) : (
          <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>
      {editing ? (
        <div className="ld-kv">
          <label htmlFor={`btn-${id}`} className="ld-k">Button goes to</label>
          <input id={`btn-${id}`} className="ld-in" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          <label htmlFor={`emb-${id}`} className="ld-k">Form embed</label>
          <input id={`emb-${id}`} className="ld-in" value={embed} onChange={(e) => setEmbed(e.target.value)} placeholder="Paste your form or calendar embed code" />
          <ErrorLine error={save.error} />
        </div>
      ) : (
        <div className="ld-kv">
          <span className="ld-k">Button goes to</span>
          <span style={{ overflowWrap: "anywhere" }}>{buttonUrl || <span className="ld-muted">Not set</span>}</span>
          <span className="ld-k">Form embed</span>
          <span>{embedCode ? "Added" : <span className="ld-muted">None (the button links instead)</span>}</span>
          <span className="ld-k">Images</span>
          <span>{images ? `${images} with public links` : <span className="ld-muted">None</span>}</span>
        </div>
      )}
    </section>
  );
}
