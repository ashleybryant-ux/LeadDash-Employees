import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, UnderlineTabs } from "../ui";
import PostPanel from "../social/PostPanel";
import { PlatIcon } from "../social/PostPreview";
import { PLAT, PLATFORMS, postChannels, postSpec, postState, whenShort, zoned, type PostRow, type SocialChannel } from "../social/model";
import { Frame } from "../social/PostPreview";

type Tab = "calendar" | "drafts" | "scheduled" | "posted";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const p2 = (n: number) => String(n).padStart(2, "0");
const dateText = (y: number, m: number, d: number) => `${p2(m)}/${p2(d)}/${y}`;

/** A small picture for a row: the image, the Reel's cover, or a plain tile. */
function Thumb({ p, w = 56, h = 70 }: { p: PostRow; w?: number; h?: number }) {
  const spec = postSpec(p);
  const box: React.CSSProperties = { width: spec.type === "reel" ? Math.round(h * 0.57) : w, height: h, borderRadius: 6, overflow: "hidden", position: "relative", background: "#0d3b2e", flexShrink: 0 };
  return (
    <div style={box}>
      {spec.type === "reel" ? (
        <>
          {spec.coverUrl ? <img src={spec.coverUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : spec.videoUrl ? <Frame src={spec.videoUrl} ms={spec.coverMs} /> : null}
          <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14 }}>▶</span>
        </>
      ) : p.imageUrl ? (
        <img src={p.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : null}
    </div>
  );
}

function Icons({ p }: { p: PostRow }) {
  return (
    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {postChannels(p).map((c) => (
        <PlatIcon key={c} c={c} />
      ))}
    </span>
  );
}

const titleOf = (p: PostRow) => `${postSpec(p).type === "reel" ? "Reel: " : ""}${p.title}`;

/** Sienna's Work tab: the calendar, drafts, scheduled and posted. */
export default function Posts({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const posts = trpc.social.listPosts.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: (q) => ((q.state.data ?? []).some((p) => postState(p).key === "posting") ? 8_000 : 60_000) });
  const all = (posts.data ?? []).filter((p) => p.status !== "cancelled" && p.status !== "drafting");
  const groups: Record<Exclude<Tab, "calendar">, PostRow[]> = {
    drafts: all.filter((p) => postState(p).key === "draft"),
    scheduled: all.filter((p) => ["scheduled", "posting"].includes(postState(p).key)).sort((a, b) => new Date(a.scheduledFor ?? 0).getTime() - new Date(b.scheduledFor ?? 0).getTime()),
    posted: all.filter((p) => ["posted", "failed"].includes(postState(p).key)).sort((a, b) => new Date(b.publishedAt ?? b.updatedAt).getTime() - new Date(a.publishedAt ?? a.updatedAt).getTime()),
  };
  const [tab, setTab] = React.useState<Tab>("calendar");
  const [open, setOpen] = React.useState<number | null>(null);
  const [editOnOpen, setEditOnOpen] = React.useState(false);

  return (
    <main className="ld-main" style={{ padding: "20px 32px" }}>
      <UnderlineTabs
        value={tab}
        onChange={(k) => {
          setTab(k);
          setOpen(null);
        }}
        tabs={[
          { key: "calendar", label: "Calendar" },
          { key: "drafts", label: `Drafts (${groups.drafts.length})` },
          { key: "scheduled", label: `Scheduled (${groups.scheduled.length})` },
          { key: "posted", label: `Posted (${groups.posted.length})` },
        ]}
      />
      {tab === "calendar" ? (
        <Calendar all={all} drafts={groups.drafts.filter((p) => !p.scheduledFor)} tz={tz} emp={emp} />
      ) : (
        <PostTable
          tab={tab}
          list={groups[tab]}
          tz={tz}
          open={open}
          editOnOpen={editOnOpen}
          setOpen={(id, edit = false) => {
            setOpen(id);
            setEditOnOpen(edit);
          }}
          loading={posts.isLoading}
          empty={tab === "drafts" ? `No drafts. Press New post on the Calendar, or ask ${emp.name} in Chat.` : tab === "scheduled" ? "Nothing scheduled yet. Drag a draft onto the calendar, or ask Sienna to schedule your drafts." : "Nothing posted yet."}
        />
      )}
    </main>
  );
}

