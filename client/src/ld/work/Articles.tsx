import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, UnderlineTabs } from "../ui";
import { fmtDate } from "../meta";

const COLS = "minmax(0,2.6fr) minmax(0,1.2fr) 120px 128px";

const STATUS: Record<string, string> = {
  drafting: "Drafting",
  pending_approval: "Waiting for approval",
  changes_requested: "Sent back",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "On WordPress",
  blocked_connection: "Needs connection",
};

/** Theo's Work tab: blog articles. */
export default function Articles({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [tab, setTab] = React.useState<"drafts" | "live">("drafts");
  const [title, setTitle] = React.useState("");
  const [points, setPoints] = React.useState("");
  const [open, setOpen] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState("");

  const articles = trpc.blog.listArticles.useQuery({ organizationId: currentOrgId });
  const refresh = () => Promise.all([utils.blog.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const write = trpc.blog.draftWordPressArticle.useMutation({
    onSuccess: async (r) => {
      setTitle("");
      setPoints("");
      setTab("drafts");
      await refresh();
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

  const all = (articles.data ?? []).filter((a) => a.status !== "cancelled");
  const drafts = all.filter((a) => a.status !== "published");
  const live = all.filter((a) => a.status === "published");
  const shown = tab === "drafts" ? drafts : live;
  const canWrite = title.trim().length >= 5;

  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      <form
        className="ld-card"
        style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr) 128px", gap: 16, alignItems: "end" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canWrite) return;
          write.mutate({ organizationId: currentOrgId, title: title.trim(), outlineNotes: points.trim() || undefined, generateBannerFlag: true });
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="art-title" className="ld-lbl">Title</label>
          <input id="art-title" className="ld-in lg" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="art-points" className="ld-lbl">Points to cover</label>
          <input id="art-points" className="ld-in lg" value={points} onChange={(e) => setPoints(e.target.value)} />
        </div>
        <button type="submit" className="ld-btn p" disabled={!canWrite || write.isPending}>
          {write.isPending ? "Writing..." : "Write article"}
        </button>
      </form>
      <ErrorLine error={write.error} />

      <UnderlineTabs
        value={tab}
        onChange={(k) => {
          setTab(k);
          setOpen(null);
          setEditing(null);
        }}
        tabs={[
          { key: "drafts", label: `Drafts (${drafts.length})` },
          { key: "live", label: `On WordPress (${live.length})` },
        ]}
      />

      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Article</span>
          <span>Status</span>
          <span>Created</span>
          <span />
        </div>
        {shown.length === 0 && (
          <div className="ld-empty">
            {articles.isLoading ? "Loading..." : tab === "drafts" ? `No drafts yet. Write an article above or ask ${emp.name} in Chat.` : "Nothing on WordPress yet."}
          </div>
        )}
        {shown.map((a) => {
          const isOpen = open === a.id;
          const isEditing = editing === a.id;
          const editable = a.status !== "published";
          return (
            <React.Fragment key={a.id}>
              <div
                className={`ld-rw ${isOpen ? "open" : ""}`}
                style={{ gridTemplateColumns: COLS, cursor: "pointer" }}
                aria-expanded={isOpen}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("button,a")) return;
                  setOpen(isOpen ? null : a.id);
                  if (isOpen) setEditing(null);
                }}
              >
                <span className="ld-strong">{a.title}</span>
                <span>{STATUS[a.status] ?? a.status}</span>
                <span>{fmtDate(a.createdAt)}</span>
                {editable ? (
                  <button
                    type="button"
                    className="ld-btn"
                    onClick={() => {
                      setDraft(a.body ?? "");
                      setEditing(a.id);
                      setOpen(a.id);
                    }}
                  >
                    Edit
                  </button>
                ) : (
                  <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : a.id)}>{isOpen ? "Close" : "View"}</button>
                )}
              </div>
              {isOpen && (
                <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20 }}>
                  <div className={`ld-card ${isEditing ? "editing" : ""}`} style={{ overflow: "hidden" }}>
                    {a.imageUrl ? (
                      <img src={a.imageUrl} alt="" style={{ width: "100%", height: 180, objectFit: "cover", display: "block" }} />
                    ) : (
                      <div style={{ height: 180, background: "#2f5d8a" }} />
                    )}
                    <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 10, maxWidth: 720 }}>
                      <span style={{ fontSize: 22, fontWeight: 800 }}>{a.title}</span>
                      {isEditing ? (
                        <>
                          <label className="ld-sr" htmlFor={`article-${a.id}`}>Article</label>
                          <textarea id={`article-${a.id}`} className="ld-ta" rows={18} value={draft} onChange={(e) => setDraft(e.target.value)} />
                        </>
                      ) : (
                        <ArticleBody text={a.body ?? ""} />
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {isEditing ? (
                      <>
                        <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, itemId: a.id, body: draft })}>
                          Save
                        </button>
                        <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
                      </>
                    ) : (
                      a.status === "pending_approval" && (
                        <>
                          <button type="button" className="ld-btn p" disabled={review.isPending} onClick={() => review.mutate({ organizationId: currentOrgId, itemId: a.id, action: "approve_for_dispatch" })}>
                            Approve
                          </button>
                          <button type="button" className="ld-btn" disabled={review.isPending} onClick={() => review.mutate({ organizationId: currentOrgId, itemId: a.id, action: "request_revisions" })}>
                            Send back
                          </button>
                        </>
                      )
                    )}
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
        <div style={{ padding: "0 18px" }}>
          <ErrorLine error={save.error ?? review.error} />
        </div>
      </div>
    </main>
  );
}

/** Renders the article's markdown simply: "#" lines as headings, everything else as paragraphs. */
function ArticleBody({ text }: { text: string }) {
  const blocks: { h: boolean; text: string }[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ h: false, text: para.join(" ") });
    para = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) {
      flush();
      blocks.push({ h: true, text: m[1] });
    } else if (/^([-*]|\d+\.)\s+/.test(line)) {
      flush();
      blocks.push({ h: false, text: line });
    } else {
      para.push(line);
    }
  }
  flush();
  const clean = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
  if (blocks.length === 0) return <span className="ld-small ld-muted">Not written yet.</span>;
  return (
    <>
      {blocks.map((b, i) =>
        b.h ? (
          <span key={i} style={{ fontSize: 17, fontWeight: 800, marginTop: 6 }}>{clean(b.text)}</span>
        ) : (
          <span key={i} style={{ fontSize: 15, lineHeight: 1.65, color: "#24332c" }}>{clean(b.text)}</span>
        )
      )}
    </>
  );
}
