import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { VideoCard, VideoMaker, type V } from "../video/VideoAgent";

/**
 * Elena's videos made from instructions: the Videos tab (Make a video, then rows that open in
 * place with the storyboard or the finished video) and the card in chat.
 */

const PILL: Record<V["status"], string> = { draft: "amber", making: "blue", ready: "green", failed: "red" };
const COLS = "minmax(0,2fr) 150px 110px 110px 128px";

/** Elena's Videos tab: every video she made from instructions. */
export function MadeVideosTab({ empName }: { empName: string }) {
  const { currentOrgId } = useTenant();
  const list = trpc.videos.list.useQuery({ organizationId: currentOrgId }, { refetchInterval: (r) => ((r.state.data ?? []).some((v) => v.status === "making") ? 10_000 : false) });
  const rows = (list.data ?? []) as V[];
  const [open, setOpen] = React.useState<number | null>(null);
  const [making, setMaking] = React.useState(false);
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
      ) : (
        <div className="ld-row" style={{ justifyContent: "flex-end" }}>
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
        {rows.length === 0 && <div className="ld-empty">{list.isLoading ? "Loading..." : `No videos yet. Press Make a video, or tell ${empName} in Chat what video you want.`}</div>}
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
