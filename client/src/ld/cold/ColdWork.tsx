import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs, UnderlineTabs } from "../ui";
import { fmtDate, openDownload, uploadFile } from "../meta";
import type { Outputs } from "../types";
import Outreach from "../work/Outreach";

/**
 * Jada's Outreach tab: cold email to the owner's lead list through Instantly
 * (today's sending, the plan, inbox health and the weekly review), the Lead
 * list, Campaigns, Replies, Pre-call reports, the Playbook, and the warm
 * outreach to prospects Riley finds.
 */

type C = Outputs["cold"];
type Overview = C["overview"];
type Lead = C["leads"]["rows"][number];
type Campaign = C["campaigns"]["list"][number];
type Reply = C["replies"][number];
type Play = C["playbook"][number];
type Precall = Outputs["precall"]["list"][number];

const fmt = (d: Date | string | null | undefined) => (d ? fmtDate(d) : "");
const fmtWhen = (d: Date | string | null | undefined) => (d ? `${fmtDate(d)} at ${new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "");
const n = (x: number | null | undefined) => (x ?? 0).toLocaleString("en-US");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "0%");
const typedToIso = (s: string) => {
  const t = s.trim();
  if (!t) return "";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};
const TA: React.CSSProperties = { height: "auto", padding: "8px 10px", lineHeight: 1.5, resize: "vertical" };
const STAGE: Record<string, [string, string]> = {
  new: ["gray", "Not sent yet"],
  queued: ["gray", "Queued"],
  in_campaign: ["amber", "In a campaign"],
  replied: ["green", "Replied"],
  booked: ["green", "Booked"],
  finished: ["gray", "Finished"],
  not_fit: ["gray", "Not sending"],
  dnc: ["red", "Do not contact"],
};
const KIND_PILL: Record<string, string> = { hot: "red", demo: "red", interested: "green", objection: "amber", question: "purple", wrong_person: "blue", referral: "blue", not_now: "gray", negative: "gray", unsubscribe: "gray", ooo: "gray", other: "gray" };
const CONF: Record<string, [string, string]> = { verified: ["green", "Verified"], likely: ["amber", "Likely"], unknown: ["gray", "Unknown"] };

function useOrg() {
  return useTenant().currentOrgId;
}
function useRefresh() {
  const utils = trpc.useUtils();
  return () => Promise.all([utils.cold.invalidate(), utils.precall.invalidate()]);
}

function Card({ label, children, buttons, right }: { label?: string; children: React.ReactNode; buttons?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: buttons ? "minmax(0,1fr) 128px" : "minmax(0,1fr)", gap: 20, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {(label || right) && (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {label && <span className="ld-lbl">{label}</span>}
            {right}
          </div>
        )}
        {children}
      </div>
      {buttons && <Buttons>{buttons}</Buttons>}
    </div>
  );
}
function Buttons({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>;
}
function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="ld-cold-kv" style={{ display: "grid", gridTemplateColumns: "170px minmax(0,1fr)", gap: "7px 14px", fontSize: 14, lineHeight: 1.5 }}>
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
        <React.Fragment key={k}>
          <b>{k}</b>
          <span style={{ overflowWrap: "anywhere" }}>{v}</span>
        </React.Fragment>
      ))}
    </div>
  );
}
function Box({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--ld-surface)", border: "1px solid #e3e9e6", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      {label && <span className="ld-lbl">{label}</span>}
      {children}
    </div>
  );
}
function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <Box>
      <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{label}</span>
      <b style={{ fontSize: 22 }}>{value}</b>
      {sub && <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{sub}</span>}
    </Box>
  );
}
function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "inline-flex", border: "1px solid #cfd9d4", borderRadius: 8, overflow: "hidden", alignSelf: "flex-start", flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={String(o.key)} type="button" role="radio" aria-checked={value === o.key} onClick={() => onChange(o.key)} style={{ height: 32, padding: "0 14px", border: 0, borderRight: "1px solid #e3e9e6", background: value === o.key ? "var(--ld-accent-bg)" : "#fff", font: "inherit", fontSize: 13, fontWeight: 700, color: value === o.key ? "var(--ld-accent-dark)" : "var(--ld-text2)", cursor: "pointer", whiteSpace: "nowrap" }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
function Form({ children }: { children: React.ReactNode }) {
  return <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "190px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>{children}</div>;
}
function Label({ id, children, top }: { id: string; children: React.ReactNode; top?: boolean }) {
  return <label htmlFor={id} style={{ fontWeight: 700, ...(top ? { alignSelf: "start", paddingTop: 6 } : {}) }}>{children}</label>;
}
function Bar({ value, max, warn }: { value: number; max: number; warn?: boolean }) {
  const w = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ height: 8, borderRadius: 999, background: "var(--ld-line2)", overflow: "hidden" }} role="img" aria-label={`${w}%`}>
      <div style={{ width: `${w}%`, height: "100%", background: warn ? "#c26a1c" : "var(--ld-accent)" }} />
    </div>
  );
}
function Step({ title, when, children }: { title: string; when?: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #e3e9e6", borderRadius: 10, background: "var(--ld-surface)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 14 }}>{title}</b>
        {when && <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{when}</span>}
      </div>
      {children}
    </div>
  );
}

// ==========================================
// The page
// ==========================================

type Tab = "cold" | "leads" | "campaigns" | "replies" | "precall" | "playbook" | "warm";

export default function ColdWork({ emp }: { emp: EmployeeRow }) {
  const orgId = useOrg();
  const initial = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
  const [tab, setTab] = React.useState<Tab>(initial && ["cold", "leads", "campaigns", "replies", "precall", "playbook", "warm"].includes(initial) ? (initial as Tab) : initial === "outreach" ? "warm" : "cold");
  const ov = trpc.cold.overview.useQuery({ organizationId: orgId }, { refetchInterval: 60_000 });
  const leads = trpc.cold.leads.useQuery({ organizationId: orgId, page: 0 });
  const camps = trpc.cold.campaigns.useQuery({ organizationId: orgId });
  const replies = trpc.cold.replies.useQuery({ organizationId: orgId }, { refetchInterval: 60_000 });
  const pre = trpc.precall.list.useQuery({ organizationId: orgId }, { refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === "running") ? 8000 : 60_000) });
  const seqs = trpc.sales.sequences.useQuery({ organizationId: orgId });
  return (
    <main className="ld-main" style={{ padding: "24px 32px", gap: 16 }}>
      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "cold", label: "Cold email" },
          { key: "leads", label: `Lead list (${n(leads.data?.counts.total)})` },
          { key: "campaigns", label: `Campaigns (${camps.data?.list.length ?? 0})` },
          { key: "replies", label: `Replies (${(replies.data ?? []).filter((r) => r.status === "open").length})` },
          { key: "precall", label: `Pre-call (${(pre.data ?? []).filter((r) => r.status !== "done").length})` },
          { key: "playbook", label: "Playbook" },
          { key: "warm", label: `Warm outreach (${(seqs.data ?? []).filter((s) => s.tab === "waiting").length})` },
        ]}
      />
      {tab === "cold" && (ov.data ? <ColdEmail v={ov.data} /> : <div className="ld-card ld-empty">{ov.isLoading ? "Loading..." : "Couldn't load cold email."}</div>)}
      {tab === "leads" && <LeadList />}
      {tab === "campaigns" && <Campaigns />}
      {tab === "replies" && <Replies list={replies.data ?? []} />}
      {tab === "precall" && <Precalls list={pre.data ?? []} />}
      {tab === "playbook" && <Playbook v={ov.data} />}
      {tab === "warm" && <Outreach emp={emp} embedded />}
    </main>
  );
}

// ==========================================
// Cold email: today, plan, inboxes, review, settings
// ==========================================

function ColdEmail({ v }: { v: Overview }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [settings, setSettings] = React.useState(false);
  const pause = trpc.cold.pause.useMutation({ onSuccess: refresh });
  if (!v.connected)
    return (
      <>
        <Connect error={v.keyError} />
        <ColdSettings v={v} />
      </>
    );
  const b = v.budget!;
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const limited = { contacts: "your plan's contact limit", plan: "your plan's monthly emails", inboxes: "your healthy inboxes", ramp: "this week's warm-up pace" }[b.limitedBy];
  return (
    <>
      {v.paused && (
        <div role="alert" className="ld-card" style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "center", background: "#fdeeee", borderColor: "#f3cccc" }}>
          <span style={{ fontSize: 14, lineHeight: 1.5 }}><b>Cold email is paused.</b> No new leads go to Instantly until you resume. Replies are still read.</span>
          <button type="button" className="ld-btn" disabled={pause.isPending} onClick={() => pause.mutate({ organizationId: orgId, paused: false })}>Resume</button>
        </div>
      )}
      <Card
        label={`Today, ${today}`}
        buttons={
          <>
            {!v.paused && <button type="button" className="ld-btn" disabled={pause.isPending} onClick={() => pause.mutate({ organizationId: orgId, paused: true })}>Pause sending</button>}
            <button type="button" className="ld-btn" onClick={() => setSettings(!settings)}>{settings ? "Close settings" : "Settings"}</button>
          </>
        }
      >
        <div className="ld-cold-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 12 }}>
          <Stat label="New leads today" value={`${n(b.addedToday)} of ${n(b.cap)}`} sub={`Set by ${limited}`} />
          <Stat label="Emails sent today" value={n(v.followUpsToday)} sub="New and follow-ups" />
          <Stat label="Replies to answer" value={n(v.repliesOpen)} sub={v.hotOpen ? `${v.hotOpen} hot ${v.hotOpen === 1 ? "lead" : "leads"}` : undefined} />
          <Stat label="Demos booked this month" value={n(v.bookedThisMonth)} sub={v.precallReady ? `Pre-call reports ready for ${v.precallReady}` : undefined} />
        </div>
        <ErrorLine error={pause.error} />
      </Card>

      {settings && <ColdSettings v={v} />}

      <Card label={`Your Instantly plan: ${v.plan.name}`} buttons={<a className="ld-btn ld-av-link-plain" href="https://app.instantly.ai/app/campaigns" target="_blank" rel="noreferrer">Open Instantly</a>}>
        <div className="ld-cold-bars" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr) 170px", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
          <b>Contacts in Instantly</b><Bar value={v.inInstantly} max={v.plan.contacts} /><span>{n(v.inInstantly)} of {n(v.plan.contacts)}</span>
          <b>Emails this month</b><Bar value={b.monthSent} max={v.plan.emails} warn /><span>{n(b.monthSent)} of {n(v.plan.emails)}</span>
          <b>Your inboxes could send</b><Bar value={Math.min(v.plan.emails, b.inboxCapacityMonth)} max={Math.max(v.plan.emails, b.inboxCapacityMonth)} /><span>About {n(b.inboxCapacityMonth)} a month</span>
        </div>
        <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.5 }}>
          Jada moves finished leads out of Instantly so new ones fit.{b.inboxCapacityMonth > v.plan.emails ? ` Your ${b.healthy} healthy inboxes could send more than your plan allows.` : ""}
        </span>
      </Card>

      <Inboxes v={v} />
      {v.review && <Review r={v.review} />}
    </>
  );
}

function Connect({ error }: { error: string | null }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [key, setKey] = React.useState("");
  const connect = trpc.cold.connect.useMutation({ onSuccess: async () => { setKey(""); await refresh(); } });
  return (
    <Card label="Connect Instantly" buttons={<button type="button" className="ld-btn p" disabled={!key.trim() || connect.isPending} onClick={() => connect.mutate({ organizationId: orgId, key })}>{connect.isPending ? "Checking..." : "Connect"}</button>}>
      <span style={{ fontSize: 14, lineHeight: 1.6 }}>In Instantly, open Settings, then Integrations, then API keys. Make a key with all scopes and paste it here. It's checked with Instantly, then stored encrypted on your server. Nobody sees it again, including Jada.</span>
      <Form>
        <Label id="ik">API key</Label>
        <input id="ik" className="ld-in" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </Form>
      {error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{error}</span>}
      <ErrorLine error={connect.error} />
    </Card>
  );
}

function Inboxes({ v }: { v: Overview }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [all, setAll] = React.useState(false);
  const [open, setOpen] = React.useState<number | null>(null);
  const sync = trpc.cold.syncInboxes.useMutation({ onSuccess: refresh });
  const rest = trpc.cold.restInbox.useMutation({ onSuccess: refresh });
  const COLS = "minmax(0,2fr) 110px 110px 110px 150px 128px";
  const list = all ? v.inboxes : v.inboxes.slice(0, 3);
  const resting = v.inboxes.filter((i) => i.status !== "healthy");
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div style={{ padding: "14px 18px 6px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span className="ld-lbl">Inbox health</span>
        <button type="button" className="ld-btn" disabled={sync.isPending} onClick={() => sync.mutate({ organizationId: orgId })}>{sync.isPending ? "Checking..." : "Check now"}</button>
      </div>
      <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Inbox</span><span>Sent today</span><span>Bounces</span><span>Replies</span><span>Status</span><span /></div>
      {!v.inboxes.length && <div className="ld-empty">No inboxes yet. Press Check now to read them from Instantly.</div>}
      {list.map((i) => (
        <React.Fragment key={i.id}>
          <div className={`ld-rw ${open === i.id ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
            <span style={{ overflowWrap: "anywhere" }}>{i.email}</span>
            <span className="ld-cold-d">{n(i.sentToday)}</span>
            <span className="ld-cold-d">{pct(i.bounced7, i.sent7)}</span>
            <span className="ld-cold-d">{pct(i.replies7, i.sent7)}</span>
            <span className="ld-cold-m">{n(i.sentToday)} sent today · {pct(i.bounced7, i.sent7)} bounces · {pct(i.replies7, i.sent7)} replies</span>
            <span className={`ld-pill ${i.status === "healthy" ? "green" : "red"}`} style={{ justifySelf: "start" }}>{i.status === "healthy" ? "Healthy" : i.status === "resting" ? "Resting" : "Not sending"}</span>
            <button type="button" className="ld-btn" onClick={() => setOpen(open === i.id ? null : i.id)}>{open === i.id ? "Close" : "Details"}</button>
          </div>
          {open === i.id && (
            <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
              <KV rows={[["Last 7 days", `${n(i.sent7)} sent, ${n(i.bounced7)} bounced, ${n(i.replies7)} replies`], ["Warmup score", i.warmupScore != null ? String(i.warmupScore) : ""], ["Why", i.reason ?? ""], ["Resting since", fmt(i.restedAt)]]} />
              <Buttons>
                {i.status === "healthy" ? (
                  <button type="button" className="ld-btn" disabled={rest.isPending} onClick={() => rest.mutate({ organizationId: orgId, id: i.id, rest: true })}>Rest it</button>
                ) : (
                  <button type="button" className="ld-btn p" disabled={rest.isPending} onClick={() => rest.mutate({ organizationId: orgId, id: i.id, rest: false })}>Put it back</button>
                )}
              </Buttons>
            </div>
          )}
        </React.Fragment>
      ))}
      <div style={{ padding: "10px 18px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }} className="ld-small">
        <span style={{ color: "var(--ld-text2)" }}>
          {resting.length ? `${resting.length} out of rotation. ` : ""}
          {v.inboxes.length - resting.length} healthy.{v.lastInboxCheckAt ? ` Checked ${fmtWhen(v.lastInboxCheckAt)}.` : ""}
        </span>
        {v.inboxes.length > 3 && <button type="button" className="ld-btn" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${v.inboxes.length}`}</button>}
      </div>
      <ErrorLine error={sync.error || rest.error} />
    </div>
  );
}

function Review({ r }: { r: NonNullable<Overview["review"]> }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const apply = trpc.cold.applyReview.useMutation({ onSuccess: refresh });
  const dismiss = trpc.cold.dismissReview.useMutation({ onSuccess: refresh });
  const waiting = r.status === "waiting" && r.changes.length > 0;
  return (
    <Card
      label={`Jada's weekly review, ${fmt(r.at)}`}
      buttons={
        waiting ? (
          <>
            <button type="button" className="ld-btn p" disabled={apply.isPending} onClick={() => apply.mutate({ organizationId: orgId, id: r.id })}>Approve changes</button>
            <button type="button" className="ld-btn" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ organizationId: orgId, id: r.id })}>Not now</button>
          </>
        ) : (
          <Link href="/chats/outreach" className="ld-btn ld-av-link-plain">Ask Jada</Link>
        )
      }
    >
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7, listStyle: "decimal" }}>
        {r.points.map((p, i) => <li key={i}>{p}</li>)}
      </ol>
      {r.changes.length > 0 && (
        <Box label={r.status === "applied" ? "Changes made" : r.status === "dismissed" ? "Changes you passed on" : "Changes Jada wants to make"}>
          {r.changes.map((c, i) => (
            <span key={i} style={{ fontSize: 14, lineHeight: 1.5 }}>
              <b>{c.kind === "share" ? `${c.campaign}: ${c.share}% of new emails` : c.kind === "pause" ? `Pause ${c.campaign}` : `${c.campaign}: keep subject line ${String(c.version).toUpperCase()}`}.</b> {c.why}
            </span>
          ))}
        </Box>
      )}
      <span className="ld-small" style={{ color: "var(--ld-muted)" }}>Jada changes one thing at a time so she can tell what worked. At level 3 she makes these changes on her own.</span>
      <ErrorLine error={apply.error || dismiss.error} />
    </Card>
  );
}

