import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { VideoCard, VideoMaker, type V } from "../video/VideoAgent";
import { EditUpload, VideoEditor, type EV } from "../video/Editor";

/**
 * Elena's videos made from instructions: the Videos tab (Make a video, then rows that open in
 * place with the storyboard or the finished video) and the card in chat.
 */

const PILL: Record<V["status"], string> = { draft: "amber", making: "blue", ready: "green", failed: "red" };
const EDIT_PILL: Record<EV["status"], string> = { preparing: "blue", draft: "amber", making: "blue", ready: "green", failed: "red" };
const COLS = "minmax(0,2fr) 150px 110px 110px 128px";

/** Elena's Videos tab: every video she made from instructions. */
export function MadeVideosTab({ empName }: { empName: string }) {
  const { currentOrgId } = useTenant();
  const list = trpc.videos.list.useQuery({ organizationId: currentOrgId }, { refetchInterval: (r) => ((r.state.data ?? []).some((v) => v.status === "making") ? 10_000 : false) });
  const rows = (list.data ?? []) as V[];
  const edits = trpc.edits.list.useQuery({ organizationId: currentOrgId }, { refetchInterval: (r) => ((r.state.data ?? []).some((e) => e.status === "preparing" || e.status === "making" || e.step) ? 5_000 : false) });
  const editRows = (edits.data ?? []) as EV[];
  const fromUrl = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("edit")) || null : null;
  const [open, setOpen] = React.useState<number | null>(null);
  const [openEdit, setOpenEdit] = React.useState<number | null>(fromUrl);
  const [making, setMaking] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <>
      {making ? (
        <VideoMaker
          onCancel={() => setMaking(false)}
          onPlanned={(r) => {
            setMaking(false);
            if (r.kind === "video") setOpen(r.id);
          }}
        />
      ) : editing ? (
        <EditUpload
          onCancel={() => setEditing(false)}
          onStarted={(id) => {
            setEditing(false);
            setOpenEdit(id);
          }}
        />
      ) : (
        <div className="ld-row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="ld-btn" style={{ width: 150 }} onClick={() => setEditing(true)}>Edit my video</button>
          <button type="button" className="ld-btn p" style={{ width: 150 }} onClick={() => setMaking(true)}>Make a video</button>
        </div>
      )}
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd ld-mv-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Video</span>
          <span>Format</span>
          <span>Sizes</span>
          <span>Status</span>
          <span />
        </div>
        {rows.length === 0 && editRows.length === 0 && <div className="ld-empty">{list.isLoading ? "Loading..." : `No videos yet. Press Make a video or Edit my video, or tell ${empName} in Chat what video you want.`}</div>}
        {editRows.map((e) => (
          <React.Fragment key={`e${e.id}`}>
            <div className={`ld-rw ld-mv-rw ${openEdit === e.id ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
              <span className="ld-strong" style={{ overflowWrap: "anywhere" }}>{e.title}</span>
              <span>{e.parentId ? "Short clip" : "Your video"}</span>
              <span>{e.ratios.join(", ")}</span>
              <span className={`ld-pill ${EDIT_PILL[e.status]}`} style={{ justifySelf: "start" }}>{e.statusLabel}</span>
              <button type="button" className="ld-btn sm" style={{ width: 128 }} aria-expanded={openEdit === e.id} onClick={() => setOpenEdit(openEdit === e.id ? null : e.id)}>
                {openEdit === e.id ? "Close" : "Open"}
              </button>
            </div>
            {openEdit === e.id && (
              <div className="ld-mv-open">
                <VideoEditor id={e.id} onRemoved={() => setOpenEdit(null)} />
              </div>
            )}
          </React.Fragment>
        ))}
        {rows.map((v) => (
          <React.Fragment key={v.id}>
            <div className={`ld-rw ld-mv-rw ${open === v.id ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
              <span className="ld-strong" style={{ overflowWrap: "anywhere" }}>{v.title}</span>
              <span>{v.kindLabel}</span>
              <span>{v.ratios.join(", ")}</span>
              <span className={`ld-pill ${PILL[v.status]}`} style={{ justifySelf: "start" }}>{v.statusLabel}</span>
              <button type="button" className="ld-btn sm" style={{ width: 128 }} aria-expanded={open === v.id} onClick={() => setOpen(open === v.id ? null : v.id)}>
                {open === v.id ? "Close" : "Open"}
              </button>
            </div>
            {open === v.id && (
              <div className="ld-mv-open">
                <VideoCard id={v.id} bare />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </>
  );
}

/** The card under Elena's message: the storyboard, then the finished video. */
export function MadeVideoCard({ id }: { id: number }) {
  return <VideoCard id={id} />;
}
