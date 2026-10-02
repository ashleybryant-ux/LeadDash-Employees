import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, ErrorLine, FolderTabs, Page, useEmployees } from "../ui";
import { CHANNEL_LABEL, fmtDate, openDownload, parseJson } from "../meta";
import type { AppRow, Attachment, Question } from "../types";

const COLS = "150px minmax(0,2.4fr) minmax(0,1.2fr) 120px 128px 128px";

type TabKey = "all" | "applications" | "hiring" | "email" | "social" | "blog" | "pitches" | "submitted" | "done";

const KIND_TAB: Record<string, Exclude<TabKey, "all" | "done" | "applications" | "submitted">> = {
  email_draft: "email",
  calendar_hold: "email",
  social_post: "social",
  blog_post: "blog",
  speaking_pitch: "pitches",
  hiring_email: "hiring",
};

const CHANNEL_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  x: "X",
  google_business: "Google Business Profile",
  google_workspace: "Gmail",
  wordpress: "WordPress",
};

const DONE_STATUS: Record<string, { label: string; cls: string }> = {
  approved: { label: "Approved", cls: "green" },
  scheduled: { label: "Approved", cls: "green" },
  published: { label: "Sent", cls: "green" },
  changes_requested: { label: "Sent back", cls: "amber" },
  cancelled: { label: "Cancelled", cls: "gray" },
  blocked_connection: { label: "Waiting on channel", cls: "amber" },
  drafting: { label: "Drafting", cls: "gray" },
};

function channelList(raw: string | null) {
  const list = parseJson<unknown>(raw, []);
  return (Array.isArray(list) ? list : []).filter((c): c is string => typeof c === "string").map((c) => CHANNEL_LABELS[c] ?? c);
}