const LEVELS = [1, 2, 3, 4] as const;
const LEVEL_SHORT: Record<number, string> = {
  1: "Level 1: you approve every reply.",
  2: "Level 2: routine replies send on their own.",
  3: "Level 3: she answers standard objections from your playbook and moves volume between campaigns.",
  4: "Level 4: she runs cold email and you take demos.",
};

function ColdSettings({ v }: { v: Overview }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const s = v.settings;
  const [edit, setEdit] = React.useState<null | { level: number; perInbox: string; rampPct: string; bounceRest: string; signature: string; address: string; optOut: string; alwaysNeedsYou: string; plan: "growth" | "hypergrowth" | "lightspeed" | "custom"; contactsLimit: string; emailsLimit: string; website: string }>(null);
  const save = trpc.cold.saveSettings.useMutation({ onSuccess: async () => { setEdit(null); await refresh(); } });
  const site = trpc.cold.checkSite.useMutation({ onSuccess: refresh });
  const disconnect = trpc.cold.disconnect.useMutation({ onSuccess: refresh });
  const dl = trpc.cold.suppressList.useMutation({ onSuccess: (r) => openDownload(r) });
  const dnc = trpc.cold.doNotContact.useMutation({ onSuccess: async () => { setAdding(null); await refresh(); } });
  const [adding, setAdding] = React.useState<string | null>(null);
  const start = () =>
    setEdit({ level: s.level, perInbox: String(s.perInbox), rampPct: String(s.rampPct), bounceRest: String(s.bounceRest), signature: s.signature, address: s.address || s.site.address, optOut: s.optOut, alwaysNeedsYou: s.alwaysNeedsYou, plan: v.plan.key, contactsLimit: String(v.plan.contacts), emailsLimit: String(v.plan.emails), website: s.website });
  const num = (x: string, d: number) => (Number.isFinite(Number(x)) && x.trim() ? Math.round(Number(x)) : d);
  return (
    <>
      {edit ? (
        <Card
          label="Cold email settings"
          buttons={
            <>
              <button
                type="button"
                className="ld-btn p"
                disabled={save.isPending}
                onClick={() => save.mutate({ organizationId: orgId, level: edit.level, perInbox: num(edit.perInbox, 20), rampPct: num(edit.rampPct, 10), bounceRest: num(edit.bounceRest, 3), signature: edit.signature, address: edit.address, optOut: edit.optOut, alwaysNeedsYou: edit.alwaysNeedsYou, plan: edit.plan, website: edit.website, ...(edit.plan === "custom" ? { contactsLimit: num(edit.contactsLimit, 1000), emailsLimit: num(edit.emailsLimit, 5000) } : {}) })}
              >
                Save
              </button>
              <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
            </>
          }
        >
          <Form>
            <b>How much Jada does</b>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Seg label="Level" value={edit.level} onChange={(x) => setEdit({ ...edit, level: x })} options={LEVELS.map((l) => ({ key: l, label: `Level ${l}` }))} />
              <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{LEVEL_SHORT[edit.level]}</span>
            </div>
            <b>Instantly plan</b>
            <Seg label="Plan" value={edit.plan} onChange={(x) => setEdit({ ...edit, plan: x })} options={[{ key: "growth", label: "Growth" }, { key: "hypergrowth", label: "Hypergrowth" }, { key: "lightspeed", label: "Light Speed" }, { key: "custom", label: "Other" }]} />
            {edit.plan === "custom" && (
              <>
                <Label id="cs-c">Contacts allowed</Label>
                <input id="cs-c" className="ld-in" style={{ width: 120 }} inputMode="numeric" value={edit.contactsLimit} onChange={(e) => setEdit({ ...edit, contactsLimit: e.target.value })} />
                <Label id="cs-e">Emails a month</Label>
                <input id="cs-e" className="ld-in" style={{ width: 120 }} inputMode="numeric" value={edit.emailsLimit} onChange={(e) => setEdit({ ...edit, emailsLimit: e.target.value })} />
              </>
            )}
            <Label id="cs-1">Most per inbox a day</Label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><input id="cs-1" className="ld-in" style={{ width: 80 }} inputMode="numeric" value={edit.perInbox} onChange={(e) => setEdit({ ...edit, perInbox: e.target.value })} /><span>new emails</span></div>
            <Label id="cs-2">Raise volume by at most</Label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><input id="cs-2" className="ld-in" style={{ width: 80 }} inputMode="numeric" value={edit.rampPct} onChange={(e) => setEdit({ ...edit, rampPct: e.target.value })} /><span>% a week</span></div>
            <Label id="cs-3">Rest an inbox over</Label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><input id="cs-3" className="ld-in" style={{ width: 80 }} inputMode="numeric" value={edit.bounceRest} onChange={(e) => setEdit({ ...edit, bounceRest: e.target.value })} /><span>% bounces</span></div>
            <Label id="cs-4">Signature</Label>
            <input id="cs-4" className="ld-in" value={edit.signature} onChange={(e) => setEdit({ ...edit, signature: e.target.value })} />
            <Label id="cs-5">Mailing address</Label>
            <input id="cs-5" className="ld-in" value={edit.address} placeholder="Street, city, state, ZIP" onChange={(e) => setEdit({ ...edit, address: e.target.value })} />
            <Label id="cs-6">Opt-out line</Label>
            <input id="cs-6" className="ld-in" value={edit.optOut} onChange={(e) => setEdit({ ...edit, optOut: e.target.value })} />
            <Label id="cs-7">Always needs you</Label>
            <input id="cs-7" className="ld-in" value={edit.alwaysNeedsYou} onChange={(e) => setEdit({ ...edit, alwaysNeedsYou: e.target.value })} />
            <Label id="cs-8">Website for pricing</Label>
            <input id="cs-8" className="ld-in" value={edit.website} onChange={(e) => setEdit({ ...edit, website: e.target.value })} />
          </Form>
          <ErrorLine error={save.error} />
        </Card>
      ) : (
        <Card
          label="Cold email settings"
          buttons={
            <>
              <button type="button" className="ld-btn" onClick={start}>Edit</button>
              <button type="button" className="ld-btn" disabled={site.isPending} onClick={() => site.mutate({ organizationId: orgId })}>{site.isPending ? "Checking..." : "Check website"}</button>
              {v.connected && <button type="button" className="ld-btn" disabled={disconnect.isPending} onClick={() => disconnect.mutate({ organizationId: orgId })}>Disconnect</button>}
            </>
          }
        >
          <KV
            rows={[
              ["Instantly", v.connected ? <span>Connected, API v2 (key stored on your server) <span className="ld-pill green">Working</span></span> : <span className="ld-pill gray">Not connected</span>],
              ["Plan limits", `${v.plan.name}: ${n(v.plan.contacts)} contacts, ${n(v.plan.emails)} emails a month`],
              ["How much Jada does", s.levelText],
              ["New emails a day", `Never more than ${s.perInbox} per inbox`],
              ["Raise volume", `By no more than ${s.rampPct}% a week, only while inboxes stay healthy`],
              ["Rest an inbox when", `Bounces over ${s.bounceRest}%, or Instantly reports an error`],
              ["Open tracking", "Off. Jada measures replies, demos and sales."],
              ["Signature", s.signature || "Not set"],
              ["Mailing address", s.addressUsed ? `${s.addressUsed}${!s.address && s.site.address ? ", from your website" : ""}, in every email` : <span style={{ color: "var(--ld-bad)" }}>Not set. Campaigns can't start without it.</span>],
              ["Opt-out line", `"${s.optOut}"`],
              ["Pricing", s.site.plans.length ? `Read from ${s.site.url}${s.siteCheckedAt ? `. Last checked ${fmt(s.siteCheckedAt)}` : ""}.` : s.siteError || "Not read yet"],
              ["Always needs you", s.alwaysNeedsYou],
              ["Webhook", s.hookUrl ? <span>On Hypergrowth, add <code style={{ fontSize: 12 }}>{s.hookUrl}</code> in Instantly under Settings, Webhooks, for all events. Without it, Jada checks for replies every 5 minutes.</span> : ""],
            ]}
          />
          <ErrorLine error={site.error || disconnect.error} />
        </Card>
      )}
      <Card
        label="Do not contact"
        buttons={
          adding === null ? (
            <>
              <button type="button" className="ld-btn" disabled={dl.isPending} onClick={() => dl.mutate({ organizationId: orgId })}>Download list</button>
              <button type="button" className="ld-btn" onClick={() => setAdding("")}>Add people</button>
            </>
          ) : (
            <>
              <button type="button" className="ld-btn p" disabled={dnc.isPending || !adding.trim()} onClick={() => dnc.mutate({ organizationId: orgId, emails: adding.split(/[\s,;]+/).filter(Boolean), reason: "Added by you" })}>Save</button>
              <button type="button" className="ld-btn" onClick={() => setAdding(null)}>Cancel</button>
            </>
          )
        }
      >
        <KV rows={[["Do not contact", `${n(v.suppress)} people (unsubscribed, bounced, asked to stop, added by you)`], ["Applies to", "Every campaign and every inbox, and Instantly's block list"]]} />
        {adding !== null && (
          <Form>
            <Label id="dnc" top>Emails</Label>
            <textarea id="dnc" className="ld-in" rows={3} style={TA} placeholder="One or more emails, separated by commas or lines" value={adding} onChange={(e) => setAdding(e.target.value)} />
          </Form>
        )}
        <ErrorLine error={dnc.error || dl.error} />
      </Card>
    </>
  );
}

// ==========================================
// Lead list
// ==========================================

const QUICK: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "group_owner", label: "Group owners" },
  { key: "solo_owner", label: "Solo owners" },
  { key: "ehr_simplepractice", label: "SimplePractice" },
  { key: "hiring", label: "Hiring" },
];

