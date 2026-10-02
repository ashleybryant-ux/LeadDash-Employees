import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, UnderlineTabs } from "../ui";
import { fmtDate } from "../meta";

type Platform = "linkedin" | "instagram" | "facebook" | "x";
const PLATFORMS: { key: Platform; label: string }[] = [
  { key: "linkedin", label: "LinkedIn" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "x", label: "X" },
];

const STATUS: Record<string, { label: string; cls: string }> = {
  drafting: { label: "Drafting", cls: "gray" },
  pending_approval: { label: "Waiting for approval", cls: "amber" },
  changes_requested: { label: "Sent back", cls: "amber" },
  approved: { label: "Approved", cls: "green" },
  scheduled: { label: "Scheduled", cls: "green" },
  published: { label: "Posted", cls: "green" },
  blocked_connection: { label: "Needs connection", cls: "red" },
};

type Tab = "drafts" | "approved" | "posted";

/** Sienna's Work tab: social posts. */
export default function Posts({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [tab, setTab] = React.useState<Tab>("drafts");
  const [topic, setTopic] = React.useState("");
  const [platforms, setPlatforms] = React.useState<Platform[]>(["linkedin", "instagram"]);
  const [makeImage, setMakeImage] = React.useState(true);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState("");

  const posts = trpc.social.listPosts.useQuery({ organizationId: currentOrgId });
  const refresh = () => Promise.all([utils.social.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const write = trpc.social.generatePostAndCreative.useMutation({
    onSuccess: async () => {
      setTopic("");
      setTab("drafts");
      await refresh();
    },
  });
  const save = trpc.publishing.updateItem.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const all = (posts.data ?? []).filter((p) => p.status !== "cancelled");
  const groups: Record<Tab, typeof all> = {
    drafts: all.filter((p) => p.status === "pending_approval" || p.status === "changes_requested" || p.status === "drafting"),
    approved: all.filter((p) => p.status === "approved" || p.status === "scheduled" || p.status === "blocked_connection"),
    posted: all.filter((p) => p.status === "published"),
  };
  const shown = groups[tab];
  const canWrite = topic.trim().length >= 3 && platforms.length > 0;

  const toggle = (k: Platform) => setPlatforms((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      <form
        className="ld-card"
        style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto 128px", gap: 16, alignItems: "end" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canWrite) return;
          write.mutate({ organizationId: currentOrgId, topic: topic.trim(), targetPlatforms: platforms, tone: "thought_leadership", generateImageFlag: makeImage });
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="post-topic" className="ld-lbl">Topic</label>
          <input id="post-topic" className="ld-in lg" value={topic} onChange={(e) => setTopic(e.target.value)} />
        </div>
        <div className="ld-row" style={{ gap: 14, height: 34 }}>
          {PLATFORMS.map((p) => (
            <label key={p.key} className="ld-row" style={{ gap: 6, fontSize: 13, fontWeight: 600 }}>
              <input type="checkbox" checked={platforms.includes(p.key)} onChange={() => toggle(p.key)} /> {p.label}
            </label>
          ))}
          <span style={{ width: 1, height: 20, background: "#e3e9e6" }} aria-hidden="true" />
          <label className="ld-row" style={{ gap: 6, fontSize: 13, fontWeight: 600 }}>
            <input type="checkbox" checked={makeImage} onChange={(e) => setMakeImage(e.target.checked)} /> Make image
          </label>
        </div>
        <button type="submit" className="ld-btn p" disabled={!canWrite || write.isPending}>
          {write.isPending ? "Writing..." : "Write post"}
        </button>
      </form>
      <ErrorLine error={write.error} />

      <UnderlineTabs
        value={tab}
        onChange={(k) => {
          setTab(k);
          setEditing(null);
        }}
        tabs={[
          { key: "drafts", label: `Drafts (${groups.drafts.length})` },
          { key: "approved", label: `Approved (${groups.approved.length})` },
          { key: "posted", label: `Posted (${groups.posted.length})` },
        ]}
      />

      {shown.length === 0 ? (
        <div className="ld-card ld-empty">
          {posts.isLoading ? "Loading..." : tab === "drafts" ? `No drafts yet. Write a post above or ask ${emp.name} in Chat.` : tab === "approved" ? "No approved posts yet." : "Nothing posted yet."}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16, alignItems: "start" }}>
          {shown.map((p) => {
            const st = STATUS[p.status] ?? { label: p.status, cls: "gray" };
            const isEditing = editing === p.id;
            return (
              <div key={p.id} className={`ld-card ${isEditing ? "editing" : ""}`} style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt={p.title} style={{ aspectRatio: "4 / 5", width: "100%", objectFit: "cover", display: "block" }} />
                ) : (
                  <div
                    style={{
                      aspectRatio: "4 / 5",
                      background: "#0d3b2e",
                      color: "#fff",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "flex-end",
                      padding: 22,
                      boxSizing: "border-box",
                      fontSize: 24,
                      fontWeight: 800,
                      lineHeight: 1.2,
                    }}
                  >
                    {p.title}
                  </div>
                )}
                <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                  {isEditing ? (
                    <>
                      <label className="ld-sr" htmlFor={`caption-${p.id}`}>Caption</label>
                      <textarea id={`caption-${p.id}`} className="ld-ta" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    </>
                  ) : (
                    <span
                      style={{
                        fontSize: 14,
                        lineHeight: 1.5,
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {p.body}
                    </span>
                  )}
                  <div className="ld-between">
                    <span className={`ld-pill ${st.cls}`}>{st.label}</span>
                    <span className="ld-small ld-muted">{fmtDate(p.createdAt)}</span>
                  </div>
                  {p.status !== "published" && (
                    <div className="ld-row">
                      {isEditing ? (
                        <>
                          <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
                          <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, itemId: p.id, body: draft })}>
                            Save
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="ld-btn"
                          onClick={() => {
                            setDraft(p.body ?? "");
                            setEditing(p.id);
                          }}
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  )}
                  {isEditing && <ErrorLine error={save.error} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