function joinAnd(list: string[]) {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

type Dispatch = { channel: string; ok: boolean; url?: string | null; error?: string };
const CH_NAME: Record<string, string> = { linkedin: "LinkedIn", facebook: "Facebook", instagram: "Instagram", x: "X", google_business: "Google Business Profile", gmail: "Gmail", calendar: "Google Calendar" };

/** Which channels an item goes out on, by the names the server uses. */
function itemChannels(kind: string, targetChannels: string | null): string[] {
  if (kind === "social_post") return channelList(targetChannels).length ? parseJson<string[]>(targetChannels, []).filter((c) => c in CH_NAME) : [];
  if (kind === "calendar_hold") return ["calendar"];
  if (kind === "email_draft" || kind === "hiring_email" || kind === "speaking_pitch") return ["gmail"];
  return [];
}

function doneLabel(kind: string, status: string, dispatch: Dispatch[]) {
  if (status === "published") return { label: kind === "calendar_hold" ? "On calendar" : kind === "social_post" || kind === "blog_post" ? "Posted" : "Sent", cls: "green" };
  if (status === "approved" && dispatch.some((d) => !d.ok)) return { label: dispatch.some((d) => d.ok) ? "Partly posted" : kind === "social_post" ? "Did not post" : "Did not send", cls: "red" };
  return DONE_STATUS[status] ?? { label: status, cls: "gray" };
}

export default function Approvals() {
  const { currentOrgId } = useTenant();
  const info = trpc.publishing.connectInfo.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const live = info.data?.channels ?? {};
  const utils = trpc.useUtils();
  const { list: employees } = useEmployees();
  const q = trpc.publishing.listApprovalQueue.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const appsQ = trpc.applications.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const apps = appsQ.data ?? [];
  const waitingApps = apps.filter((a) => a.status === "ready");
  const sentApps = apps.filter((a) => ["approved", "submitted", "awarded", "declined"].includes(a.status));
  const [tab, setTab] = React.useState<TabKey>("all");
  const [open, setOpen] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState("");

  const refresh = () => utils.publishing.listApprovalQueue.invalidate();
  const act = trpc.publishing.approveAndDispatch.useMutation({ onSuccess: refresh });
  const save = trpc.publishing.updateItem.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const items = q.data ?? [];
  const pending = items.filter((i) => i.status === "pending_approval");
  const done = items.filter((i) => i.status !== "pending_approval" && i.status !== "drafting");
  const count = (k: Exclude<TabKey, "all" | "done" | "applications" | "submitted">) => pending.filter((i) => KIND_TAB[i.kind] === k).length;

  const shown = tab === "done" ? done : tab === "all" ? pending : tab === "applications" || tab === "submitted" ? [] : pending.filter((i) => KIND_TAB[i.kind] === tab);
  const shownApps = tab === "all" || tab === "applications" ? waitingApps : tab === "submitted" ? sentApps : [];

  return (
    <Page rail="approvals">
      <h1 className="ld-h1">Approvals</h1>

      <FolderTabs
        value={tab}
        onChange={(k) => {
          setTab(k);
          setOpen(null);
          setEditing(null);
        }}
        tabs={[
          { key: "all", label: `All (${pending.length + waitingApps.length})` },
          { key: "applications", label: `Applications (${waitingApps.length})` },
          { key: "hiring", label: `Hiring (${count("hiring")})` },
          { key: "email", label: `Email (${count("email")})` },
          { key: "social", label: `Social (${count("social")})` },
          { key: "blog", label: `Blog (${count("blog")})` },
          { key: "pitches", label: `Pitches (${count("pitches")})` },
          { key: "submitted", label: `Submitted (${sentApps.length})` },
          { key: "done", label: `Done (${done.length})` },
        ]}
      >
        {shownApps.length > 0 && <AppRows list={shownApps} employees={employees} />}
        <div className="ld-hd" style={{ gridTemplateColumns: COLS, display: shown.length === 0 && shownApps.length > 0 ? "none" : undefined }}>
          <span>From</span>
          <span>Item</span>
          <span>Goes to</span>
          <span>Created</span>
          <span />
          <span />
        </div>
        {shown.length === 0 && shownApps.length === 0 && (
          <div className="ld-empty">{q.isLoading ? "Loading..." : tab === "done" ? "Nothing approved or sent back yet." : tab === "submitted" ? "Nothing submitted yet." : "Nothing is waiting for approval."}</div>
        )}
        {shown.length > 0 && shownApps.length > 0 && <div style={{ height: 1, background: "#e3e9e6" }} />}
        {shown.map((item) => {
          const emp = employees.find((e) => e.id === item.employeeId);
          const isOpen = open === item.id;
          const channels = channelList(item.targetChannels);
          const isPending = item.status === "pending_approval";
          const meta = parseJson<{ headline?: string; to?: string; email?: string; dispatch?: Dispatch[] }>(item.metadata, {});
          const dispatch = meta.dispatch ?? [];
          const st = doneLabel(item.kind, item.status, dispatch);
          const chans = itemChannels(item.kind, item.targetChannels);
          const liveChans = chans.filter((c) => live[c]);
          const goLabel = liveChans.length === 0 ? "Approve" : item.kind === "social_post" ? "Post" : item.kind === "calendar_hold" ? "Add" : "Send";
          const canRetry = (item.status === "approved" && dispatch.some((d) => !d.ok)) || item.status === "blocked_connection";
          const viewUrl = dispatch.find((d) => d.ok && d.url)?.url ?? null;
          const isEditing = editing === item.id;
          return (
            <React.Fragment key={item.id}>
              <div
                className={`ld-rw ${isOpen ? "open" : ""}`}
                style={{ gridTemplateColumns: COLS, cursor: "pointer" }}
                aria-expanded={isOpen}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("button,a,textarea,input")) return;
                  setOpen(isOpen ? null : item.id);
                  if (isOpen) setEditing(null);
                }}
              >
                <span className="ld-row ld-strong" style={{ minWidth: 0 }}>
                  {emp ? <Avatar name={emp.name} kind={emp.kind} src={emp.avatar} size={26} /> : null}
                  <span className="ld-clip" style={{ whiteSpace: "nowrap" }}>{emp?.name ?? "Employee"}</span>
                </span>
                <span className="ld-strong">{item.title}</span>
                <span>{channels.join(", ") || "Not set"}</span>
                <span>{fmtDate(item.createdAt)}</span>
                {isPending ? (
                  <>
                    <button
                      type="button"
                      className="ld-btn p"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ organizationId: currentOrgId, itemId: item.id, action: "approve_for_dispatch" })}
                    >
                      {act.isPending && act.variables?.itemId === item.id ? "Working..." : goLabel}
                    </button>
                    <button
                      type="button"
                      className="ld-btn"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ organizationId: currentOrgId, itemId: item.id, action: "request_revisions" })}
                    >
                      Send back
                    </button>
                  </>
                ) : (
                  <>
                    <span className={`ld-pill ${st.cls}`}>{st.label}</span>
                    {canRetry ? (
                      <button type="button" className="ld-btn p" disabled={act.isPending} onClick={() => act.mutate({ organizationId: currentOrgId, itemId: item.id, action: "retry" })}>
                        {act.isPending && act.variables?.itemId === item.id ? "Working..." : "Try again"}
                      </button>
                    ) : viewUrl ? (
                      <a className="ld-btn" href={viewUrl} target="_blank" rel="noreferrer noopener">{item.kind === "social_post" ? "View post" : "Open"}</a>
                    ) : (
                      <span />
                    )}
                  </>
                )}
              </div>
              {isOpen && (
                <div
                  className="ld-expand"
                  style={{ display: "grid", gridTemplateColumns: item.kind === "social_post" ? "220px minmax(0,1fr) 128px" : "minmax(0,1fr) 128px", gap: 20 }}
                >
                  {item.kind === "social_post" &&
                    (item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.title} style={{ width: 220, height: 275, borderRadius: 10, objectFit: "cover", display: "block" }} />
                    ) : (
                      <div
                        style={{
                          width: 220,
                          height: 275,
                          borderRadius: 10,
                          background: "#0d3b2e",
                          color: "#fff",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "flex-end",
                          padding: 16,
                          boxSizing: "border-box",
                          fontWeight: 800,
                          fontSize: 17,
                          lineHeight: 1.25,
                        }}
                      >
                        {meta.headline || item.title}
                      </div>
                    ))}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                    <label className="ld-lbl" htmlFor={`body-${item.id}`}>{item.kind === "social_post" ? "Caption" : "Text"}</label>
                    {isEditing ? (
                      <textarea id={`body-${item.id}`} className="ld-ta" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    ) : (
                      <span className="ld-body ld-pre" style={{ lineHeight: 1.6 }}>{item.body || "No text."}</span>
                    )}
                    {chans.length > 0 && isPending && liveChans.length > 0 && (
                      <>
                        <span className="ld-lbl" style={{ marginTop: 8 }}>{item.kind === "social_post" ? "Posts to" : "Goes out through"}</span>
                        <span className="ld-body">{liveChans.map((c) => CH_NAME[c]).join(", ")}{chans.length > liveChans.length ? `. Not connected yet: ${chans.filter((c) => !live[c]).map((c) => CH_NAME[c]).join(", ")}` : ""}</span>
                      </>
                    )}
                    {dispatch.length > 0 && (
                      <>
                        <span className="ld-lbl" style={{ marginTop: 8 }}>Result</span>
                        {dispatch.map((d) => (
                          <span key={d.channel} className="ld-body" style={{ color: d.ok ? "#155c3e" : "#b42318" }}>
                            {CH_NAME[d.channel] ?? d.channel}: {d.ok ? (item.kind === "social_post" ? "posted" : item.kind === "calendar_hold" ? "added" : "sent") : d.error}
                            {d.ok && d.url ? (
                              <>
                                {" "}
                                <a href={d.url} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600 }}>Open</a>
                              </>
                            ) : null}
                          </span>
                        ))}
                      </>
                    )}
                    {item.kind === "hiring_email" && (
                      <>
                        <span className="ld-lbl" style={{ marginTop: 8 }}>To</span>
                        <span className="ld-body">{[meta.to, meta.email].filter(Boolean).join(", ")}</span>
                        {isPending && !live.gmail && (
                          <>
                            <span className="ld-lbl" style={{ marginTop: 8 }}>After approval</span>
                            <span className="ld-body">Held until Google is connected on Integrations, or copy it and send it yourself</span>
                          </>
                        )}
                      </>
                    )}
                    {item.kind === "social_post" && isPending && liveChans.length === 0 && (
                      <>
                        <span className="ld-lbl" style={{ marginTop: 8 }}>After approval</span>
                        <span className="ld-body">
                          Held until {joinAnd(channels) || "the channel"} {channels.length > 1 ? "are" : "is"} connected
                        </span>
                      </>
                    )}
                    {item.approvedBy && (
                      <span className="ld-small ld-muted" style={{ marginTop: 8 }}>
                        Approved by {item.approvedBy}
                        {item.approvedAt ? ` on ${fmtDate(item.approvedAt)}` : ""}
                      </span>
                    )}
                    <ErrorLine error={save.error} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          className="ld-btn p"
                          disabled={save.isPending}
                          onClick={() => save.mutate({ organizationId: currentOrgId, itemId: item.id, body: draft })}
                        >
                          Save
                        </button>
                        <button type="button" className="ld-btn" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </>
                    ) : item.status !== "published" ? (
                      <button
                        type="button"
                        className="ld-btn"
                        onClick={() => {
                          setDraft(item.body ?? "");
                          setEditing(item.id);
                        }}
                      >
                        Edit
                      </button>
                    ) : null}
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
        {act.error && (
          <div style={{ padding: "8px 18px" }}>
            <ErrorLine error={act.error} />
          </div>
        )}
      </FolderTabs>
    </Page>
  );
}