function LeadList() {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [q, setQ] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [segment, setSegment] = React.useState("");
  const [state, setState] = React.useState("");
  const [tier, setTier] = React.useState<"" | "top" | "mid" | "test" | "low">("");
  const [page, setPage] = React.useState(0);
  const [open, setOpen] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [researching, setResearching] = React.useState<string | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => { setSearch(q); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = trpc.cold.leads.useQuery({ organizationId: orgId, page, q: search || undefined, segment: segment || undefined, state: state.trim() || undefined, tier: tier || undefined }, { placeholderData: (p) => p });
  const ov = trpc.cold.overview.useQuery({ organizationId: orgId });
  const research = trpc.cold.research.useMutation({ onSuccess: async () => { setResearching(null); await refresh(); } });
  const d = list.data;
  const COLS = "minmax(0,1.6fr) minmax(0,1.3fr) 80px 70px minmax(0,1fr) 128px";
  const tiers: { key: typeof tier; label: string; value: number; sub: string }[] = d
    ? [
        { key: "top", label: "Fit 80 to 100", value: d.counts.top, sub: "Personal first line" },
        { key: "mid", label: "Fit 60 to 79", value: d.counts.mid, sub: "Standard sequence" },
        { key: "test", label: "Fit 40 to 59", value: d.counts.test, sub: "Test campaigns" },
        { key: "low", label: "Under 40 or unscored", value: d.counts.low, sub: "Not sending yet" },
      ]
    : [];
  return (
    <>
      <Card
        label={`${n(d?.counts.total)} leads`}
        buttons={
          <>
            <button type="button" className="ld-btn p" onClick={() => setAdding(!adding)}>{adding ? "Close" : "Add leads"}</button>
            <button type="button" className="ld-btn" disabled={ov.data?.researching || research.isPending} onClick={() => setResearching(researching === null ? "500" : null)}>{ov.data?.researching ? "Researching..." : "Research"}</button>
          </>
        }
      >
        <div className="ld-cold-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: 12 }}>
          {tiers.map((t) => (
            <button key={t.key} type="button" onClick={() => { setTier(tier === t.key ? "" : t.key); setPage(0); }} aria-pressed={tier === t.key} style={{ textAlign: "left", font: "inherit", background: tier === t.key ? "var(--ld-accent-bg)" : "#fff", border: `1px solid ${tier === t.key ? "var(--ld-accent)" : "var(--ld-line)"}`, borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, cursor: "pointer", color: "var(--ld-ink)" }}>
              <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{t.label}</span>
              <b style={{ fontSize: 20 }}>{n(t.value)}</b>
              <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{t.sub}</span>
            </button>
          ))}
          {d && <Stat label="Do not contact" value={n(d.suppress)} sub="Never emailed" />}
        </div>
        {d && d.counts.unresearched > 0 && <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{n(d.counts.unresearched)} not researched yet. Jada researches the best few hundred at a time and scores them, so money isn't spent on leads that never get emailed.</span>}
        {researching !== null && (
          <Box label="Research the next best leads">
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Seg label="How many" value={researching} onChange={setResearching} options={["50", "100", "500", "1000"].map((x) => ({ key: x, label: x }))} />
              <button type="button" className="ld-btn p" disabled={research.isPending} onClick={() => research.mutate({ organizationId: orgId, count: Number(researching), state: state.trim() || undefined })}>Start</button>
            </div>
            <span className="ld-small" style={{ color: "var(--ld-muted)" }}>Their practice website first, a web search when there isn't one{state.trim() ? `, only in ${state.trim()}` : ""}. Public business information only.</span>
          </Box>
        )}
        <ErrorLine error={research.error} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input className="ld-in" style={{ width: 240 }} placeholder="Search name, practice, city" aria-label="Search leads" value={q} onChange={(e) => setQ(e.target.value)} />
          <Seg label="Segment" value={segment} onChange={(x) => { setSegment(x); setPage(0); }} options={QUICK} />
          <input className="ld-in" style={{ width: 90 }} placeholder="State" aria-label="State" value={state} onChange={(e) => { setState(e.target.value); setPage(0); }} />
        </div>
      </Card>

      {adding && <AddLeads onDone={() => setAdding(false)} />}

      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Therapist</span><span>Practice</span><span>State</span><span>Fit</span><span>Stage</span><span /></div>
        {d && !d.rows.length && <div className="ld-empty">{d.counts.total ? "No leads match." : "No leads yet. Press Add leads to bring in your list."}</div>}
        {(d?.rows ?? []).map((l) => (
          <LeadRow key={l.id} l={l} open={open === l.id} onToggle={() => setOpen(open === l.id ? null : l.id)} cols={COLS} />
        ))}
        {d && d.total > d.size && (
          <div style={{ padding: "12px 18px", display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
            <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{n(page * d.size + 1)} to {n(Math.min(d.total, (page + 1) * d.size))} of {n(d.total)}</span>
            <button type="button" className="ld-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <button type="button" className="ld-btn" disabled={(page + 1) * d.size >= d.total} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
    </>
  );
}

function LeadRow({ l, open, onToggle, cols }: { l: Lead; open: boolean; onToggle: () => void; cols: string }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const stop = trpc.cold.stopLead.useMutation({ onSuccess: refresh });
  const dnc = trpc.cold.doNotContact.useMutation({ onSuccess: refresh });
  const pre = trpc.precall.forLead.useMutation({ onSuccess: refresh });
  const [pill, label] = STAGE[l.stage] ?? ["gray", l.stage];
  const stageText = l.stage === "not_fit" && l.notFitReason ? `Not sending: ${l.notFitReason}` : l.stage === "replied" && l.lastReplyKind ? `Replied: ${l.lastReplyKind.replace("_", " ")}` : l.stage === "booked" && l.bookedFor ? `Booked ${fmt(l.bookedFor)}` : label;
  const sig = l.signals;
  return (
    <>
      <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: cols }}>
        <b style={{ overflowWrap: "anywhere" }}>{l.name}{l.license ? `, ${l.license}` : ""}</b>
        <span style={{ overflowWrap: "anywhere" }}>{l.practice || "Not found yet"}</span>
        <span>{l.state}</span>
        <b>{l.fit ?? "-"}</b>
        <span className={`ld-pill ${pill}`} style={{ justifySelf: "start", whiteSpace: "normal" }}>{stageText}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <KV
              rows={[
                ["Email", l.email],
                ["License", [l.license, l.licenseStatus && `(${l.licenseStatus})`, l.source && `from ${l.source}`].filter(Boolean).join(" ")],
                ["Practice", sig ? `${sig.practice || l.practice || "Not found"}${sig.clinicians ? `. ${sig.clinicians} ${sig.clinicians === 1 ? "clinician" : "clinicians"}` : ""}${sig.telehealth ? ". Telehealth" : ""}${sig.summary ? `. ${sig.summary}` : ""}` : l.practice],
                ["Website", l.website ? <a href={l.website} target="_blank" rel="noreferrer">{l.website.replace(/^https?:\/\//, "")}</a> : ""],
                ["Segments", l.segments.map((x) => x.label).join(" · ")],
                ["Campaign", l.campaign ? `${l.campaign}${l.addedAt ? `. Sent to Instantly ${fmt(l.addedAt)}` : ""}` : ""],
                ["Follow up", l.followUpAt ? `${fmt(l.followUpAt)}: ${l.followUpNote ?? ""}` : ""],
                ["Research", l.depth === "list" ? "Only what's on the list so far." : `${l.depth === "full" ? "Full pre-call report" : l.depth === "moderate" ? "Read again after they replied" : "Website or search"}${l.researchedAt ? `, ${fmt(l.researchedAt)}` : ""}`],
                ["EHR", sig?.ehr?.name ? <span>{sig.ehr.name} <span className={`ld-pill ${CONF[sig.ehr.confidence]?.[0] ?? "gray"}`}>{CONF[sig.ehr.confidence]?.[1]}</span> {sig.ehr.evidence}</span> : ""],
              ]}
            />
            {l.fitWhy.length > 0 && (
              <Box label={`Why ${l.fit ?? 0}`}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 60px", gap: "6px 14px", fontSize: 13 }}>
                  {l.fitWhy.map((w, i) => (
                    <React.Fragment key={i}>
                      <span>{w.label}</span>
                      <b>{w.points > 0 ? `+${w.points}` : w.points}</b>
                    </React.Fragment>
                  ))}
                </div>
              </Box>
            )}
            <ErrorLine error={stop.error || dnc.error || pre.error} />
            {pre.isSuccess && <span className="ld-small" style={{ color: "var(--ld-accent-dark)" }}>The pre-call report is on its way. It shows on the Pre-call tab.</span>}
          </div>
          <Buttons>
            {(l.stage === "in_campaign" || l.stage === "queued") && <button type="button" className="ld-btn" disabled={stop.isPending} onClick={() => stop.mutate({ organizationId: orgId, id: l.id })}>Stop emails</button>}
            <button type="button" className="ld-btn" disabled={pre.isPending} onClick={() => pre.mutate({ organizationId: orgId, leadId: l.id })}>Pre-call report</button>
            {l.stage !== "dnc" && <button type="button" className="ld-btn" disabled={dnc.isPending} onClick={() => dnc.mutate({ organizationId: orgId, emails: [l.email], reason: "Added by you" })}>Do not contact</button>}
          </Buttons>
        </div>
      )}
    </>
  );
}

function AddLeads({ onDone }: { onDone: () => void }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [source, setSource] = React.useState<"platform" | "instantly" | "file">("platform");
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<null | { rows: number; added: number; duplicates: number; noEmail: number; doNotContact: number; inactive: number }>(null);
  const pull = trpc.cold.importInstantly.useMutation({ onSuccess: async (r) => { setResult(r); await refresh(); } });
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      setResult(await uploadFile("leads", file, { organizationId: orgId }));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      label="Add leads"
      buttons={
        <>
          {source === "instantly" ? (
            <button type="button" className="ld-btn p" disabled={pull.isPending} onClick={() => pull.mutate({ organizationId: orgId })}>{pull.isPending ? "Pulling..." : "Pull leads"}</button>
          ) : (
            <button type="button" className="ld-btn p" disabled={!file || busy} onClick={() => void upload()}>{busy ? "Adding..." : "Add file"}</button>
          )}
          <button type="button" className="ld-btn" onClick={onDone}>Close</button>
        </>
      }
    >
      <Seg label="Source" value={source} onChange={(x) => { setSource(x); setResult(null); }} options={[{ key: "platform", label: "LeadDash platform" }, { key: "instantly", label: "Instantly" }, { key: "file", label: "Upload a file" }]} />
      {source === "platform" && <span style={{ fontSize: 14, lineHeight: 1.6 }}>In the LeadDash platform, open Contacts, filter by the tag for your list, select all, and export them as a CSV. Then add that file here.</span>}
      {source === "file" && <span style={{ fontSize: 14, lineHeight: 1.6 }}>A CSV with an email column: a state license list, a spreadsheet saved as CSV, or any export.</span>}
      {source === "instantly" && <span style={{ fontSize: 14, lineHeight: 1.6 }}>Jada copies the leads already in your Instantly workspace onto the list (up to 5,000 at a time).</span>}
      {source !== "instantly" && (
        <Form>
          <Label id="lf">CSV file</Label>
          <input id="lf" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Form>
      )}
      <span className="ld-small" style={{ color: "var(--ld-muted)" }}>The list stays here. Jada only sends Instantly the next batch she's ready to email. Emails already on the list or on do not contact are skipped, and expired licenses are kept out.</span>
      {result && (
        <Box label="Added">
          <span style={{ fontSize: 14, lineHeight: 1.6 }}>
            {n(result.added)} added from {n(result.rows)} rows. {result.duplicates ? `${n(result.duplicates)} already on the list. ` : ""}
            {result.noEmail ? `${n(result.noEmail)} had no email. ` : ""}
            {result.doNotContact ? `${n(result.doNotContact)} on do not contact. ` : ""}
            {result.inactive ? `${n(result.inactive)} with a license that isn't active, kept out.` : ""}
          </span>
        </Box>
      )}
      {err && <p role="alert" className="ld-small" style={{ color: "var(--ld-bad)", margin: 0 }}>{err}</p>}
      <ErrorLine error={pull.error} />
    </Card>
  );
}

// ==========================================
// Campaigns
// ==========================================

function Campaigns() {
  const orgId = useOrg();
  const refresh = useRefresh();
  const q = trpc.cold.campaigns.useQuery({ organizationId: orgId }, { refetchInterval: 60_000 });
  const [open, setOpen] = React.useState<number | null>(null);
  const [angle, setAngle] = React.useState<string>("switcher");
  const write = trpc.cold.newCampaign.useMutation({ onSuccess: async (c) => { setOpen(c.id); await refresh(); } });
  const list = q.data?.list ?? [];
  React.useEffect(() => {
    if (open === null && list.length) setOpen(list[0].id);
  }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const COLS = "minmax(0,2fr) minmax(0,1.3fr) 90px 90px 90px 128px";
  return (
    <>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Campaign</span><span>Who</span><span>Added</span><span>Replies</span><span>Demos</span><span /></div>
        {!list.length && <div className="ld-empty">No campaigns yet. Pick an angle below and Jada writes the 4 emails.</div>}
        {list.map((c) => (
          <CampaignRow key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} cols={COLS} segments={q.data?.segments ?? []} />
        ))}
      </div>
      <Card label="Angles Jada can use" buttons={<button type="button" className="ld-btn p" disabled={write.isPending} onClick={() => write.mutate({ organizationId: orgId, angle: angle as never })}>{write.isPending ? "Writing..." : "New campaign"}</button>}>
        <Seg label="Angle" value={angle} onChange={setAngle} options={(q.data?.angles ?? []).map((a) => ({ key: a.key, label: a.name }))} />
        <span style={{ fontSize: 14, lineHeight: 1.6 }}>{q.data?.angles.find((a) => a.key === angle)?.idea}</span>
        <span className="ld-small" style={{ color: "var(--ld-muted)" }}>Each campaign starts with a subject line test. Jada scales what books demos and stops the rest.</span>
        <ErrorLine error={write.error} />
      </Card>
    </>
  );
}

type CampEdit = { name: string; offer: string; ask: string; share: string; minFit: string; segments: string[]; states: string; steps: { day: number; subject: string; subjectB: string; body: string }[] };

function CampaignRow({ c, open, onToggle, cols, segments }: { c: Campaign; open: boolean; onToggle: () => void; cols: string; segments: { key: string; label: string }[] }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [edit, setEdit] = React.useState<CampEdit | null>(null);
  const save = trpc.cold.saveCampaign.useMutation({ onSuccess: async () => { setEdit(null); await refresh(); } });
  const start = trpc.cold.startCampaign.useMutation({ onSuccess: refresh });
  const pause = trpc.cold.pauseCampaign.useMutation({ onSuccess: refresh });
  const remove = trpc.cold.removeCampaign.useMutation({ onSuccess: refresh });
  const winner = trpc.cold.pickWinner.useMutation({ onSuccess: refresh });
  const st = c.stats;
  const replyRate = st.added ? pct(st.replies ?? 0, st.added) : "0%";
  const status = c.status === "sending" ? <span className="ld-pill green">Sending</span> : c.status === "paused" ? <span className="ld-pill amber">Paused</span> : c.status === "done" ? <span className="ld-pill gray">Done</span> : <span className="ld-pill gray">Draft</span>;
  const testOn = !!c.steps[0]?.subjectB;
  const err = save.error || start.error || pause.error || remove.error || winner.error;
  const begin = () => setEdit({ name: c.name, offer: c.offer, ask: c.ask, share: String(c.share), minFit: String(c.who.minFit), segments: c.who.segments, states: c.who.states.join(", "), steps: c.steps.map((s) => ({ ...s })) });
  return (
    <>
      <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: cols }}>
        <b style={{ overflowWrap: "anywhere" }}>{c.name}</b>
        <span>{c.whoText}</span>
        <span>{n(st.added)}</span>
        <span>{replyRate}</span>
        <span>{n(st.demos)}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          {edit ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
              <Form>
                <Label id={`cn-${c.id}`}>Name</Label>
                <input id={`cn-${c.id}`} className="ld-in" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                <Label id={`co-${c.id}`}>Offer</Label>
                <input id={`co-${c.id}`} className="ld-in" placeholder="Only an offer you really make" value={edit.offer} onChange={(e) => setEdit({ ...edit, offer: e.target.value })} />
                <Label id={`ca-${c.id}`}>Ask in email 1</Label>
                <input id={`ca-${c.id}`} className="ld-in" value={edit.ask} onChange={(e) => setEdit({ ...edit, ask: e.target.value })} />
                <b>Who gets it</b>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {segments.map((sg) => {
                    const on = edit.segments.includes(sg.key);
                    return (
                      <button key={sg.key} type="button" aria-pressed={on} className="ld-btn" style={{ width: "auto", height: 30, fontSize: 12, background: on ? "var(--ld-accent-bg)" : "#fff", borderColor: on ? "var(--ld-accent)" : undefined, color: on ? "var(--ld-accent-dark)" : undefined }} onClick={() => setEdit({ ...edit, segments: on ? edit.segments.filter((x) => x !== sg.key) : [...edit.segments, sg.key].slice(0, 6) })}>
                        {sg.label}
                      </button>
                    );
                  })}
                </div>
                <Label id={`cf-${c.id}`}>Lowest fit</Label>
                <input id={`cf-${c.id}`} className="ld-in" style={{ width: 80 }} inputMode="numeric" value={edit.minFit} onChange={(e) => setEdit({ ...edit, minFit: e.target.value })} />
                <Label id={`cst-${c.id}`}>States</Label>
                <input id={`cst-${c.id}`} className="ld-in" placeholder="All states, or TX, OK" value={edit.states} onChange={(e) => setEdit({ ...edit, states: e.target.value })} />
                <Label id={`csh-${c.id}`}>Share of new emails</Label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}><input id={`csh-${c.id}`} className="ld-in" style={{ width: 80 }} inputMode="numeric" value={edit.share} onChange={(e) => setEdit({ ...edit, share: e.target.value })} /><span>%</span></div>
              </Form>
              {edit.steps.map((s, i) => (
                <Step key={i} title={`Email ${i + 1}`} when={`Day ${s.day}`}>
                  <Form>
                    <Label id={`ss-${c.id}-${i}`}>Subject</Label>
                    <input id={`ss-${c.id}-${i}`} className="ld-in" placeholder={i ? "Same thread as email 1" : ""} value={s.subject} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)) })} />
                    {i === 0 && (
                      <>
                        <Label id={`sb-${c.id}`}>Subject to test</Label>
                        <input id={`sb-${c.id}`} className="ld-in" placeholder="Leave empty for no test" value={s.subjectB} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === 0 ? { ...x, subjectB: e.target.value } : x)) })} />
                      </>
                    )}
                    <Label id={`sbd-${c.id}-${i}`} top>Email</Label>
                    <textarea id={`sbd-${c.id}-${i}`} className="ld-in" rows={6} style={TA} value={s.body} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)) })} />
                  </Form>
                </Step>
              ))}
              <span className="ld-small" style={{ color: "var(--ld-muted)" }}>[first name] and [practice name] are filled in for each lead. Your signature, mailing address and opt-out line go under every email.</span>
              <ErrorLine error={err} />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
              <KV rows={[["Angle", c.angleName], ["Offer", c.offer || "None"], ["Ask in email 1", c.ask ? `"${c.ask}"` : ""], ["Status", <span key="s">{status} {c.status === "sending" ? `${c.share}% of each day's new emails` : ""}</span>], ["Results", `${n(st.added)} added, ${n(st.sent)} emails sent, ${n(st.replies)} replies, ${n(st.positive)} positive, ${n(st.demos)} demos${st.bounced ? `, ${n(st.bounced)} bounced` : ""}`]]} />
              {testOn && (
                <Box label="Test running: subject line only">
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 90px 90px", gap: "6px 14px", fontSize: 13 }}>
                    <b>Version</b><b>Replies</b><b>Positive</b>
                    <span>A: "{c.steps[0].subject}"</span><span>{n(st.a?.replies)}</span><span>{n(st.a?.positive)}</span>
                    <span>B: "{c.steps[0].subjectB}"</span><span>{n(st.b?.replies)}</span><span>{n(st.b?.positive)}</span>
                  </div>
                  <span className="ld-small" style={{ color: "var(--ld-muted)" }}>Same body, audience, ask and send times. Jada picks a winner at about 500 sends each.</span>
                </Box>
              )}
              {c.test.winner && <span className="ld-small" style={{ color: "var(--ld-text2)" }}>Subject line test done: kept "{c.test.kept ?? c.steps[0]?.subject}".</span>}
              {c.steps.map((s, i) => (
                <Step key={i} title={`Email ${i + 1}`} when={`Day ${s.day}`}>
                  {s.subject && <b style={{ fontSize: 14 }}>{s.subject}</b>}
                  <span style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-line" }}>{s.body}</span>
                </Step>
              ))}
              <ErrorLine error={err} />
            </div>
          )}
          <Buttons>
            {edit ? (
              <>
                <button
                  type="button"
                  className="ld-btn p"
                  disabled={save.isPending}
                  onClick={() => save.mutate({ organizationId: orgId, id: c.id, name: edit.name, offer: edit.offer, ask: edit.ask, share: Math.min(100, Math.max(0, Number(edit.share) || 0)), who: { segments: edit.segments, minFit: Math.min(100, Math.max(0, Number(edit.minFit) || 0)), states: edit.states.split(/[\s,]+/).filter(Boolean).map((x) => x.toUpperCase()), licenses: c.who.licenses }, steps: edit.steps })}
                >
                  Save
                </button>
                <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
              </>
            ) : (
              <>
                {c.status === "sending" ? (
                  <button type="button" className="ld-btn" disabled={pause.isPending} onClick={() => pause.mutate({ organizationId: orgId, id: c.id })}>Pause</button>
                ) : (
                  <button type="button" className="ld-btn p" disabled={start.isPending} onClick={() => start.mutate({ organizationId: orgId, id: c.id })}>{start.isPending ? "Starting..." : c.status === "paused" ? "Resume" : "Start"}</button>
                )}
                <button type="button" className="ld-btn" onClick={begin}>Edit</button>
                {testOn && (
                  <>
                    <button type="button" className="ld-btn" disabled={winner.isPending} onClick={() => winner.mutate({ organizationId: orgId, id: c.id, version: "a" })}>Keep A</button>
                    <button type="button" className="ld-btn" disabled={winner.isPending} onClick={() => winner.mutate({ organizationId: orgId, id: c.id, version: "b" })}>Keep B</button>
                  </>
                )}
                {c.status !== "sending" && <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: orgId, id: c.id })}>Remove</button>}
              </>
            )}
          </Buttons>
        </div>
      )}
    </>
  );
}

