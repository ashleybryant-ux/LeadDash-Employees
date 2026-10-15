import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { Outputs } from "../types";
import type { EmployeeRow } from "../ChatPage";
import { useHoursAsk } from "../HoursAsk";
import { ErrorLine } from "../ui";
import { fmtDate } from "../meta";
import { BrowserCard } from "../ChatPage";
import { makingStep } from "@shared/makingStep";

/**
 * Simone's Videos tab: demo and training videos of a website or app, and social "Come with me" videos.
 * - MakeForm: what to show, kind, presenter (tiles), avatar and look, where, who it's for, voice, sizes, written SOP.
 * - DemoView: the plan (every step with what she does and says, Edit in place, Start over, Record it),
 *   the recording (her live browser and the steps), and the finished video (lines, Look, Export, Written SOP)
 *   or the social video (frames, style, lines, New hook, 3 versions).
 * - DemoVideoCard: the card under Simone's message.
 */

export type DV = NonNullable<Outputs["demo"]["get"]>;
type Opts = Outputs["demo"]["options"];
type Size = "wide" | "vertical" | "square";
type Presenter = { type: "twin"; twinId: number; lookId?: number | null } | { type: "photo" } | { type: "cast"; castId: number };

const RATIO: Record<Size, string> = { wide: "16:9", vertical: "9:16", square: "1:1" };
const ASPECT: Record<Size, string> = { wide: "16 / 9", vertical: "9 / 16", square: "1 / 1" };
const SIZE_KEYS: Size[] = ["wide", "vertical", "square"];
const AUDIENCES = ["Front desk", "Clinicians", "Billing", "Admins", "Customers"];
const STYLE_SUB: Record<string, string> = {
  come: "Filmed-on-a-phone look: the avatar talks to the camera, the screen takes over with her in a bubble, then she's back for the ending.",
  tip: "Opens with \"Hey guys, quick tip\" and the problem, then the fix on screen, fast.",
  pov: "Sets the scene in one line, then the fix on screen.",
};
const hrs = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)}`;
const pillFor = (s: DV["status"]) => (s === "ready" ? "green" : s === "failed" ? "red" : s === "plan" || s === "asking" ? "amber" : "blue");

function Chip({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

// ==========================================
// Data
// ==========================================

function useDemo(id: number) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.demo.get.useQuery(
    { organizationId: currentOrgId, id },
    { enabled: currentOrgId > 0, refetchInterval: (r) => (r.state.data && ["planning", "recording", "making"].includes(r.state.data.status) ? 3000 : false) }
  );
  const refresh = async () => {
    await Promise.all([utils.demo.get.invalidate({ organizationId: currentOrgId, id }), utils.demo.list.invalidate()]);
  };
  return { orgId: currentOrgId, d: q.data ?? null, loading: q.isLoading, refresh, utils };
}

// ==========================================
// The tab
// ==========================================

export default function DemoVideosTab({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const list = trpc.demo.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: (r) => ((r.state.data ?? []).some((d) => ["planning", "recording", "making"].includes(d.status)) ? 5000 : false) });
  const fromUrl = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("video") || 0) : 0;
  const [open, setOpen] = React.useState<number | null>(fromUrl || null);
  const [making, setMaking] = React.useState(false);
  const rows = list.data ?? [];
  const show = (id: number | null) => {
    setOpen(id);
    try {
      const u = new URL(window.location.href);
      if (id) u.searchParams.set("video", String(id));
      else u.searchParams.delete("video");
      window.history.replaceState(null, "", u.toString());
    } catch {
      /* none */
    }
  };

  if (open) {
    return (
      <main className="ld-main ld-dv" style={{ padding: "24px 36px" }}>
        <button type="button" className="ld-btn" style={{ width: 130, alignSelf: "flex-start" }} onClick={() => show(null)}>All videos</button>
        <DemoView id={open} onOpen={show} />
      </main>
    );
  }

  const formOpen = making || (!list.isLoading && rows.length === 0);
  return (
    <main className="ld-main ld-dv" style={{ padding: "24px 36px" }}>
      {formOpen ? (
        <MakeForm empName={emp.name} onCancel={rows.length ? () => setMaking(false) : undefined} onStarted={(id) => (setMaking(false), show(id))} />
      ) : (
        <div className="ld-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{`${emp.name} plans every step first. Nothing is recorded until you press Record it.`}</span>
          <button type="button" className="ld-btn p" style={{ width: 150 }} onClick={() => setMaking(true)}>New video</button>
        </div>
      )}
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd ld-dv-cols">
          <span>Video</span>
          <span>Where</span>
          <span>Length</span>
          <span>Status</span>
          <span />
        </div>
        {rows.length === 0 && <div className="ld-empty">{list.isLoading ? "Loading..." : `No videos yet. Plan one above, or ask ${emp.name} in Chat.`}</div>}
        {rows.map((d) => (
          <div key={d.id} className="ld-dv-row ld-dv-cols">
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <b style={{ overflowWrap: "anywhere" }}>{d.title}</b>
              <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{d.kindLabel} · {fmtDate(d.createdAt)}</span>
            </span>
            <span className="ld-dv-where">{d.fromSopId ? "SOP" : d.where || "Not set"}</span>
            <span>{d.length}</span>
            <span><span className={`ld-pill ${pillFor(d.status)}`}>{d.statusLabel}</span></span>
            <button type="button" className="ld-btn sm" style={{ width: 128 }} onClick={() => show(d.id)}>Open</button>
          </div>
        ))}
      </div>
    </main>
  );
}

// ==========================================
// Make a demo video
// ==========================================

type Where = { kind: "login"; name: string } | { kind: "url" } | { kind: "sop" };

function MakeForm({ empName, onCancel, onStarted }: { empName: string; onCancel?: () => void; onStarted: (id: number) => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const opts = trpc.demo.options.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const sops = trpc.sops.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [ask, setAsk] = React.useState("");
  const [kind, setKind] = React.useState<"training" | "social">("training");
  const [presenter, setPresenter] = React.useState<"screen" | "corner" | "bookends">("screen");
  const [avatar, setAvatar] = React.useState<Presenter | null>(null);
  const [where, setWhere] = React.useState<Where | null>(null);
  const [url, setUrl] = React.useState("");
  const [sopId, setSopId] = React.useState<number | null>(null);
  const [sopLogin, setSopLogin] = React.useState("");
  const [signInEmail, setSignInEmail] = React.useState("");
  const [audience, setAudience] = React.useState("");
  const [voiceId, setVoiceId] = React.useState<string | null>(null);
  const [style, setStyle] = React.useState<"come" | "tip" | "pov">("come");
  const [sizes, setSizes] = React.useState<Size[]>(["wide"]);
  const [makeSop, setMakeSop] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const create = trpc.demo.create.useMutation({
    onSuccess: async (d) => {
      await utils.demo.list.invalidate();
      onStarted(d.id);
    },
    onError: (e) => setErr(e.message),
  });
  const o = opts.data;
  const logins = o?.logins ?? [];
  // The first saved login is picked to start with.
  React.useEffect(() => {
    if (!where && logins.length) setWhere({ kind: "login", name: logins[0].name });
    if (!where && o && !logins.length) setWhere({ kind: "url" });
  }, [o, logins.length, where]);
  const social = kind === "social";
  const needsAvatar = social || presenter !== "screen";
  const sop = (sops.data?.sops ?? []).find((s) => s.id === sopId) ?? null;
  const sopHasSite = !!sop && sop.sourceKind === "site" && !!sop.sourceUrl;
  const pickKind = (k: "training" | "social") => {
    setKind(k);
    setSizes(k === "social" ? ["vertical"] : ["wide"]);
  };
  // The avatar's own voice is used; for screen only, the voice picked here.
  const avatarVoice = !o || !avatar ? null : avatar.type === "photo" ? o.photo?.voiceName ?? null : avatar.type === "twin" ? `${o.twins.find((t) => t.id === avatar.twinId)?.name ?? "Your"}'s voice` : null;
  const voices = o?.voices ?? [];
  const own = voices.filter((v) => v.own);
  const stock = voices.filter((v) => !v.own).slice(0, 6);
  const shownVoice = voiceId ?? own[0]?.id ?? stock[0]?.id ?? null;

  const submit = () => {
    setErr(null);
    if (!ask.trim()) return setErr("Say what the video should show.");
    if (needsAvatar && !avatar) return setErr("Pick the avatar.");
    if (where?.kind === "url" && !url.trim()) return setErr("Add the web address.");
    if (where?.kind === "sop" && !sop) return setErr("Pick the SOP.");
    if (where?.kind === "sop" && !sopHasSite && !sopLogin) return setErr("Pick the Website login she records it in.");
    create.mutate({
      organizationId: currentOrgId,
      ask: ask.trim(),
      kind,
      presenter: social ? "bookends" : presenter,
      avatar: needsAvatar ? avatar : null,
      voiceId: needsAvatar ? null : shownVoice,
      audience,
      socialStyle: social ? style : undefined,
      loginName: where?.kind === "login" ? where.name : where?.kind === "sop" && !sopHasSite ? sopLogin : null,
      url: where?.kind === "url" ? url.trim() : null,
      fromSopId: where?.kind === "sop" ? sopId : null,
      signInEmail: where?.kind === "url" ? signInEmail.trim() || null : null,
      sizes,
      makeSop: !social && where?.kind !== "sop" && makeSop,
    });
  };

  return (
    <div className="ld-card ld-dv-make">
      <div className="ld-row" style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 17 }}>Make a demo video</b>
        <span className="ld-pill blue">Planning uses no work hours</span>
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="ld-lbl">What to show</span>
        <textarea className="ld-in ld-dv-ta" rows={6} maxLength={4000} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Show a new front desk person how to take an insurance payment" />
      </label>
      <div className="ld-dv-kv">
        <span className="ld-lbl">Kind</span>
        <div className="ld-dv-chips">
          <Chip on={!social} onClick={() => pickKind("training")}>Training video</Chip>
          <Chip on={social} onClick={() => pickKind("social")}>Social video</Chip>
        </div>
        {social && (
          <>
            <span className="ld-lbl">Style</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="ld-dv-chips">
                {(o?.styles ?? []).map((s) => (
                  <Chip key={s.key} on={style === s.key} onClick={() => setStyle(s.key as typeof style)}>{s.label}</Chip>
                ))}
              </div>
              <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{STYLE_SUB[style]}</span>
            </div>
          </>
        )}
      </div>
      {!social && <PresenterTiles value={presenter} onChange={setPresenter} opts={o ?? null} />}
      {needsAvatar && <AvatarPicker value={avatar} onChange={setAvatar} opts={o ?? null} />}
      <div className="ld-dv-kv">
        <span className="ld-lbl">Where</span>
        <div className="ld-dv-chips">
          {logins.map((l) => (
            <Chip key={l.name} on={where?.kind === "login" && where.name === l.name} onClick={() => setWhere({ kind: "login", name: l.name })}>{l.name}</Chip>
          ))}
          <Chip on={where?.kind === "url"} onClick={() => setWhere({ kind: "url" })}>A web address</Chip>
          {!social && <Chip on={where?.kind === "sop"} onClick={() => setWhere({ kind: "sop" })}>From an SOP</Chip>}
        </div>
        {where?.kind === "url" && (
          <>
            <span />
            <input className="ld-in lg" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" style={{ maxWidth: 480 }} />
            <span className="ld-lbl">Sign in as</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 480 }}>
              <input className="ld-in lg" type="email" value={signInEmail} onChange={(e) => setSignInEmail(e.target.value)} placeholder="Email (if the site needs one)" />
              <span className="ld-small" style={{ color: "var(--ld-text2)" }}>When the site sends a code, she asks for it in chat. You can also sign in for her.</span>
            </div>
          </>
        )}
        {where?.kind === "sop" && (
          <>
            <span />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
              <select className="ld-in lg" value={sopId ?? ""} onChange={(e) => setSopId(Number(e.target.value) || null)} aria-label="SOP">
                <option value="">Pick the SOP</option>
                {(sops.data?.sops ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
              {sop && !sopHasSite && (
                <select className="ld-in lg" value={sopLogin} onChange={(e) => setSopLogin(e.target.value)} aria-label="Website login">
                  <option value="">Website login to record it in</option>
                  {logins.map((l) => (
                    <option key={l.name} value={l.name}>{l.name}</option>
                  ))}
                </select>
              )}
            </div>
          </>
        )}
        <span />
        <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.45 }}>
          {`${empName} signs in with your saved Website login. LeadDash EHR is recorded in the demo practice only (demo.leaddash.io, or Maple Crest Counseling at ehr.leaddash.io), so no client information is ever in a video.`}
          {!logins.length && <> Add logins under <Link href="/integrations?tab=logins">Website logins</Link>.</>}
        </span>
        <span className="ld-lbl">Who it's for</span>
        <div className="ld-dv-chips">
          {AUDIENCES.map((a) => (
            <Chip key={a} on={audience === a} onClick={() => setAudience(audience === a ? "" : a)}>{a}</Chip>
          ))}
        </div>
        <span className="ld-lbl">Voice</span>
        {needsAvatar ? (
          <span style={{ fontSize: 13 }}>{avatar ? (avatar.type === "cast" ? "The person's own voice" : avatarVoice ?? "The avatar's voice") : "The avatar's voice"}</span>
        ) : (
          <div className="ld-dv-chips">
            {[...own, ...stock].map((v) => (
              <Chip key={v.id} on={shownVoice === v.id} onClick={() => setVoiceId(v.id)}>{v.own ? (own.length === 1 ? "My voice" : v.name) : v.name}</Chip>
            ))}
            {!voices.length && <span className="ld-small">{opts.isLoading ? "Loading..." : "No voices set up yet."}</span>}
          </div>
        )}
        <span className="ld-lbl">Sizes</span>
        <div className="ld-dv-chips">
          {SIZE_KEYS.map((s) => (
            <Chip key={s} on={sizes.includes(s)} onClick={() => setSizes(sizes.includes(s) ? (sizes.length > 1 ? sizes.filter((x) => x !== s) : sizes) : [...sizes, s])}>{RATIO[s]}</Chip>
          ))}
        </div>
        {!social && where?.kind !== "sop" && (
          <>
            <span className="ld-lbl">Also make</span>
            <div className="ld-dv-chips">
              <Chip on={makeSop} onClick={() => setMakeSop(!makeSop)}>Written SOP from the same steps</Chip>
            </div>
          </>
        )}
      </div>
      {err && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{err}</span>}
      <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="ld-btn p" style={{ width: 150 }} disabled={create.isPending} onClick={submit}>{create.isPending ? "Starting..." : "Plan the video"}</button>
        {onCancel && <button type="button" className="ld-btn" style={{ width: 150 }} onClick={onCancel}>Cancel</button>}
        <span className="ld-small" style={{ color: "var(--ld-text2)" }}>
          {`You see every step and line before she records. ${hrs(o?.screenHoursPerMinute ?? 2)} work hours for each minute of finished video${needsAvatar ? `, ${hrs(o?.avatarHoursPerMinute ?? 8)} a minute of avatar time` : ""}.`}
        </span>
      </div>
    </div>
  );
}

