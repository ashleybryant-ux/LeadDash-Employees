import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { useHoursAsk } from "../HoursAsk";
import { ErrorLine, FolderTabs } from "../ui";
import { uploadTo, VideoMaker } from "./VideoAgent";

/**
 * Elena's B-roll tab: every clip she made and every clip people uploaded. Elena checks this
 * library first when she builds a video, so reused clips use no work hours. Upload clips
 * (MP4 or MOV, up to 60 seconds) or ask her to make a set.
 */

type Tab = "all" | "made" | "uploaded" | "favorites";
type Size = "vertical" | "square" | "wide";

export default function Broll({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const lib = trpc.broll.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: (r) => (r.state.data?.clips.some((c) => c.status === "making") ? 10_000 : false) });
  const opts = trpc.videos.options.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const clips = lib.data?.clips ?? [];
  const [tab, setTab] = React.useState<Tab>("all");
  const [uploading, setUploading] = React.useState<string | null>(null);
  const [upErr, setUpErr] = React.useState<string | null>(null);
  const [ask, setAsk] = React.useState("");
  const [count, setCount] = React.useState(4);
  const [size, setSize] = React.useState<Size>("vertical");
  const [secs, setSecs] = React.useState<5 | 10>(5);
  const [using, setUsing] = React.useState<{ id: number; title: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const hours = useHoursAsk();
  const refresh = () => utils.broll.list.invalidate();
  const make = trpc.broll.make.useMutation({ onSuccess: async () => (setAsk(""), await refresh()) });
  const fav = trpc.broll.favorite.useMutation({ onSuccess: refresh });
  const del = trpc.broll.remove.useMutation({ onSuccess: refresh });

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUpErr(null);
    for (const f of Array.from(files)) {
      setUploading(f.name);
      try {
        await uploadTo("broll", currentOrgId, f);
        await refresh();
      } catch (err) {
        setUpErr(`${f.name}: ${err instanceof Error ? err.message : "Upload failed."}`);
      }
    }
    setUploading(null);
  };

  const shown = clips.filter((c) => (tab === "made" ? c.source === "made" : tab === "uploaded" ? c.source === "uploaded" : tab === "favorites" ? c.favorite : true));
  const clipHours = opts.data?.clipHours ?? 2;
  const each = secs === 10 ? clipHours * 2 : clipHours;
  const startMake = () => hours.confirm("broll-set", `${count} ${count === 1 ? "clip uses" : "clips use"} ${count * each} work hours (${each} each)`, () => make.mutate({ organizationId: currentOrgId, ask, count, size, seconds: secs }));

  return (
    <main className="ld-main ld-br" style={{ padding: "28px 36px" }}>
      <div className="ld-br-top">
        <div className="ld-vm-drop">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <b style={{ color: "var(--ld-ink)" }}>Upload b-roll</b>
            <span>MP4 or MOV, up to 60 seconds each. {emp.name} tags each clip so she can find it.</span>
          </div>
          <button type="button" className="ld-btn p" style={{ width: 150 }} disabled={!!uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? "Uploading..." : "Upload clips"}
          </button>
          <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" multiple hidden onChange={(e) => (upload(e.target.files), (e.target.value = ""))} />
        </div>
        <div className="ld-card ld-br-make">
          <b>Make clips</b>
          <span className="ld-small" style={{ color: "var(--ld-text2)" }}>Tell {emp.name} what you want, like "a calm therapy office, morning light." Each clip is saved here for every video after this one.</span>
          <textarea className="ld-vm-text" style={{ minHeight: 56 }} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="What should the clips show?" aria-label="What should the clips show?" />
          <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
            {[2, 4, 6, 10].map((n) => (
              <button key={n} type="button" className={`ld-chip ${count === n ? "on" : ""}`} aria-pressed={count === n} onClick={() => setCount(n)}>{`${n} clips`}</button>
            ))}
            <span className="ld-br-sep" />
            {(["vertical", "square", "wide"] as const).map((k) => (
              <button key={k} type="button" className={`ld-chip ${size === k ? "on" : ""}`} aria-pressed={size === k} onClick={() => setSize(k)}>{k === "vertical" ? "9:16" : k === "square" ? "1:1" : "16:9"}</button>
            ))}
            <span className="ld-br-sep" />
            {([5, 10] as const).map((k) => (
              <button key={k} type="button" className={`ld-chip ${secs === k ? "on" : ""}`} aria-pressed={secs === k} onClick={() => setSecs(k)}>{`${k} seconds`}</button>
            ))}
          </div>
          {hours.question("broll-set")}
          <div className="ld-between" style={{ gap: 10, flexWrap: "wrap" }}>
            <span className="ld-vm-hours">{`${each} work ${each === 1 ? "hour" : "hours"} for each clip`}</span>
            <button type="button" className="ld-btn p" style={{ width: 150 }} disabled={!ask.trim() || make.isPending || !!lib.data?.making} onClick={startMake}>
              {make.isPending ? "Planning..." : lib.data?.making ? "Making..." : "Make clips"}
            </button>
          </div>
          <ErrorLine error={make.error} />
        </div>
      </div>
      {upErr && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{upErr}</span>}
      {using && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="ld-lbl">{`A video with "${using.title}"`}</span>
          <VideoMaker key={using.id} initial={`Use my b-roll clip "${using.title}". `} onCancel={() => setUsing(null)} onPlanned={() => setUsing(null)} />
        </div>
      )}

      <FolderTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "all", label: `All ${clips.length}` },
          { key: "made", label: `Made by ${emp.name}` },
          { key: "uploaded", label: "Uploaded" },
          { key: "favorites", label: "Favorites" },
        ]}
      >
        {shown.length === 0 ? (
          <div className="ld-empty">{lib.isLoading ? "Loading..." : tab === "favorites" ? "No favorites yet. Press ★ on a clip." : `No clips yet. Upload your own, or ask ${emp.name} to make a set.`}</div>
        ) : (
          <div className="ld-br-grid">
            {shown.map((c) => (
              <div key={c.id} className="ld-br-clip">
                <div className="ld-br-ph">
                  {c.status === "ready" && c.url ? <video src={c.url} poster={c.thumbUrl ?? undefined} muted loop playsInline preload="none" onMouseEnter={(e) => e.currentTarget.play().catch(() => null)} onMouseLeave={(e) => e.currentTarget.pause()} /> : c.thumbUrl ? <img src={c.thumbUrl} alt="" /> : null}
                  {c.status === "ready" && <span className="ld-br-len">{c.length}</span>}
                  <span className="ld-br-src">{c.status === "making" ? "Making..." : c.status === "failed" ? "Didn't finish" : c.sourceLabel}</span>
                </div>
                <div className="ld-br-tx">
                  <b>{c.title}</b>
                  <span>{c.status === "failed" ? c.error ?? "It used no work hours." : [c.fits.join(" · "), c.uses ? `used in ${c.uses} ${c.uses === 1 ? "video" : "videos"}` : ""].filter(Boolean).join(" · ")}</span>
                </div>
                <div className="ld-br-bt">
                  <button type="button" className="ld-btn" disabled={c.status !== "ready"} onClick={() => setUsing({ id: c.id, title: c.title })}>Use</button>
                  <button type="button" className="ld-btn" aria-pressed={c.favorite} aria-label={c.favorite ? "Remove from favorites" : "Add to favorites"} disabled={c.status !== "ready"} onClick={() => fav.mutate({ organizationId: currentOrgId, id: c.id, favorite: !c.favorite })} style={c.favorite ? { color: "#c98a00" } : undefined}>
                    {c.favorite ? "★" : "☆"}
                  </button>
                  <button type="button" className="ld-btn danger" disabled={c.status === "making" || del.isPending} onClick={() => del.mutate({ organizationId: currentOrgId, id: c.id })}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </FolderTabs>
      <ErrorLine error={fav.error ?? del.error} />
    </main>
  );
}

/** Formats that work now: the trends Elena found, each with Recreate. */
export function FormatsTab({ empName, onMade }: { empName: string; onMade: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const list = trpc.videos.formats.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const re = trpc.videos.recreate.useMutation({ onSuccess: async () => (await Promise.all([utils.videos.list.invalidate(), utils.chat.list.invalidate()]), onMade()) });
  const rows = list.data ?? [];
  if (!rows.length) return <div className="ld-card ld-empty">{list.isLoading ? "Loading..." : `No formats yet. Press Find trends on Video plans, or ask ${empName} what's working now.`}</div>;
  return (
    <>
      <p className="ld-small" style={{ margin: 0, color: "var(--ld-text2)" }}>Recreate keeps the structure and pacing and fills it with your business.</p>
      <div className="ld-fmt-lib">
        {rows.map((f, i) => (
          <div key={f.id} className="ld-fmt-card">
            <div className={`ld-fmt-ph t${(i % 5) + 1}`}>
              <span>{f.name}</span>
            </div>
            <div className="ld-fmt-tx">
              <b>{f.title}</b>
              <span>{[f.structure, f.platform].filter(Boolean).join(" · ")}</span>
              {f.why && <span>{f.why}</span>}
            </div>
            <button type="button" className="ld-btn p" disabled={re.isPending} onClick={() => re.mutate({ organizationId: currentOrgId, planId: f.id })}>
              {re.isPending && re.variables?.planId === f.id ? "Writing..." : "Recreate"}
            </button>
          </div>
        ))}
      </div>
      <ErrorLine error={re.error} />
    </>
  );
}

/** Clips from Elena's b-roll library, for Sienna's posts and Jordan's ads: pick one and it's used as the video. */
export function BrollPicker({ onPick, onClose }: { onPick: (c: { url: string; title: string; w: number | null; h: number | null; seconds: number }) => void; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const lib = trpc.broll.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const clips = (lib.data?.clips ?? []).filter((c) => c.status === "ready" && c.url);
  return (
    <div className="ld-vm-editor" style={{ marginTop: 8 }}>
      <span className="ld-lbl">From the b-roll library</span>
      {clips.length === 0 ? (
        <span className="ld-small ld-muted">{lib.isLoading ? "Loading..." : "No clips yet. Upload some or ask Elena to make a set on her B-roll tab."}</span>
      ) : (
        <div className="ld-vm-pick">
          {clips.map((c) => (
            <button key={c.id} type="button" onClick={() => onPick({ url: c.url!, title: c.title, w: c.w, h: c.h, seconds: c.seconds })}>
              {c.thumbUrl ? <img src={c.thumbUrl} alt="" loading="lazy" /> : <span className="ld-vm-ph t1" />}
              <span>{c.title}</span>
            </button>
          ))}
        </div>
      )}
      <div>
        <button type="button" className="ld-btn" style={{ width: 130 }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