// ==========================================
// Replies
// ==========================================

function Replies({ list }: { list: Reply[] }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const firstOpen = list.find((r) => r.status === "open" && r.draft)?.id ?? null;
  const [open, setOpen] = React.useState<number | null>(firstOpen);
  const picked = React.useRef(firstOpen !== null);
  React.useEffect(() => {
    if (!picked.current && firstOpen !== null) {
      picked.current = true;
      setOpen(firstOpen);
    }
  }, [firstOpen]);
  const check = trpc.cold.checkReplies.useMutation({ onSuccess: refresh });
  const COLS = "minmax(0,1.5fr) 180px minmax(0,2fr) 128px";
  return (
    <>
      <Card label={`${list.filter((r) => r.status === "open").length} waiting for you`} buttons={<button type="button" className="ld-btn" disabled={check.isPending} onClick={() => check.mutate({ organizationId: orgId })}>{check.isPending ? "Checking..." : "Check now"}</button>}>
        <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.5 }}>Every reply is read and sorted. Opt-outs are honored right away. What Jada answers on her own depends on the level in Cold email settings.</span>
        {check.data && <span className="ld-small" style={{ color: "var(--ld-accent-dark)" }}>{check.data.read ? `${check.data.read} new.` : "Nothing new."}</span>}
        <ErrorLine error={check.error} />
      </Card>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>From</span><span>Type</span><span>They said</span><span /></div>
        {!list.length && <div className="ld-empty">No replies yet.</div>}
        {list.map((r) => (
          <ReplyRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} cols={COLS} />
        ))}
      </div>
    </>
  );
}