/** Presenter: three tiles, each a small picture of how it looks. */
function PresenterTiles({ value, onChange, opts }: { value: "screen" | "corner" | "bookends"; onChange: (v: "screen" | "corner" | "bookends") => void; opts: Opts | null }) {
  const s = hrs(opts?.screenHoursPerMinute ?? 2);
  const a = hrs(opts?.avatarHoursPerMinute ?? 8);
  const tiles = [
    { key: "screen" as const, title: "Screen only", sub: "The screen with her voice over it. Quickest to make.", hours: `${s} work hours a minute` },
    { key: "corner" as const, title: "Avatar in the corner", sub: "The avatar talks in a corner the whole way, like a trainer beside the screen.", hours: `${a} work hours a minute` },
    { key: "bookends" as const, title: "Avatar opens and closes", sub: "Full screen avatar for the intro and the wrap up, the screen with her voice in between.", hours: `${a} for avatar time, ${s} for screen time` },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="ld-lbl">Presenter</span>
      <div className="ld-dv-tiles" role="radiogroup" aria-label="Presenter">
        {tiles.map((t) => (
          <button key={t.key} type="button" role="radio" aria-checked={value === t.key} className={`ld-dv-tile ${value === t.key ? "on" : ""}`} onClick={() => onChange(t.key)}>
            <span className={`ld-dv-scr ${t.key}`} aria-hidden="true">
              {t.key !== "bookends" && (
                <>
                  <span className="side" />
                  <span className="app"><span style={{ width: "50%" }} /><span /><span style={{ width: "80%" }} /><span style={{ width: "65%" }} /></span>
                </>
              )}
              {t.key !== "screen" && <span className="face"><i /><b /></span>}
            </span>
            <b>{t.title}</b>
            <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.4 }}>{t.sub}</span>
            <span className="ld-dv-hrs">{t.hours}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Avatar: your twin(s), your photo avatar, or a made-up person from Elena's cast; then the look. */
function AvatarPicker({ value, onChange, opts }: { value: Presenter | null; onChange: (v: Presenter) => void; opts: Opts | null }) {
  const twins = opts?.twins ?? [];
  const twin = value?.type === "twin" ? twins.find((t) => t.id === value.twinId) ?? null : null;
  // The first one there is starts picked.
  React.useEffect(() => {
    if (value || !opts) return;
    if (twins[0]) onChange({ type: "twin", twinId: twins[0].id, lookId: null });
    else if (opts.photo) onChange({ type: "photo" });
    else if (opts.cast[0]) onChange({ type: "cast", castId: opts.cast[0].id });
  }, [opts, value]);
  if (!opts) return <div className="ld-dv-avbox"><span className="ld-small">Loading...</span></div>;
  return (
    <div className="ld-dv-avbox">
      <b style={{ fontSize: 15 }}>Avatar</b>
      <div className="ld-dv-avs">
        {twins.map((t) => (
          <button key={t.id} type="button" aria-pressed={twin?.id === t.id} className={`ld-dv-av ${twin?.id === t.id ? "on" : ""}`} onClick={() => onChange({ type: "twin", twinId: t.id, lookId: null })}>
            {t.thumbUrl ? <img src={t.thumbUrl} alt="" className="pic" /> : <span className="pic face" aria-hidden="true"><i /><b /></span>}
            <span><b>{twins.length > 1 ? `${t.name}'s twin` : "My twin"}</b><small>Your video and your voice</small></span>
          </button>
        ))}
        {!twins.length && (
          <Link href="/chats/video/work?tab=avatar" className="ld-dv-av new">
            <span><b>My twin</b><small>Set it up on Elena's Your avatar tab</small></span>
          </Link>
        )}
        {opts.photo && (
          <button type="button" aria-pressed={value?.type === "photo"} className={`ld-dv-av ${value?.type === "photo" ? "on" : ""}`} onClick={() => onChange({ type: "photo" })}>
            <img src={opts.photo.url} alt="" className="pic" />
            <span><b>My photo avatar</b><small>Your photo, your voice</small></span>
          </button>
        )}
        {opts.cast.map((c) => (
          <button key={c.id} type="button" aria-pressed={value?.type === "cast" && value.castId === c.id} className={`ld-dv-av ${value?.type === "cast" && value.castId === c.id ? "on" : ""}`} onClick={() => onChange({ type: "cast", castId: c.id })}>
            {c.photoUrl ? <img src={c.photoUrl} alt="" className="pic" /> : <span className="pic face" aria-hidden="true"><i /><b /></span>}
            <span><b>{c.name}</b><small>{c.look ? c.look.slice(0, 48) : "Made-up person"}</small></span>
          </button>
        ))}
        <Link href="/chats/video/work?tab=cast" className="ld-dv-av new"><b>New person</b></Link>
      </div>
      {twin && (
        <div className="ld-dv-chips" style={{ alignItems: "center" }}>
          <span className="ld-lbl" style={{ marginRight: 6 }}>Look</span>
          <Chip on={!value || value.type !== "twin" || !value.lookId} onClick={() => onChange({ type: "twin", twinId: twin.id, lookId: null })}>Original</Chip>
          {twin.looks.map((l) => (
            <Chip key={l.id} on={value?.type === "twin" && value.lookId === l.id} onClick={() => onChange({ type: "twin", twinId: twin.id, lookId: l.id })}>{l.name}</Chip>
          ))}
          <Link href="/chats/video/work?tab=avatar" className="ld-small">New look</Link>
        </div>
      )}
      <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.45 }}>Made-up people come from Elena's cast: describe one once and they look and sound the same in every video. Real clients are never used.</span>
    </div>
  );
}

// ==========================================
// One video
// ==========================================

export function DemoView({ id, onOpen }: { id: number; onOpen?: (id: number) => void }) {
  const { d, loading } = useDemo(id);
  if (!d) return <div className="ld-card ld-empty">{loading ? "Loading..." : "This video was removed."}</div>;
  if (d.status === "recording") return <Recording d={d} />;
  if (d.status === "ready" || (d.status === "making" && Object.keys(d.videoUrls).length > 0)) return d.kind === "social" ? <SocialDone d={d} onOpen={onOpen} /> : <Finished d={d} />;
  if (d.status === "making" && d.take.length > 0) return <Making d={d} />;
  return <PlanView d={d} />;
}

function Head({ d, children, sub }: { d: DV; children?: React.ReactNode; sub?: string }) {
  return (
    <div className="ld-card ld-dv-head">
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <b style={{ fontSize: 17, overflowWrap: "anywhere" }}>{d.title}</b>
        <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{sub ?? metaOf(d)}</span>
      </div>
      <div className="ld-dv-headbtns">{children}</div>
    </div>
  );
}

function metaOf(d: DV) {
  return [
    d.kindLabel,
    d.plan.steps.length ? `${d.plan.steps.length} step${d.plan.steps.length === 1 ? "" : "s"}` : null,
    d.length.toLowerCase().startsWith("about") ? d.length.toLowerCase() : d.length,
    d.kind === "social" ? d.presenterLabel : d.presenter === "screen" ? "screen only" : `${d.presenterLabel.toLowerCase()}, ${d.avatarLabel}`,
    d.where,
    d.voiceName,
    d.ratios.join(" and "),
    d.madeSop && !d.fromSopId ? "written SOP too" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function PlanView({ d }: { d: DV }) {
  const { orgId, refresh } = useDemo(d.id);
  const hours = useHoursAsk();
  const [open, setOpen] = React.useState<string | null>(null);
  const record = trpc.demo.record.useMutation({ onSuccess: refresh });
  const replan = trpc.demo.replan.useMutation({ onSuccess: refresh });
  const answer = trpc.demo.answer.useMutation({ onSuccess: refresh });
  const remove = trpc.demo.remove.useMutation({ onSuccess: refresh });
  const build = trpc.demo.buildRecorded.useMutation({ onSuccess: refresh });
  const busy = d.status === "planning" || d.status === "making";
  // A recording that stopped part way: what's recorded is kept, and she can keep going or build from it.
  const partial = d.recordedUpTo > 0;
  const go = (keepGoing = false) => {
    const run = () => record.mutate({ organizationId: orgId, id: d.id, keepGoing });
    if (d.estimateMinutes >= 180) hours.confirm(`rec-${d.id}`, `This video uses ${d.hours}`, run);
    else run();
  };
  return (
    <>
      <Head d={d}>
        {d.status === "plan" || d.status === "failed" ? (
          <>
            {d.plan.steps.length > 0 && <span className="ld-pill amber">Uses {d.hours.replace("No work hours", "no work hours")}</span>}
            <button type="button" className="ld-btn" style={{ width: 140 }} disabled={replan.isPending} onClick={() => replan.mutate({ organizationId: orgId, id: d.id })}>Start over</button>
            {partial ? (
              <>
                <button type="button" className="ld-btn" style={{ width: 140 }} disabled={record.isPending || build.isPending} onClick={() => go(false)}>Record again</button>
                <button type="button" className="ld-btn" style={{ width: 140 }} disabled={record.isPending || build.isPending} onClick={() => build.mutate({ organizationId: orgId, id: d.id })}>{build.isPending ? "Starting..." : "Stop and build"}</button>
                <button type="button" className="ld-btn p" style={{ width: 140 }} disabled={record.isPending || build.isPending} onClick={() => go(true)}>{record.isPending ? "Starting..." : "Keep going"}</button>
              </>
            ) : (
              d.plan.steps.length > 0 && <button type="button" className="ld-btn p" style={{ width: 140 }} disabled={record.isPending} onClick={() => go(false)}>{record.isPending ? "Starting..." : "Record it"}</button>
            )}
          </>
        ) : d.status === "asking" ? (
          <span className="ld-pill amber">Question</span>
        ) : (
          <span className="ld-pill blue">{d.statusLabel}</span>
        )}
      </Head>
      {hours.question(`rec-${d.id}`)}
      {busy && <div className="ld-card ld-dv-busy"><span className="ld-dv-spin" aria-hidden="true" />{d.step ?? "Working"}...</div>}
      {d.asking && <SignInBox d={d} />}
      {d.status === "planning" && d.liveId && <BrowserCard card={{ type: "browser_live", id: 0, title: "Simone's browser", url: d.liveId }} />}
      {d.error && <div className={`ld-card ${partial ? "ld-dv-kept" : "ld-dv-err"}`}>{d.error}</div>}
      <ErrorLine error={record.error ?? replan.error ?? answer.error ?? remove.error ?? build.error} />
      {d.status === "asking" && d.plan.question && (
        <div className="ld-card ld-dv-q">
          <b>{d.plan.question.text}</b>
          <div className="ld-dv-chips">
            {d.plan.question.options.map((o) => (
              <button key={o} type="button" className="ld-btn" disabled={answer.isPending} onClick={() => answer.mutate({ organizationId: orgId, id: d.id, option: o })}>{o}</button>
            ))}
          </div>
        </div>
      )}
      {d.plan.steps.length > 0 && (
        <div className="ld-card" style={{ overflow: "hidden" }}>
          <div className="ld-hd ld-dv-plan">
            <span>Step</span>
            <span>What she does</span>
            <span>What she says</span>
            <span />
          </div>
          <InfoRow d={d} k="intro" label={d.kind === "social" ? "Hook" : "Opening"} open={open === "intro"} onToggle={() => setOpen(open === "intro" ? null : "intro")} locked={busy} />
          {d.plan.steps.map((s, i) => (
            <StepRow key={i} d={d} n={i} open={open === `s${i}`} onToggle={() => setOpen(open === `s${i}` ? null : `s${i}`)} locked={busy} />
          ))}
          <InfoRow d={d} k="outro" label={d.kind === "social" ? "Ending" : "Closing"} open={open === "outro"} onToggle={() => setOpen(open === "outro" ? null : "outro")} locked={busy} />
        </div>
      )}
      {d.plan.steps.length > 0 && (
        <div className="ld-card ld-dv-where">
          <span className="ld-lbl">Starts on</span>
          <span>{d.plan.startsOn || "The first page after signing in"}</span>
          <span className="ld-lbl">Done when</span>
          <span>{d.plan.doneWhen || "The last step's result is on screen"}</span>
          {d.plan.needs.length > 0 && (
            <>
              <span className="ld-lbl">Needs first</span>
              <span>{d.plan.needs.join("; ")}</span>
            </>
          )}
        </div>
      )}
      {(d.status === "plan" || d.status === "failed" || d.status === "asking") && (
        <div>
          <button type="button" className="ld-btn" style={{ width: 140 }} disabled={remove.isPending} onClick={() => window.confirm("Delete this video plan?") && remove.mutate({ organizationId: orgId, id: d.id })}>Delete</button>
        </div>
      )}
    </>
  );
}

function StepRow({ d, n, open, onToggle, locked }: { d: DV; n: number; open: boolean; onToggle: () => void; locked: boolean }) {
  const { orgId, refresh } = useDemo(d.id);
  const s = d.plan.steps[n];
  const [form, setForm] = React.useState({ do: s.do, say: s.say });
  const save = trpc.demo.saveStep.useMutation({ onSuccess: async () => (await refresh(), onToggle()) });
  React.useEffect(() => setForm({ do: s.do, say: s.say }), [open]);
  return (
    <>
      <div className={`ld-dv-plan ld-dv-prow ${open ? "open" : ""}`}>
        <span className={`ld-dv-n ${open ? "on" : ""}`}>{n + 1}</span>
        <span>
          {s.do}
          {d.recordedUpTo > 0 && (n < d.recordedUpTo ? <span className="ld-pill green ld-dv-rec">Recorded</span> : <span className="ld-pill ld-dv-rec">Not yet</span>)}
        </span>
        <span>{s.say}</span>
        <button type="button" className="ld-btn sm" disabled={locked} onClick={onToggle}>{open ? "Close" : "Edit"}</button>
      </div>
      {d.recordedUpTo > 0 && n < d.recordedUpTo && d.take[n]?.shot && !open && (
        <div className="ld-dv-shotrow"><img src={d.take[n].shot!} alt={`Step ${n + 1} as recorded`} className="ld-dv-shot" /></div>
      )}
      {open && (
        <div className="ld-dv-pedit">
          <div className="ld-dv-pform">
            <span className="ld-lbl">What she does</span>
            <input className="ld-in lg" value={form.do} onChange={(e) => setForm({ ...form, do: e.target.value })} />
            <span className="ld-lbl">What she says</span>
            <textarea className="ld-in ld-dv-ta" rows={2} value={form.say} onChange={(e) => setForm({ ...form, say: e.target.value })} />
            <span />
            <div className="ld-row" style={{ gap: 8 }}>
              <button type="button" className="ld-btn p sm" disabled={save.isPending || !form.do.trim()} onClick={() => save.mutate({ organizationId: orgId, id: d.id, n, do: form.do, say: form.say })}>{save.isPending ? "Saving..." : "Save"}</button>
              <button type="button" className="ld-btn sm" onClick={onToggle}>Cancel</button>
            </div>
          </div>
          <ErrorLine error={save.error} />
        </div>
      )}
    </>
  );
}

function InfoRow({ d, k, label, open, onToggle, locked }: { d: DV; k: "intro" | "outro"; label: string; open: boolean; onToggle: () => void; locked: boolean }) {
  const { orgId, refresh } = useDemo(d.id);
  const text = d.plan[k];
  const [val, setVal] = React.useState(text);
  const save = trpc.demo.savePlanInfo.useMutation({ onSuccess: async () => (await refresh(), onToggle()) });
  React.useEffect(() => setVal(text), [open]);
  return (
    <>
      <div className={`ld-dv-plan ld-dv-prow ${open ? "open" : ""}`}>
        <span className="ld-dv-k">{label}</span>
        <span className="ld-muted">{k === "intro" ? (d.avatarLines.includes("intro") ? "The avatar, to camera" : "Title card") : d.avatarLines.includes("outro") ? "The avatar, to camera" : "Last screen"}</span>
        <span>{text || <span className="ld-muted">None</span>}</span>
        <button type="button" className="ld-btn sm" disabled={locked} onClick={onToggle}>{open ? "Close" : "Edit"}</button>
      </div>
      {open && (
        <div className="ld-dv-pedit">
          <div className="ld-dv-pform">
            <span className="ld-lbl">What she says</span>
            <textarea className="ld-in ld-dv-ta" rows={2} value={val} onChange={(e) => setVal(e.target.value)} />
            <span />
            <div className="ld-row" style={{ gap: 8 }}>
              <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: d.id, [k]: val })}>{save.isPending ? "Saving..." : "Save"}</button>
              <button type="button" className="ld-btn sm" onClick={onToggle}>Cancel</button>
            </div>
          </div>
          <ErrorLine error={save.error} />
        </div>
      )}
    </>
  );
}

