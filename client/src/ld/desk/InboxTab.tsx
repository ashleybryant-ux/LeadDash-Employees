import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, FolderTabs } from "../ui";
import { fmtDate, fmtTime } from "../meta";

/**
 * Avery's Inbox, on his Desk. What needs the owner (with the reply he wrote,
 * opened in place), what he filed by himself (Move back returns one), and the
 * week as a chart next to its figures. Only the owner and admins get this tab:
 * the server refuses everyone else.
 */

const COLS = "minmax(0,1fr) minmax(0,1.5fr) minmax(0,1.2fr) 128px";
const DID: Record<string, string> = { drafted: "Drafted a reply", decision: "Needs your decision", filed: "Filed" };
const when = (d: Date | string) => `${fmtDate(d)}, ${fmtTime(d)}`;
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

export default function InboxTab() {
  const orgId = useTenant().currentOrgId;
  const utils = trpc.useUtils();
  const q = trpc.inbox.view.useQuery({ organizationId: orgId }, { refetchInterval: 60_000 });
  const [folder, setFolder] = React.useState<"needs" | "filed">("needs");
  const [open, setOpen] = React.useState<number | null>(null);
  const refresh = () => utils.inbox.invalidate();
  const read = trpc.inbox.read.useMutation({ onSuccess: refresh });
  const back = trpc.inbox.moveBack.useMutation({ onSuccess: refresh });
  if (!q.data) return <div className="ld-card ld-empty">{q.isLoading ? "Loading..." : "Couldn't load the inbox."}</div>;
  const v = q.data;
  const rows = folder === "needs" ? v.needs : v.filed;
  const top = Math.max(1, ...v.week.days.map((d) => d.filed + d.needed));
  return (
    <>
      {v.problem && <p role="alert" className="ld-small" style={{ color: "var(--ld-bad)", margin: 0, fontWeight: 700 }}>{v.problem}</p>}
      {v.practice && <div className="ld-card" style={{ padding: "10px 14px", fontSize: 13, fontWeight: 700, background: "var(--ld-accent-bg)", borderColor: "var(--ld-accent-line)" }}>Client email is read only on tools under a signed BAA.</div>}
      <div className="ld-stats4">
        <Stat n={v.counts.needs} label="Need you" warn={v.counts.needs > 0} />
        <Stat n={v.counts.drafted} label="Replies drafted" />
        <Stat n={v.counts.filedToday} label="Filed today" />
        <Stat n={v.week.received} label="This week" />
      </div>
      <FolderTabs
        value={folder}
        onChange={(k) => {
          setFolder(k);
          setOpen(null);
        }}
        tabs={[
          { key: "needs", label: `Needs you (${v.counts.needs})` },
          { key: "filed", label: `Filed (${v.counts.filed})` },
        ]}
      >
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>From</span>
          <span>Subject</span>
          <span>{folder === "needs" ? "What Avery did" : "Where Avery put it"}</span>
          <span />
        </div>
        {rows.length === 0 && <div className="ld-empty">{folder === "needs" ? "Nothing needs you right now." : "Nothing filed yet."}</div>}
        {rows.map((m) => (
          <React.Fragment key={m.id}>
            <div className={`ld-rw ${open === m.id ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
              <div style={{ minWidth: 0 }}>
                <b style={{ display: "block", overflowWrap: "anywhere" }}>{m.fromName}</b>
                <span className="ld-small">{when(m.receivedAt)}</span>
              </div>
              <span style={{ overflowWrap: "anywhere" }}>{m.subject || "No subject"}</span>
              <span>{folder === "needs" ? DID[m.did] : m.label}</span>
              {folder === "needs" ? (
                <button type="button" className="ld-btn" aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>{open === m.id ? "Close" : "View"}</button>
              ) : (
                <button type="button" className="ld-btn" disabled={back.isPending} onClick={() => back.mutate({ organizationId: orgId, id: m.id })}>Move back</button>
              )}
            </div>
            {open === m.id && folder === "needs" && <Opened id={m.id} onDone={() => setOpen(null)} />}
          </React.Fragment>
        ))}
      </FolderTabs>
      <ErrorLine error={back.error || read.error} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{v.email}{v.lastRead ? `. Last read ${when(v.lastRead)}.` : ""}</span>
        <button type="button" className="ld-btn" disabled={read.isPending} onClick={() => read.mutate({ organizationId: orgId })}>{read.isPending ? "Reading..." : "Read now"}</button>
      </div>

      <div className="ld-card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <span className="ld-lbl">This week</span>
        <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(0,.9fr)", gap: 20, alignItems: "center" }}>
          <div>
            <div role="img" aria-label={`Emails this week: ${v.week.filed} filed by Avery, ${v.week.needed} needed you`} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0,1fr))", gap: 10, alignItems: "end", height: 170 }}>
              {v.week.days.map((d) => (
                <div key={d.day} style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: "100%", fontSize: 12, fontWeight: 700 }}>
                  <span>{d.filed + d.needed}</span>
                  <i style={{ display: "block", width: "100%", flexShrink: 0, height: Math.round((d.needed / top) * 120), background: "#e88a3a", borderRadius: "6px 6px 0 0" }} />
                  <i style={{ display: "block", width: "100%", flexShrink: 0, height: Math.round((d.filed / top) * 120), background: "var(--ld-accent)", borderRadius: d.needed ? 0 : "6px 6px 0 0" }} />
                  <span style={{ marginTop: 4 }}>{WEEKDAY.format(new Date(`${d.day}T12:00:00Z`))}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 12.5, fontWeight: 700, marginTop: 12 }}>
              <span><i style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: "var(--ld-accent)", marginRight: 6, verticalAlign: -1 }} />Filed by Avery</span>
              <span><i style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: "#e88a3a", marginRight: 6, verticalAlign: -1 }} />Needed you</span>
            </div>
          </div>
          <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 60px", gap: "8px 14px", fontSize: 14 }}>
            <b>Emails received</b><span>{v.week.received}</span>
            <b>Filed by Avery</b><span>{v.week.filed}</span>
            <b>Needed you</b><span>{v.week.needed}</span>
            <b>Replies you sent</b><span>{v.week.sent}</span>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <div className="ld-card" style={{ padding: "10px 14px", background: warn ? "var(--ld-warn-bg)" : undefined }}>
      <b style={{ display: "block", fontSize: 26, lineHeight: 1.15 }}>{n}</b>
      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</span>
    </div>
  );
}

/** One email opened in place: the email on the left, Avery's reply on the right. Edit opens the reply; Send is its own click. */
function Opened({ id, onDone }: { id: number; onDone: () => void }) {
  const orgId = useTenant().currentOrgId;
  const utils = trpc.useUtils();
  const q = trpc.inbox.open.useQuery({ organizationId: orgId, id });
  const [draft, setDraft] = React.useState<string | null>(null);
  const done = async () => {
    await utils.inbox.invalidate();
    onDone();
  };
  const save = trpc.inbox.saveReply.useMutation({ onSuccess: async () => { setDraft(null); await utils.inbox.invalidate(); } });
  const send = trpc.inbox.send.useMutation({ onSuccess: done });
  const skip = trpc.inbox.skip.useMutation({ onSuccess: done });
  if (!q.data) return <div className="ld-expand ld-empty">{q.isLoading ? "Loading..." : "Couldn't open the email."}</div>;
  const m = q.data;
  const busy = save.isPending || send.isPending || skip.isPending;
  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16, paddingTop: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <b style={{ fontSize: 13 }}>The email</b>
        <div className="ld-card" style={{ padding: "12px 14px", fontSize: 13 }}>
          <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "70px minmax(0,1fr)", gap: "3px 10px", paddingBottom: 8, marginBottom: 8, borderBottom: "1px solid var(--ld-line)" }}>
            <b>From</b><span style={{ overflowWrap: "anywhere" }}>{m.fromName} ({m.fromEmail})</span>
            <b>Subject</b><span style={{ overflowWrap: "anywhere" }}>{m.subject || "No subject"}</span>
            <b>Received</b><span>{when(m.receivedAt)}</span>
          </div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 320, overflow: "auto", lineHeight: 1.5 }}>{m.body || "No text in this email."}</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <label htmlFor={`inbox-reply-${id}`} style={{ fontSize: 13, fontWeight: 700 }}>{m.reply || draft !== null ? "Avery's reply" : "No reply written"}</label>
        {m.why && <span style={{ fontSize: 13 }}>{m.why}</span>}
        {draft !== null ? (
          <textarea id={`inbox-reply-${id}`} className="ld-ta" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
        ) : (
          m.reply && <div id={`inbox-reply-${id}`} className="ld-card" style={{ padding: "12px 14px", fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5 }}>{m.reply}</div>
        )}
        {m.masked && <span style={{ fontSize: 13 }}>Set client names to Show to edit the reply.</span>}
        <ErrorLine error={save.error || send.error || skip.error} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {draft !== null ? (
            <>
              <button type="button" className="ld-btn p sm" disabled={busy} onClick={() => save.mutate({ organizationId: orgId, id, text: draft })}>Save</button>
              <button type="button" className="ld-btn sm" onClick={() => setDraft(null)}>Cancel</button>
            </>
          ) : (
            <>
              {m.reply && <button type="button" className="ld-btn p sm" disabled={busy} onClick={() => send.mutate({ organizationId: orgId, id })}>{send.isPending ? "Sending..." : "Send"}</button>}
              {!m.masked && <button type="button" className="ld-btn sm" disabled={busy} onClick={() => setDraft(m.reply)}>{m.reply ? "Edit" : "Write"}</button>}
              <button type="button" className="ld-btn sm" disabled={busy} onClick={() => skip.mutate({ organizationId: orgId, id })}>Skip</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
