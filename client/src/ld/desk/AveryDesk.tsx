import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs, UnderlineTabs } from "../ui";
import { fmtDate, fmtTime } from "../meta";
import type { Outputs } from "../types";
import Drafts from "../work/Drafts";

/**
 * Avery's Desk: one queue for everything that needs a person.
 * Today (top three, meetings, off track, handled), Decisions (who decides,
 * options, notes, decided today), Waiting (what others owe, the owner's
 * promises), Drafts (emails and holds) and Rules (who decides, what Avery
 * does on his own, the owner's time, who comes first).
 */

type D = Outputs["desk"];
type Today = D["today"];
type Q = D["decisions"]["open"][number];
type W = D["waiting"]["owed"][number];
type Rules = D["rules"]["rules"];

const WHEN: Record<string, [string, string]> = { now: ["red", "Now"], today: ["amber", "Today"], week: ["blue", "This week"] };
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function useOrg() {
  return useTenant().currentOrgId;
}
function useRefresh() {
  const utils = trpc.useUtils();
  return () => Promise.all([utils.desk.invalidate(), utils.publishing.listApprovalQueue.invalidate(), utils.assistant.invalidate()]);
}
const dueText = (d: Date | string | null | undefined) => {
  if (!d) return "";
  const x = new Date(d);
  const today = new Date();
  if (x.toDateString() === today.toDateString()) return `Today, ${fmtTime(x)}`;
  return fmtDate(x);
};
const to12 = (hm: string) => {
  if (!hm) return "";
  const [h, m] = hm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const from12 = (s: string) => {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(s);
  if (!m) return s.trim() === "" ? "" : null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
};
const dayList = (d: number[]) => {
  if (!d.length) return "";
  const sorted = WEEK.filter((x) => d.includes(x));
  if (sorted.length >= 3 && sorted.every((x, i) => i === 0 || WEEK.indexOf(x) === WEEK.indexOf(sorted[i - 1]) + 1)) return `${DAY_NAMES[sorted[0]]} to ${DAY_NAMES[sorted[sorted.length - 1]]}`;
  return sorted.map((x) => DAY_NAMES[x]).join(", ");
};
const typedDate = (s: string) => {
  const t = s.trim();
  if (!t) return "";
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const d = m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 17) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const asTyped = (d: Date | string | null | undefined) => {
  if (!d) return "";
  const x = new Date(d);
  return `${String(x.getMonth() + 1).padStart(2, "0")}/${String(x.getDate()).padStart(2, "0")}/${x.getFullYear()}`;
};

function Card({ label, children, buttons }: { label?: string; children: React.ReactNode; buttons?: React.ReactNode }) {
  return (
    <div className="ld-card" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: buttons ? "minmax(0,1fr) 128px" : "minmax(0,1fr)", gap: 20, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {label && <span className="ld-lbl">{label}</span>}
        {children}
      </div>
      {buttons && <Buttons>{buttons}</Buttons>}
    </div>
  );
}
function Buttons({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>;
}
function Lane({ rows }: { rows: [React.ReactNode, React.ReactNode][] }) {
  return (
    <div className="ld-desk-lane" style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", gap: "8px 14px", fontSize: 14, lineHeight: 1.5 }}>
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <b>{k}</b>
          <span style={{ overflowWrap: "anywhere" }}>{v}</span>
        </React.Fragment>
      ))}
    </div>
  );
}
function Form({ children }: { children: React.ReactNode }) {
  return <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>{children}</div>;
}
function Chips({ options, value, onToggle, label }: { options: { key: string | number; label: string }[]; value: (string | number)[]; onToggle: (k: string | number) => void; label: string }) {
  return (
    <div role="group" aria-label={label} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value.includes(o.key)} className={`ld-chip ${value.includes(o.key) ? "on" : ""}`} onClick={() => onToggle(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
const DAY_CHIPS = WEEK.slice(0, 5).map((d) => ({ key: d, label: DAY_NAMES[d] }));

// ==========================================
// The Desk
// ==========================================

type Tab = "today" | "decisions" | "waiting" | "drafts" | "rules";

export default function AveryDesk({ emp }: { emp: EmployeeRow }) {
  const orgId = useOrg();
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const initial = params?.get("tab");
  const [tab, setTab] = React.useState<Tab>(initial && ["today", "decisions", "waiting", "drafts", "rules"].includes(initial) ? (initial as Tab) : "today");
  const [openKey, setOpenKey] = React.useState<string | null>(params?.get("d") ?? null);
  const today = trpc.desk.today.useQuery({ organizationId: orgId }, { refetchInterval: 120_000 });
  const dec = trpc.desk.decisions.useQuery({ organizationId: orgId }, { refetchInterval: 60_000 });
  const wait = trpc.desk.waiting.useQuery({ organizationId: orgId });
  const items = trpc.assistant.listItems.useQuery({ organizationId: orgId });
  const drafts = (items.data ?? []).filter((i) => (i.kind === "email_draft" || i.kind === "calendar_hold") && (i.status === "pending_approval" || i.status === "changes_requested")).length;
  const openDecision = (key: string) => {
    setOpenKey(key);
    setTab("decisions");
  };
  return (
    <main className="ld-main" style={{ padding: "24px 32px", gap: 16 }}>
      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "today", label: "Today" },
          { key: "decisions", label: `Decisions (${dec.data?.open.length ?? 0})` },
          { key: "waiting", label: `Waiting (${(wait.data?.owed.length ?? 0) + (wait.data?.promises.length ?? 0)})` },
          { key: "drafts", label: `Drafts (${drafts})` },
          { key: "rules", label: "Rules" },
        ]}
      />
      {tab === "today" && (today.data ? <TodayTab t={today.data} empKind={emp.kind} onDecide={openDecision} /> : <div className="ld-card ld-empty">{today.isLoading ? "Loading..." : "Couldn't load today."}</div>)}
      {tab === "decisions" && (dec.data ? <DecisionsTab v={dec.data} openKey={openKey} setOpenKey={setOpenKey} /> : <div className="ld-card ld-empty">{dec.isLoading ? "Loading..." : "Couldn't load decisions."}</div>)}
      {tab === "waiting" && (wait.data ? <WaitingTab v={wait.data} /> : <div className="ld-card ld-empty">{wait.isLoading ? "Loading..." : "Couldn't load the list."}</div>)}
      {tab === "drafts" && <Drafts emp={emp} embedded />}
      {tab === "rules" && <RulesTab />}
    </main>
  );
}