// ==========================================
// Recording
// ==========================================

function Recording({ d }: { d: DV }) {
  const { currentOrgId } = useTenant();
  const live = trpc.browser.live.useQuery({ organizationId: currentOrgId }, { refetchInterval: 1000 });
  const stop = trpc.browser.stop.useMutation();
  const started = React.useRef(Date.now());
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const l = live.data;
  const cur = Math.max(1, Math.min(d.plan.steps.length, l?.plan || 1));
  const secs = Math.floor((Date.now() - started.current) / 1000);
  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const redo = /again/i.test(d.step ?? "");
  return (
    <>
      <div className="ld-dv-rechd">
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <b style={{ fontSize: 17, overflowWrap: "anywhere" }}>{d.title}</b>
          <span className="ld-small" style={{ color: "var(--ld-text2)", display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="ld-dv-rec"><span className="dot" aria-hidden="true" />REC {mm}</span>
            {`Simone is ${redo ? (d.step ?? "recording").toLowerCase() : "recording"}${d.where ? ` in ${d.where}` : ""} · step ${cur} of ${d.plan.steps.length}`}
          </span>
        </div>
        <button type="button" className="ld-btn" style={{ width: 140 }} disabled={!l?.id || stop.isPending} onClick={() => l?.id && stop.mutate({ organizationId: currentOrgId, id: l.id })}>{stop.isPending ? "Stopping..." : "Stop"}</button>
      </div>
      <div className="ld-dv-recgrid">
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          {d.asking && <SignInBox d={d} />}
          {d.liveId || l?.id ? (
            <BrowserCard card={{ type: "browser_live", id: 0, title: "Simone's browser", url: d.liveId ?? l!.id }} />
          ) : (
            <div className="ld-card ld-dv-screen">
              <div className="ld-dv-frame"><span className="ld-muted">Opening the browser</span></div>
            </div>
          )}
        </div>
        <div className="ld-card ld-dv-steps">
          <b style={{ fontSize: 15, marginBottom: 6 }}>Steps</b>
          {d.plan.steps.map((s, i) => {
            const state = i + 1 < cur ? "done" : i + 1 === cur ? "now" : "next";
            return (
              <div key={i} className={`ld-dv-st ${state}`}>
                <span className="dot">{state === "done" ? "✓" : i + 1}</span>
                {state === "now" ? <b>{s.do}</b> : <span>{s.do}</span>}
              </div>
            );
          })}
          <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.45, marginTop: "auto", paddingTop: 10 }}>If the site sends a sign-in code, she asks you for it here and in chat, and waits. You can also take over and sign in for her. If a screen doesn't match the plan, she stops instead of guessing.</span>
        </div>
      </div>
      <ErrorLine error={stop.error} />
    </>
  );
}