// ==========================================
// Buttons that change a post's state
// ==========================================

function usePostActions() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.social.listPosts.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const act = trpc.publishing.approveAndDispatch.useMutation({ onSuccess: refresh });
  const unschedule = trpc.social.unschedule.useMutation({ onSuccess: refresh });
  const schedule = trpc.social.schedule.useMutation({ onSuccess: refresh });
  return {
    act: (itemId: number, action: "approve_only" | "cancel" | "retry") => act.mutate({ organizationId: currentOrgId, itemId, action }),
    unschedule: (itemId: number) => unschedule.mutate({ organizationId: currentOrgId, itemId }),
    schedule: (itemId: number, date: string) => schedule.mutate({ organizationId: currentOrgId, itemId, date }),
    pending: act.isPending || unschedule.isPending || schedule.isPending,
    error: act.error || unschedule.error || schedule.error,
  };
}

function SideButtons({ p, a }: { p: PostRow; a: ReturnType<typeof usePostActions> }) {
  const st = postState(p);
  return (
    <>
      {p.status === "pending_approval" || p.status === "changes_requested" ? (
        <button type="button" className="ld-btn p" disabled={a.pending} onClick={() => a.act(p.id, "approve_only")}>Approve</button>
      ) : null}
      {st.key === "scheduled" && (
        <button type="button" className="ld-btn" disabled={a.pending} onClick={() => a.unschedule(p.id)}>Unschedule</button>
      )}
      {st.key === "failed" && (
        <button type="button" className="ld-btn p" disabled={a.pending} onClick={() => a.act(p.id, "retry")}>Try again</button>
      )}
      {st.key !== "posted" && st.key !== "posting" && (
        <button type="button" className="ld-btn danger" disabled={a.pending} onClick={() => window.confirm(`Delete "${p.title}"?`) && a.act(p.id, "cancel")}>Delete</button>
      )}
    </>
  );
}

function Results({ p }: { p: PostRow }) {
  const st = postState(p);
  if (!st.dispatch.length && st.key !== "posting") return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="ld-lbl">Result</span>
      {st.key === "posting" && <span className="ld-body">Posting now. Videos can take a few minutes.</span>}
      {st.dispatch.map((d) => (
        <span key={d.channel} className="ld-body" style={{ color: d.ok ? "var(--ld-accent-dark)" : "var(--ld-bad)" }}>
          {PLAT[d.channel as SocialChannel]?.name ?? d.channel}: {d.ok ? "posted" : d.error}
          {d.ok && d.url ? (
            <>
              {" "}
              <a href={d.url} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600 }}>Open</a>
            </>
          ) : null}
        </span>
      ))}
    </div>
  );
}

// ==========================================
// Drafts, Scheduled, Posted
// ==========================================