function ReplyRow({ r, open, onToggle, cols }: { r: Reply; open: boolean; onToggle: () => void; cols: string }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [text, setText] = React.useState<string | null>(null);
  const send = trpc.cold.sendReply.useMutation({ onSuccess: async () => { setText(null); await refresh(); } });
  const take = trpc.cold.takeOver.useMutation({ onSuccess: refresh });
  const l = r.lead;
  const handled = r.status !== "open";
  const said = r.text.split("\n").find((x) => x.trim()) ?? "";
  return (
    <>
      <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: cols }}>
        <b style={{ overflowWrap: "anywhere" }}>{l ? `${l.name}${l.practice ? `, ${l.practice}` : ""}` : "Unknown"}</b>
        <span className={`ld-pill ${handled && r.status === "done" ? "green" : KIND_PILL[r.kind] ?? "gray"}`} style={{ justifySelf: "start", whiteSpace: "normal" }}>{r.status === "sent" ? `Answered: ${r.label}` : r.status === "done" ? `Handled: ${r.label}` : r.label}</span>
        <span style={{ overflowWrap: "anywhere" }}>"{said.slice(0, 140)}{said.length > 140 ? "..." : ""}"</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <KV
              rows={[
                ["Lead", l ? `${l.fit != null ? `Fit ${l.fit}` : "Not scored"}${l.segments.length ? ` · ${l.segments.map((x) => x.label).join(", ")}` : ""}${l.city ? ` · ${l.city}` : ""}${l.state ? `, ${l.state}` : ""}` : ""],
                ["Campaign", r.campaign ? `${r.campaign}${r.variant ? `, subject ${r.variant.toUpperCase()}` : ""}` : ""],
                ["Received", fmtWhen(r.receivedAt)],
                ["What Jada did", r.handled ?? ""],
              ]}
            />
            <Step title="Their reply" when={r.subject}>
              <span style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-line" }}>{r.text}</span>
            </Step>
            {(r.draft || text !== null) && (
              <Step title={r.status === "sent" ? `Sent ${fmtWhen(r.sentAt)}` : "Jada's answer"}>
                {text !== null ? (
                  <textarea className="ld-in" aria-label="Answer" rows={8} style={TA} value={text} onChange={(e) => setText(e.target.value)} />
                ) : (
                  <span style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-line" }}>{r.draft}</span>
                )}
              </Step>
            )}
            <ErrorLine error={send.error || take.error} />
          </div>
          <Buttons>
            {r.status === "open" && (
              <>
                {text !== null ? (
                  <>
                    <button type="button" className="ld-btn p" disabled={send.isPending || !text.trim()} onClick={() => send.mutate({ organizationId: orgId, id: r.id, text })}>{send.isPending ? "Sending..." : "Send"}</button>
                    <button type="button" className="ld-btn" onClick={() => setText(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    {r.draft && <button type="button" className="ld-btn p" disabled={send.isPending} onClick={() => send.mutate({ organizationId: orgId, id: r.id })}>{send.isPending ? "Sending..." : "Approve"}</button>}
                    <button type="button" className="ld-btn" onClick={() => setText(r.draft ?? "")}>{r.draft ? "Edit" : "Write answer"}</button>
                    <button type="button" className="ld-btn" disabled={take.isPending} onClick={() => take.mutate({ organizationId: orgId, id: r.id })}>I'll take it</button>
                  </>
                )}
              </>
            )}
          </Buttons>
        </div>
      )}
    </>
  );
}

