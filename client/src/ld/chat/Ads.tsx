import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import type { Outputs } from "../types";

/**
 * Reese's cards: the budget split (Use this split, Change it, Split evenly)
 * and one platform's creative set (Approve, Edit, Another version, Skip;
 * once approved, Copy text and the downloads). The same pieces draw the
 * open set on the Ads tab.
 */

export type CampaignView = Outputs["ads"]["campaign"];
export type SetView = Outputs["ads"]["set"];
export type SetRow = NonNullable<CampaignView["rows"][number]["set"]>;
type Platform = CampaignView["rows"][number]["platform"];

export const PLATFORM_LOOK: Record<Platform, { bg: string; fg?: string; letter: string }> = {
  meta: { bg: "#1877f2", letter: "M" },
  google: { bg: "#4285f4", letter: "G" },
  youtube: { bg: "#ff0000", letter: "▶" },
  microsoft: { bg: "#0b7a3b", letter: "B" },
  linkedin: { bg: "#0a66c2", letter: "in" },
  tiktok: { bg: "#111111", letter: "T" },
  reddit: { bg: "#ff4500", letter: "r" },
  spotify: { bg: "#1db954", letter: "S" },
  nextdoor: { bg: "#8ed500", fg: "#123", letter: "N" },
  yelp: { bg: "#d32323", letter: "Y" },
};

