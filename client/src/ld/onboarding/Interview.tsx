import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import type { Outputs } from "../types";

export type View = Outputs["onboarding"]["get"]["interview"];
type Section = View["sections"][number];
type Q = Section["questions"][number];
type Answer = string | string[];
type Example = { liked: boolean; text: string };

const small: React.CSSProperties = { fontSize: 12, color: "var(--ld-muted)", lineHeight: 1.45 };
const col: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };

export function filled(v: Answer | undefined) {
  return Array.isArray(v) ? v.length > 0 : !!String(v ?? "").trim();
}

export function showAnswer(q: Q, v: Answer | undefined, view: View) {
  if (q.type === "examples") {
    const n = view.state.examples.length;
    return n ? `${n} example${n === 1 ? "" : "s"}` : "";
  }
  if (q.type === "samples") {
    const s = view.state.samples.find((x) => x.label === v);
    return s ? `${s.label}: "${s.text}"` : String(v ?? "");
  }
  return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

function Chips({ options, value, multi, onChange }: { options: string[]; value: Answer | undefined; multi: boolean; onChange: (v: Answer) => void }) {
  return (
    <div className="ld-row" style={{ flexWrap: "wrap", gap: 8 }}>
      {options.map((o) => {
        const on = multi ? Array.isArray(value) && value.includes(o) : value === o;
        return (
          <button
            key={o}
            type="button"
            className={`ld-chip ${on ? "on" : ""}`}
            aria-pressed={on}
            onClick={() => {
              if (!multi) return onChange(o);
              const cur = Array.isArray(value) ? value : [];
              onChange(on ? cur.filter((x) => x !== o) : [...cur, o]);
            }}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** The voice samples: pick one, or ask for three more. */
export function Samples({ emp, view, value, onChange }: { emp: EmployeeRow; view: View; value: Answer | undefined; onChange: (v: string) => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const more = trpc.onboarding.samples.useMutation({ onSuccess: () => utils.onboarding.get.invalidate() });
  const started = React.useRef(false);
  React.useEffect(() => {
    if (!view.state.samples.length && !started.current) {
      started.current = true;
      more.mutate({ organizationId: currentOrgId, employeeId: emp.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.state.samples.length]);
  const list = view.state.samples;
  return (
    <div style={col}>
      {list.length === 0 && <span className="ld-body ld-muted">{more.isPending ? `${emp.name} is writing three samples from your Brain...` : "No samples yet."}</span>}
      {list.map((s, i) => {
        const on = value === s.label;
        return (
          <button
            key={`${s.label}-${i}`}
            type="button"
            onClick={() => onChange(s.label)}
            aria-pressed={on}
            style={{ textAlign: "left", font: "inherit", background: "var(--ld-surface)", border: `1px solid ${on ? "var(--ld-accent)" : "var(--ld-line)"}`, outline: on ? "1px solid #1b6b4a" : "none", borderRadius: 10, padding: "10px 12px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <b style={{ fontSize: 14 }}>{`${String.fromCharCode(65 + i)}. ${s.label}`}</b>
              {on && <span className="ld-pill green">Sounds like us</span>}
            </span>
            <span style={{ fontSize: 14, lineHeight: 1.5, color: "#24332c" }}>{s.text}</span>
          </button>
        );
      })}
      <div>
        <button type="button" className="ld-btn" style={{ width: 150 }} disabled={more.isPending} onClick={() => more.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>{more.isPending ? "Writing..." : "Write 3 more"}</button>
      </div>
      <ErrorLine error={more.error} />
    </div>
  );
}

/** Examples: paste work you liked and one you didn't. */
export function Examples({ value, onChange }: { value: Example[]; onChange: (v: Example[]) => void }) {
  const [text, setText] = React.useState("");
  const [liked, setLiked] = React.useState(true);
  return (
    <div style={col}>
      {value.map((e, i) => (
        <div key={i} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 96px", gap: 8, alignItems: "start", border: "1px solid #e3e9e6", borderRadius: 10, padding: "8px 10px", background: "var(--ld-surface)" }}>
          <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span className={`ld-pill ${e.liked ? "green" : "amber"}`} style={{ alignSelf: "flex-start" }}>{e.liked ? "Liked" : "Didn't like"}</span>
            <span style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{e.text.length > 400 ? `${e.text.slice(0, 400)}...` : e.text}</span>
          </span>
          <button type="button" className="ld-btn" style={{ width: 96 }} onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      {value.length < 8 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Chips options={["Liked", "Didn't like"]} value={liked ? "Liked" : "Didn't like"} multi={false} onChange={(v) => setLiked(v === "Liked")} />
          <textarea className="ld-ta" rows={3} aria-label="Paste an example or a link" placeholder="Paste the text, or a link to it" value={text} onChange={(e) => setText(e.target.value)} />
          <div>
            <button type="button" className="ld-btn" style={{ width: 128 }} disabled={!text.trim()} onClick={() => { onChange([...value, { liked, text: text.trim() }]); setText(""); }}>Add example</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One question's answer control. */
export function Field({ emp, view, q, value, onChange, examples, onExamples }: { emp: EmployeeRow; view: View; q: Q; value: Answer | undefined; onChange: (v: Answer) => void; examples: Example[]; onExamples: (v: Example[]) => void }) {
  if (q.type === "choice") return <Chips options={q.options ?? []} value={value} multi={false} onChange={onChange} />;
  if (q.type === "multi") return <Chips options={q.options ?? []} value={value} multi onChange={onChange} />;
  if (q.type === "samples") return <Samples emp={emp} view={view} value={value} onChange={onChange} />;
  if (q.type === "examples") return <Examples value={examples} onChange={onExamples} />;
  return <input className="ld-in" aria-label={q.label} value={String(value ?? "")} maxLength={800} placeholder={q.placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function QRow({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="ld-qrow" style={{ display: "grid", gridTemplateColumns: "240px minmax(0,1fr)", gap: 12, alignItems: "start", padding: "12px 0", borderBottom: "1px solid #eef2f0" }}>
      <span className="ld-strong" style={{ fontSize: 14, paddingTop: 6 }}>{label}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        {children}
        {note && <span style={small}>{note}</span>}
      </div>
    </div>
  );
}

/** The step list on the left. */
function Steps({ view, current, onGo }: { view: View; current: number; onGo: (i: number) => void }) {
  const doneCount = view.state.done ? view.total : view.state.step;
  return (
    <div className="ld-card ld-steps" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 2, alignSelf: "start" }}>
      <span className="ld-lbl" style={{ padding: "4px 10px 8px" }}>{`Onboarding · ${doneCount} of ${view.total} done`}</span>
      {view.sections.map((s, i) => {
        const done = i < doneCount;
        const on = i === current;
        const can = i <= view.state.step;
        return (
          <button
            key={s.key}
            type="button"
            disabled={!can}
            onClick={() => onGo(i)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, background: on ? "var(--ld-faint2)" : "transparent", border: 0, font: "inherit", cursor: can ? "pointer" : "default", textAlign: "left" }}
          >
            <span style={{ width: 24, height: 24, borderRadius: 999, background: done ? "var(--ld-accent)" : on ? "var(--ld-ink)" : "#e9efec", color: done || on ? "#fff" : "var(--ld-muted)", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{done ? "✓" : i + 1}</span>
            <span style={{ fontSize: 14, fontWeight: on ? 800 : 600, color: done || on ? "var(--ld-ink)" : "var(--ld-muted)" }}>{s.title}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The Brain part: facts with Looks right or Missing, inputs for what's missing. */
function BrainPart({ emp, view, onDone, inline }: { emp: EmployeeRow; view: View; onDone?: () => void; inline?: boolean }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [fixing, setFixing] = React.useState(false);
  const [facts, setFacts] = React.useState<Record<string, string>>(() => Object.fromEntries(view.brain.map((f) => [f.key, f.value])));
  const save = trpc.onboarding.saveBrain.useMutation({ onSuccess: async () => { await utils.onboarding.get.invalidate(); setFixing(false); onDone?.(); } });
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {view.brain.map((f) => (
        <div key={f.key} className="ld-qrow" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr) 130px", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid #eef2f0" }}>
          <span className="ld-strong" style={{ fontSize: 14 }}>{f.label}</span>
          {fixing || f.missing ? (
            <input className="ld-in" aria-label={f.label} value={facts[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setFacts({ ...facts, [f.key]: e.target.value })} />
          ) : (
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 14, overflowWrap: "anywhere" }}>{f.value}</span>
              <span style={small}>{`From ${f.from}`}</span>
            </span>
          )}
          <span className={`ld-pill ${f.missing ? "amber" : "green"}`} style={{ justifySelf: "start" }}>{f.missing ? "Missing" : "Looks right"}</span>
        </div>
      ))}
      <span style={{ ...small, paddingTop: 8 }}>What you add here is saved to your Brain, so every employee has it.</span>
      <ErrorLine error={save.error} />
      <div className="ld-row" style={{ gap: 8, paddingTop: 12 }}>
        <button type="button" className="ld-btn p" style={{ width: 128 }} disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, employeeId: emp.id, facts, advance: !inline })}>{save.isPending ? "Saving..." : inline ? "Save" : "Looks right"}</button>
        {!fixing && <button type="button" className="ld-btn" style={{ width: 128 }} onClick={() => setFixing(true)}>Fix something</button>}
      </div>
    </div>
  );
}

/** Follow-up questions, shown on the last part. */
function Followups({ emp, view }: { emp: EmployeeRow; view: View }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const answer = trpc.onboarding.followup.useMutation({ onSuccess: () => utils.onboarding.get.invalidate() });
  if (!view.state.followups.length) return null;
  return (
    <section className="ld-card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column" }}>
      <span className="ld-lbl">{`${emp.name} has ${view.state.followups.length} follow-up question${view.state.followups.length === 1 ? "" : "s"}`}</span>
      <span style={{ fontSize: 14, color: "var(--ld-text2)", padding: "6px 0 2px" }}>From your answers so far.</span>
      {view.state.followups.map((f, i) => (
        <QRow key={i} label={f.q}>
          <Chips options={f.options} value={f.answer} multi={false} onChange={(v) => answer.mutate({ organizationId: currentOrgId, employeeId: emp.id, index: i, answer: String(v) })} />
        </QRow>
      ))}
      <ErrorLine error={answer.error} />
    </section>
  );
}

/** One part of the interview with its questions, Next, Back and Save for later. */
function PartCard({ emp, view, index, onIndex }: { emp: EmployeeRow; view: View; index: number; onIndex: (i: number) => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const section = view.sections[index];
  const [draft, setDraft] = React.useState<Record<string, Answer>>(() => Object.fromEntries(section.questions.map((q) => [q.key, (view.answers[q.key] as Answer) ?? (q.type === "multi" ? [] : "")])));
  const [examples, setExamples] = React.useState<Example[]>(view.state.examples);
  React.useEffect(() => {
    setDraft(Object.fromEntries(section.questions.map((q) => [q.key, (view.answers[q.key] as Answer) ?? (q.type === "multi" ? [] : "")])));
    setExamples(view.state.examples);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.key]);
  const saveEx = trpc.onboarding.examples.useMutation();
  const save = trpc.onboarding.savePart.useMutation();
  const later = trpc.onboarding.later.useMutation();
  const busy = save.isPending || saveEx.isPending || later.isPending;
  const hasExamples = section.questions.some((q) => q.type === "examples");
  const answers = Object.fromEntries(Object.entries(draft).filter(([k]) => section.questions.find((q) => q.key === k)?.type !== "examples"));
  const persist = async (advance: boolean) => {
    if (hasExamples) await saveEx.mutateAsync({ organizationId: currentOrgId, employeeId: emp.id, examples });
    const v = await save.mutateAsync({ organizationId: currentOrgId, employeeId: emp.id, section: section.key, answers, advance });
    await utils.onboarding.get.invalidate();
    await utils.employees.invalidate();
    return v;
  };
  const isLast = index === view.sections.length - 1;
  return (
    <>
      {isLast && <Followups emp={emp} view={view} />}
      <section className="ld-card editing" style={{ padding: "18px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span className="ld-lbl">{`${index + 1} of ${view.total} · ${section.title}`}</span>
          <span style={{ fontSize: 14, color: "var(--ld-text2)", padding: "6px 0 4px" }}>{section.intro}</span>
          {section.key === "brain" ? (
            <BrainPart emp={emp} view={view} onDone={() => onIndex(1)} />
          ) : (
            section.questions.map((q) => (
              <QRow key={q.key} label={q.label} note={q.note}>
                <Field emp={emp} view={view} q={q} value={draft[q.key]} onChange={(v) => setDraft({ ...draft, [q.key]: v })} examples={examples} onExamples={setExamples} />
              </QRow>
            ))
          )}
          <ErrorLine error={save.error || saveEx.error || later.error} />
        </div>
        {section.key !== "brain" ? (
          <div style={col}>
            <button type="button" className="ld-btn p" disabled={busy} onClick={async () => { await persist(true); onIndex(index + 1); }}>{busy ? "Saving..." : isLast ? "Finish" : "Next"}</button>
            {index > 0 && <button type="button" className="ld-btn" disabled={busy} onClick={async () => { await persist(false); onIndex(index - 1); }}>Back</button>}
            <button type="button" className="ld-btn" disabled={busy} onClick={async () => { await persist(false); await later.mutateAsync({ organizationId: currentOrgId, employeeId: emp.id }); await utils.onboarding.get.invalidate(); }}>Save for later</button>
            {later.isSuccess && <span style={small}>Saved. I'll remind you tomorrow at 9:00 AM.</span>}
          </div>
        ) : (
          <div />
        )}
      </section>
    </>
  );
}

/** Finished: what the employee knows, a card per part with its own Edit. */
function Brief({ emp, view }: { emp: EmployeeRow; view: View }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const tryIt = trpc.onboarding.tryIt.useMutation({ onSuccess: () => { utils.chat.invalidate(); window.location.assign(emp.kind === "custom" ? `/chats/e/${emp.id}` : `/chats/${emp.kind}`); } });
  const redo = trpc.onboarding.redo.useMutation({ onSuccess: () => utils.onboarding.get.invalidate() });
  const [editing, setEditing] = React.useState<string | null>(null);
  const count = Object.values(view.answers).filter((v) => filled(v as Answer)).length;
  const doneAt = view.state.doneAt ? new Date(view.state.doneAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";
  return (
    <>
      <section className="ld-card ld-between" style={{ padding: "16px 20px", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontWeight: 800, fontSize: 16 }}>{`${emp.name} is ready to start`}</span>
          <span className="ld-body" style={{ color: "var(--ld-text2)" }}>{`${view.total} of ${view.total} parts · ${count} answers · ${view.state.examples.length} example${view.state.examples.length === 1 ? "" : "s"}${doneAt ? ` · finished ${doneAt}` : ""}`}</span>
        </div>
        <div className="ld-row" style={{ gap: 8 }}>
          <button type="button" className="ld-btn p" style={{ width: 170 }} disabled={tryIt.isPending} onClick={() => tryIt.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>{tryIt.isPending ? "Working..." : view.tryIt.label}</button>
          <button type="button" className="ld-btn" style={{ width: 150 }} disabled={redo.isPending} onClick={() => redo.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>Redo interview</button>
        </div>
        <ErrorLine error={tryIt.error || redo.error} />
      </section>
      {view.sections.map((s) =>
        editing === s.key ? (
          <BriefEdit key={s.key} emp={emp} view={view} section={s} onClose={() => setEditing(null)} />
        ) : (
          <section key={s.key} className="ld-card" style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span className="ld-lbl" style={{ paddingBottom: 4 }}>{s.title}</span>
              {s.key === "brain"
                ? view.brain.map((f) => <BriefRow key={f.key} k={f.label} v={f.value || "Not set"} muted={f.missing} />)
                : s.questions.map((q) => <BriefRow key={q.key} k={q.short ?? q.label} v={showAnswer(q, view.answers[q.key] as Answer, view) || "Not answered"} muted={q.type === "examples" ? !view.state.examples.length : !filled(view.answers[q.key] as Answer)} />)}
            </div>
            <div style={col}>
              <button type="button" className="ld-btn" disabled={editing !== null} onClick={() => setEditing(s.key)}>Edit</button>
            </div>
          </section>
        )
      )}
    </>
  );
}

function BriefRow({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="ld-qrow" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: 12, padding: "8px 0", borderBottom: "1px solid #eef2f0", fontSize: 14, lineHeight: 1.5 }}>
      <b>{k}</b>
      <span className={muted ? "ld-muted" : ""} style={{ overflowWrap: "anywhere" }}>{v}</span>
    </div>
  );
}

function BriefEdit({ emp, view, section, onClose }: { emp: EmployeeRow; view: View; section: Section; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [draft, setDraft] = React.useState<Record<string, Answer>>(() => Object.fromEntries(section.questions.map((q) => [q.key, (view.answers[q.key] as Answer) ?? (q.type === "multi" ? [] : "")])));
  const [examples, setExamples] = React.useState<Example[]>(view.state.examples);
  const save = trpc.onboarding.savePart.useMutation();
  const saveEx = trpc.onboarding.examples.useMutation();
  const hasExamples = section.questions.some((q) => q.type === "examples");
  if (section.key === "brain") {
    return (
      <section className="ld-card editing" style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span className="ld-lbl" style={{ paddingBottom: 4 }}>{section.title}</span>
          <BrainPart emp={emp} view={view} inline onDone={onClose} />
        </div>
        <div style={col}>
          <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
        </div>
      </section>
    );
  }
  return (
    <section className="ld-card editing" style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span className="ld-lbl" style={{ paddingBottom: 4 }}>{section.title}</span>
        {section.questions.map((q) => (
          <QRow key={q.key} label={q.label} note={q.note}>
            <Field emp={emp} view={view} q={q} value={draft[q.key]} onChange={(v) => setDraft({ ...draft, [q.key]: v })} examples={examples} onExamples={setExamples} />
          </QRow>
        ))}
        <ErrorLine error={save.error || saveEx.error} />
      </div>
      <div style={col}>
        <button
          type="button"
          className="ld-btn p"
          disabled={save.isPending || saveEx.isPending}
          onClick={async () => {
            if (hasExamples) await saveEx.mutateAsync({ organizationId: currentOrgId, employeeId: emp.id, examples });
            const answers = Object.fromEntries(Object.entries(draft).filter(([k]) => section.questions.find((q) => q.key === k)?.type !== "examples"));
            await save.mutateAsync({ organizationId: currentOrgId, employeeId: emp.id, section: section.key, answers, advance: false });
            await utils.onboarding.get.invalidate();
            onClose();
          }}
        >
          {save.isPending ? "Saving..." : "Save"}
        </button>
        <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
      </div>
    </section>
  );
}

/** The Onboarding tab's top: the interview while it's going, the brief when it's done. */
export function InterviewPanel({ emp, view }: { emp: EmployeeRow; view: View }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const goTo = trpc.onboarding.goTo.useMutation({ onSuccess: () => utils.onboarding.get.invalidate() });
  const [index, setIndex] = React.useState(Math.min(view.state.step, view.total - 1));
  React.useEffect(() => setIndex(Math.min(view.state.step, view.total - 1)), [emp.id, view.state.done]);
  if (view.state.done) return <Brief emp={emp} view={view} />;
  const go = (i: number) => {
    const n = Math.max(0, Math.min(i, view.total - 1));
    setIndex(n);
    if (n > view.state.step) goTo.mutate({ organizationId: currentOrgId, employeeId: emp.id, step: n });
  };
  return (
    <div className="ld-interview" style={{ display: "grid", gridTemplateColumns: "250px minmax(0,1fr)", gap: 20, alignItems: "start" }}>
      <Steps view={view} current={index} onGo={go} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <PartCard key={view.sections[index].key} emp={emp} view={view} index={index} onIndex={go} />
      </div>
    </div>
  );
}