// ==========================================
// Today
// ==========================================

function TodayTab({ t, empKind, onDecide }: { t: Today; empKind: string; onDecide: (key: string) => void }) {
  const [shown, setShown] = React.useState<string | null>(null);
  return (
    <>
      <Card label={`Your top three, ${t.date}`} buttons={<Link href={`/chats/${empKind}`} className="ld-btn">Ask Avery</Link>}>
        {t.top.length === 0 ? (
          <span style={{ fontSize: 15 }}>Nothing needs you right now.</span>
        ) : (
          <div>
            {t.top.map((x, i) => (
              <div key={x.key} className="ld-desk-top" style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr) 128px", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: i < t.top.length - 1 ? "1px solid #eef2f0" : 0, fontSize: 15 }}>
                <span aria-hidden style={{ width: 26, height: 26, borderRadius: 999, background: "var(--ld-accent-bg)", color: "var(--ld-accent-dark)", fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                <span>
                  <b>{x.title}</b> {x.body}
                </span>
                {x.button === "Decide" && x.decisionKey ? (
                  <button type="button" className="ld-btn p" onClick={() => onDecide(x.decisionKey!)}>Decide</button>
                ) : x.link ? (
                  <Link href={x.link} className="ld-btn">{x.button}</Link>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <div className="ld-desk-stats" style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 12 }}>
        {[
          ["Decisions waiting", t.counts.decisions],
          ["Meetings today", t.counts.meetings],
          ["Waiting on others", t.counts.waiting],
          ["Handled for you", t.counts.handled],
        ].map(([k, v]) => (
          <div key={k as string} className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{k}</span>
            <b style={{ fontSize: 22 }}>{v}</b>
          </div>
        ))}
      </div>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div style={{ padding: "14px 18px 6px 18px" }}><span className="ld-lbl">Today</span></div>
        {t.events.length === 0 && <div className="ld-empty">{t.calendarsFailed.length ? `Couldn't read ${t.calendarsFailed.join(", ")}.` : "Nothing on your calendars today."}</div>}
        {t.events.map((e) => (
          <div key={e.key} className="ld-rw" style={{ gridTemplateColumns: "170px minmax(0,1fr) 190px 150px" }}>
            <b>{e.when}</b>
            <span style={{ overflowWrap: "anywhere" }}>{e.title}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ld-text2)", fontWeight: 600 }}>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, background: e.color, display: "inline-block", flexShrink: 0 }} />
              {e.calendar}
            </span>
            {e.status ? <span className={`ld-pill ${e.status === "Protected" ? "gray" : "green"}`}>{e.status}</span> : <span />}
          </div>
        ))}
      </div>
      {t.offTrack.length > 0 && (
        <div className="ld-card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 18px 6px 18px" }}><span className="ld-lbl">Off track</span></div>
          {t.offTrack.map((o) => (
            <div key={o.key} className="ld-rw" style={{ gridTemplateColumns: "150px minmax(0,1fr) 128px" }}>
              <b>{o.who}</b>
              <span>{o.text}</span>
              {o.link ? <Link href={o.link} className="ld-btn">Open</Link> : <span />}
            </div>
          ))}
        </div>
      )}
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div style={{ padding: "14px 18px 6px 18px" }}><span className="ld-lbl">Handled for you since {t.handled.since}</span></div>
        {t.handled.rows.length === 0 && <div className="ld-empty">Nothing yet.</div>}
        {t.handled.rows.map((h) => {
          const open = shown === h.key;
          return (
            <React.Fragment key={h.key}>
              <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
                <span>{h.text}</span>
                <button type="button" className="ld-btn" aria-expanded={open} onClick={() => setShown(open ? null : h.key)}>{open ? "Close" : "Show"}</button>
              </div>
              {open && (
                <div className="ld-expand">
                  {h.lines.slice(0, 30).map((l, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 120px minmax(0,1fr)", gap: 12, fontSize: 13, padding: "6px 0", borderBottom: "1px solid #e3e9e6" }}>
                      <span style={{ color: "var(--ld-muted)" }}>{fmtDate(l.at)}, {fmtTime(l.at)}</span>
                      <b>{l.who}</b>
                      <span>{l.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}

// ==========================================
// Decisions
// ==========================================

const COLS = "110px minmax(0,2fr) 140px 130px 150px 128px";
const DCOLS = "110px minmax(0,2fr) 140px minmax(0,1.4fr) 128px";

function DecisionsTab({ v, openKey, setOpenKey }: { v: D["decisions"]; openKey: string | null; setOpenKey: (k: string | null) => void }) {
  return (
    <>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>When</span>
          <span>Decision</span>
          <span>From</span>
          <span>Who decides</span>
          <span>Due</span>
          <span />
        </div>
        {v.open.length === 0 && <div className="ld-empty">Nothing is waiting for a decision.</div>}
        {v.open.map((d) => (
          <DecisionRow key={d.key} d={d} owner={v.owner} open={openKey === d.key} onToggle={() => setOpenKey(openKey === d.key ? null : d.key)} />
        ))}
      </div>
      {v.decided.length > 0 && (
        <div className="ld-card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 18px 6px 18px" }}><span className="ld-lbl">Decided today</span></div>
          {v.decided.map((x) => (
            <div key={x.key} className="ld-rw" style={{ gridTemplateColumns: DCOLS }}>
              <span className={`ld-pill ${x.result === "Sent back" ? "gray" : "green"}`}>{x.result}</span>
              <b style={{ overflowWrap: "anywhere" }}>{x.title}</b>
              <span>{x.from}</span>
              <span>{x.by} · {fmtTime(x.at)}</span>
              {x.link ? <Link href={x.link} className="ld-btn">Open</Link> : <span />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function DecisionRow({ d, owner, open, onToggle }: { d: Q; owner: string; open: boolean; onToggle: () => void }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const ref = React.useRef<HTMLDivElement>(null);
  const [pick, setPick] = React.useState<number | null>(d.suggested);
  const [mode, setMode] = React.useState<"none" | "note" | "back">("none");
  const [text, setText] = React.useState("");
  const done = async () => {
    setMode("none");
    setText("");
    await refresh();
  };
  const decide = trpc.desk.decide.useMutation({ onSuccess: done });
  const back = trpc.desk.sendBack.useMutation({ onSuccess: done });
  const note = trpc.desk.note.useMutation({ onSuccess: done });
  const later = trpc.desk.later.useMutation({ onSuccess: done });
  React.useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const [cls, when] = WHEN[d.urgency] ?? WHEN.week;
  const picked = pick !== null ? d.options[pick] : null;
  return (
    <>
      <div ref={ref} className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
        <span className={`ld-pill ${cls}`}>{when}</span>
        <b style={{ overflowWrap: "anywhere" }}>{d.title}</b>
        <span>{d.from.join(", ")}</span>
        <span className={`ld-pill ${d.who === "you" ? "purple" : "gray"}`}>{d.whoLabel}</span>
        <span>{dueText(d.dueAt)}</span>
        <button type="button" className="ld-btn" aria-expanded={open} onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <Lane
              rows={[
                ...(d.why ? ([["Why it matters", d.why]] as [string, string][]) : []),
                ...(d.project ? ([["Project", d.project]] as [string, string][]) : []),
                ...(d.minutes ? ([["Your time", `About ${d.minutes} minutes`]] as [string, string][]) : []),
                ["Kind", d.categoryLabel],
                ...d.notes.map((n) => [`${n.by.split(" ")[0]}'s note`, `"${n.text}"`] as [string, string]),
              ]}
            />
            {d.options.length > 0 && (
              <div role="radiogroup" aria-label="Options" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {d.options.map((o, i) => (
                  <label key={i} className="ld-desk-opt" style={{ display: "grid", gridTemplateColumns: "20px 110px minmax(0,1fr) 150px", gap: 12, alignItems: "start", padding: "10px 12px", border: `1px solid ${pick === i ? "var(--ld-accent)" : "var(--ld-line)"}`, boxShadow: pick === i ? "0 0 0 2px #cfe6da" : "none", borderRadius: 10, background: "var(--ld-surface)", fontSize: 14, lineHeight: 1.5, cursor: d.canDecide ? "pointer" : "default" }}>
                    <input type="radio" name={`opt-${d.key}`} checked={pick === i} disabled={!d.canDecide} onChange={() => setPick(i)} style={{ margin: "4px 0 0 0", accentColor: "var(--ld-accent)" }} />
                    <b>{o.label}</b>
                    <span>{o.text}</span>
                    {d.suggested === i ? <span className="ld-pill green">Avery suggests</span> : <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{o.source}</span>}
                  </label>
                ))}
              </div>
            )}
            {d.suggestedWhy && <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{d.suggestedWhy}</span>}
            {d.source === "desk" && !d.canDecide && <span className="ld-small" style={{ color: "var(--ld-muted)" }}>Only {owner} can decide {d.categoryLabel.toLowerCase()}. You can add a note for {owner}.</span>}
            {d.source !== "desk" && <span className="ld-small" style={{ color: "var(--ld-muted)" }}>{d.why || "Open it to review and approve it where the work is."}</span>}
            {mode !== "none" && (
              <div className="ld-card editing" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                <label className="ld-lbl" htmlFor={`desk-note-${d.key}`}>{mode === "note" ? "Your note" : "What to change"}</label>
                <textarea id={`desk-note-${d.key}`} className="ld-ta" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
              </div>
            )}
            <ErrorLine error={decide.error ?? back.error ?? note.error ?? later.error} />
          </div>
          <Buttons>
            {d.source !== "desk" ? (
              d.link ? <Link href={d.link} className="ld-btn p">Review</Link> : null
            ) : mode !== "none" ? (
              <>
                <button type="button" className="ld-btn p" disabled={!text.trim() || note.isPending || back.isPending} onClick={() => (mode === "note" ? note.mutate({ organizationId: orgId, id: d.id!, text }) : back.mutate({ organizationId: orgId, id: d.id!, note: text }))}>
                  {mode === "note" ? "Save note" : "Send back"}
                </button>
                <button type="button" className="ld-btn" onClick={() => setMode("none")}>Cancel</button>
              </>
            ) : (
              <>
                {d.canDecide && (
                  <button type="button" className="ld-btn p" disabled={decide.isPending} onClick={() => decide.mutate({ organizationId: orgId, id: d.id!, choice: picked?.label })}>
                    {decide.isPending ? "Saving..." : picked ? `Approve ${picked.label.replace(/^Option /, "")}` : "Approve"}
                  </button>
                )}
                {d.canDecide && <button type="button" className="ld-btn" onClick={() => setMode("back")}>Send back</button>}
                <button type="button" className="ld-btn" onClick={() => setMode("note")}>Add note</button>
                {d.link && <Link href={d.link} className="ld-btn">Open work</Link>}
                <button type="button" className="ld-btn" disabled={later.isPending} onClick={() => later.mutate({ organizationId: orgId, id: d.id! })}>Later</button>
              </>
            )}
          </Buttons>
        </div>
      )}
    </>
  );
}

// ==========================================
// Waiting
// ==========================================

const WCOLS = "minmax(0,1.2fr) minmax(0,2fr) 150px 150px 128px";
const PCOLS = "minmax(0,2fr) minmax(0,1.2fr) 150px 150px 128px";

function WaitingTab({ v }: { v: D["waiting"] }) {
  const [folder, setFolder] = React.useState<"owed" | "promises">("owed");
  const [open, setOpen] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  return (
    <>
      <FolderTabs
        value={folder}
        onChange={(k) => {
          setFolder(k);
          setOpen(null);
          setAdding(false);
        }}
        tabs={[
          { key: "owed", label: `Waiting on others (${v.owed.length})` },
          { key: "promises", label: `Your promises (${v.promises.length})` },
        ]}
      >
        <div className="ld-hd" style={{ gridTemplateColumns: folder === "owed" ? WCOLS : PCOLS }}>
          {folder === "owed" ? (
            <>
              <span>Who</span>
              <span>What they owe you</span>
              <span>Expected</span>
              <span>Avery's next nudge</span>
            </>
          ) : (
            <>
              <span>You said you'd</span>
              <span>To</span>
              <span>By</span>
              <span>Who's on it</span>
            </>
          )}
          <span />
        </div>
        {adding && <AddWaiting kind={folder === "owed" ? "owed" : "promise"} onDone={() => setAdding(false)} />}
        {(folder === "owed" ? v.owed : v.promises).length === 0 && !adding && <div className="ld-empty">{folder === "owed" ? "Nobody owes you anything right now." : "No open promises."}</div>}
        {(folder === "owed" ? v.owed : v.promises).map((w) => (
          <WaitingRow key={w.id} w={w} open={open === w.id} onToggle={() => setOpen(open === w.id ? null : w.id)} />
        ))}
      </FolderTabs>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "start", flexWrap: "wrap" }}>
        <span className="ld-small" style={{ color: "var(--ld-muted)", maxWidth: 760, lineHeight: 1.5 }}>
          {folder === "owed" ? "Avery nudges people outside the company himself. Work owed by an employee goes to Nora, and sales and speaking follow-ups go to Jada and Taylor, so nobody chases the same thing twice." : "Avery picks up promises from meeting notes and from what you tell her in chat."}
        </span>
        {!adding && <button type="button" className="ld-btn" onClick={() => setAdding(true)}>Add</button>}
      </div>
    </>
  );
}

function AddWaiting({ kind, onDone }: { kind: "owed" | "promise"; onDone: () => void }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [who, setWho] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [what, setWhat] = React.useState("");
  const [by, setBy] = React.useState("");
  const add = trpc.desk.addWaiting.useMutation({ onSuccess: async () => { await refresh(); onDone(); } });
  const iso = typedDate(by);
  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start", paddingTop: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Form>
          <label htmlFor="w-who" style={{ fontWeight: 700 }}>{kind === "owed" ? "Who owes it" : "Promised to"}</label>
          <input id="w-who" className="ld-in" value={who} onChange={(e) => setWho(e.target.value)} style={{ maxWidth: 320 }} />
          {kind === "owed" && (
            <>
              <label htmlFor="w-email" style={{ fontWeight: 700 }}>Their email</label>
              <input id="w-email" className="ld-in" value={email} onChange={(e) => setEmail(e.target.value)} style={{ maxWidth: 320 }} />
            </>
          )}
          <label htmlFor="w-what" style={{ fontWeight: 700 }}>{kind === "owed" ? "What they owe" : "What you'll do"}</label>
          <input id="w-what" className="ld-in" value={what} onChange={(e) => setWhat(e.target.value)} />
          <label htmlFor="w-by" style={{ fontWeight: 700 }}>{kind === "owed" ? "Expected" : "By"}</label>
          <input id="w-by" className="ld-in" placeholder="MM/DD/YYYY" value={by} onChange={(e) => setBy(e.target.value)} style={{ maxWidth: 160 }} />
        </Form>
        {iso === null && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>Type the date as MM/DD/YYYY.</span>}
        <ErrorLine error={add.error} />
      </div>
      <Buttons>
        <button type="button" className="ld-btn p" disabled={!who.trim() || !what.trim() || iso === null || add.isPending} onClick={() => add.mutate({ organizationId: orgId, kind, who, email, what, expectedAt: iso || undefined })}>Save</button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      </Buttons>
    </div>
  );
}

function WaitingRow({ w, open, onToggle }: { w: W; open: boolean; onToggle: () => void }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [editing, setEditing] = React.useState(false);
  const [f, setF] = React.useState({ who: w.who, email: w.email, what: w.what, expected: asTyped(w.expectedAt), nudge: asTyped(w.nudgeAt), subject: w.nudgeSubject, body: w.nudgeBody, plan: w.plan });
  const save = trpc.desk.saveWaiting.useMutation({ onSuccess: async () => { setEditing(false); await refresh(); } });
  const finish = trpc.desk.finishWaiting.useMutation({ onSuccess: refresh });
  const send = trpc.desk.sendNudge.useMutation({ onSuccess: refresh });
  const owed = w.kind === "owed";
  const startEdit = () => {
    setF({ who: w.who, email: w.email, what: w.what, expected: asTyped(w.expectedAt), nudge: asTyped(w.nudgeAt), subject: w.nudgeSubject, body: w.nudgeBody, plan: w.plan });
    setEditing(true);
  };
  const expIso = typedDate(f.expected);
  const nudgeIso = typedDate(f.nudge);
  return (
    <>
      <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: owed ? WCOLS : PCOLS }}>
        {owed ? (
          <>
            <b>{w.who}</b>
            <span>{w.what}</span>
            <span>{fmtDate(w.expectedAt)}</span>
            <span>{w.ownerLabel ?? (w.nudgeAt ? fmtDate(w.nudgeAt) : w.email ? "Not set" : "Needs an email")}</span>
          </>
        ) : (
          <>
            <b>{w.what}</b>
            <span>{w.who}</span>
            <span>{fmtDate(w.expectedAt)}</span>
            <span>{w.ownerLabel ?? "Avery drafts it"}</span>
          </>
        )}
        <button type="button" className="ld-btn" aria-expanded={open} onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            {editing ? (
              <div className="ld-card editing" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                <Form>
                  <label htmlFor={`we-who-${w.id}`} style={{ fontWeight: 700 }}>{owed ? "Who" : "To"}</label>
                  <input id={`we-who-${w.id}`} className="ld-in" value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })} style={{ maxWidth: 320 }} />
                  <label htmlFor={`we-what-${w.id}`} style={{ fontWeight: 700 }}>What</label>
                  <input id={`we-what-${w.id}`} className="ld-in" value={f.what} onChange={(e) => setF({ ...f, what: e.target.value })} />
                  <label htmlFor={`we-exp-${w.id}`} style={{ fontWeight: 700 }}>{owed ? "Expected" : "By"}</label>
                  <input id={`we-exp-${w.id}`} className="ld-in" placeholder="MM/DD/YYYY" value={f.expected} onChange={(e) => setF({ ...f, expected: e.target.value })} style={{ maxWidth: 160 }} />
                  {owed ? (
                    <>
                      <label htmlFor={`we-email-${w.id}`} style={{ fontWeight: 700 }}>Their email</label>
                      <input id={`we-email-${w.id}`} className="ld-in" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={{ maxWidth: 320 }} />
                      <label htmlFor={`we-nudge-${w.id}`} style={{ fontWeight: 700 }}>Nudge on</label>
                      <input id={`we-nudge-${w.id}`} className="ld-in" placeholder="MM/DD/YYYY" value={f.nudge} onChange={(e) => setF({ ...f, nudge: e.target.value })} style={{ maxWidth: 160 }} />
                      <label htmlFor={`we-subj-${w.id}`} style={{ fontWeight: 700 }}>Subject</label>
                      <input id={`we-subj-${w.id}`} className="ld-in" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
                      <label htmlFor={`we-body-${w.id}`} style={{ fontWeight: 700, alignSelf: "start", paddingTop: 6 }}>Message</label>
                      <textarea id={`we-body-${w.id}`} className="ld-ta" rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
                    </>
                  ) : (
                    <>
                      <label htmlFor={`we-plan-${w.id}`} style={{ fontWeight: 700 }}>Plan</label>
                      <input id={`we-plan-${w.id}`} className="ld-in" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })} />
                    </>
                  )}
                </Form>
                {(expIso === null || nudgeIso === null) && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>Type dates as MM/DD/YYYY.</span>}
              </div>
            ) : owed ? (
              <>
                <Lane
                  rows={[
                    ["Asked", w.askedAt ? fmtDate(w.askedAt) : "Not noted"],
                    ...(w.blocks ? ([["Blocks", w.blocks]] as [string, string][]) : []),
                    ...(w.escalateAt ? ([["If still nothing", `Avery brings it to Decisions on ${fmtDate(w.escalateAt)}`]] as [string, string][]) : []),
                    ...(w.email ? ([["Email", w.email]] as [string, string][]) : []),
                  ]}
                />
                {w.ownerLabel === null && (
                  <div className="ld-card" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                    <b style={{ fontSize: 14 }}>{w.nudgeAt ? `The nudge Avery will send on ${fmtDate(w.nudgeAt)}` : "The nudge Avery will send"}</b>
                    <span style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-line" }}>{w.nudgeBody}</span>
                  </div>
                )}
              </>
            ) : (
              <Lane rows={[...(w.heardIn ? ([["Heard in", w.heardIn]] as [string, string][]) : []), ["Plan", w.plan || "Avery drafts it and brings it to Decisions for your OK."]]} />
            )}
            <ErrorLine error={save.error ?? finish.error ?? send.error} />
          </div>
          <Buttons>
            {editing ? (
              <>
                <button type="button" className="ld-btn p" disabled={save.isPending || expIso === null || nudgeIso === null} onClick={() => save.mutate({ organizationId: orgId, id: w.id, who: f.who, what: f.what, expectedAt: expIso || null, ...(owed ? { email: f.email, nudgeAt: nudgeIso || null, nudgeSubject: f.subject, nudgeBody: f.body } : { plan: f.plan }) })}>Save</button>
                <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
              </>
            ) : owed ? (
              <>
                <button type="button" className="ld-btn" onClick={startEdit}>Edit nudge</button>
                {w.ownerLabel === null && <button type="button" className="ld-btn" disabled={send.isPending || !w.email} onClick={() => send.mutate({ organizationId: orgId, id: w.id })}>{send.isPending ? "Sending..." : "Send now"}</button>}
                <button type="button" className="ld-btn" disabled={finish.isPending} onClick={() => finish.mutate({ organizationId: orgId, id: w.id, how: "done" })}>Mark done</button>
              </>
            ) : (
              <>
                <button type="button" className="ld-btn" onClick={startEdit}>Edit</button>
                {w.owner !== "you" && <button type="button" className="ld-btn" disabled={finish.isPending} onClick={() => finish.mutate({ organizationId: orgId, id: w.id, how: "mine" })}>I'll do it</button>}
                <button type="button" className="ld-btn" disabled={finish.isPending} onClick={() => finish.mutate({ organizationId: orgId, id: w.id, how: "done" })}>Mark done</button>
                <button type="button" className="ld-btn" disabled={finish.isPending} onClick={() => finish.mutate({ organizationId: orgId, id: w.id, how: "dismissed" })}>Not a promise</button>
              </>
            )}
          </Buttons>
        </div>
      )}
    </>
  );
}

// ==========================================
// Rules
// ==========================================

type Section = "who" | "duties" | "time" | "first" | null;

function RulesTab() {
  const orgId = useOrg();
  const q = trpc.desk.rules.useQuery({ organizationId: orgId });
  const utils = trpc.useUtils();
  const [edit, setEdit] = React.useState<Section>(null);
  const [draft, setDraft] = React.useState<Rules | null>(null);
  const [typed, setTyped] = React.useState({ meetFrom: "", meetTo: "", focusFrom: "", focusTo: "", brief: "", maxHours: "", buffer: "", afterTalk: "", spend: "" });
  const save = trpc.desk.saveRules.useMutation({
    onSuccess: async () => {
      setEdit(null);
      await utils.desk.invalidate();
    },
  });
  if (!q.data) return <div className="ld-card ld-empty">{q.isLoading ? "Loading..." : "Couldn't load the rules."}</div>;
  const { rules, categories, duties, never, owner, role, team } = q.data;
  const teamLabel = team.length && team.length <= 2 ? team.join(" or ") : "your team";
  const isOwner = role === "owner";
  const canEdit = role === "owner" || role === "admin";
  const start = (s: Section) => {
    setDraft(JSON.parse(JSON.stringify(rules)));
    setTyped({ meetFrom: to12(rules.time.meetFrom), meetTo: to12(rules.time.meetTo), focusFrom: to12(rules.time.focusFrom), focusTo: to12(rules.time.focusTo), brief: to12(rules.briefTime), maxHours: rules.time.maxHours?.toString() ?? "", buffer: rules.time.buffer?.toString() ?? "", afterTalk: rules.time.afterTalk?.toString() ?? "", spend: rules.spendLimitCents === null ? "" : String(rules.spendLimitCents / 100) });
    setEdit(s);
  };
  const r = edit && draft ? draft : rules;
  const editBtn = (s: Section, allowed = canEdit) => (allowed ? <button type="button" className="ld-btn" onClick={() => start(s)}>Edit</button> : undefined);
  const saveBtns = (onSave: () => void, bad = false) => (
    <>
      <button type="button" className="ld-btn p" disabled={save.isPending || bad} onClick={onSave}>Save</button>
      <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
    </>
  );
  const own = duties.filter((d) => r.duties[d.key] === "own");
  const ask = duties.filter((d) => r.duties[d.key] === "ask");
  const t = r.time;
  const times = { meetFrom: from12(typed.meetFrom), meetTo: from12(typed.meetTo), focusFrom: from12(typed.focusFrom), focusTo: from12(typed.focusTo), brief: from12(typed.brief) };
  const timesBad = Object.values(times).some((x) => x === null) || !times.meetFrom || !times.meetTo || !times.brief;
  const numOrNull = (s: string) => (s.trim() === "" ? null : Number.isFinite(Number(s)) ? Number(s) : NaN);
  const toggle = <T,>(list: T[], k: T) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);

  return (
    <>
      {/* Who decides */}
      {edit === "who" && draft ? (
        <Card label="Who decides" buttons={saveBtns(() => save.mutate({ organizationId: orgId, rules: { onlyYou: draft.onlyYou, spendLimitCents: numOrNull(typed.spend) === null ? null : Math.round(Number(typed.spend) * 100) } }), Number.isNaN(numOrNull(typed.spend)))}>
          <Form>
            <span style={{ fontWeight: 700, alignSelf: "start", paddingTop: 6 }}>Only you</span>
            <Chips label="Only you decides" options={categories.map((c) => ({ key: c.key, label: c.label }))} value={draft.onlyYou} onToggle={(k) => setDraft({ ...draft, onlyYou: toggle(draft.onlyYou, k as string) })} />
            <label htmlFor="r-spend" style={{ fontWeight: 700 }}>Spending over</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>$</span>
              <input id="r-spend" className="ld-in" style={{ width: 120 }} value={typed.spend} onChange={(e) => setTyped({ ...typed, spend: e.target.value })} placeholder="No limit" />
              <span>needs you</span>
            </div>
            <span style={{ fontWeight: 700 }}>Everything else</span>
            <span>You or {teamLabel}</span>
          </Form>
          <ErrorLine error={save.error} />
        </Card>
      ) : (
        <Card label="Who decides" buttons={editBtn("who", isOwner)}>
          <Lane
            rows={[
              [isOwner ? `You or ${teamLabel}` : `You or ${owner}`, `Everything in Decisions not listed below${categories.filter((c) => !rules.onlyYou.includes(c.key)).length ? `: ${categories.filter((c) => !rules.onlyYou.includes(c.key)).map((c) => c.label.toLowerCase()).join(", ")}` : ""}`],
              [`Only ${isOwner ? "you" : owner}`, `${rules.onlyYou.map((k) => categories.find((c) => c.key === k)?.label ?? k).join(", ") || "Nothing extra"}${rules.spendLimitCents !== null ? `, spending over $${(rules.spendLimitCents / 100).toLocaleString("en-US")}` : ""}`],
              ["Who sees it", "Everyone on the team sees the same queue. Every decision shows who made it."],
            ]}
          />
        </Card>
      )}

      {/* What Avery does */}
      {edit === "duties" && draft ? (
        <Card label="What Avery does" buttons={saveBtns(() => save.mutate({ organizationId: orgId, rules: { duties: draft.duties } }))}>
          <Form>
            <span style={{ fontWeight: 700, alignSelf: "start", paddingTop: 6 }}>On his own</span>
            <Chips
              label="On his own"
              options={duties.filter((d) => d.key !== "new_people" && d.key !== "money").map((d) => ({ key: d.key, label: d.label }))}
              value={duties.filter((d) => draft.duties[d.key] === "own").map((d) => d.key)}
              onToggle={(k) => setDraft({ ...draft, duties: { ...draft.duties, [k]: (draft.duties[k as string] === "own" ? "ask" : "own") as "own" | "ask" } })}
            />
            <span style={{ fontWeight: 700, alignSelf: "start", paddingTop: 6 }}>Asks you first</span>
            <span style={{ lineHeight: 1.5 }}>{duties.filter((d) => draft.duties[d.key] === "ask").map((d) => d.label).join(", ")}</span>
            <span style={{ fontWeight: 700, alignSelf: "start" }}>Never</span>
            <span style={{ lineHeight: 1.5 }}>{never}</span>
          </Form>
          <ErrorLine error={save.error} />
        </Card>
      ) : (
        <Card label="What Avery does" buttons={editBtn("duties")}>
          <Lane rows={[["On his own", own.map((d) => d.label).join(", ") || "Nothing"], ["Asks you first", ask.map((d) => d.label).join(", ")], ["Never", never]]} />
        </Card>
      )}

      {/* Your time */}
      {edit === "time" && draft ? (
        <Card
          label="Your time"
          buttons={saveBtns(
            () =>
              save.mutate({
                organizationId: orgId,
                rules: {
                  briefTime: times.brief,
                  briefDays: draft.briefDays,
                  time: { ...draft.time, meetFrom: times.meetFrom, meetTo: times.meetTo, focusFrom: times.focusFrom ?? "", focusTo: times.focusTo ?? "", maxHours: numOrNull(typed.maxHours), buffer: numOrNull(typed.buffer), afterTalk: numOrNull(typed.afterTalk) },
                },
              }),
            timesBad || [typed.maxHours, typed.buffer, typed.afterTalk].some((x) => Number.isNaN(numOrNull(x)))
          )}
        >
          <Form>
            <span style={{ fontWeight: 700 }}>Meetings</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input aria-label="Meetings start" className="ld-in" style={{ width: 110 }} value={typed.meetFrom} onChange={(e) => setTyped({ ...typed, meetFrom: e.target.value })} />
              <span>to</span>
              <input aria-label="Meetings end" className="ld-in" style={{ width: 110 }} value={typed.meetTo} onChange={(e) => setTyped({ ...typed, meetTo: e.target.value })} />
              <Chips label="Meeting days" options={DAY_CHIPS} value={draft.time.meetDays} onToggle={(k) => setDraft({ ...draft, time: { ...draft.time, meetDays: toggle(draft.time.meetDays, k as number) } })} />
            </div>
            <span style={{ fontWeight: 700 }}>Focus time</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input aria-label="Focus start" className="ld-in" style={{ width: 110 }} placeholder="None" value={typed.focusFrom} onChange={(e) => setTyped({ ...typed, focusFrom: e.target.value })} />
              <span>to</span>
              <input aria-label="Focus end" className="ld-in" style={{ width: 110 }} placeholder="None" value={typed.focusTo} onChange={(e) => setTyped({ ...typed, focusTo: e.target.value })} />
              <Chips label="Focus days" options={DAY_CHIPS} value={draft.time.focusDays} onToggle={(k) => setDraft({ ...draft, time: { ...draft.time, focusDays: toggle(draft.time.focusDays, k as number) } })} />
            </div>
            <label htmlFor="r-max" style={{ fontWeight: 700 }}>Most meetings a day</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input id="r-max" className="ld-in" style={{ width: 110 }} placeholder="No limit" value={typed.maxHours} onChange={(e) => setTyped({ ...typed, maxHours: e.target.value })} />
              <span>hours</span>
            </div>
            <label htmlFor="r-buffer" style={{ fontWeight: 700 }}>Between meetings</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input id="r-buffer" className="ld-in" style={{ width: 110 }} value={typed.buffer} onChange={(e) => setTyped({ ...typed, buffer: e.target.value })} />
              <span>minutes</span>
            </div>
            <span style={{ fontWeight: 700 }}>Demos</span>
            <Chips label="Demo days" options={DAY_CHIPS} value={draft.time.demoDays} onToggle={(k) => setDraft({ ...draft, time: { ...draft.time, demoDays: toggle(draft.time.demoDays, k as number) } })} />
            <label htmlFor="r-talk" style={{ fontWeight: 700 }}>After a talk</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input id="r-talk" className="ld-in" style={{ width: 110 }} placeholder="No rule" value={typed.afterTalk} onChange={(e) => setTyped({ ...typed, afterTalk: e.target.value })} />
              <span>hours with nothing</span>
            </div>
            <span style={{ fontWeight: 700 }}>Morning brief</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input aria-label="Brief time" className="ld-in" style={{ width: 110 }} value={typed.brief} onChange={(e) => setTyped({ ...typed, brief: e.target.value })} />
              <Chips label="Brief days" options={DAY_CHIPS} value={draft.briefDays} onToggle={(k) => setDraft({ ...draft, briefDays: toggle(draft.briefDays, k as number) })} />
            </div>
          </Form>
          {timesBad && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>Type times like 9:00 AM.</span>}
          <ErrorLine error={save.error} />
        </Card>
      ) : (
        <Card label="Your time" buttons={editBtn("time")}>
          <Lane
            rows={[
              ["Meetings", `${to12(t.meetFrom)} to ${to12(t.meetTo)}${t.meetDays.length ? `, ${dayList(t.meetDays)}` : ""}`],
              ["Focus time", t.focusFrom && t.focusTo && t.focusDays.length ? `${to12(t.focusFrom)} to ${to12(t.focusTo)}, ${dayList(t.focusDays)}` : "Not set"],
              ["Most meetings a day", t.maxHours ? `${t.maxHours} hours` : "No limit"],
              ["Between meetings", t.buffer ? `${t.buffer} minutes` : "No break"],
              ["Demos", t.demoDays.length ? dayList(t.demoDays) : "Any day"],
              ["After a talk", t.afterTalk ? `Nothing for ${t.afterTalk} hours` : "No rule"],
              ["Morning brief", `${to12(rules.briefTime)}${rules.briefDays.length ? `, ${dayList(rules.briefDays)}` : ", off"}`],
            ]}
          />
        </Card>
      )}

      {/* Who comes first */}
      {edit === "first" && draft ? (
        <Card label="Who comes first" buttons={saveBtns(() => save.mutate({ organizationId: orgId, rules: { first: draft.first, normal: draft.normal, wait: draft.wait } }))}>
          <Form>
            <label htmlFor="r-first" style={{ fontWeight: 700 }}>First</label>
            <input id="r-first" className="ld-in" value={draft.first} onChange={(e) => setDraft({ ...draft, first: e.target.value })} />
            <label htmlFor="r-normal" style={{ fontWeight: 700 }}>Normal</label>
            <input id="r-normal" className="ld-in" value={draft.normal} onChange={(e) => setDraft({ ...draft, normal: e.target.value })} />
            <label htmlFor="r-wait" style={{ fontWeight: 700 }}>Can wait</label>
            <input id="r-wait" className="ld-in" value={draft.wait} onChange={(e) => setDraft({ ...draft, wait: e.target.value })} />
          </Form>
          <ErrorLine error={save.error} />
        </Card>
      ) : (
        <Card label="Who comes first" buttons={editBtn("first")}>
          <Lane rows={[["First", rules.first], ["Normal", rules.normal], ["Can wait", rules.wait]]} />
        </Card>
      )}

      <Card label="How Avery ranks a decision">
        <Lane
          rows={[
            [<span className="ld-pill red">Now</span>, "Costs money, a customer or a story if it waits past today"],
            [<span className="ld-pill amber">Today</span>, "Blocks a project or a buyer who is ready"],
            [<span className="ld-pill blue">This week</span>, "Needs a person, but nothing breaks if it waits a few days"],
            ["Hand off", "Someone on the team can do it, so it never reaches you"],
          ]}
        />
      </Card>
      <Card label="Who asks you for things">
        <Lane
          rows={[
            ["Avery", "The only employee who brings you and your team decisions and reminders. He merges repeats into one request."],
            ["Nora", "Owns projects, tasks and deadlines. Sends Avery what needs a person."],
            ["Simone", "Runs the meetings and the scorecard, with the notes Avery takes in your meetings. Asks Avery for your time."],
            ["Everyone else", "Sends Avery their decisions instead of asking you in their own chats."],
          ]}
        />
      </Card>
    </>
  );
}
