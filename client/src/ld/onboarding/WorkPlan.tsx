import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import { fmtDate } from "../meta";
import { DictateButton, appendText } from "../Dictate";
import { InterviewPanel, type View } from "./Interview";

/**
 * "How <name> will work": the employee drafts its own onboarding from the
 * Brain, the owner reads one card and presses Looks right, or Edit to change
 * a line (typed or dictated). The full interview stays one link away.
 */
export function OnboardingTop({ emp, view }: { emp: EmployeeRow; view: View }) {
  const [full, setFull] = React.useState(false);
  React.useEffect(() => setFull(false), [emp.id]);
  // An interview already under way, or finished without a plan, keeps the interview panel.
  const started = view.state.step > 0 && !view.state.done;
  if (full || started || (view.state.done && !view.plan)) return <InterviewPanel emp={emp} view={view} />;
  return <WorkPlan emp={emp} view={view} onFull={() => setFull(true)} />;
}

type Row = NonNullable<View["plan"]>["rows"][number];
type Answer = string | string[];

function WorkPlan({ emp, view, onFull }: { emp: EmployeeRow; view: View; onFull: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.onboarding.get.invalidate(), utils.employees.list.invalidate(), utils.tasks.list.invalidate()]);
  const draft = trpc.onboarding.draftPlan.useMutation({ onSuccess: refresh });
  const accept = trpc.onboarding.acceptPlan.useMutation({ onSuccess: async () => { await refresh(); setEditing(false); } });
  const [editing, setEditing] = React.useState(false);
  const [changes, setChanges] = React.useState<Record<string, Answer>>({});
  const plan = view.plan;
  const tried = React.useRef(0);
  React.useEffect(() => {
    if (!plan && !draft.isPending && !draft.isError && tried.current !== emp.id) {
      tried.current = emp.id;
      draft.mutate({ organizationId: currentOrgId, employeeId: emp.id });
    }
  }, [plan, emp.id, currentOrgId, draft]);
  if (!plan) {
    return (
      <section className="ld-card" style={{ padding: "18px 18px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="ld-st">How {emp.name} will work</span>
        {draft.isError ? (
          <>
            <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{draft.error.message}</span>
            <div className="ld-row">
              <button type="button" className="ld-btn" style={{ width: 128 }} onClick={() => draft.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>Try again</button>
              <button type="button" className="gp-link" onClick={onFull}>Answer the interview instead</button>
            </div>
          </>
        ) : (
          <span className="ld-small ld-muted">{emp.name} is reading your Brain and writing a plan for the job. About half a minute.</span>
        )}
      </section>
    );
  }
  const valueOf = (r: Row): Answer => (r.key in changes ? changes[r.key] : r.value);
  const text = (v: Answer) => (Array.isArray(v) ? v.join(", ") : v);
  const sections = Array.from(new Set(plan.rows.map((r) => r.section)));
  const set = (key: string, v: Answer) => setChanges((c) => ({ ...c, [key]: v }));
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`} style={{ overflow: "hidden" }}>
      <div className="ld-sh">
        <span className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className="ld-st">How {emp.name} will work</span>
          {view.state.done ? <span className="ld-pill green">Approved {view.state.doneAt ? fmtDate(view.state.doneAt) : ""}</span> : <span className="ld-pill amber">Drafted from your Brain, check it</span>}
        </span>
        {!editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => { setChanges({}); setEditing(true); }}>Edit</button>
          </span>
        ) : (
          <span className="ld-row">
            <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => { setEditing(false); setChanges({}); }}>Cancel</button>
            <button type="button" className="ld-btn p" style={{ width: 100 }} disabled={accept.isPending} onClick={() => accept.mutate({ organizationId: currentOrgId, employeeId: emp.id, changes })}>{accept.isPending ? "Saving" : "Save"}</button>
          </span>
        )}
      </div>
      <div style={{ padding: "0 18px 16px" }}>
        <div className="ld-plan">
          {sections.map((sec) => (
            <React.Fragment key={sec}>
              <div className="ld-plan-sec">{sec}</div>
              {plan.rows
                .filter((r) => r.section === sec)
                .map((r) => (
                  <React.Fragment key={r.key}>
                    <div className="k">{r.short}</div>
                    <div>
                      {!editing ? (
                        <span style={{ overflowWrap: "anywhere" }}>
                          {text(r.value) || <span className="ld-muted">Not set</span>}
                          {r.guess && !view.state.done && <span className="guess">Guess, check this</span>}
                        </span>
                      ) : r.type === "text" ? (
                        <span style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
                          <textarea className="ld-ta" rows={2} aria-label={r.label} value={text(valueOf(r))} onChange={(e) => set(r.key, e.target.value)} />
                          <DictateButton small onText={(t) => set(r.key, appendText(text(valueOf(r)), t))} />
                        </span>
                      ) : (
                        <span className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
                          {r.options.map((o) => {
                            const v = valueOf(r);
                            const on = Array.isArray(v) ? v.includes(o) : v === o;
                            return (
                              <button key={o} type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => set(r.key, r.type === "multi" ? (on ? (Array.isArray(v) ? v.filter((x) => x !== o) : []) : [...(Array.isArray(v) ? v : []), o]) : o)}>
                                {o}
                              </button>
                            );
                          })}
                        </span>
                      )}
                    </div>
                  </React.Fragment>
                ))}
            </React.Fragment>
          ))}
        </div>
        <ErrorLine error={accept.error || draft.error} />
        {!editing && (
          <div className="ld-row" style={{ gap: 12, paddingTop: 14, flexWrap: "wrap" }}>
            {!view.state.done && (
              <>
                <button type="button" className="ld-btn p" style={{ width: 128 }} disabled={accept.isPending} onClick={() => accept.mutate({ organizationId: currentOrgId, employeeId: emp.id, changes: {} })}>{accept.isPending ? "Saving" : "Looks right"}</button>
                <span className="ld-small ld-muted">{emp.name} starts working from this the moment you press it.</span>
              </>
            )}
            {view.state.done && <button type="button" className="ld-btn" style={{ width: 176 }} disabled={draft.isPending} onClick={() => draft.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>{draft.isPending ? "Writing" : "Redo from the Brain"}</button>}
            <span style={{ flex: 1 }} />
            <button type="button" className="gp-link" onClick={onFull}>{view.state.done ? "See the full interview" : `Answer the full interview instead (${view.total} parts, about 10 minutes)`}</button>
          </div>
        )}
      </div>
    </section>
  );
}
