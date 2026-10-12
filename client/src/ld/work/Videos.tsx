import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, UnderlineTabs } from "../ui";
import { useHoursAsk } from "../HoursAsk";
import { fmtDate, parseJson } from "../meta";
import { AvatarVideosTab } from "../chat/Avatar";
import { CampaignsTab, DramaCastTab, DramaEpisodesTab, StyleTab } from "../chat/Drama";
import { MadeVideosTab } from "./MadeVideos";
import { FormatsTab } from "../video/Broll";

type Shot = { time: string; shot: string; say: string };
type VideoData = {
  trend?: { name?: string; whyItWorks?: string; sourceUrl?: string };
  plan?: { title?: string; platform?: string; lengthSeconds?: number; hook?: string; shots?: Shot[]; caption?: string };
};

const SHOT_COLS = "90px minmax(0,1.2fr) minmax(0,1.6fr)";

const short = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "");

/** Elena's Videos tab: the videos she made, her avatar, video plans from trends, episodes and campaigns. */
export default function Videos({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const studio = trpc.drama.studio.useQuery({ organizationId: currentOrgId });
  type VTab = "videos" | "formats" | "avatar" | "plans" | "episodes" | "campaigns" | "cast" | "style";
  const fromUrl = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
  const [tab, setTab] = React.useState<VTab>(fromUrl === "trends" ? "plans" : fromUrl && ["videos", "formats", "avatar", "plans", "episodes", "campaigns", "cast", "style"].includes(fromUrl) ? (fromUrl as VTab) : "videos");
  const made = trpc.videos.list.useQuery({ organizationId: currentOrgId });
  const [selected, setSelected] = React.useState<number | null>(null);

  const videos = trpc.video.list.useQuery({ organizationId: currentOrgId });
  const find = trpc.video.find.useMutation({ onSuccess: () => utils.video.invalidate() });
  const makeIt = trpc.video.makeIt.useMutation({ onSuccess: () => Promise.all([utils.videos.invalidate(), utils.video.invalidate()]) });
  const dismiss = trpc.video.dismiss.useMutation({
    onSuccess: async () => {
      setSelected(null);
      await utils.video.invalidate();
    },
  });

  const list = (videos.data ?? []).map((v) => ({ ...v, d: parseJson<VideoData>(v.data, {}) }));
  const current = list.find((v) => v.id === selected) ?? list[0] ?? null;

  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      {tab === "plans" && <div className="ld-row" style={{ justifyContent: "flex-end" }}>
        {find.data && !find.isPending && (
          <span className="ld-small ld-muted">
            {find.data.added ? `Planned ${find.data.added} from ${find.data.queries.length} searches.` : `No new trends from ${find.data.queries.length} searches.`}
          </span>
        )}
        <button type="button" className="ld-btn p" disabled={find.isPending} onClick={() => find.mutate({ organizationId: currentOrgId })}>
          {find.isPending ? "Searching..." : "Find trends"}
        </button>
      </div>}
      <ErrorLine error={find.error} />

      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "videos", label: `Videos (${made.data?.length ?? 0})` },
          { key: "formats", label: "Formats" },
          { key: "avatar", label: "Your avatar" },
          { key: "plans", label: `Video plans (${list.length})` },
          { key: "episodes", label: `Episodes (${studio.data?.episodes.length ?? 0})` },
          { key: "campaigns", label: `Campaigns (${studio.data?.campaigns.length ?? 0})` },
          { key: "cast", label: `Cast (${studio.data?.cast.length ?? 0})` },
          { key: "style", label: `Style (${studio.data?.styleRefs.length ?? 0})` },
        ]}
      />

      {tab === "videos" ? (
        <MadeVideosTab empName={emp.name} />
      ) : tab === "formats" ? (
        <FormatsTab empName={emp.name} onMade={() => setTab("videos")} />
      ) : tab === "episodes" ? (
        <DramaEpisodesTab empName={emp.name} />
      ) : tab === "campaigns" ? (
        <CampaignsTab empName={emp.name} />
      ) : tab === "cast" ? (
        <DramaCastTab />
      ) : tab === "style" ? (
        <StyleTab />
      ) : tab === "avatar" ? (
        <AvatarVideosTab empName={emp.name} />
      ) : list.length === 0 ? (
        <div className="ld-card ld-empty">{videos.isLoading ? "Loading..." : `No video plans yet. Press Find trends or ask ${emp.name} in Chat.`}</div>
      ) : (
        <>
          {list.length > 1 && (
            <div className="ld-card" style={{ padding: 10, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {list.map((v) => {
                const on = current?.id === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setSelected(v.id)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      padding: "10px 12px",
                      borderRadius: 9,
                      font: "inherit",
                      fontSize: 14,
                      border: 0,
                      background: on ? "#eef5f1" : "transparent",
                      color: "var(--ld-ink)",
                      textAlign: "left",
                      cursor: "pointer",
                      maxWidth: 320,
                    }}
                  >
                    <span className="ld-strong">{v.d.plan?.title || v.title}</span>
                    <span style={{ fontSize: 12, color: "var(--ld-muted)" }}>{fmtDate(v.createdAt)}</span>
                  </button>
                );
              })}
            </div>
          )}
          {current && (
            <PlanView
              key={current.id}
              item={current}
              onDismiss={() => dismiss.mutate({ organizationId: currentOrgId, id: current.id })}
              dismissing={dismiss.isPending}
              made={(made.data ?? []).find((m) => m.planId === current.id) ?? null}
              onMake={() => makeIt.mutate({ organizationId: currentOrgId, id: current.id }, { onSuccess: () => setTab("videos") })}
              making={makeIt.isPending}
            />
          )}
          <ErrorLine error={dismiss.error ?? makeIt.error} />
        </>
      )}
    </main>
  );
}