// ==========================================
// Pre-call reports
// ==========================================

function Precalls({ list }: { list: Precall[] }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const deep = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("report")) || null : null;
  const first = deep ?? list.find((r) => r.status === "ready")?.id ?? list.find((r) => r.status !== "done")?.id ?? null;
  const [open, setOpen] = React.useState<number | null>(first);
  const picked = React.useRef(first !== null);
  React.useEffect(() => {
    if (!picked.current && first !== null) {
      picked.current = true;
      setOpen(first);
    }
  }, [first]);
  const [form, setForm] = React.useState<null | { person: string; practice: string; website: string; meetingAt: string }>(null);
  const run = trpc.precall.run.useMutation({ onSuccess: async (r) => { setForm(null); setOpen(r.id); await refresh(); } });
  const COLS = "minmax(0,1.6fr) minmax(0,1.3fr) 210px 128px";
  return (
    <>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Prospect</span><span>Run by</span><span>Meeting</span><span /></div>
        {!list.length && <div className="ld-empty">No reports yet. One runs on its own when a lead books, or press Run a report.</div>}
        {list.map((r) => (
          <PrecallRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} cols={COLS} />
        ))}
      </div>
      {form ? (
        <Card
          label="Run a pre-call report"
          buttons={
            <>
              <button type="button" className="ld-btn p" disabled={run.isPending || (!form.person.trim() && !form.practice.trim())} onClick={() => run.mutate({ organizationId: orgId, person: form.person, practice: form.practice, website: form.website, meetingAt: typedToIso(form.meetingAt) || undefined })}>Run</button>
              <button type="button" className="ld-btn" onClick={() => setForm(null)}>Cancel</button>
            </>
          }
        >
          <Form>
            <Label id="pp">Person</Label>
            <input id="pp" className="ld-in" value={form.person} onChange={(e) => setForm({ ...form, person: e.target.value })} />
            <Label id="pr">Practice</Label>
            <input id="pr" className="ld-in" value={form.practice} onChange={(e) => setForm({ ...form, practice: e.target.value })} />
            <Label id="pw">Website</Label>
            <input id="pw" className="ld-in" placeholder="https://" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            <Label id="pm">Meeting</Label>
            <input id="pm" className="ld-in" placeholder="MM/DD/YYYY 10:00 AM" value={form.meetingAt} onChange={(e) => setForm({ ...form, meetingAt: e.target.value })} />
          </Form>
          <ErrorLine error={run.error} />
        </Card>
      ) : (
        <Card buttons={<button type="button" className="ld-btn p" onClick={() => setForm({ person: "", practice: "", website: "", meetingAt: "" })}>Run a report</button>}>
          <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.6 }}>Public business information only. No home addresses, family, health or personal accounts. Every fact shows where it came from, and anything not confirmed is marked Likely or Unknown. Any employee can run one in chat: "Run a pre-call report on Bayou Family Therapy."</span>
        </Card>
      )}
    </>
  );
}

