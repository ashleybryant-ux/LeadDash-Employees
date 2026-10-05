import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, UnderlineTabs } from "../ui";
import { fmtDate, parseJson } from "../meta";

const COLS = "minmax(0,1.3fr) minmax(0,2fr) 110px 150px 128px";
const HCOLS = "minmax(0,2fr) minmax(0,1.3fr) minmax(0,1.3fr) 150px 128px";

const URGENCY: Record<string, { label: string; cls: string }> = {
  today: { label: "Today", cls: "amber" },
  this_week: { label: "This week", cls: "gray" },
  later: { label: "Later", cls: "gray" },
};

const STATUS: Record<string, string> = {
  drafting: "Drafting",
  pending_approval: "Waiting for approval",
  changes_requested: "Sent back",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Sent",
  blocked_connection: "Needs connection",
  cancelled: "Dismissed",
};

type EmailMeta = { recipient?: string; threadSubject?: string; whatTheyWant?: string; urgency?: string };
type HoldMeta = { date?: string; time?: string; attendees?: string[] };

const DATE_RE = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;

/** Avery's Work tab: email drafts and calendar holds. */
export default function Drafts({ emp, embedded = false }: { emp: EmployeeRow; embedded?: boolean }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [tab, setTab] = React.useState<"email" | "holds">("email");
  const [open, setOpen] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState("");

  // Paste a message
  const [from, setFrom] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");

  const items = trpc.assistant.listItems.useQuery({ organizationId: currentOrgId });
  const refresh = () => Promise.all([utils.assistant.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const draftReply = trpc.assistant.draftEmailReply.useMutation({
    onSuccess: async (r) => {
      setFrom("");
      setSubject("");
      setMessage("");
      await refresh();
      setTab("email");
      if (r?.id) setOpen(r.id);
    },
  });
  const save = trpc.publishing.updateItem.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const review = trpc.publishing.approveAndDispatch.useMutation({ onSuccess: refresh });

  const all = (items.data ?? []).filter((i) => i.status !== "cancelled");
  const emails = all.filter((i) => i.kind === "email_draft");
  const holds = all.filter((i) => i.kind === "calendar_hold");
  const canDraft = from.trim().length >= 3 && subject.trim().length >= 2 && message.trim().length >= 5;

  const sideButtons = (i: { id: number; status: string }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {editing === i.id ? (
        <>
          <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, itemId: i.id, body: draft })}>
            Save
          </button>
          <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
        </>
      ) : (
        <>
          {i.status === "pending_approval" && (
            <>
              <button type="button" className="ld-btn p" disabled={review.isPending} onClick={() => review.mutate({ organizationId: currentOrgId, itemId: i.id, action: "approve_for_dispatch" })}>
                Approve
              </button>
              <button type="button" className="ld-btn" disabled={review.isPending} onClick={() => review.mutate({ organizationId: currentOrgId, itemId: i.id, action: "request_revisions" })}>
                Send back
              </button>
            </>
          )}
          {i.status !== "published" && (
            <button type="button" className="ld-btn" disabled={review.isPending} onClick={() => review.mutate({ organizationId: currentOrgId, itemId: i.id, action: "cancel" })}>
              Dismiss
            </button>
          )}
        </>
      )}
    </div>
  );

  const rowClick = (id: number, isOpen: boolean) => (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,a")) return;
    setOpen(isOpen ? null : id);
    if (isOpen) setEditing(null);
  };

  const startEdit = (id: number, body: string | null) => {
    setDraft(body ?? "");
    setEditing(id);
    setOpen(id);
  };

  const Shell = embedded ? "div" : "main";
  return (
    <Shell className={embedded ? undefined : "ld-main"} style={embedded ? { display: "flex", flexDirection: "column", gap: 16 } : { padding: "28px 36px" }}>
      <form
        className="ld-card"
        style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canDraft) return;
          draftReply.mutate({ organizationId: currentOrgId, recipient: from.trim(), subject: subject.trim(), context: message.trim() });
        }}
      >
        <span className="ld-st">Paste a message</span>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label htmlFor="pm-from" className="ld-lbl">From</label>
            <input id="pm-from" className="ld-in lg" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label htmlFor="pm-subject" className="ld-lbl">Subject</label>
            <input id="pm-subject" className="ld-in lg" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
        </div>
        <label htmlFor="pm-message" className="ld-lbl">Message</label>
        <textarea id="pm-message" className="ld-ta" rows={3} placeholder="Paste the email here" value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className="ld-row" style={{ justifyContent: "flex-end" }}>
          <button type="submit" className="ld-btn p" disabled={!canDraft || draftReply.isPending}>
            {draftReply.isPending ? "Drafting..." : "Draft reply"}
          </button>
        </div>
        <ErrorLine error={draftReply.error} />
      </form>

      {embedded ? (
        <div className="ld-ftabs" role="tablist" style={{ marginBottom: -16 }}>
          {([["email", `Email drafts (${emails.length})`], ["holds", `Calendar holds (${holds.length})`]] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`ld-ft ${tab === k ? "on" : ""}`} onClick={() => { setTab(k); setOpen(null); setEditing(null); }}>
              {l}
            </button>
          ))}
        </div>
      ) : (
        <UnderlineTabs
          value={tab}
          onChange={(k) => {
            setTab(k);
            setOpen(null);
            setEditing(null);
          }}
          tabs={[
            { key: "email", label: `Email drafts (${emails.length})` },
            { key: "holds", label: `Calendar holds (${holds.length})` },
          ]}
        />
      )}

      {tab === "email" ? (
        <div className="ld-card" style={{ overflow: "hidden" }}>
          <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
            <span>From</span>
            <span>Subject</span>
            <span>Urgency</span>
            <span>Status</span>
            <span />
          </div>
          {emails.length === 0 && <div className="ld-empty">{items.isLoading ? "Loading..." : `No drafts yet. Paste a message above or ask ${emp.name} in Chat.`}</div>}
          {emails.map((i) => {
            const m = parseJson<EmailMeta>(i.metadata, {});
            const u = URGENCY[m.urgency ?? ""] ?? URGENCY.later;
            const isOpen = open === i.id;
            const isEditing = editing === i.id;
            const editable = i.status !== "published";
            return (
              <React.Fragment key={i.id}>
                <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS, cursor: "pointer" }} aria-expanded={isOpen} onClick={rowClick(i.id, isOpen)}>
                  <span className="ld-strong ld-clip">{m.recipient || "Unknown sender"}</span>
                  <span className="ld-clip">{m.threadSubject || i.title}</span>
                  <span className={`ld-pill ${u.cls}`}>{u.label}</span>
                  <span>{STATUS[i.status] ?? i.status}</span>
                  {editable ? (
                    <button type="button" className="ld-btn" onClick={() => startEdit(i.id, i.body)}>Edit</button>
                  ) : (
                    <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : i.id)}>{isOpen ? "Close" : "View"}</button>
                  )}
                </div>
                {isOpen && (
                  <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 20 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <Field label="What they want">{m.whatTheyWant || "Not noted."}</Field>
                      <Field label="Drafted">{fmtDate(i.createdAt)}</Field>
                      {i.reviewerNotes && <Field label="Review note">{i.reviewerNotes}</Field>}
                    </div>
                    <div className={`ld-card ${isEditing ? "editing" : ""}`} style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                      {isEditing ? (
                        <>
                          <label className="ld-lbl" htmlFor={`reply-${i.id}`}>Draft reply</label>
                          <textarea id={`reply-${i.id}`} className="ld-ta" rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} />
                        </>
                      ) : (
                        <>
                          <span className="ld-lbl">Draft reply</span>
                          <span className="ld-pre" style={{ fontSize: 14, lineHeight: 1.6 }}>{i.body}</span>
                        </>
                      )}
                    </div>
                    {sideButtons(i)}
                  </div>
                )}
              </React.Fragment>
            );
          })}
          <div style={{ padding: "0 18px" }}>
            <ErrorLine error={save.error ?? review.error} />
          </div>
        </div>
      ) : (
        <>
          <HoldForm onAdded={async (id) => { await refresh(); if (id) setOpen(id); }} />
          <div className="ld-card" style={{ overflow: "hidden" }}>
            <div className="ld-hd" style={{ gridTemplateColumns: HCOLS }}>
              <span>Hold</span>
              <span>When</span>
              <span>Attendees</span>
              <span>Status</span>
              <span />
            </div>
            {holds.length === 0 && <div className="ld-empty">{items.isLoading ? "Loading..." : "No calendar holds yet."}</div>}
            {holds.map((i) => {
              const m = parseJson<HoldMeta>(i.metadata, {});
              const isOpen = open === i.id;
              const isEditing = editing === i.id;
              const editable = i.status !== "published";
              return (
                <React.Fragment key={i.id}>
                  <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: HCOLS, cursor: "pointer" }} aria-expanded={isOpen} onClick={rowClick(i.id, isOpen)}>
                    <span className="ld-strong ld-clip">{i.title}</span>
                    <span>{[m.date, m.time].filter(Boolean).join(" at ") || "Not set"}</span>
                    <span className="ld-clip">{(m.attendees ?? []).join(", ") || "None"}</span>
                    <span>{STATUS[i.status] ?? i.status}</span>
                    {editable ? (
                      <button type="button" className="ld-btn" onClick={() => startEdit(i.id, i.body)}>Edit</button>
                    ) : (
                      <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : i.id)}>{isOpen ? "Close" : "View"}</button>
                    )}
                  </div>
                  {isOpen && (
                    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20 }}>
                      <div className={`ld-card ${isEditing ? "editing" : ""}`} style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                        {isEditing ? (
                          <>
                            <label className="ld-lbl" htmlFor={`hold-${i.id}`}>Details</label>
                            <textarea id={`hold-${i.id}`} className="ld-ta" rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
                          </>
                        ) : (
                          <>
                            <span className="ld-lbl">Details</span>
                            <span className="ld-pre" style={{ fontSize: 14, lineHeight: 1.6 }}>{i.body}</span>
                          </>
                        )}
                      </div>
                      {sideButtons(i)}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
            <div style={{ padding: "0 18px" }}>
              <ErrorLine error={save.error ?? review.error} />
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}