export const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const mdy = (ymd: string) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}` : ymd);
export const longDate = (ymd: string) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ymd);

export function PlatformTag({ platform, name, size = 22 }: { platform: Platform; name: string; size?: number }) {
  const look = PLATFORM_LOOK[platform];
  return (
    <span className="ad-pl">
      <i style={{ background: look.bg, color: look.fg ?? "#fff", width: size, height: size, fontSize: Math.round(size * 0.5) }}>{look.letter}</i>
      {name}
    </span>
  );
}

export function SetStatus({ status }: { status: SetRow["status"] | "none" | "left" }) {
  const map: Record<string, { cls: string; label: string }> = {
    review: { cls: "amber", label: "Waiting for you" },
    approved: { cls: "green", label: "Approved" },
    skipped: { cls: "gray", label: "Skipped" },
    writing: { cls: "gray", label: "Writing" },
    replaced: { cls: "gray", label: "Replaced" },
    none: { cls: "gray", label: "Not yet" },
    left: { cls: "gray", label: "Left out" },
  };
  const m = map[status] ?? map.none;
  return <span className={`ld-pill ${m.cls}`}>{m.label}</span>;
}

const asLines = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join("\n") : v ?? "");

/** The set's words, field by field. */
export function SetFields({ s }: { s: SetRow }) {
  return (
    <div className="ad-copy">
      {s.fields.map((f) => {
        const v = s.content[f.key];
        const empty = v == null || (Array.isArray(v) ? v.length === 0 : !String(v).trim());
        if (empty) return null;
        return (
          <React.Fragment key={f.key}>
            <span className="k">{f.label}</span>
            {Array.isArray(v) ? <span className={f.key === "headlines" ? "hl" : ""}>{v.join(" · ")}</span> : <span className={f.key === "headline" || f.key === "hook" || f.key === "title" ? "hl" : ""} style={{ whiteSpace: "pre-line" }}>{v}</span>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** The picture (or its placeholder) beside the words. */
export function SetPicture({ s, small }: { s: SetRow; small?: boolean }) {
  if (!s.imageLabel) return <div className="ld-small ld-muted" style={{ maxWidth: 200 }}>{s.copies ? `Copied from ${s.copies}. Same words; Reese keeps them in step.` : "Text ads, no picture. Shown on searches for the keywords."}</div>;
  const tall = s.imageLabel.includes("1920 ·") || s.imageLabel.includes("9:16") || s.imageLabel.includes("1080 × 1920");
  const w = small ? 180 : 220;
  const h = tall ? Math.round(w * 1.5) : s.imageLabel.includes("1080 × 1080") || s.imageLabel.includes("640") ? w : Math.round(w * 0.56);
  return (
    <div className="ad-img" style={{ width: w, height: h }}>
      {s.imageUrl ? <img src={s.imageUrl} alt="" /> : <span className="ld-small" style={{ color: "#fff", opacity: 0.9, padding: 12 }}>{s.imageError ? `No picture yet: ${s.imageError}` : "Picture on the way"}</span>}
      <small>{s.imageLabel}</small>
    </div>
  );
}

/** Edit: every field as a compact box; lists one item per line. Save and Cancel. */
export function SetEditor({ s, onDone }: { s: SetRow; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [draft, setDraft] = React.useState<Record<string, string>>(() => Object.fromEntries(s.fields.map((f) => [f.key, asLines(s.content[f.key])])));
  const save = trpc.ads.saveSet.useMutation({ onSuccess: async () => { await utils.ads.invalidate(); onDone(); } });
  const go = () => {
    const content: Record<string, string | string[]> = {};
    for (const f of s.fields) content[f.key] = f.kind === "list" ? draft[f.key].split("\n").map((x) => x.trim()).filter(Boolean) : draft[f.key];
    save.mutate({ organizationId: currentOrgId, id: s.id, content });
  };
  return (
    <div className="ad-copy">
      {s.fields.map((f) => (
        <label key={f.key} className="ad-f">
          <span className="k">{f.label}{f.limit && f.kind !== "list" ? ` · ${draft[f.key].length} of ${f.limit}` : f.kind === "list" ? " · one per line" : ""}</span>
          {f.kind === "text" ? (
            <input className="ld-in" value={draft[f.key]} maxLength={f.limit} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
          ) : (
            <textarea className="ld-ta" rows={f.kind === "list" ? Math.min(8, Math.max(3, draft[f.key].split("\n").length + 1)) : 3} value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
          )}
        </label>
      ))}
      <div className="ld-row">
        <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={go}>Save</button>
        <button type="button" className="ld-btn sm" onClick={onDone}>Cancel</button>
      </div>
      <ErrorLine error={save.error} />
    </div>
  );
}

/** Approve, Edit, Another version, Skip; or, once approved, Copy text and the downloads. */
export function SetActions({ s, text, onEdit }: { s: SetRow; text: string; onEdit: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.ads.invalidate(), utils.chat.list.invalidate()]);
  const approve = trpc.ads.approve.useMutation({ onSuccess: refresh });
  const skip = trpc.ads.skip.useMutation({ onSuccess: refresh });
  const rewrite = trpc.ads.rewrite.useMutation({ onSuccess: refresh });
  const [copied, setCopied] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const [note, setNote] = React.useState("");
  const busy = approve.isPending || skip.isPending || rewrite.isPending;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const err = approve.error ?? skip.error ?? rewrite.error;
  if (s.status === "writing") return <span className="ld-small ld-muted">Reese is writing this one.</span>;
  if (s.status === "review") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="ld-row" style={{ flexWrap: "wrap" }}>
          <button type="button" className="ld-btn p sm gp-auto" disabled={busy} onClick={() => approve.mutate({ organizationId: currentOrgId, id: s.id })}>Approve</button>
          <button type="button" className="ld-btn sm gp-auto" disabled={busy} onClick={onEdit}>Edit</button>
          <button type="button" className="ld-btn sm gp-auto" disabled={busy} onClick={() => setAsking((v) => !v)}>Another version</button>
          <button type="button" className="ld-btn sm gp-auto" disabled={busy} onClick={() => skip.mutate({ organizationId: currentOrgId, id: s.id })}>Skip {s.name}</button>
        </div>
        {asking && (
          <div className="ld-row" style={{ gap: 8 }}>
            <input className="ld-in" style={{ maxWidth: 360 }} placeholder="What to change (optional)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && rewrite.mutate({ organizationId: currentOrgId, id: s.id, note })} />
            <button type="button" className="ld-btn p sm gp-auto" disabled={busy} onClick={() => rewrite.mutate({ organizationId: currentOrgId, id: s.id, note })}>Write it</button>
            <button type="button" className="ld-btn sm gp-auto" onClick={() => setAsking(false)}>Cancel</button>
          </div>
        )}
        <ErrorLine error={err} />
      </div>
    );
  }
  if (s.status === "approved") {
    return (
      <div className="ld-row" style={{ flexWrap: "wrap" }}>
        <SetStatus status="approved" />
        <button type="button" className="ld-btn sm gp-auto" onClick={copy}>{copied ? "Copied" : s.audio ? "Copy script" : "Copy text"}</button>
        {s.imageUrl && <a className="ld-btn sm gp-auto" href={s.imageUrl} download target="_blank" rel="noreferrer noopener">{s.video ? "Download cover" : "Download image"}</a>}
        {s.audioUrl && <a className="ld-btn sm gp-auto" href={s.audioUrl} download target="_blank" rel="noreferrer noopener">Download audio</a>}
        <button type="button" className="ld-btn sm gp-auto" onClick={onEdit}>Edit</button>
        <ErrorLine error={err} />
      </div>
    );
  }
  return <SetStatus status={s.status} />;
}

/** One set: the picture beside the words, then the actions. */
export function SetBody({ s, text }: { s: SetRow; text: string }) {
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="ad-var">
      <div><SetPicture s={s} /></div>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {editing ? <SetEditor s={s} onDone={() => setEditing(false)} /> : <SetFields s={s} />}
        {!editing && <SetActions s={s} text={text} onEdit={() => setEditing(true)} />}
      </div>
    </div>
  );
}

/** The steps across the top of a set card: approved ones ticked, the open one dark. */
function Steps({ c, open }: { c: CampaignView; open: Platform }) {
  return (
    <div className="ad-steps">
      {c.rows.filter((r) => !r.leftOut).map((r) => {
        const done = r.set?.status === "approved" || r.set?.status === "skipped";
        return <span key={r.platform} className={done ? "done" : r.platform === open ? "on" : ""}>{r.name}{done ? " ✓" : ""}</span>;
      })}
    </div>
  );
}

/** A set in chat: fetched live, so Approve here or on the Ads tab shows the same state. */
export function AdSetCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const q = trpc.ads.set.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0, refetchInterval: (r) => (r.state.data?.status === "writing" ? 3000 : false) });
  const c = trpc.ads.campaign.useQuery({ organizationId: currentOrgId, id: q.data?.campaignId ?? 0 }, { enabled: currentOrgId > 0 && !!q.data });
  const s = q.data;
  if (!s) return <div className="ld-card" style={{ padding: 14 }}><span className="ld-small ld-muted">{q.isLoading ? "Loading..." : "This set is gone."}</span></div>;
  return (
    <div className="ld-card ad-card">
      <div className="ad-hd">
        <b>{s.campaignName}</b>
        <span className="ld-small ld-muted">{s.position.n} of {s.position.of} · {s.name}{s.version > 1 ? ` · version ${s.version}` : ""}</span>
      </div>
      {c.data && s.status === "review" && <Steps c={c.data} open={s.platform} />}
      <div style={{ padding: "12px 14px 14px" }}>
        <div style={{ marginBottom: 8 }}><PlatformTag platform={s.platform} name={s.name} /></div>
        <SetBody s={s} text={s.text} />
      </div>
    </div>
  );
}

/** The budget split in chat: a table with Use this split, Change it and Split evenly; once taken, it shows which split was used. */
export function AdBudgetCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.ads.campaign.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0 });
  const [editing, setEditing] = React.useState(false);
  const refresh = () => Promise.all([utils.ads.invalidate(), utils.chat.list.invalidate()]);
  const start = trpc.ads.start.useMutation({ onSuccess: refresh });
  const c = q.data;
  if (!c) return <div className="ld-card" style={{ padding: 14 }}><span className="ld-small ld-muted">{q.isLoading ? "Loading..." : "This campaign is gone."}</span></div>;
  const taken = c.status !== "budget";
  const rows = c.rows.filter((r) => !r.leftOut);
  return (
    <div className="ld-card ad-card">
      <div className="ad-hd">
        <b>Budget · {c.budget}{c.days ? ` · ${longDate(c.startDate)} to ${longDate(c.endDate)} (${c.days} days)` : ""}</b>
        <span className="ld-small ld-muted">{c.splitMode === "even" ? "Split evenly" : c.splitMode === "custom" ? "Your split" : "Reese's split"}</span>
      </div>
      {editing ? (
        <BudgetEditor c={c} onDone={() => setEditing(false)} onSaved={(mode) => { setEditing(false); if (!taken) start.mutate({ organizationId: currentOrgId, id: c.id, mode }); }} />
      ) : (
        <>
          <div className="ad-bud h"><span>Platform</span><span>Share</span><span>Total</span><span>Per day</span></div>
          {rows.map((r) => (
            <div key={r.platform} className="ad-bud">
              <PlatformTag platform={r.platform} name={r.name} size={18} />
              <span>{r.share}%</span>
              <span><b>{money(r.totalCents)}</b></span>
              <span>{c.days ? money(r.perDayCents) : "set dates"}</span>
            </div>
          ))}
          <div className="ad-bud t"><span>Total</span><span>{rows.reduce((n, r) => n + r.share, 0)}%</span><span>{c.budget}</span><span>{c.days ? money(c.perDayCents) : ""}</span></div>
          {c.leftOutWhy && c.rows.some((r) => r.leftOut) && <div className="ld-small ld-muted" style={{ padding: "8px 14px 0" }}>{c.rows.filter((r) => r.leftOut).map((r) => r.name).join(" and ")} left out: {c.leftOutWhy}</div>}
          <div className="ld-row" style={{ padding: "10px 14px 14px", flexWrap: "wrap" }}>
            {!taken ? (
              <>
                <button type="button" className="ld-btn p sm gp-auto" disabled={start.isPending} onClick={() => start.mutate({ organizationId: currentOrgId, id: c.id, mode: c.splitMode === "even" ? "even" : "reese" })}>Use this split</button>
                <button type="button" className="ld-btn sm gp-auto" onClick={() => setEditing(true)}>Change it</button>
                <button type="button" className="ld-btn sm gp-auto" disabled={start.isPending} onClick={() => start.mutate({ organizationId: currentOrgId, id: c.id, mode: "even" })}>Split evenly</button>
              </>
            ) : (
              <button type="button" className="ld-btn sm gp-auto" onClick={() => setEditing(true)}>Edit</button>
            )}
          </div>
          <ErrorLine error={start.error} />
        </>
      )}
    </div>
  );
}

/** The budget in edit: total, dates typed MM/DD/YYYY, a share and a total per platform (one follows the other), Use Reese's split or Split evenly, Save and Cancel. */
export function BudgetEditor({ c, onDone, onSaved }: { c: CampaignView; onDone: () => void; onSaved: (mode: "reese" | "even" | "custom") => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const rows = c.rows.filter((r) => !r.leftOut);
  const [budget, setBudget] = React.useState((c.budgetCents / 100).toString());
  const [start, setStart] = React.useState(mdy(c.startDate));
  const [end, setEnd] = React.useState(mdy(c.endDate));
  const [shares, setShares] = React.useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.platform, String(r.share)])));
  const [mode, setMode] = React.useState<"reese" | "even" | "custom">(c.splitMode);
  const save = trpc.ads.saveBudget.useMutation({ onSuccess: async (_v, vars) => { await utils.ads.invalidate(); onSaved(vars.mode); } });
  const cents = Math.round(Number(budget.replace(/[^0-9.]/g, "")) * 100) || 0;
  const days = (() => {
    const a = Date.parse(`${toYmd(start)}T00:00:00Z`);
    const b = Date.parse(`${toYmd(end)}T00:00:00Z`);
    return Number.isNaN(a) || Number.isNaN(b) || b < a ? 0 : Math.round((b - a) / 86_400_000) + 1;
  })();
  const sum = rows.reduce((n, r) => n + (Number(shares[r.platform]) || 0), 0);
  const setShare = (p: string, v: string) => { setShares({ ...shares, [p]: v }); setMode("custom"); };
  const setTotal = (p: string, v: string) => { const dollars = Number(v.replace(/[^0-9.]/g, "")) || 0; setShares({ ...shares, [p]: cents ? String(Math.round((dollars * 100 * 100) / cents)) : "0" }); setMode("custom"); };
  const even = () => { const n = rows.length; const base = Math.floor(100 / n); const extra = 100 % n; setShares(Object.fromEntries(rows.map((r, i) => [r.platform, String(base + (i < extra ? 1 : 0))]))); setMode("even"); };
  const reese = () => { setShares(Object.fromEntries(rows.map((r) => [r.platform, String(r.share)]))); setMode("reese"); };
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div className="ld-row" style={{ padding: "10px 14px 0", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="ld-btn sm gp-auto" onClick={reese}>Use Reese's split</button>
        <button type="button" className="ld-btn sm gp-auto" onClick={even}>Split evenly</button>
      </div>
      <div className="ad-form" style={{ gridTemplateColumns: "150px 140px 140px 80px" }}>
        <label className="ad-f"><span className="k">Total budget</span><input className="ld-in" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
        <label className="ad-f"><span className="k">Starts (MM/DD/YYYY)</span><input className="ld-in" value={start} placeholder="MM/DD/YYYY" onChange={(e) => setStart(e.target.value)} /></label>
        <label className="ad-f"><span className="k">Ends (MM/DD/YYYY)</span><input className="ld-in" value={end} placeholder="MM/DD/YYYY" onChange={(e) => setEnd(e.target.value)} /></label>
        <div className="ad-f"><span className="k">Days</span><b style={{ lineHeight: "32px" }}>{days || "?"}</b></div>
      </div>
      <div className="ad-bud h"><span>Platform</span><span>Share</span><span>Total</span><span>Per day</span></div>
      {rows.map((r) => {
        const share = Number(shares[r.platform]) || 0;
        const total = Math.round((cents * share) / 100);
        return (
          <div key={r.platform} className="ad-bud">
            <PlatformTag platform={r.platform} name={r.name} size={18} />
            <span className="ld-row" style={{ gap: 4 }}><input className="ld-in" style={{ width: 64 }} value={shares[r.platform]} onChange={(e) => setShare(r.platform, e.target.value)} aria-label={`${r.name} share`} />%</span>
            <span><input className="ld-in" style={{ width: 96 }} value={total ? (total / 100).toFixed(0) : "0"} onChange={(e) => setTotal(r.platform, e.target.value)} aria-label={`${r.name} total`} /></span>
            <span>{days ? money(Math.round(total / days)) : ""}</span>
          </div>
        );
      })}
      <div className="ad-bud t"><span>Total</span><span style={{ color: sum === 100 ? undefined : "#b42318" }}>{sum}%</span><span>{money(cents)}</span><span>{days ? money(Math.round(cents / days)) : ""}</span></div>
      <div className="ld-small ld-muted" style={{ padding: "6px 14px 0" }}>Shares must add up to 100%. Type a share or a total and the other follows.</div>
      <div className="ld-row" style={{ padding: "10px 14px 14px", justifyContent: "flex-end" }}>
        <button type="button" className="ld-btn sm gp-auto" onClick={onDone}>Cancel</button>
        <button type="button" className="ld-btn p sm gp-auto" disabled={save.isPending || sum !== 100} onClick={() => save.mutate({ organizationId: currentOrgId, id: c.id, budget, startDate: start, endDate: end, shares: Object.fromEntries(rows.map((r) => [r.platform, Number(shares[r.platform]) || 0])), mode })}>Save</button>
      </div>
      <div style={{ padding: "0 14px 10px" }}><ErrorLine error={save.error} /></div>
    </div>
  );
}

function toYmd(raw: string) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : raw.trim();
}