// ==========================================
// Making: after the recording, while the lines are read and the video is cut
// ==========================================

function Making({ d }: { d: DV }) {
  const total = d.plan.steps.length;
  const at = makingStep(d.step, total);
  const cur = at === null ? 0 : at === "all" ? total + 1 : at;
  const shot = (at === "all" || at === null ? d.take[d.take.length - 1] : d.take[at - 1])?.shot ?? null;
  const stage = at === "all" && /^Making/i.test(d.step ?? "") ? "Cutting the video" : "Reading the lines";
  return (
    <>
      <div className="ld-dv-rechd">
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <b style={{ fontSize: 17, overflowWrap: "anywhere" }}>{d.title}</b>
          <span className="ld-small" style={{ color: "var(--ld-text2)", display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="ld-dv-spin" aria-hidden="true" />
            {`Recorded ${d.take.length} of ${total} steps · ${stage}${at !== null && at !== "all" ? ` · step ${at} of ${total}` : ""}`}
          </span>
        </div>
        <span className="ld-pill blue">Making</span>
      </div>
      <div className="ld-dv-recgrid">
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div className="ld-card ld-dv-screen">
            <div className="ld-dv-frame">{shot ? <img src={shot} alt="" /> : <span className="ld-muted">{d.step ?? "Making it"}...</span>}</div>
          </div>
          <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{d.step ?? "Making it"}...</span>
        </div>
        <div className="ld-card ld-dv-steps">
          <b style={{ fontSize: 15, marginBottom: 6 }}>Steps</b>
          {d.plan.steps.map((s, i) => {
            const state = i + 1 < cur ? "done" : i + 1 === cur ? "now" : "next";
            return (
              <div key={i} className={`ld-dv-st ${state}`}>
                <span className="dot">{state === "done" ? "✓" : i + 1}</span>
                {state === "now" ? <b>{s.do}</b> : <span>{s.do}</span>}
              </div>
            );
          })}
          <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.45, marginTop: "auto", paddingTop: 10 }}>Every step is recorded. Simone is reading each line in her voice, then cutting the video. The player appears here when it is ready.</span>
        </div>
      </div>
      {d.error && <div className="ld-card ld-dv-err">{d.error}</div>}
    </>
  );
}