function HoldForm({ onAdded }: { onAdded: (id: number | undefined) => void }) {
  const { currentOrgId } = useTenant();
  const [title, setTitle] = React.useState("");
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [attendees, setAttendees] = React.useState("");
  const [agenda, setAgenda] = React.useState("");
  const add = trpc.assistant.scheduleAppointmentHold.useMutation({
    onSuccess: (r) => {
      setTitle("");
      setDate("");
      setTime("");
      setAttendees("");
      setAgenda("");
      onAdded(r?.id);
    },
  });
  const dateOk = DATE_RE.test(date.trim());
  const ok = title.trim().length >= 2 && dateOk && time.trim().length > 0;

  return (
    <form
      className="ld-card"
      style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        add.mutate({ organizationId: currentOrgId, title: title.trim(), date: date.trim(), time: time.trim(), attendees: attendees.trim(), agenda: agenda.trim() });
      }}
    >
      <span className="ld-st">Add a hold</span>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) 140px 120px minmax(0,1.4fr)", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="h-title" className="ld-lbl">Title</label>
          <input id="h-title" className="ld-in lg" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="h-date" className="ld-lbl">Date</label>
          <input id="h-date" className="ld-in lg" type="text" inputMode="numeric" placeholder="MM/DD/YYYY" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="h-time" className="ld-lbl">Time</label>
          <input id="h-time" className="ld-in lg" type="text" placeholder="2:00 PM" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="h-att" className="ld-lbl">Attendees</label>
          <input id="h-att" className="ld-in lg" placeholder="Separate with commas" value={attendees} onChange={(e) => setAttendees(e.target.value)} />
        </div>
      </div>
      <label htmlFor="h-agenda" className="ld-lbl">Agenda</label>
      <textarea id="h-agenda" className="ld-ta" rows={2} value={agenda} onChange={(e) => setAgenda(e.target.value)} />
      <div className="ld-row" style={{ justifyContent: "flex-end" }}>
        {date.trim() && !dateOk && <span className="ld-small" style={{ color: "#b42318" }}>Type the date as MM/DD/YYYY.</span>}
        <button type="submit" className="ld-btn p" disabled={!ok || add.isPending}>
          {add.isPending ? "Adding..." : "Add hold"}
        </button>
      </div>
      <ErrorLine error={add.error} />
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body">{children}</span>
    </div>
  );
}