// ==========================================
// Applications waiting for the Submit tap, and sent ones
// ==========================================

const APP_COLS = "150px minmax(0,2.4fr) minmax(0,1.2fr) 120px 128px 128px";
const SENT: Record<string, { label: string; cls: string }> = {
  approved: { label: "Approved to send", cls: "green" },
  submitted: { label: "Submitted", cls: "green" },
  awarded: { label: "Awarded", cls: "green" },
  declined: { label: "Declined", cls: "gray" },
};

function AppRows({ list, employees }: { list: AppRow[]; employees: ReturnType<typeof useEmployees>["list"] }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [open, setOpen] = React.useState<number | null>(list[0]?.status === "ready" ? list[0].id : null);
  const submit = trpc.applications.submit.useMutation({ onSuccess: () => utils.applications.invalidate() });
  const back = trpc.applications.sendBack.useMutation({ onSuccess: () => utils.applications.invalidate() });
  const dl = trpc.applications.download.useMutation({ onSuccess: openDownload });
  const org = trpc.organizations.get.useQuery({ id: currentOrgId }, { enabled: currentOrgId > 0 });
  const signer = org.data?.signerName ? `${org.data.signerName}${org.data.signerTitle ? `, ${org.data.signerTitle}` : ""}` : "Not set (Integrations, Applying)";
  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: APP_COLS }}>
        <span>From</span>
        <span>Application</span>
        <span>Goes in through</span>
        <span>Due</span>
        <span />
        <span />
      </div>
      {list.map((a) => {
        const emp = employees.find((e) => e.id === a.employeeId);
        const isOpen = open === a.id;
        const waiting = a.status === "ready";
        const qs = parseJson<Question[]>(a.questions, []);
        const atts = parseJson<Attachment[]>(a.attachments, []);
        const base = `/chats/${emp?.kind ?? "grants"}`;
        return (
          <React.Fragment key={`app-${a.id}`}>
            <div
              className={`ld-rw ${isOpen ? "open" : ""}`}
              style={{ gridTemplateColumns: APP_COLS, cursor: "pointer" }}
              aria-expanded={isOpen}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button,a")) return;
                setOpen(isOpen ? null : a.id);
              }}
            >
              <span className="ld-row ld-strong" style={{ minWidth: 0 }}>
                {emp ? <Avatar name={emp.name} kind={emp.kind} src={emp.avatar} size={26} /> : null}
                <span className="ld-clip" style={{ whiteSpace: "nowrap" }}>{emp?.name ?? "Employee"}</span>
              </span>
              <span className="ld-strong">{a.title}</span>
              <span>{a.channel === "portal" || a.channel === "email" ? a.channelDetail || CHANNEL_LABEL[a.channel] : CHANNEL_LABEL[a.channel] ?? a.channel}</span>
              <span>{a.opp?.deadline || "Not listed"}</span>
              {waiting ? (
                <>
                  <button type="button" className="ld-btn p" disabled={submit.isPending || a.blockers.length > 0} title={a.blockers.join(". ") || undefined} onClick={() => submit.mutate({ organizationId: currentOrgId, id: a.id })}>Submit</button>
                  <button type="button" className="ld-btn" disabled={back.isPending} onClick={() => back.mutate({ organizationId: currentOrgId, id: a.id })}>Send back</button>
                </>
              ) : (
                <>
                  <span className={`ld-pill ${SENT[a.status]?.cls ?? "gray"}`}>{SENT[a.status]?.label ?? a.status}</span>
                  <span />
                </>
              )}
            </div>
            {isOpen && (
              <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px 128px", gap: "14px 24px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="ld-lbl">Host</span><span className="ld-body">{[a.opp?.host, a.opp?.amount].filter(Boolean).join(" · ")}</span></div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="ld-lbl">Questions</span><span className="ld-body">{qs.filter((x) => x.answer.trim()).length} of {qs.length} answered</span></div>
                  {a.confirmation && <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="ld-lbl">Confirmation</span><span className="ld-body">{a.confirmation}</span></div>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="ld-lbl">Attachments</span><span className="ld-body">{atts.length ? atts.map((x) => x.name).join(", ") : "None asked for"}</span></div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="ld-lbl">Signed by</span><span className="ld-body">{a.certifiedBy ? `${a.certifiedBy}, ${fmtDate(a.certifiedAt)}` : signer}</span></div>
                  {waiting && (
                    a.blockers.length ? (
                      <span className="ld-small" style={{ color: "#8a4510", fontWeight: 600 }}>Before Submit: {a.blockers.join(". ")}.</span>
                    ) : (
                      <span className="ld-small ld-muted" style={{ lineHeight: 1.5 }}>Submitting certifies the application is true and complete and that you are authorized to submit it for {org.data?.name ?? "this workspace"}.</span>
                    )
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}><Link href={`${base}/app/${a.id}`} className="ld-btn">Open</Link></div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button type="button" className="ld-btn" disabled={dl.isPending} onClick={() => dl.mutate({ organizationId: currentOrgId, id: a.id, what: "zip" })}>Download</button>
                </div>
              </div>
            )}
          </React.Fragment>
        );
      })}
      {(submit.error || back.error || dl.error) && (
        <div style={{ padding: "8px 18px" }}>
          <ErrorLine error={submit.error || back.error || dl.error} />
        </div>
      )}
    </>
  );
}