function PrecallRow({ r, open, onToggle, cols }: { r: Precall; open: boolean; onToggle: () => void; cols: string }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [after, setAfter] = React.useState<string | null>(null);
  const doc = trpc.precall.docx.useMutation({ onSuccess: (x) => openDownload(x) });
  const refreshRun = trpc.precall.refresh.useMutation({ onSuccess: refresh });
  const afterCall = trpc.precall.afterCall.useMutation({ onSuccess: async () => { setAfter(null); await refresh(); } });
  const approve = trpc.precall.approveAfter.useMutation({ onSuccess: refresh });
  const remove = trpc.precall.remove.useMutation({ onSuccess: refresh });
  const rep = r.report;
  const err = doc.error || refreshRun.error || afterCall.error || approve.error || remove.error;
  return (
    <>
      <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: cols }}>
        <b style={{ overflowWrap: "anywhere" }}>{[r.person, r.practice].filter(Boolean).join(", ")}</b>
        <span>{r.runBy}{r.refreshedAt ? `. Updated ${fmt(r.refreshedAt)}` : ""}</span>
        <span>{r.status === "running" ? <span className="ld-pill amber">Researching</span> : r.status === "failed" ? <span className="ld-pill red">Didn't finish</span> : fmtWhen(r.meetingAt) || "No meeting set"}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            {r.status === "running" && <span style={{ fontSize: 14 }}>Jada is reading the practice's public pages. This takes a few minutes.</span>}
            {r.status === "failed" && <span style={{ fontSize: 14, color: "var(--ld-bad)" }}>{r.error}</span>}
            {(r.status === "ready" || r.status === "done") && (
              <div className="ld-card" style={{ overflow: "hidden" }}>
                <Sec label="30-second brief">
                  <KV rows={[["Prospect", [rep.brief.person, rep.brief.role].filter(Boolean).join(", ")], ["Practice", [rep.brief.practice, rep.brief.location, rep.brief.size].filter(Boolean).join(". ")], ["Current system", <span key="c">{rep.brief.currentSystem || "Unknown"} <Conf c={rep.brief.currentConfidence} /></span>], ["Fit", r.fit != null ? `${r.fit} of 100` : ""]]} />
                  {rep.brief.summary && <span style={{ fontSize: 14, lineHeight: 1.6 }}>{rep.brief.summary}</span>}
                </Sec>
                <Sec label="Prospect">
                  <KV rows={[["Background", rep.profile.background], ["Decision authority", rep.profile.authority], ["Public information", rep.profile.publicInfo]]} />
                </Sec>
                <Sec label="Practice">
                  <KV rows={[["Locations", rep.practice.locations], ["Specialties", rep.practice.specialties], ["Insurance", rep.practice.insurance], ["Telehealth", rep.practice.telehealth], ["Services", rep.practice.services], ["Hiring", rep.practice.hiring]]} />
                </Sec>
                {rep.tech.length > 0 && (
                  <Sec label="Technology">
                    <div style={{ display: "grid", gridTemplateColumns: "140px minmax(0,1fr) 100px minmax(0,1.6fr)", gap: "8px 12px", fontSize: 13, alignItems: "start" }} className="ld-cold-tech">
                      {rep.tech.map((t, i) => (
                        <React.Fragment key={i}>
                          <span>{t.job}</span>
                          <b>{t.tool}</b>
                          <Conf c={t.confidence} />
                          <span style={{ color: "var(--ld-muted)" }}>{t.evidence}</span>
                        </React.Fragment>
                      ))}
                    </div>
                    {rep.costRange && <span className="ld-small" style={{ color: "var(--ld-muted)" }}>Rough cost of these tools today: {rep.costRange}. A range, not their bill.</span>}
                  </Sec>
                )}
                {rep.journey.steps.length > 0 && (
                  <Sec label="How a new client gets in today">
                    <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7, listStyle: "decimal" }}>{rep.journey.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                    {rep.journey.friction && <span style={{ fontSize: 14, lineHeight: 1.6 }}><b>Friction:</b> {rep.journey.friction}</span>}
                  </Sec>
                )}
                {rep.growth.stage && (
                  <Sec label="Growth">
                    <span style={{ fontSize: 14, lineHeight: 1.6 }}><b>{rep.growth.stage}.</b> {rep.growth.evidence.join("; ")}. {rep.growth.implication}</span>
                  </Sec>
                )}
                {rep.pains.length > 0 && (
                  <Sec label="Pain points: evidence, hypothesis, question">
                    {rep.pains.map((p, i) => (
                      <div key={i} className="ld-cold-ehq" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10 }}>
                        <Box label={i === 0 ? "Evidence" : undefined}><span style={{ fontSize: 14 }}>{p.evidence}</span></Box>
                        <Box label={i === 0 ? "Hypothesis" : undefined}><span style={{ fontSize: 14 }}>{p.hypothesis}</span></Box>
                        <Box label={i === 0 ? "Ask" : undefined}><span style={{ fontSize: 14 }}>"{p.question}"</span></Box>
                      </div>
                    ))}
                  </Sec>
                )}
                <Sec label="Demo plan">
                  <KV rows={[["Lead with", rep.demo.leadWith], ["Then", rep.demo.then], ["Don't lead with", rep.demo.dontLeadWith], ["Order", rep.demo.order.join(", ")], ["Opening", rep.demo.opening ? `"${rep.demo.opening}"` : ""]]} />
                </Sec>
                {rep.objections.length > 0 && (
                  <Sec label="Likely objections">
                    <KV rows={rep.objections.map((o) => [o.objection, `${o.reason} ${o.response}`] as [string, string])} />
                    {r.battle && <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{r.battle.title} battle card attached from the playbook: {r.battle.body.differs}</span>}
                  </Sec>
                )}
                {rep.questions.length > 0 && (
                  <Sec label="Discovery questions">
                    <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7, listStyle: "decimal" }}>{rep.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
                  </Sec>
                )}
                {rep.committee.length > 0 && (
                  <Sec label="Who decides">
                    <KV rows={rep.committee.map((c) => [c.name, `${c.role}${c.note ? `. ${c.note}` : ""}`] as [string, string])} />
                  </Sec>
                )}
                {rep.risks.length > 0 && (
                  <Sec label="Risks">
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>{rep.risks.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  </Sec>
                )}
                <Sec label="Sources">
                  <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.8 }}>
                    {rep.sources.map((s, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && " · "}
                        <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>
                        {s.date ? ` (${s.date})` : ""}
                      </React.Fragment>
                    ))}
                  </span>
                </Sec>
              </div>
            )}
            {after !== null && (
              <Box label="After the call">
                <textarea className="ld-in" aria-label="What you learned" rows={6} style={TA} placeholder="What did you learn? Leave it empty to use Avery's notes when he sat in." value={after} onChange={(e) => setAfter(e.target.value)} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="ld-btn p" disabled={afterCall.isPending} onClick={() => afterCall.mutate({ organizationId: orgId, id: r.id, notes: after })}>{afterCall.isPending ? "Comparing..." : "Compare"}</button>
                  <button type="button" className="ld-btn" onClick={() => setAfter(null)}>Cancel</button>
                </div>
              </Box>
            )}
            {r.after && (
              <Box label={`After the call (${r.after.notesFrom})`}>
                <div style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr) minmax(0,1fr)", gap: "8px 12px", fontSize: 14 }} className="ld-cold-tech">
                  <b>What</b><b>Before</b><b>From the call</b>
                  {r.after.changes.map((c, i) => (
                    <React.Fragment key={i}>
                      <span>{c.what}</span>
                      <span>{c.before}</span>
                      <b>{c.after}</b>
                    </React.Fragment>
                  ))}
                </div>
                {r.after.nextStep && <span style={{ fontSize: 14 }}><b>Next step:</b> {r.after.nextStep}</span>}
                <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{r.status === "done" ? "Saved to the lead." : "Approve to save these to the lead, so the next report and Jada's weekly review use them."}</span>
              </Box>
            )}
            <ErrorLine error={err} />
          </div>
          <Buttons>
            {(r.status === "ready" || r.status === "done") && <button type="button" className="ld-btn p" disabled={doc.isPending} onClick={() => doc.mutate({ organizationId: orgId, id: r.id })}>Download</button>}
            {r.status !== "running" && <button type="button" className="ld-btn" disabled={refreshRun.isPending} onClick={() => refreshRun.mutate({ organizationId: orgId, id: r.id })}>Refresh</button>}
            {r.status === "ready" && !r.after && after === null && <button type="button" className="ld-btn" onClick={() => setAfter("")}>After the call</button>}
            {r.status === "ready" && r.after && <button type="button" className="ld-btn p" disabled={approve.isPending} onClick={() => approve.mutate({ organizationId: orgId, id: r.id })}>Approve</button>}
            {r.status === "ready" && r.after && <button type="button" className="ld-btn" onClick={() => setAfter("")}>Redo</button>}
            <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: orgId, id: r.id })}>Remove</button>
          </Buttons>
        </div>
      )}
    </>
  );
}