function PostTable({ tab, list, tz, open, setOpen, editOnOpen, loading, empty }: { tab: Exclude<Tab, "calendar">; list: PostRow[]; tz: string; open: number | null; setOpen: (id: number | null, edit?: boolean) => void; editOnOpen: boolean; loading: boolean; empty: string }) {
  const a = usePostActions();
  const cols = tab === "drafts" ? "90px minmax(0,2fr) minmax(0,1.2fr) 140px 128px 128px" : "90px minmax(0,2fr) minmax(0,1.2fr) 170px 128px 128px";
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: cols }}>
        <span />
        <span>Post</span>
        <span>Accounts</span>
        <span>{tab === "drafts" ? "Status" : tab === "scheduled" ? "When" : "Posted"}</span>
        <span />
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : empty}</div>}
      {list.map((p) => {
        const st = postState(p);
        const isOpen = open === p.id;
        const viewUrl = st.dispatch.find((d) => d.ok && d.url)?.url;
        let action: React.ReactNode = <span />;
        if (tab === "drafts") {
          action =
            p.status === "approved" ? (
              <button type="button" className="ld-btn p" onClick={() => setOpen(p.id, true)}>Schedule</button>
            ) : (
              <button type="button" className="ld-btn p" disabled={a.pending} onClick={() => a.act(p.id, "approve_only")}>Approve</button>
            );
        } else if (tab === "posted") {
          action = st.key === "failed" ? <button type="button" className="ld-btn p" disabled={a.pending} onClick={() => a.act(p.id, "retry")}>Try again</button> : viewUrl ? <a className="ld-btn" href={viewUrl} target="_blank" rel="noreferrer noopener">View post</a> : <span />;
        } else action = <span className={`ld-pill ${st.cls}`}>{st.label}</span>;
        return (
          <React.Fragment key={p.id}>
            <div
              className={`ld-rw ${isOpen ? "open" : ""}`}
              style={{ gridTemplateColumns: cols, cursor: "pointer" }}
              aria-expanded={isOpen}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button,a")) return;
                setOpen(isOpen ? null : p.id);
              }}
            >
              <Thumb p={p} />
              <span className="ld-strong">{titleOf(p)}</span>
              <Icons p={p} />
              {tab === "drafts" ? (
                <span style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                  <span className={`ld-pill ${st.cls}`}>{st.label}</span>
                  {p.scheduledFor && <span className="ld-small ld-muted">{whenShort(p.scheduledFor, tz)}</span>}
                </span>
              ) : tab === "scheduled" ? (
                <span>{p.scheduledFor ? whenShort(p.scheduledFor, tz) : ""}</span>
              ) : (
                <span style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                  <span>{p.publishedAt ? whenShort(p.publishedAt, tz) : p.scheduledFor ? whenShort(p.scheduledFor, tz) : ""}</span>
                  {st.key === "failed" && <span className={`ld-pill ${st.cls}`}>{st.label}</span>}
                </span>
              )}
              {action}
              <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : p.id)}>{isOpen ? "Close" : "Open"}</button>
            </div>
            {isOpen && (
              <div className="ld-expand" style={{ padding: "6px 18px 20px 18px" }}>
                <PostPanel item={p} startEditing={editOnOpen} side={<SideButtons p={p} a={a} />} extra={<Results p={p} />} />
              </div>
            )}
          </React.Fragment>
        );
      })}
      {a.error && (
        <div style={{ padding: "8px 18px" }}>
          <ErrorLine error={a.error} />
        </div>
      )}
    </div>
  );
}

// ==========================================
// Calendar
// ==========================================

type Ev = { p: PostRow; key: number; time: string; kind: "s" | "dr" | "p" };

