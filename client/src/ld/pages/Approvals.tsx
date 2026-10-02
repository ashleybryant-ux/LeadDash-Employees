import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, ErrorLine, FolderTabs, Page, useEmployees } from "../ui";
import { fmtDate, parseJson } from "../meta";

const COLS = "150px minmax(0,2.4fr) minmax(0,1.2fr) 120px 128px 128px";

type TabKey = "all" | "email" | "social" | "blog" | "pitches" | "done";

const KIND_TAB: Record<string, Exclude<TabKey, "all" | "done">> = {
  email_draft: "email",
  calendar_hold: "email",
  social_post: "social",
  blog_post: "blog",
  speaking_pitch: "pitches",
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

export default function Approvals() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const { list: employees } = useEmployees();
  const q = trpc.publishing.listApprovalQueue.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
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
  const count = (k: Exclude<TabKey, "all" | "done">) => pending.filter((i) => KIND_TAB[i.kind] === k).length;

  const shown = tab === "done" ? done : tab === "all" ? pending : pending.filter((i) => KIND_TAB[i.kind] === tab);

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
          { key: "all", label: `All (${pending.length})` },
          { key: "email", label: `Email (${count("email")})` },
          { key: "social", label: `Social (${count("social")})` },
          { key: "blog", label: `Blog (${count("blog")})` },
          { key: "pitches", label: `Pitches (${count("pitches")})` },
          { key: "done", label: `Done (${done.length})` },
        ]}
      >
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>From</span>
          <span>Item</span>
          <span>Goes to</span>
          <span>Created</span>
          <span />
          <span />
        </div>
        {shown.length === 0 && (
          <div className="ld-empty">{q.isLoading ? "Loading..." : tab === "done" ? "Nothing approved or sent back yet." : "Nothing is waiting for approval."}</div>
        )}
        {shown.map((item) => {
          const emp = employees.find((e) => e.id === item.employeeId);
          const isOpen = open === item.id;
          const channels = channelList(item.targetChannels);
          const isPending = item.status === "pending_approval";
          const st = DONE_STATUS[item.status] ?? { label: item.status, cls: "gray" };
          const meta = parseJson<{ headline?: string }>(item.metadata, {});
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
                      Approve
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
                    <span />
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
                    {item.kind === "social_post" && isPending && (
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
