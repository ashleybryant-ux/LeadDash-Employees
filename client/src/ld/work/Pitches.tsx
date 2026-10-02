import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, UnderlineTabs } from "../ui";
import { fmtDate, parseJson } from "../meta";

const COLS = "minmax(0,2.2fr) minmax(0,1.6fr) 150px 100px 128px";

type EventData = {
  organizer?: string;
  audience?: string;
  deadline?: string;
  pays?: string;
  location?: string;
  angle?: string;
  pitch?: { subject: string; body: string } | null;
};

/** Taylor's Work tab: speaking Opportunities and Pitches. */
export default function Pitches({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [tab, setTab] = React.useState<"opps" | "pitches">("opps");
  const [open, setOpen] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");

  const list = trpc.speaking.list.useQuery({ organizationId: currentOrgId });
  const refresh = () => Promise.all([utils.speaking.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const find = trpc.speaking.find.useMutation({ onSuccess: () => utils.speaking.invalidate() });
  const write = trpc.speaking.writePitch.useMutation({
    onSuccess: async (_r, vars) => {
      await refresh();
      setTab("pitches");
      setOpen(vars.id);
    },
  });
  const save = trpc.speaking.updatePitch.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const send = trpc.speaking.sendToApproval.useMutation({ onSuccess: refresh });
  const dismiss = trpc.speaking.dismiss.useMutation({ onSuccess: refresh });

  const items = (list.data ?? []).map((i) => ({ ...i, d: parseJson<EventData>(i.data, {}) }));
  const opps = items.filter((i) => !i.d.pitch && i.status === "new");
  const pitches = items.filter((i) => !!i.d.pitch || i.status === "drafted" || i.status === "sent_to_approval");
  const shown = tab === "opps" ? opps : pitches;

  const startEdit = (id: number, d: EventData) => {
    setSubject(d.pitch?.subject ?? "");
    setBody(d.pitch?.body ?? "");
    setEditing(id);
    setOpen(id);
  };

  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      <div className="ld-row" style={{ justifyContent: "flex-end" }}>
        {find.data && !find.isPending && (
          <span className="ld-small ld-muted">
            {find.data.added ? `Added ${find.data.added} from ${find.data.queries.length} searches.` : `No new events from ${find.data.queries.length} searches.`}
          </span>
        )}
        <button type="button" className="ld-btn p" disabled={find.isPending} onClick={() => find.mutate({ organizationId: currentOrgId })}>
          {find.isPending ? "Searching..." : "Find events"}
        </button>
      </div>
      <ErrorLine error={find.error} />

      <UnderlineTabs
        value={tab}
        onChange={(k) => {
          setTab(k);
          setOpen(null);
          setEditing(null);
        }}
        tabs={[
          { key: "opps", label: `Opportunities (${opps.length})` },
          { key: "pitches", label: `Pitches (${pitches.length})` },
        ]}
      />

      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Event</span>
          <span>Audience</span>
          <span>Proposals due</span>
          <span>Pays</span>
          <span />
        </div>
        {shown.length === 0 && (
          <div className="ld-empty">
            {list.isLoading ? "Loading..." : tab === "opps" ? `No events yet. Press Find events or ask ${emp.name} in Chat.` : "No pitches yet. Press Write pitch on an event."}
          </div>
        )}
        {shown.map((i) => {
          const isOpen = open === i.id;
          const isEditing = editing === i.id;
          const sent = i.status === "sent_to_approval";
          const writing = write.isPending && write.variables?.id === i.id;
          return (
            <React.Fragment key={i.id}>
              <div
                className={`ld-rw ${isOpen ? "open" : ""}`}
                style={{ gridTemplateColumns: COLS, cursor: "pointer" }}
                aria-expanded={isOpen}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("button,a")) return;
                  setOpen(isOpen ? null : i.id);
                  if (isOpen) setEditing(null);
                }}
              >
                <span className="ld-strong">{i.title}</span>
                <span>{i.d.audience || "Not listed"}</span>
                <span>{i.d.deadline || "Not listed"}</span>
                <span>{i.d.pays || "Unknown"}</span>
                {sent ? (
                  <button type="button" className="ld-btn" disabled>In approvals</button>
                ) : i.d.pitch ? (
                  <button type="button" className="ld-btn" onClick={() => startEdit(i.id, i.d)}>Edit pitch</button>
                ) : (
                  <button type="button" className="ld-btn p" disabled={write.isPending} onClick={() => write.mutate({ organizationId: currentOrgId, id: i.id })}>
                    {writing ? "Writing..." : "Write pitch"}
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
                  {i.d.pitch ? (
                    <div className={`ld-card ${isEditing ? "editing" : ""}`} style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "80px minmax(0,1fr)", gap: "6px 12px", fontSize: 14, alignItems: "center" }}>
                        <span className="ld-lbl">To</span>
                        <span>{i.d.organizer ? `${i.d.organizer}, via the event page` : "Via the event page"}</span>
                        {isEditing ? (
                          <label className="ld-lbl" htmlFor={`pitch-subject-${i.id}`}>Subject</label>
                        ) : (
                          <span className="ld-lbl">Subject</span>
                        )}
                        {isEditing ? (
                          <input id={`pitch-subject-${i.id}`} className="ld-in" value={subject} onChange={(e) => setSubject(e.target.value)} />
                        ) : (
                          <span className="ld-strong">{i.d.pitch.subject}</span>
                        )}
                      </div>
                      <div style={{ borderTop: "1px solid #eef2f0", paddingTop: 12 }}>
                        {isEditing ? (
                          <>
                            <label className="ld-sr" htmlFor={`pitch-body-${i.id}`}>Pitch</label>
                            <textarea id={`pitch-body-${i.id}`} className="ld-ta" rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
                          </>
                        ) : (
                          <div className="ld-pre" style={{ fontSize: 14, lineHeight: 1.6, color: "#24332c" }}>{i.d.pitch.body}</div>
                        )}
                      </div>
                      {isEditing && (
                        <div className="ld-row" style={{ justifyContent: "flex-end" }}>
                          <button type="button" className="ld-btn sm" onClick={() => setEditing(null)}>Cancel</button>
                          <button
                            type="button"
                            className="ld-btn p sm"
                            disabled={save.isPending}
                            onClick={() => save.mutate({ organizationId: currentOrgId, id: i.id, subject, body })}
                          >
                            Save
                          </button>
                        </div>
                      )}
                      <div className="ld-row" style={{ gap: 16, fontSize: 13, color: "#5b6b64", borderTop: "1px solid #eef2f0", paddingTop: 10 }}>
                        <Source url={i.sourceUrl} />
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 24 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        <Field label="Session to pitch">{i.d.angle || "Not suggested yet."}</Field>
                        <Field label="Organizer">{i.d.organizer || "Not listed"}</Field>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        <Field label="Location">{i.d.location || "Not listed"}</Field>
                        <Field label="Source">
                          <Source url={i.sourceUrl} bare />
                        </Field>
                        <Field label="Found">{fmtDate(i.createdAt)}</Field>
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {i.d.pitch && !sent && (
                      <button
                        type="button"
                        className="ld-btn p"
                        disabled={send.isPending || isEditing}
                        onClick={() => send.mutate({ organizationId: currentOrgId, id: i.id })}
                      >
                        Send to approval
                      </button>
                    )}
                    <button type="button" className="ld-btn" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ organizationId: currentOrgId, id: i.id })}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
        <div style={{ padding: "0 18px" }}>
          <ErrorLine error={write.error ?? save.error ?? send.error ?? dismiss.error} />
        </div>
      </div>
    </main>
  );
}

function Source({ url, bare }: { url: string | null; bare?: boolean }) {
  if (!url) return <span>{bare ? "None" : "Source: none"}</span>;
  const link = (
    <a href={url} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
      {url.replace(/^https?:\/\/(www\.)?/, "")}
    </a>
  );
  return bare ? link : <span>Source: {link}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body">{children}</span>
    </div>
  );
}