function PlanView({
  item,
  onDismiss,
  dismissing,
  made,
  onMake,
  making,
}: {
  item: { id: number; title: string; sourceUrl: string | null; createdAt: Date | string; d: VideoData };
  onDismiss: () => void;
  dismissing: boolean;
  /** The video already made from this plan, if any. */
  made: { statusLabel: string } | null;
  onMake: () => void;
  making: boolean;
}) {
  const hours = useHoursAsk();
  const [copied, setCopied] = React.useState(false);
  const p = item.d.plan ?? {};
  const t = item.d.trend ?? {};
  const shots = p.shots ?? [];
  const url = t.sourceUrl || item.sourceUrl;
  const meta = [p.platform, p.lengthSeconds ? `${p.lengthSeconds} seconds` : "", "vertical"].filter(Boolean).join(", ");

  const copyScript = () => {
    const text = [
      p.title || item.title,
      meta,
      p.hook ? `Hook: ${p.hook}` : "",
      ...shots.map((s) => `${s.time}  ${s.shot}\nSay: ${s.say}`),
      p.caption ? `Caption:\n${p.caption}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const sh: React.CSSProperties = { display: "grid", gridTemplateColumns: SHOT_COLS, gap: 16, padding: "12px 18px", borderBottom: "1px solid #eef2f0", fontSize: 14, lineHeight: 1.5 };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 20, alignItems: "start" }}>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-between" style={{ padding: "16px 18px", borderBottom: "1px solid var(--ld-line)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontWeight: 800, fontSize: 17 }}>{p.title || item.title}</span>
            <span className="ld-small ld-muted">{meta}</span>
          </div>
          <div className="ld-row" style={{ flexWrap: "wrap", flexShrink: 0, maxWidth: "100%" }}>
            {made ? (
              <span className="ld-pill green">{made.statusLabel === "Ready" ? "Made" : made.statusLabel}</span>
            ) : (
              <button type="button" className="ld-btn p" disabled={making} onClick={() => hours.confirm(`plan-${item.id}`, "A video uses 8 work hours for each minute of video", onMake)}>
                {making ? "Starting..." : "Make it"}
              </button>
            )}
            <button type="button" className="ld-btn" disabled={dismissing} onClick={onDismiss}>Dismiss</button>
            <button type="button" className="ld-btn" onClick={copyScript}>{copied ? "Copied" : "Copy script"}</button>
          </div>
        </div>
        {hours.question(`plan-${item.id}`) && <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--ld-line)" }}>{hours.question(`plan-${item.id}`)}</div>}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--ld-line)", display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="ld-lbl">Hook (first 2 seconds)</span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{p.hook || "Not written."}</span>
        </div>
        <div style={{ ...sh, fontSize: 12, fontWeight: 700, color: "var(--ld-muted)", textTransform: "uppercase", letterSpacing: "0.06em", paddingTop: 10, paddingBottom: 10 }}>
          <span>Time</span>
          <span>Shot</span>
          <span>Say</span>
        </div>
        {shots.length === 0 && <div className="ld-empty">No shots listed.</div>}
        {shots.map((s, i) => (
          <div key={i} style={{ ...sh, ...(i === shots.length - 1 && !p.caption ? { borderBottom: 0 } : {}) }}>
            <span className="ld-strong">{s.time}</span>
            <span>{s.shot}</span>
            <span>{s.say}</span>
          </div>
        ))}
        {p.caption && (
          <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="ld-lbl">Caption</span>
            <span className="ld-body ld-pre">{p.caption}</span>
          </div>
        )}
      </div>

      <div className="ld-card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <span className="ld-lbl">Trend this is built on</span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{t.name || "Not named"}</span>
        {t.whyItWorks && <span style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ld-text2)" }}>{t.whyItWorks}</span>}
        <span className="ld-lbl">Source</span>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{short(url)}</a>
        ) : (
          <span style={{ fontSize: 14 }}>None</span>
        )}
        <span className="ld-lbl">Found</span>
        <span style={{ fontSize: 14 }}>{fmtDate(item.createdAt)}</span>
      </div>
    </div>
  );
}