function Sec({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 18px", borderBottom: "1px solid #eef2f0" }}>
      <span className="ld-lbl">{label}</span>
      {children}
    </div>
  );
}
function Conf({ c }: { c: string }) {
  const [p, l] = CONF[c] ?? CONF.unknown;
  return <span className={`ld-pill ${p}`} style={{ justifySelf: "start", alignSelf: "start" }}>{l}</span>;
}

// ==========================================
// Playbook
// ==========================================

type PTab = "objection" | "battle" | "fact" | "never" | "pricing" | "example";
const FIELDS: Record<string, { key: string; label: string; rows?: number }[]> = {
  objection: [
    { key: "meaning", label: "What it usually means" },
    { key: "goal", label: "Goal of the answer" },
    { key: "facts", label: "Facts Jada can use", rows: 3 },
    { key: "never", label: "Never say", rows: 2 },
    { key: "escalate", label: "Send to you when" },
    { key: "example", label: "Example answer", rows: 4 },
  ],
  battle: [
    { key: "doesWell", label: "What they do well" },
    { key: "differs", label: "Where LeadDash differs", rows: 2 },
    { key: "dontClaim", label: "Don't claim" },
    { key: "whySwitch", label: "Why people switch" },
    { key: "questions", label: "Questions to ask", rows: 2 },
  ],
  fact: [{ key: "text", label: "The fact", rows: 3 }],
  never: [],
  example: [
    { key: "said", label: "They said", rows: 3 },
    { key: "draft", label: "Jada's draft", rows: 3 },
    { key: "better", label: "Your answer", rows: 3 },
    { key: "tag", label: "Type" },
  ],
};
const TITLE: Record<string, [string, string]> = { objection: ["They say", "What it usually means"], battle: ["Competitor", "Where LeadDash differs"], fact: ["Topic", "The fact"], never: ["Never say", ""], example: ["They said", "Your answer"] };
const SECOND: Record<string, string> = { objection: "meaning", battle: "differs", fact: "text", example: "better" };

function Playbook({ v }: { v?: Overview }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const q = trpc.cold.playbook.useQuery({ organizationId: orgId });
  const site = trpc.cold.checkSite.useMutation({ onSuccess: refresh });
  const [tab, setTab] = React.useState<PTab>("objection");
  const [open, setOpen] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<null | { id?: number; title: string; body: Record<string, string> }>(null);
  const save = trpc.cold.savePlay.useMutation({ onSuccess: async (p) => { setEditing(null); setOpen(p.id); await refresh(); } });
  const remove = trpc.cold.removePlay.useMutation({ onSuccess: refresh });
  const all = q.data ?? [];
  const rows = all.filter((p) => p.kind === tab);
  const count = (k: string) => all.filter((p) => p.kind === k).length;
  const tabs: { key: PTab; label: string }[] = [
    { key: "objection", label: `Objections (${count("objection")})` },
    { key: "battle", label: `Battle cards (${count("battle")})` },
    { key: "fact", label: "Approved facts" },
    { key: "never", label: "Never say" },
    { key: "pricing", label: "Pricing" },
    { key: "example", label: `Real examples (${count("example")})` },
  ];
  const COLS = tab === "never" ? "minmax(0,1fr) 128px" : "minmax(0,1.4fr) minmax(0,2fr) 128px";
  const editor = () =>
    editing ? (
      <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
        <Form>
          <Label id="pt">{TITLE[tab]?.[0] ?? "Title"}</Label>
          <input id="pt" className="ld-in" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
          {(FIELDS[tab] ?? []).map((f) => (
            <React.Fragment key={f.key}>
              <Label id={`pf-${f.key}`} top={!!f.rows}>{f.label}</Label>
              {f.rows ? (
                <textarea id={`pf-${f.key}`} className="ld-in" rows={f.rows} style={TA} value={editing.body[f.key] ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, [f.key]: e.target.value } })} />
              ) : (
                <input id={`pf-${f.key}`} className="ld-in" value={editing.body[f.key] ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, [f.key]: e.target.value } })} />
              )}
            </React.Fragment>
          ))}
        </Form>
        <Buttons>
          <button type="button" className="ld-btn p" disabled={save.isPending || !editing.title.trim()} onClick={() => save.mutate({ organizationId: orgId, id: editing.id, kind: tab as Exclude<PTab, "pricing">, title: editing.title, body: editing.body })}>Save</button>
          <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
        </Buttons>
      </div>
    ) : null;
  return (
    <FolderTabs value={tab} onChange={(k) => { setTab(k); setOpen(null); setEditing(null); }} tabs={tabs}>
      {tab === "pricing" ? (
        <div style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20 }} className="ld-resultcard">
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            {v?.settings.site.plans.length ? (
              <>
                <KV rows={v.settings.site.plans.map((p) => [p.name, `${p.price}${p.seats ? `, ${p.seats}` : ""}${p.includes ? `. ${p.includes}` : ""}`] as [string, string])} />
                {v.settings.site.notes && <span style={{ fontSize: 14 }}>{v.settings.site.notes}</span>}
              </>
            ) : (
              <span style={{ fontSize: 14 }}>{v?.settings.siteError || "Not read from the website yet."}</span>
            )}
            <span className="ld-small" style={{ color: "var(--ld-muted)" }}>Read from {v?.settings.site.url || `${v?.settings.website ?? "your website"}/pricing`} every Monday{v?.settings.siteCheckedAt ? `. Last checked ${fmt(v.settings.siteCheckedAt)}` : ""}. Jada quotes only these prices. Change the website in Cold email settings.</span>
            <ErrorLine error={site.error} />
          </div>
          <Buttons><button type="button" className="ld-btn" disabled={site.isPending} onClick={() => site.mutate({ organizationId: orgId })}>{site.isPending ? "Checking..." : "Check now"}</button></Buttons>
        </div>
      ) : (
        <>
          {tab !== "never" && <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>{TITLE[tab][0]}</span><span>{TITLE[tab][1]}</span><span /></div>}
          {!rows.length && editing?.id === undefined && !editing && <div className="ld-empty">{tab === "example" ? "When you rewrite one of Jada's answers before sending, it's saved here as a real example." : tab === "fact" ? "Add the facts Jada may state: offers, what moving over looks like, anything she should know exactly." : "Nothing here yet."}</div>}
          {rows.map((p) => (
            <React.Fragment key={p.id}>
              <div className={`ld-rw ${open === p.id ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
                <b style={{ overflowWrap: "anywhere" }}>{tab === "objection" || tab === "example" ? `"${p.title}"` : p.title}</b>
                {tab !== "never" && <span style={{ overflowWrap: "anywhere" }}>{(p.body[SECOND[tab]] ?? "").slice(0, 160)}</span>}
                <button type="button" className="ld-btn" onClick={() => { setOpen(open === p.id ? null : p.id); setEditing(null); }}>{open === p.id ? "Close" : "Open"}</button>
              </div>
              {open === p.id &&
                (editing?.id === p.id ? (
                  editor()
                ) : (
                  <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
                      {(FIELDS[tab] ?? []).length ? <KV rows={(FIELDS[tab] ?? []).filter((f) => f.key !== "example").map((f) => [f.label, p.body[f.key] ?? ""] as [string, string])} /> : <span style={{ fontSize: 14 }}>Jada never writes this.</span>}
                      {tab === "objection" && p.body.example && (
                        <Step title="Example answer">
                          <span style={{ fontSize: 14, lineHeight: 1.55 }}>{p.body.example}</span>
                        </Step>
                      )}
                    </div>
                    <Buttons>
                      <button type="button" className="ld-btn" onClick={() => setEditing({ id: p.id, title: p.title, body: { ...p.body } })}>Edit</button>
                      <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: orgId, id: p.id })}>Remove</button>
                    </Buttons>
                  </div>
                ))}
            </React.Fragment>
          ))}
          {editing && editing.id === undefined && editor()}
          {!editing && tab !== "example" && (
            <div style={{ padding: "14px 18px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" className="ld-btn p" onClick={() => { setOpen(null); setEditing({ title: "", body: {} }); }}>{tab === "objection" ? "Add objection" : tab === "battle" ? "Add card" : tab === "fact" ? "Add fact" : "Add phrase"}</button>
              {tab === "objection" && <span className="ld-small" style={{ color: "var(--ld-muted)" }}>When you answer a reply yourself, Jada saves it as a real example.</span>}
            </div>
          )}
          <ErrorLine error={save.error || remove.error} />
        </>
      )}
    </FolderTabs>
  );
}
