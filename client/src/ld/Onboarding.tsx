import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "./ChatPage";
import { ErrorLine } from "./ui";
import { fmtDate } from "./meta";
import type { Outputs } from "./types";
import { LeadSetupCard, SellsCard, WorksOnOwnCard } from "./sales/OnboardingCards";

type Data = Outputs["onboarding"]["get"];
type Question = Data["questions"][number];
type Answers = Record<string, string | string[]>;
type Assignment = Data["assignments"][number];
type Template = Data["templates"][number];

const REPEATS: { key: "daily" | "weekdays" | "weekly" | "monthly" | "once"; label: string }[] = [
  { key: "daily", label: "Every day" },
  { key: "weekdays", label: "Weekdays" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "once", label: "Once" },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NOTIFY: { key: "push" | "email" | "chat"; label: string }[] = [
  { key: "push", label: "Push" },
  { key: "email", label: "Email" },
  { key: "chat", label: "Chat only" },
];

/** "9:00 AM" or "14:30" becomes "09:00" / "14:30"; null when it can't be read. */
export function to24(v: string) {
  const m = v.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? "0");
  const ap = m[3]?.[0];
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** "09:00" becomes "9:00 AM". */
export function to12(v: string) {
  const [h, m] = v.split(":").map(Number);
  if (Number.isNaN(h)) return v;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function answered(q: Question, a: Answers) {
  const v = a[q.key];
  return Array.isArray(v) ? v.length > 0 : !!String(v ?? "").trim();
}

function show(q: Question, a: Answers) {
  const v = a[q.key];
  return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

export default function Onboarding({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const q = trpc.onboarding.get.useQuery({ organizationId: currentOrgId, employeeId: emp.id }, { enabled: currentOrgId > 0 });
  if (!q.data) return <main className="ld-main" style={{ padding: "28px 36px" }}><div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load onboarding."}</div><ErrorLine error={q.error} /></main>;
  const d = q.data;
  const pct = d.progress.total ? Math.round((d.progress.answered / d.progress.total) * 100) : 100;
  return (
    <main className="ld-main" style={{ padding: "28px 36px", maxWidth: 980 }}>
      <div className="ld-card ld-between" style={{ padding: "16px 20px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontWeight: 800, fontSize: 16 }}>Onboarding</span>
          <span className="ld-body" style={{ color: "#3d4c45" }}>
            {d.progress.answered} of {d.progress.total} answered · {d.assignments.length} assignment{d.assignments.length === 1 ? "" : "s"}
          </span>
        </div>
        <div style={{ width: 220, maxWidth: "100%", height: 8, background: "#e9efec", borderRadius: 999, overflow: "hidden" }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Onboarding progress">
          <div style={{ width: `${pct}%`, height: "100%", background: "#1b6b4a" }} />
        </div>
      </div>
      {emp.kind === "prospecting" && <SellsCard />}
      {emp.kind === "leads" && <LeadSetupCard emp={emp} rule={d.rules.find((r) => r.key === "reply")} />}
      <WorksOnOwnCard emp={emp} rules={emp.kind === "leads" ? d.rules.filter((r) => r.key !== "reply") : d.rules} alwaysAsks={d.alwaysAsks} firstN={d.firstN} />
      <AnswersCard emp={emp} questions={d.questions} answers={d.answers as Answers} startOpen={d.progress.answered === 0} />
      <DayCard emp={emp} items={d.dayToDay} />
      <AssignmentsCard emp={emp} list={d.assignments} templates={d.templates} />
    </main>
  );
}

function AnswersCard({ emp, questions, answers, startOpen }: { emp: EmployeeRow; questions: Question[]; answers: Answers; startOpen: boolean }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(startOpen);
  const [draft, setDraft] = React.useState<Answers>(answers);
  const save = trpc.onboarding.save.useMutation({
    onSuccess: async () => {
      setEditing(false);
      await Promise.all([utils.onboarding.get.invalidate(), utils.employees.list.invalidate()]);
    },
  });
  const set = (k: string, v: string | string[]) => setDraft((x) => ({ ...x, [k]: v }));
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div className="ld-sh">
        <span className="ld-st">What you want from {emp.name}</span>
        {editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => { setEditing(false); setDraft(answers); }}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, employeeId: emp.id, answers: draft })}>
              {save.isPending ? "Saving..." : "Save"}
            </button>
          </span>
        ) : (
          <button type="button" className="ld-btn sm" onClick={() => { setDraft(answers); setEditing(true); }}>Edit</button>
        )}
      </div>
      {editing ? (
        <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
          {questions.map((qq) => (
            <div key={qq.key} className="ld-field">
              {qq.type === "text" ? (
                <>
                  <label className="ld-lbl" htmlFor={`ob-${qq.key}`}>{qq.label}</label>
                  <input id={`ob-${qq.key}`} className="ld-in" value={String(draft[qq.key] ?? "")} maxLength={500} placeholder={qq.placeholder} onChange={(e) => set(qq.key, e.target.value)} />
                </>
              ) : (
                <>
                  <span className="ld-lbl">{qq.label}</span>
                  <div className="ld-row" style={{ flexWrap: "wrap" }}>
                    {(qq.options ?? []).map((o) => {
                      const cur = draft[qq.key];
                      const on = qq.type === "multi" ? Array.isArray(cur) && cur.includes(o) : cur === o;
                      return (
                        <button
                          key={o}
                          type="button"
                          className={`ld-chip ${on ? "on" : ""}`}
                          aria-pressed={on}
                          onClick={() => {
                            if (qq.type === "multi") {
                              const list = Array.isArray(cur) ? cur : [];
                              set(qq.key, on ? list.filter((x) => x !== o) : [...list, o]);
                            } else set(qq.key, o);
                          }}
                        >
                          {o}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ))}
          <ErrorLine error={save.error} />
        </div>
      ) : (
        <div className="ld-kv" style={{ gridTemplateColumns: "minmax(0, 260px) minmax(0, 1fr)" }}>
          {questions.map((qq) => (
            <React.Fragment key={qq.key}>
              <span className="ld-k">{qq.label}</span>
              <span style={{ color: answered(qq, answers) ? undefined : "#8a9a93" }}>{answered(qq, answers) ? show(qq, answers) : "Not answered"}</span>
            </React.Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

function DayCard({ emp, items }: { emp: EmployeeRow; items: { when: string; what: string }[] }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const rewrite = trpc.onboarding.rewriteDay.useMutation({ onSuccess: () => utils.onboarding.get.invalidate() });
  return (
    <section className="ld-card">
      <div className="ld-sh">
        <span className="ld-st">A day with {emp.name}</span>
        <button type="button" className="ld-btn sm" disabled={rewrite.isPending} onClick={() => rewrite.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>
          {rewrite.isPending ? "Writing..." : "Rewrite"}
        </button>
      </div>
      <div style={{ padding: "6px 18px 12px 18px" }}>
        {items.length === 0 && <div className="ld-body ld-muted" style={{ padding: "8px 0" }}>Answer the questions above and {emp.name} will write this.</div>}
        {items.map((it, i) => (
          <div key={i} className="ld-dayrow" style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", gap: 12, padding: "9px 0", borderBottom: i === items.length - 1 ? 0 : "1px solid #eef2f0", fontSize: 14, lineHeight: 1.5 }}>
            <span className="ld-strong">{it.when}</span>
            <span>{it.what}</span>
          </div>
        ))}
        <ErrorLine error={rewrite.error} />
      </div>
    </section>
  );
}

const ASSIGN_COLS = "minmax(0,2fr) minmax(0,1.2fr) 130px 128px";

function AssignmentsCard({ emp, list, templates }: { emp: EmployeeRow; list: Assignment[]; templates: Template[] }) {
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<number | null>(null);
  return (
    <section className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-sh">
        <span className="ld-st">Assignments</span>
        <button type="button" className="ld-btn p" onClick={() => { setAdding(true); setEditing(null); }}>Add assignment</button>
      </div>
      <div className="ld-hd" style={{ gridTemplateColumns: ASSIGN_COLS }}>
        <span>Assignment</span>
        <span>Repeats</span>
        <span>Next</span>
        <span />
      </div>
      {adding && <AssignmentEditor emp={emp} templates={templates} onDone={() => setAdding(false)} />}
      {list.length === 0 && !adding && <div className="ld-empty">No assignments yet. Press Add assignment, for example "Send me a report" every day at 9:00 AM.</div>}
      {list.map((t) =>
        editing === t.id ? (
          <AssignmentEditor key={t.id} emp={emp} templates={templates} task={t} onDone={() => setEditing(null)} />
        ) : (
          <div key={t.id} className="ld-rw" style={{ gridTemplateColumns: ASSIGN_COLS, opacity: t.enabled ? 1 : 0.6 }}>
            <span className="ld-strong">{t.title}</span>
            <span>{t.repeatLabel}</span>
            <span>{t.enabled && t.nextRunAt ? fmtDate(t.nextRunAt) : "Off"}</span>
            <button type="button" className="ld-btn" onClick={() => { setEditing(t.id); setAdding(false); }}>Edit</button>
          </div>
        )
      )}
    </section>
  );
}

function AssignmentEditor({ emp, templates, task, onDone }: { emp: EmployeeRow; templates: Template[]; task?: Assignment; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const first = templates[0];
  const [tpl, setTpl] = React.useState<string | null>(task ? null : first?.label ?? null);
  const [title, setTitle] = React.useState(task?.title ?? first?.title ?? "");
  const [what, setWhat] = React.useState(task?.instructions ?? first?.instructions ?? "");
  const [repeat, setRepeat] = React.useState<(typeof REPEATS)[number]["key"]>((task?.repeat as never) ?? first?.repeat ?? "daily");
  const [time, setTime] = React.useState(task ? to12(task.time) : first ? to12(first.time) : "9:00 AM");
  const [weekday, setWeekday] = React.useState<number>(task?.weekday ?? first?.weekday ?? 1);
  const [monthDay, setMonthDay] = React.useState(String(task?.monthDay ?? 1));
  const [onDate, setOnDate] = React.useState("");
  const [notify, setNotify] = React.useState<"push" | "email" | "chat">((task?.notify as never) ?? "push");
  const [enabled, setEnabled] = React.useState(task?.enabled ?? true);
  const [error, setError] = React.useState<string | null>(null);
  const refresh = async () => {
    await Promise.all([utils.onboarding.get.invalidate(), utils.tasks.list.invalidate()]);
    onDone();
  };
  const save = trpc.tasks.save.useMutation({ onSuccess: refresh });
  const del = trpc.tasks.delete.useMutation({ onSuccess: refresh });

  const pick = (t: Template) => {
    setTpl(t.label);
    setTitle(t.title);
    setWhat(t.instructions);
    setRepeat(t.repeat);
    setTime(to12(t.time));
    if (t.weekday !== undefined) setWeekday(t.weekday);
  };

  const submit = () => {
    setError(null);
    const t24 = to24(time);
    if (!t24) return setError("Type a time like 9:00 AM.");
    let date: string | null = null;
    if (repeat === "once") {
      const m = onDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!m) return setError("Type the date as MM/DD/YYYY.");
      date = `${m[3]}-${m[1]}-${m[2]}`;
    }
    const md = Number(monthDay);
    if (repeat === "monthly" && !(md >= 1 && md <= 28)) return setError("Pick a day of the month from 1 to 28.");
    save.mutate({
      organizationId: currentOrgId,
      id: task?.id,
      employeeId: emp.id,
      title: (title.trim() || what.trim().split(/[.:]/)[0]).slice(0, 200),
      instructions: what.trim(),
      repeat,
      weekday: repeat === "weekly" ? weekday : null,
      monthDay: repeat === "monthly" ? md : null,
      time: t24,
      onDate: date,
      enabled,
      notify,
    });
  };

  return (
    <>
      <div className="ld-rw open" style={{ gridTemplateColumns: ASSIGN_COLS }}>
        <span className="ld-strong">{task ? task.title : "New assignment"}</span>
        <span />
        <span />
        <span />
      </div>
      <div className="ld-expand" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {!task && templates.length > 0 && (
          <div className="ld-field">
            <span className="ld-lbl">Start from</span>
            <div className="ld-row" style={{ flexWrap: "wrap" }}>
              {templates.map((t) => (
                <button key={t.label} type="button" className={`ld-chip ${tpl === t.label ? "on" : ""}`} aria-pressed={tpl === t.label} onClick={() => pick(t)}>{t.label}</button>
              ))}
            </div>
          </div>
        )}
        <div className="ld-field">
          <label className="ld-lbl" htmlFor="as-what">What to do</label>
          <input id="as-what" className="ld-in" value={what} maxLength={4000} onChange={(e) => { setWhat(e.target.value); setTpl(null); }} />
        </div>
        <div className="ld-field">
          <span className="ld-lbl">Repeats</span>
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            {REPEATS.map((r) => (
              <button key={r.key} type="button" className={`ld-chip ${repeat === r.key ? "on" : ""}`} aria-pressed={repeat === r.key} onClick={() => setRepeat(r.key)}>{r.label}</button>
            ))}
          </div>
        </div>
        {repeat === "weekly" && (
          <div className="ld-field">
            <span className="ld-lbl">Day</span>
            <div className="ld-row" style={{ flexWrap: "wrap" }}>
              {DAYS.map((dname, i) => (
                <button key={dname} type="button" className={`ld-chip ${weekday === i ? "on" : ""}`} aria-pressed={weekday === i} onClick={() => setWeekday(i)}>{dname}</button>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "180px minmax(0,1fr)", gap: 12, alignItems: "end" }} className="ld-grid2">
          <div className="ld-field">
            {repeat === "monthly" ? (
              <>
                <label className="ld-lbl" htmlFor="as-md">Day of month and time</label>
                <div className="ld-row">
                  <input id="as-md" className="ld-in" style={{ width: 60 }} value={monthDay} inputMode="numeric" onChange={(e) => setMonthDay(e.target.value)} aria-label="Day of month" />
                  <input className="ld-in" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
                </div>
              </>
            ) : repeat === "once" ? (
              <>
                <label className="ld-lbl" htmlFor="as-date">Date and time</label>
                <div className="ld-row">
                  <input id="as-date" className="ld-in" value={onDate} placeholder="MM/DD/YYYY" inputMode="numeric" onChange={(e) => setOnDate(e.target.value)} />
                  <input className="ld-in" style={{ width: 90 }} value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
                </div>
              </>
            ) : (
              <>
                <label className="ld-lbl" htmlFor="as-time">Time</label>
                <input id="as-time" className="ld-in" value={time} onChange={(e) => setTime(e.target.value)} placeholder="9:00 AM" />
              </>
            )}
          </div>
          <div className="ld-field">
            <span className="ld-lbl">Notify me</span>
            <div className="ld-row" style={{ flexWrap: "wrap" }}>
              {NOTIFY.map((n) => (
                <button key={n.key} type="button" className={`ld-chip ${notify === n.key ? "on" : ""}`} aria-pressed={notify === n.key} onClick={() => setNotify(n.key)}>{n.label}</button>
              ))}
            </div>
          </div>
        </div>
        {task && (
          <div className="ld-field">
            <span className="ld-lbl">Status</span>
            <div className="ld-row">
              <button type="button" className={`ld-chip ${enabled ? "on" : ""}`} aria-pressed={enabled} onClick={() => setEnabled(true)}>On</button>
              <button type="button" className={`ld-chip ${!enabled ? "on" : ""}`} aria-pressed={!enabled} onClick={() => setEnabled(false)}>Off</button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="ld-small" style={{ color: "#b42318", margin: 0 }}>{error}</p>}
        <ErrorLine error={save.error || del.error} />
        <div className="ld-row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
          {task && (
            <button type="button" className="ld-btn danger" disabled={del.isPending} onClick={() => del.mutate({ organizationId: currentOrgId, id: task.id })} style={{ marginRight: "auto" }}>Delete</button>
          )}
          <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
          <button type="button" className="ld-btn p" disabled={save.isPending || what.trim().length < 5} onClick={submit}>{save.isPending ? "Saving..." : "Save"}</button>
        </div>
      </div>
    </>
  );
}
