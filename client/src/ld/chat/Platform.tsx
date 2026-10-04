import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";

/**
 * Cards for work done in an employee's browser: a finished browser job (with
 * Finish it when a Save or Submit waits for approval), Zara's workflow
 * findings with Fix, and a page Zara put in a funnel with Publish.
 */

export const SEV: Record<"fix_now" | "should_fix", { label: string; bg: string; fg: string }> = {
  fix_now: { label: "Fix now", bg: "#fde8e8", fg: "#9b1c1c" },
  should_fix: { label: "Should fix", bg: "#fdf0e3", fg: "#8a4510" },
};

export function SevPill({ s }: { s: "fix_now" | "should_fix" }) {
  const v = SEV[s];
  return <span style={{ fontSize: 12, fontWeight: 700, borderRadius: 999, padding: "2px 10px", whiteSpace: "nowrap", background: v.bg, color: v.fg, justifySelf: "start" }}>{v.label}</span>;
}

function shortUrl(u: string | null | undefined) {
  return (u ?? "").replace(/^https?:\/\//, "");
}

/** A browser job that finished: what the page looked like, and Finish it when an approval is waiting. */
export function WebTaskCard({ id, empName }: { id: number; empName: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.web.get.useQuery({ organizationId: currentOrgId, id }, { refetchInterval: (r) => (r.state.data && (r.state.data.status === "queued" || r.state.data.status === "working") ? 5000 : false) });
  const approve = trpc.web.approve.useMutation({ onSuccess: () => Promise.all([utils.web.get.invalidate(), utils.chat.list.invalidate()]) });
  const t = q.data;
  if (!t) return null;
  const pill =
    t.status === "done" && t.pending ? <span className="ld-pill amber">Waiting for you</span>
    : t.status === "done" ? <span className="ld-pill green">Done</span>
    : t.status === "failed" ? <span className="ld-pill red">Didn't finish</span>
    : t.status === "need_code" ? <span className="ld-pill amber">Needs a code</span>
    : <span className="ld-pill gray">Working</span>;
  const steps = t.steps ? `${t.status === "done" ? "Done" : "Stopped"} in ${t.steps} ${t.steps === 1 ? "step" : "steps"}.` : "";
  const open = t.lastUrl || t.screenshotUrl;
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{empName}'s browser</span>
          {pill}
        </div>
        {t.screenshotUrl && (
          <div style={{ border: "1px solid #cfd9d4", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "8px 10px", background: "#eef2f0", borderBottom: "1px solid #dbe4df" }}>
              <span style={{ flex: 1, background: "#fff", border: "1px solid #dbe4df", borderRadius: 6, padding: "4px 10px", fontSize: 12, color: "#3d4c45", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{shortUrl(t.lastUrl) || t.title}</span>
            </div>
            <img src={t.screenshotUrl} alt={`The page ${empName} ended on`} style={{ display: "block", width: "100%", maxHeight: 260, objectFit: "cover", objectPosition: "top" }} />
          </div>
        )}
        {steps && <span style={{ fontSize: 13, color: "#3d4c45", lineHeight: 1.6 }}>{steps}</span>}
        {t.pending && <span style={{ fontSize: 14, color: "#3d4c45", lineHeight: 1.5 }}>Ready to press {t.pending}. Nothing was saved or sent yet.</span>}
        <ErrorLine error={approve.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {t.pending && t.status === "done" && (
          <button type="button" className="ld-btn p" disabled={approve.isPending} onClick={() => approve.mutate({ organizationId: currentOrgId, id })}>
            {approve.isPending ? "Starting..." : "Finish it"}
          </button>
        )}
        {open && (
          <a className="ld-btn ld-av-link-plain" href={open} target="_blank" rel="noreferrer noopener">
            Open page
          </a>
        )}
      </div>
    </div>
  );
}

/** Zara's open findings, top three, with Fix. */
export function FindingsCard() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.platform.overview.useQuery({ organizationId: currentOrgId }, { refetchInterval: (r) => ((r.state.data?.findings ?? []).some((f) => f.status === "fixing") ? 8000 : false) });
  const fix = trpc.platform.fix.useMutation({ onSuccess: () => Promise.all([utils.platform.overview.invalidate(), utils.chat.list.invalidate()]) });
  const open = (q.data?.findings ?? []).filter((f) => f.status === "open" || f.status === "fixing");
  if (!q.data) return null;
  if (!open.length)
    return (
      <div className="ld-card" style={{ padding: "14px 18px" }}>
        <span className="ld-small ld-muted">Nothing left to fix from the last audit.</span>
      </div>
    );
  const top = [...open].sort((a, b) => (a.severity === b.severity ? a.id - b.id : a.severity === "fix_now" ? -1 : 1)).slice(0, 3);
  return (
    <div className="ld-card" style={{ padding: 0 }}>
      {top.map((f, i) => (
        <div key={f.id} className="ld-resultcard" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 14, padding: "14px 16px", borderBottom: i < top.length - 1 || open.length > 3 ? "1px solid #eef2f0" : 0 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
              <b>{f.workflow}</b>
              <SevPill s={f.severity} />
            </div>
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>{f.detail || f.issue}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {f.status === "fixing" ? (
              <span className="ld-pill amber" style={{ alignSelf: "flex-start" }}>Fixing now</span>
            ) : f.severity === "fix_now" ? (
              <button type="button" className="ld-btn p" disabled={fix.isPending} onClick={() => fix.mutate({ organizationId: currentOrgId, findingId: f.id })}>Fix</button>
            ) : (
              <Link href="/chats/platform/work" className="ld-btn ld-av-link-plain">Open</Link>
            )}
          </div>
        </div>
      ))}
      {open.length > 3 && (
        <div style={{ padding: "10px 16px" }}>
          <Link href="/chats/platform/work" className="ld-small" style={{ color: "#155c3e", fontWeight: 700 }}>See all {open.length} on the Workflows tab</Link>
        </div>
      )}
      {fix.error && <div style={{ padding: "0 16px 12px" }}><ErrorLine error={fix.error} /></div>}
    </div>
  );
}

/** A page Zara put in a funnel: a draft until Publish. */
export function PlatformPageCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.platform.page.useQuery({ organizationId: currentOrgId, id }, { refetchInterval: (r) => (r.state.data?.publishing ? 8000 : false) });
  const publish = trpc.platform.publish.useMutation({ onSuccess: () => Promise.all([utils.platform.page.invalidate(), utils.chat.list.invalidate()]) });
  const p = q.data;
  if (!p) return null;
  const pill = p.published ? <span className="ld-pill green">Published</span> : p.publishing ? <span className="ld-pill amber">Publishing</span> : <span className="ld-pill gray">Draft in the platform</span>;
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <b>{p.title}</b>
          {pill}
        </div>
        <span style={{ fontSize: 13, color: "#3d4c45" }}>{[`${p.funnel} funnel`, `/${p.path}`, p.version ? `from Jordan's version ${p.version}` : ""].filter(Boolean).join(" · ")}</span>
        <ErrorLine error={publish.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {!p.published && (
          <button type="button" className="ld-btn p" disabled={publish.isPending || p.publishing} onClick={() => publish.mutate({ organizationId: currentOrgId, id })}>
            {p.publishing ? "Publishing..." : "Publish"}
          </button>
        )}
        {p.lastUrl && (
          <a className="ld-btn ld-av-link-plain" href={p.lastUrl} target="_blank" rel="noreferrer noopener">
            Open
          </a>
        )}
      </div>
    </div>
  );
}