function Calendar({ all, drafts, tz, emp }: { all: PostRow[]; drafts: PostRow[]; tz: string; emp: EmployeeRow }) {
  const now = zoned(new Date(), tz);
  const [view, setView] = React.useState<"month" | "week">("month");
  const [ym, setYm] = React.useState({ y: now.y, m: now.m });
  const [weekStart, setWeekStart] = React.useState(() => {
    const t = new Date(Date.UTC(now.y, now.m - 1, now.d));
    t.setUTCDate(t.getUTCDate() - t.getUTCDay());
    return t;
  });
  const [account, setAccount] = React.useState<"all" | SocialChannel>("all");
  const [selected, setSelected] = React.useState<number | null>(null);
  const [creating, setCreating] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState<number | null>(null);
  const a = usePostActions();
  const shownSel = React.useRef<number | null>(null);

  const match = (p: PostRow) => account === "all" || postChannels(p).includes(account);
  const events = new Map<number, Ev[]>();
  for (const p of all) {
    if (!match(p)) continue;
    const st = postState(p);
    const at = st.key === "posted" ? p.publishedAt ?? p.scheduledFor : p.scheduledFor;
    if (!at) continue;
    const z = zoned(at, tz);
    const kind: Ev["kind"] = st.key === "posted" || st.key === "failed" ? "p" : st.key === "draft" && p.status !== "approved" ? "dr" : "s";
    const list = events.get(z.key) ?? [];
    list.push({ p, key: z.key, time: z.time, kind });
    events.set(z.key, list);
  }
  events.forEach((l) => l.sort((x, y) => new Date(x.p.scheduledFor ?? x.p.publishedAt ?? 0).getTime() - new Date(y.p.scheduledFor ?? y.p.publishedAt ?? 0).getTime()));

  // Days shown: the whole weeks around the month, or one week.
  const days: { y: number; m: number; d: number; out: boolean }[] = [];
  if (view === "month") {
    const first = new Date(Date.UTC(ym.y, ym.m - 1, 1));
    const start = new Date(first);
    start.setUTCDate(1 - first.getUTCDay());
    const last = new Date(Date.UTC(ym.y, ym.m, 0));
    const total = Math.ceil((first.getUTCDay() + last.getUTCDate()) / 7) * 7;
    for (let i = 0; i < total; i++) {
      const t = new Date(start);
      t.setUTCDate(start.getUTCDate() + i);
      days.push({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), out: t.getUTCMonth() + 1 !== ym.m });
    }
  } else {
    for (let i = 0; i < 7; i++) {
      const t = new Date(weekStart);
      t.setUTCDate(weekStart.getUTCDate() + i);
      days.push({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), out: false });
    }
  }

  const step = (n: number) => {
    setSelected(null);
    if (view === "month") setYm((c) => (c.m + n < 1 ? { y: c.y - 1, m: 12 } : c.m + n > 12 ? { y: c.y + 1, m: 1 } : { y: c.y, m: c.m + n }));
    else
      setWeekStart((w) => {
        const t = new Date(w);
        t.setUTCDate(t.getUTCDate() + 7 * n);
        return t;
      });
  };
  const heading =
    view === "month"
      ? `${MONTHS[ym.m - 1]} ${ym.y}`
      : (() => {
          const e = new Date(weekStart);
          e.setUTCDate(e.getUTCDate() + 6);
          return `${MONTHS[weekStart.getUTCMonth()].slice(0, 3)} ${weekStart.getUTCDate()}, ${weekStart.getUTCFullYear()} to ${MONTHS[e.getUTCMonth()].slice(0, 3)} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
        })();
  const todayKey = now.key;
  const sel = all.find((p) => p.id === selected) ?? null;
  const sideDrafts = drafts.filter(match);

  const dropOn = (key: number, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const id = Number(e.dataTransfer.getData("text/post-id"));
    if (!id) return;
    const y = Math.floor(key / 10000);
    const m = Math.floor((key % 10000) / 100);
    const d = key % 100;
    if (key < todayKey) return;
    a.schedule(id, dateText(y, m, d));
  };

  const chip = (ev: Ev) => {
    const cls = ev.kind === "s" ? { background: "var(--ld-accent-bg)", color: "var(--ld-accent-dark)" } : ev.kind === "p" ? { background: "var(--ld-line2)", color: "var(--ld-muted)" } : { background: "var(--ld-surface)", border: "1px dashed #d9a066", color: "#8a4510" };
    const movable = ev.kind !== "p";
    return (
      <button
        key={ev.p.id}
        type="button"
        draggable={movable}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/post-id", String(ev.p.id));
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => {
          setCreating(null);
          setSelected(selected === ev.p.id ? null : ev.p.id);
        }}
        className="ld-ev"
        title={`${ev.time} ${ev.p.title}`}
        style={{ ...cls, font: "inherit", fontSize: 11.5, lineHeight: 1.3, borderRadius: 6, padding: "4px 6px", fontWeight: 600, display: "flex", flexDirection: "column", gap: 3, overflow: "hidden", textAlign: "left", cursor: movable ? "grab" : "pointer", border: ev.kind === "dr" ? "1px dashed #d9a066" : 0, outline: selected === ev.p.id ? "2px solid #1b6b4a" : "none", width: "100%", boxSizing: "border-box" }}
      >
        <span style={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
          {postChannels(ev.p).map((c) => (
            <PlatIcon key={c} c={c} size={14} />
          ))}
          <span className="ld-ev-time" style={{ marginLeft: 2 }}>{ev.time}</span>
        </span>
        <span className="ld-ev-title" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 500, display: "block" }}>
          {ev.kind === "dr" ? "Draft: " : ""}
          {titleOf(ev.p)}
        </span>
      </button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="ld-between">
        <div className="ld-row" style={{ gap: 10 }}>
          <button type="button" className="ld-btn" style={{ width: 36, padding: 0 }} aria-label={view === "month" ? "Previous month" : "Previous week"} onClick={() => step(-1)}>‹</button>
          <span style={{ fontWeight: 800, fontSize: 18 }}>{heading}</span>
          <button type="button" className="ld-btn" style={{ width: 36, padding: 0 }} aria-label={view === "month" ? "Next month" : "Next week"} onClick={() => step(1)}>›</button>
        </div>
        <div className="ld-row" style={{ flexWrap: "wrap" }}>
          <button type="button" className={`ld-chip ${view === "month" ? "on" : ""}`} aria-pressed={view === "month"} onClick={() => setView("month")}>Month</button>
          <button
            type="button"
            className={`ld-chip ${view === "week" ? "on" : ""}`}
            aria-pressed={view === "week"}
            onClick={() => {
              if (view !== "week" && (ym.y !== now.y || ym.m !== now.m)) {
                const t = new Date(Date.UTC(ym.y, ym.m - 1, 1));
                t.setUTCDate(1 - t.getUTCDay());
                setWeekStart(t);
              }
              setView("week");
            }}
          >
            Week
          </button>
          <label className="ld-sr" htmlFor="cal-acct">Account</label>
          <select id="cal-acct" className="ld-in" style={{ width: 160, height: 32, fontWeight: 700 }} value={account} onChange={(e) => setAccount(e.target.value as typeof account)}>
            <option value="all">All accounts</option>
            {PLATFORMS.map((p) => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="ld-btn p"
            onClick={() => {
              setSelected(null);
              setCreating("");
            }}
          >
            New post
          </button>
        </div>
      </div>

      {creating !== null && (
        <div className="ld-card" style={{ padding: "6px 18px 20px 18px", background: "var(--ld-hover)", borderColor: "var(--ld-accent)" }}>
          <div style={{ fontWeight: 800, fontSize: 15, padding: "10px 0 8px" }}>New post</div>
          <PostPanel key={`new-${creating}`} item={null} preset={creating ? { date: creating } : undefined} onClose={() => setCreating(null)} onSaved={(row) => { setCreating(null); setSelected(row.id); }} />
        </div>
      )}

      <div className="ld-calwrap" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 250px", gap: 16, alignItems: "start" }}>
        <div className="ld-cal ld-keep" style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", borderLeft: "1px solid #e3e9e6", borderTop: "1px solid #e3e9e6", background: "var(--ld-surface)" }}>
          {DOW.map((d) => (
            <div key={d} style={{ fontSize: 12, fontWeight: 700, color: "var(--ld-muted)", textTransform: "uppercase", letterSpacing: ".06em", padding: 8, borderRight: "1px solid #e3e9e6", borderBottom: "1px solid #e3e9e6", background: "var(--ld-page)" }}>{d}</div>
          ))}
          {days.map((day) => {
            const key = day.y * 10000 + day.m * 100 + day.d;
            const evs = events.get(key) ?? [];
            const isToday = key === todayKey;
            const past = key < todayKey;
            return (
              <div
                key={key}
                className="ld-calday"
                onDragOver={(e) => {
                  if (past) return;
                  e.preventDefault();
                  setDragOver(key);
                }}
                onDragLeave={() => setDragOver((k) => (k === key ? null : k))}
                onDrop={(e) => dropOn(key, e)}
                onDoubleClick={() => {
                  if (past) return;
                  setSelected(null);
                  setCreating(dateText(day.y, day.m, day.d));
                }}
                style={{ minHeight: view === "week" ? 320 : 118, borderRight: "1px solid #e3e9e6", borderBottom: "1px solid #e3e9e6", padding: 6, display: "flex", flexDirection: "column", gap: 4, boxSizing: "border-box", minWidth: 0, background: dragOver === key ? "var(--ld-accent-bg)" : past && !day.out ? "#fcfdfc" : "#fff" }}
              >
                <span style={{ fontSize: 12, fontWeight: 700, color: day.out ? "#b3c0ba" : "var(--ld-text2)", ...(isToday ? { background: "var(--ld-accent)", color: "#fff", borderRadius: 999, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center" } : {}) }}>
                  {view === "week" ? `${day.m}/${day.d}` : day.d}
                </span>
                {evs.map(chip)}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="ld-lbl">Drafts to schedule ({sideDrafts.length})</span>
          {sideDrafts.map((p) => {
            const st = postState(p);
            return (
              <button
                key={p.id}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/post-id", String(p.id));
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => {
                  setCreating(null);
                  setSelected(selected === p.id ? null : p.id);
                }}
                style={{ border: `1px solid ${selected === p.id ? "var(--ld-accent)" : "var(--ld-line)"}`, borderRadius: 10, padding: 10, background: "var(--ld-surface)", display: "flex", flexDirection: "column", gap: 6, font: "inherit", textAlign: "left", cursor: "grab" }}
              >
                <span style={{ fontWeight: 700, fontSize: 13, color: "var(--ld-ink)" }}>{titleOf(p)}</span>
                <span style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                  {postChannels(p).map((c) => (
                    <PlatIcon key={c} c={c} />
                  ))}
                  <span className={`ld-pill ${p.status === "approved" ? "green" : "amber"}`} style={{ marginLeft: 6 }}>{p.status === "approved" ? "Approved" : st.label}</span>
                </span>
              </button>
            );
          })}
          <span className="ld-small ld-muted" style={{ fontSize: 12 }}>{sideDrafts.length ? `Drag a draft onto a day, or ask ${emp.name} to schedule them.` : `No drafts waiting. Ask ${emp.name} to write some.`}</span>
        </div>
      </div>
      <ErrorLine error={a.error} />

      <div className="ld-row" style={{ gap: 14, fontSize: 12, color: "var(--ld-muted)", flexWrap: "wrap" }}>
        <span style={{ background: "var(--ld-accent-bg)", color: "var(--ld-accent-dark)", borderRadius: 6, padding: "4px 6px", fontWeight: 600 }}>Scheduled</span>
        <span style={{ background: "var(--ld-surface)", border: "1px dashed #d9a066", color: "#8a4510", borderRadius: 6, padding: "4px 6px", fontWeight: 600 }}>Draft</span>
        <span style={{ background: "var(--ld-line2)", color: "var(--ld-muted)", borderRadius: 6, padding: "4px 6px", fontWeight: 600 }}>Posted</span>
        <span>Double-click a day to write a post for it.</span>
      </div>

      {sel && (
        <div ref={(el) => {
            if (el && selected !== shownSel.current) {
              shownSel.current = selected;
              el.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
          }} className="ld-card" style={{ padding: "6px 18px 20px 18px", background: "var(--ld-hover)", borderColor: "var(--ld-accent)" }}>
          <div className="ld-between" style={{ padding: "10px 0 8px" }}>
            <span style={{ fontWeight: 800, fontSize: 15 }}>{titleOf(sel)}</span>
            <span className={`ld-pill ${postState(sel).cls}`}>{postState(sel).label}</span>
          </div>
          <PostPanel key={sel.id} item={sel} side={<SideButtons p={sel} a={a} />} extra={<Results p={sel} />} />
        </div>
      )}
    </div>
  );
}