// ==========================================
// Finished: training video
// ==========================================

function useShown(d: DV) {
  const made = d.sizes.filter((s) => d.videoUrls[s as Size]) as Size[];
  const [size, setSize] = React.useState<Size | null>(null);
  const shown: Size = size && d.videoUrls[size] ? size : made[0] ?? (d.sizes[0] as Size) ?? "wide";
  return { made, shown, setSize, url: d.videoUrls[shown] ?? d.videoUrl ?? null };
}

function Player({ url, size, max }: { url: string | null; size: Size; max?: number }) {
  return (
    <div className="ld-dv-player" style={{ aspectRatio: ASPECT[size], maxWidth: max }}>
      {url ? <video key={url} src={`${url}#t=0.1`} controls playsInline preload="metadata" /> : <span className="ld-muted">Making it</span>}
    </div>
  );
}

function Finished({ d }: { d: DV }) {
  const { orgId, refresh } = useDemo(d.id);
  const { made, shown, setSize, url } = useShown(d);
  const [open, setOpen] = React.useState<string | null>(null);
  const making = d.status === "making";
  return (
    <>
      <Head d={d} sub={[d.length, d.ratios.join(" and "), d.where, `made ${fmtDate(d.updatedAt)}`].filter(Boolean).join(" · ")}>
        <span className={`ld-pill ${making ? "blue" : "green"}`}>{making ? "Making" : "Ready"}</span>
      </Head>
      {making && <div className="ld-card ld-dv-busy"><span className="ld-dv-spin" aria-hidden="true" />{d.step ?? "Making it again"}...</div>}
      {d.error && <div className="ld-card ld-dv-err">{d.error}</div>}
      <div className="ld-dv-done">
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <Player url={url} size={shown} />
          {made.length > 1 && (
            <div className="ld-dv-chips" role="radiogroup" aria-label="Size shown">
              {made.map((s) => (
                <Chip key={s} on={shown === s} onClick={() => setSize(s)}>{RATIO[s]}</Chip>
              ))}
            </div>
          )}
          <div className="ld-card" style={{ overflow: "hidden" }}>
            {d.lines.map((ln) => (
              <LineRow key={ln.key} d={d} ln={ln} open={open === ln.key} onToggle={() => setOpen(open === ln.key ? null : ln.key)} locked={making} onDone={refresh} orgId={orgId} />
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <LookSec d={d} locked={making} />
          <ExportSec d={d} url={url} shown={shown} locked={making} />
          {d.sopId && (
            <div className="ld-card ld-vm-sec">
              <div className="ld-vm-sec-hd"><b>Written SOP</b><span className="ld-pill amber">In review</span></div>
              <span className="ld-small" style={{ lineHeight: 1.45 }}>{`${d.title}: ${d.plan.steps.length} steps, a screenshot under each, this video at the top.`}</span>
              <Link href={`/handbook/sop/${d.sopId}`} className="ld-btn" style={{ width: "100%" }}>Open SOP</Link>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

type Ln = DV["lines"][number];

function LineRow({ d, ln, open, onToggle, locked, onDone, orgId }: { d: DV; ln: Ln; open: boolean; onToggle: () => void; locked: boolean; onDone: () => Promise<void>; orgId: number }) {
  const [val, setVal] = React.useState(ln.text);
  const edit = trpc.demo.editLine.useMutation({ onSuccess: async () => (await onDone(), onToggle()) });
  const redo = trpc.demo.redoStep.useMutation({ onSuccess: async () => (await onDone(), onToggle()) });
  React.useEffect(() => setVal(ln.text), [open]);
  const isStep = ln.key.startsWith("s");
  const avatarLine = d.avatarLines.includes(ln.key);
  const shot = "shot" in ln ? (ln.shot as string | null) : null;
  return (
    <>
      <div className={`ld-dv-lrow ${open ? "open" : ""}`}>
        {shot ? <img src={shot} alt="" className="th" /> : <span className="th" aria-hidden="true" />}
        <b>{ln.label}</b>
        <span>{ln.text || <span className="ld-muted">None</span>}</span>
        <button type="button" className="ld-btn" style={{ width: 112 }} disabled={locked} onClick={onToggle}>{open ? "Close" : "Edit line"}</button>
      </div>
      {open && (
        <div className="ld-dv-ledit">
          <div className="box">
            <span className="ld-lbl">What she says</span>
            <textarea className="ld-in ld-dv-ta" rows={2} value={val} onChange={(e) => setVal(e.target.value)} />
            <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{avatarLine ? "This line's voice and the avatar are made again. Avatar time uses work hours." : "Only this line's voice is made again. No work hours."}</span>
            <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="ld-btn p" style={{ width: 112 }} disabled={edit.isPending || !val.trim()} onClick={() => edit.mutate({ organizationId: orgId, id: d.id, key: ln.key, text: val })}>{edit.isPending ? "Saving..." : "Save"}</button>
              <button type="button" className="ld-btn" style={{ width: 112 }} onClick={onToggle}>Cancel</button>
              {isStep && (
                <button type="button" className="ld-btn" style={{ width: 112, marginLeft: "auto" }} disabled={redo.isPending} onClick={() => redo.mutate({ organizationId: orgId, id: d.id, n: Number(ln.key.slice(1)) })}>Redo step</button>
              )}
            </div>
            <ErrorLine error={edit.error ?? redo.error} />
          </div>
        </div>
      )}
    </>
  );
}

const TRACKS = [
  { key: "none", label: "Off" },
  { key: "calm", label: "Calm pulse" },
  { key: "upbeat", label: "Upbeat" },
  { key: "piano", label: "Warm piano" },
] as const;

function LookSec({ d, locked }: { d: DV; locked: boolean }) {
  const { orgId, refresh } = useDemo(d.id);
  const [editing, setEditing] = React.useState(false);
  const [f, setF] = React.useState(d.look);
  const save = trpc.demo.changeLook.useMutation({ onSuccess: async () => (await refresh(), setEditing(false)) });
  const open = () => (setF(d.look), setEditing(true));
  const l = d.look;
  return (
    <div className={`ld-card ld-vm-sec ${editing ? "editing" : ""}`}>
      <div className="ld-vm-sec-hd">
        <b>Look</b>
        {!editing && <button type="button" className="ld-btn sm" disabled={locked} onClick={open}>Edit</button>}
      </div>
      {!editing ? (
        <div className="ld-dv-lkv">
          <span>Clicks</span>
          <span>{l.zoom ? "Zoom in with a gold ring" : "No zoom"}</span>
          <span>Captions</span>
          <span>{l.captions.on ? `On, ${l.captions.position}` : "Off"}</span>
          <span>Intro</span>
          <span>{l.cards ? `Title card${l.logo ? " with your logo" : ""}` : "Straight to the screen"}</span>
          <span>Logo</span>
          <span>{l.logo ? "In the corner" : "Off"}</span>
          <span>Music</span>
          <span>{TRACKS.find((t) => t.key === l.music.track)?.label ?? "Off"}</span>
        </div>
      ) : (
        <div className="ld-dv-lkv edit">
          <span>Clicks</span>
          <div className="ld-dv-chips"><Chip on={f.zoom} onClick={() => setF({ ...f, zoom: true })}>Zoom</Chip><Chip on={!f.zoom} onClick={() => setF({ ...f, zoom: false })}>No zoom</Chip></div>
          <span>Captions</span>
          <div className="ld-dv-chips">
            <Chip on={!f.captions.on} onClick={() => setF({ ...f, captions: { ...f.captions, on: false } })}>Off</Chip>
            <Chip on={f.captions.on && f.captions.position === "bottom"} onClick={() => setF({ ...f, captions: { on: true, position: "bottom" } })}>Bottom</Chip>
            <Chip on={f.captions.on && f.captions.position === "top"} onClick={() => setF({ ...f, captions: { on: true, position: "top" } })}>Top</Chip>
          </div>
          <span>Intro</span>
          <div className="ld-dv-chips"><Chip on={f.cards} onClick={() => setF({ ...f, cards: true })}>Title card</Chip><Chip on={!f.cards} onClick={() => setF({ ...f, cards: false })}>None</Chip></div>
          <span>Logo</span>
          <div className="ld-dv-chips"><Chip on={f.logo} onClick={() => setF({ ...f, logo: true })}>On</Chip><Chip on={!f.logo} onClick={() => setF({ ...f, logo: false })}>Off</Chip></div>
          <span>Music</span>
          <div className="ld-dv-chips">
            {TRACKS.map((t) => (
              <Chip key={t.key} on={f.music.track === t.key} onClick={() => setF({ ...f, music: { ...f.music, track: t.key } })}>{t.label}</Chip>
            ))}
          </div>
          <span />
          <div className="ld-row" style={{ gap: 8 }}>
            <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: d.id, zoom: f.zoom, cards: f.cards, logo: f.logo, captions: f.captions, music: { track: f.music.track, volume: f.music.volume } })}>{save.isPending ? "Saving..." : "Save"}</button>
            <button type="button" className="ld-btn sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
      {editing && <span className="ld-small" style={{ color: "var(--ld-text2)" }}>It's cut again with the new look. No work hours.</span>}
      <ErrorLine error={save.error} />
    </div>
  );
}

function ExportSec({ d, url, shown, locked }: { d: DV; url: string | null; shown: Size; locked: boolean }) {
  const { orgId, refresh } = useDemo(d.id);
  const [copied, setCopied] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const sizes = trpc.demo.setSizes.useMutation({ onSuccess: refresh });
  const sienna = trpc.demo.toSienna.useMutation({ onSuccess: () => setSent(true) });
  const cur = d.sizes as Size[];
  const toggle = (s: Size) => {
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
    if (next.length) sizes.mutate({ organizationId: orgId, id: d.id, sizes: next });
  };
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(new URL(url, window.location.origin).toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* none */
    }
  };
  return (
    <div className="ld-card ld-vm-sec">
      <div className="ld-vm-sec-hd"><b>Export</b></div>
      <div className="ld-dv-lkv">
        <span>Sizes</span>
        <div className="ld-dv-chips">
          {SIZE_KEYS.map((s) => (
            <Chip key={s} on={cur.includes(s)} disabled={locked || sizes.isPending} onClick={() => toggle(s)}>{RATIO[s]}</Chip>
          ))}
        </div>
      </div>
      <span className="ld-small" style={{ color: "var(--ld-text2)" }}>A new size is cut from the same recording. No work hours.</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {url ? <a className="ld-btn p" style={{ width: "100%" }} href={url} download={`${d.title} ${RATIO[shown].replace(":", "x")}.mp4`}>Download</a> : <button type="button" className="ld-btn p" style={{ width: "100%" }} disabled>Download</button>}
        <button type="button" className="ld-btn" style={{ width: "100%" }} disabled={!url} onClick={copy}>{copied ? "Link copied" : "Copy link"}</button>
        <button type="button" className="ld-btn" style={{ width: "100%" }} disabled={sienna.isPending || sent || !url} onClick={() => sienna.mutate({ organizationId: orgId, id: d.id })}>{sent ? "Sent to Sienna" : sienna.isPending ? "Sending..." : "Send to Sienna"}</button>
      </div>
      {copied && <span className="ld-small" style={{ color: "var(--ld-text2)" }}>Anyone on your workspace can open the link.</span>}
      {sent && <span className="ld-small">It's in Sienna's drafts with a caption. <Link href="/chats/social/work">Open her posts</Link></span>}
      <ErrorLine error={sizes.error ?? sienna.error} />
    </div>
  );
}

// ==========================================
// Finished: social video
// ==========================================

function SocialDone({ d, onOpen }: { d: DV; onOpen?: (id: number) => void }) {
  const { orgId, refresh, utils } = useDemo(d.id);
  const { shown, url } = useShown(d);
  const [open, setOpen] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);
  const hours = useHoursAsk();
  const hook = trpc.demo.newHook.useMutation({ onSuccess: refresh });
  const versions = trpc.demo.versions.useMutation({ onSuccess: () => utils.demo.list.invalidate() });
  const sienna = trpc.demo.toSienna.useMutation({ onSuccess: () => setSent(true) });
  const making = d.status === "making";
  const steps = d.lines.filter((l) => l.key.startsWith("s"));
  // The frames: the hook, two screens with the bubble, the ending.
  const frames = [
    { k: "Hook", clip: d.clips.intro, shot: null as string | null, text: d.lines[0]?.text ?? "" },
    ...[steps[0], steps[Math.max(1, steps.length - 1)]].filter(Boolean).filter((s, i, a) => a.indexOf(s) === i).map((s) => ({ k: "Screen", clip: null, shot: ("shot" in s! ? (s!.shot as string | null) : null), text: s!.text })),
    { k: "Ending", clip: d.clips.outro, shot: null, text: d.lines[d.lines.length - 1]?.text ?? "" },
  ];
  return (
    <>
      <Head d={d} sub={`Social video · ${d.ratios.join(" and ")} · ${d.length} · ${d.avatarLabel}, then the screen, then back`}>
        <span className={`ld-pill ${making ? "blue" : "green"}`}>{making ? "Making" : "Ready"}</span>
        {url ? <a className="ld-btn" style={{ width: 140 }} href={url} download={`${d.title} ${RATIO[shown].replace(":", "x")}.mp4`}>Download</a> : null}
        <button type="button" className="ld-btn p" style={{ width: 140 }} disabled={sienna.isPending || sent || !url} onClick={() => sienna.mutate({ organizationId: orgId, id: d.id })}>{sent ? "Sent to Sienna" : sienna.isPending ? "Sending..." : "Send to Sienna"}</button>
      </Head>
      {making && <div className="ld-card ld-dv-busy"><span className="ld-dv-spin" aria-hidden="true" />{d.step ?? "Making it again"}...</div>}
      {d.error && <div className="ld-card ld-dv-err">{d.error}</div>}
      {sent && <span className="ld-small">It's in Sienna's drafts with a caption. <Link href="/chats/social/work">Open her posts</Link></span>}
      <ErrorLine error={hook.error ?? versions.error ?? sienna.error} />
      <div className="ld-dv-social">
        <div className="ld-card ld-dv-frames">
          <div className="ld-dv-framerow">
            {frames.map((f, i) => (
              <div key={i} className="ld-dv-fr">
                <span className="ph">
                  {f.clip ? <video src={`${f.clip}#t=0.5`} muted playsInline preload="metadata" /> : f.shot ? <img src={f.shot} alt="" /> : null}
                  <span className="cap">{f.text}</span>
                </span>
                <span className="k">{f.k}</span>
              </div>
            ))}
          </div>
          <Player url={url} size={shown} max={320} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div className="ld-card ld-vm-sec">
            <div className="ld-vm-sec-hd"><b>Style</b></div>
            <div className="ld-dv-chips"><span className="ld-chip on" aria-current="true" style={{ display: "inline-flex", alignItems: "center" }}>{d.presenterLabel}</span></div>
            <span className="ld-small" style={{ color: "var(--ld-text2)", lineHeight: 1.45 }}>{STYLE_SUB[d.socialStyle] ?? STYLE_SUB.come}</span>
          </div>
          <div className="ld-card" style={{ overflow: "hidden" }}>
            {d.lines.map((ln, i) => (
              <SocialLine key={ln.key} d={d} ln={ln} label={i === 0 ? "Hook" : i === d.lines.length - 1 ? "Ending" : "Screen"} open={open === ln.key} onToggle={() => setOpen(open === ln.key ? null : ln.key)} locked={making} orgId={orgId} onDone={refresh} />
            ))}
          </div>
          <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="ld-btn" style={{ width: 140 }} disabled={making || hook.isPending} onClick={() => hours.confirm(`hook-${d.id}`, "A new hook uses avatar time", () => hook.mutate({ organizationId: orgId, id: d.id }))}>{hook.isPending ? "Writing..." : "New hook"}</button>
            <button type="button" className="ld-btn" style={{ width: 140 }} disabled={making || versions.isPending} onClick={() => hours.confirm(`ver-${d.id}`, "2 more versions use avatar time for their hooks", () => versions.mutate({ organizationId: orgId, id: d.id }))}>{versions.isPending ? "Writing..." : "3 versions"}</button>
          </div>
          {hours.question(`hook-${d.id}`)}
          {hours.question(`ver-${d.id}`)}
          {versions.data && (
            <span className="ld-small">
              2 more versions are being made:{" "}
              {versions.data.map((vid, i) => (
                <React.Fragment key={vid}>
                  {i > 0 && ", "}
                  <button type="button" className="ld-linkbtn" onClick={() => onOpen?.(vid)}>{`version ${i + 2}`}</button>
                </React.Fragment>
              ))}
              .
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function SocialLine({ d, ln, label, open, onToggle, locked, orgId, onDone }: { d: DV; ln: Ln; label: string; open: boolean; onToggle: () => void; locked: boolean; orgId: number; onDone: () => Promise<void> }) {
  const [val, setVal] = React.useState(ln.text);
  const edit = trpc.demo.editLine.useMutation({ onSuccess: async () => (await onDone(), onToggle()) });
  React.useEffect(() => setVal(ln.text), [open]);
  return (
    <>
      <div className="ld-dv-sline">
        <span className="k">{label}</span>
        <span>{ln.text}</span>
        <button type="button" className="ld-btn sm" disabled={locked} onClick={onToggle}>{open ? "Close" : "Edit"}</button>
      </div>
      {open && (
        <div className="ld-dv-ledit">
          <div className="box">
            <textarea className="ld-in ld-dv-ta" rows={2} value={val} onChange={(e) => setVal(e.target.value)} aria-label={`${label} line`} />
            <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{d.avatarLines.includes(ln.key) ? "The avatar says it again. Avatar time uses work hours." : "Only this line's voice is made again. No work hours."}</span>
            <div className="ld-row" style={{ gap: 8 }}>
              <button type="button" className="ld-btn p sm" disabled={edit.isPending || !val.trim()} onClick={() => edit.mutate({ organizationId: orgId, id: d.id, key: ln.key, text: val })}>{edit.isPending ? "Saving..." : "Save"}</button>
              <button type="button" className="ld-btn sm" onClick={onToggle}>Cancel</button>
            </div>
            <ErrorLine error={edit.error} />
          </div>
        </div>
      )}
    </>
  );
}

// ==========================================
// Signing her in
// ==========================================

/** What she's waiting on: the code the site sent, or the email to sign in as. */
export function SignInBox({ d }: { d: DV }) {
  const { orgId, refresh } = useDemo(d.id);
  const [code, setCode] = React.useState("");
  const [email, setEmail] = React.useState(d.signInEmail ?? "");
  const send = trpc.demo.signIn.useMutation({ onSuccess: refresh });
  const forCode = d.asking === "code";
  const ok = forCode ? code.trim().length >= 4 : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const go = () => ok && send.mutate({ organizationId: orgId, id: d.id, ...(forCode ? { code: code.trim() } : { email: email.trim() }) });
  return (
    <div className="ld-card ld-dv-signin">
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <b style={{ fontSize: 15 }}>{forCode ? "The site sent a sign-in code" : "Who should she sign in as?"}</b>
        <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{forCode ? "Check the email or phone it went to and enter it here. Or take over below and sign in for her." : "Enter the email she signs in with. Or take over below and sign in for her."}</span>
        {send.isSuccess ? (
          <span className="ld-pill green" style={{ alignSelf: "flex-start" }}>{forCode ? "Got it. Typing it in now" : "Got it. Signing in now"}</span>
        ) : forCode ? (
          <input className="ld-in lg" inputMode="numeric" autoComplete="one-time-code" maxLength={12} aria-label="Sign-in code" style={{ maxWidth: 200, letterSpacing: 2 }} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
        ) : (
          <input className="ld-in lg" type="email" aria-label="Email" style={{ maxWidth: 320 }} value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
        )}
        <ErrorLine error={send.error} />
      </div>
      {!send.isSuccess && (
        <button type="button" className="ld-btn p" style={{ width: 128 }} disabled={!ok || send.isPending} onClick={go}>{send.isPending ? "Sending..." : forCode ? "Send code" : "Send email"}</button>
      )}
    </div>
  );
}

/** The sign-in card in Simone's chat. */
export function DemoSignInCard({ id }: { id: number }) {
  const { d } = useDemo(id);
  if (!d) return null;
  if (!d.asking) return <div className="ld-card" style={{ padding: "12px 16px" }}><span className="ld-small" style={{ color: "var(--ld-text2)" }}>{`"${d.title}": signed in.`}</span></div>;
  return <SignInBox d={d} />;
}

// ==========================================
// The card under Simone's message
// ==========================================

export function DemoVideoCard({ id }: { id: number }) {
  const { d, loading } = useDemo(id);
  if (!d) return loading ? null : <div className="ld-card ld-empty">This video was removed.</div>;
  const ready = d.status === "ready" && !!d.videoUrl;
  return (
    <div className="ld-card ld-dv-card">
      <div className="ld-row" style={{ justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <b style={{ overflowWrap: "anywhere" }}>{d.title}</b>
          <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{[d.kindLabel, d.length, d.ratios.join(" and ")].join(" · ")}</span>
        </div>
        <span className={`ld-pill ${pillFor(d.status)}`}>{d.statusLabel}</span>
      </div>
      {ready && <Player url={d.videoUrl} size={(d.sizes[0] as Size) ?? "wide"} max={d.kind === "social" ? 240 : undefined} />}
      {!ready && d.step && <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{d.step}...</span>}
      {d.error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{d.error}</span>}
      <Link href={`/chats/coo/videos?video=${d.id}`} className="ld-btn" style={{ width: 150 }}>{d.status === "plan" ? "Read the plan" : "Open"}</Link>
    </div>
  );
}
