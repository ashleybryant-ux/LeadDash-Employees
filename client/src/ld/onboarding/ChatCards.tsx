import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { Examples, Samples, filled, showAnswer, type View } from "./Interview";
import type { EmployeeRow } from "../ChatPage";

type Answer = string | string[];
const card: React.CSSProperties = { padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" };
const col: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const small: React.CSSProperties = { fontSize: 12, color: "var(--ld-muted)", lineHeight: 1.45 };

function useView(employeeId: number) {
  const { currentOrgId } = useTenant();
  return trpc.onboarding.get.useQuery({ organizationId: currentOrgId, employeeId }, { enabled: currentOrgId > 0 });
}

function useRefresh() {
  const utils = trpc.useUtils();
  return () => Promise.all([utils.onboarding.get.invalidate(), utils.chat.invalidate(), utils.employees.invalidate()]);
}

/** "My onboarding": Start, Continue or Later; when finished, Open and the try-it button. */
export function OnboardingCard({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const q = useView(emp.id);
  const refresh = useRefresh();
  const start = trpc.onboarding.startChat.useMutation({ onSuccess: refresh });
  const later = trpc.onboarding.later.useMutation({ onSuccess: refresh });
  const tryIt = trpc.onboarding.tryIt.useMutation({ onSuccess: refresh });
  const v = q.data?.interview;
  if (!v) return <div className="ld-card" style={{ padding: "16px 18px" }}><span className="ld-muted">Loading...</span></div>;
  const s = v.state;
  const started = s.step > 0;
  const pill = s.done ? { l: "Done", c: "green" } : started ? { l: `Part ${Math.min(s.step + 1, v.total)} of ${v.total}`, c: "amber" } : { l: "Not started", c: "gray" };
  const remind = s.remindAt ? new Date(s.remindAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  const base = emp.kind === "custom" ? `/chats/e/${emp.id}` : `/chats/${emp.kind}`;
  return (
    <div className="ld-card ld-resultcard" style={card}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>My onboarding</span>
          <span className={`ld-pill ${pill.c}`}>{pill.l}</span>
        </div>
        <span style={{ fontSize: 14, color: "var(--ld-text2)" }}>{s.done ? "Everything you told me is in my Guidelines. You can change any line there." : `${v.total} parts · about 10 minutes · you can stop and pick up later`}</span>
        {!s.done && remind && <span style={small}>{`I'll remind you ${remind}.`}</span>}
        <ErrorLine error={start.error || later.error || tryIt.error} />
      </div>
      <div style={col}>
        {s.done ? (
          <>
            <button type="button" className="ld-btn p" disabled={tryIt.isPending} onClick={() => tryIt.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>{tryIt.isPending ? "Working..." : "Try it"}</button>
            <Link href={`${base}/guidelines`} className="ld-btn">Guidelines</Link>
          </>
        ) : (
          <>
            <button type="button" className="ld-btn p" disabled={start.isPending} onClick={() => start.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>{start.isPending ? "Starting..." : started ? "Continue" : "Start"}</button>
            <button type="button" className="ld-btn" disabled={later.isPending || !!remind} onClick={() => later.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>Later</button>
          </>
        )}
      </div>
    </div>
  );
}

/** One interview question in chat, answered right in the card. */
export function OnboardingQuestionCard({ emp, qkey }: { emp: EmployeeRow; qkey: string }) {
  const { currentOrgId } = useTenant();
  const q = useView(emp.id);
  const refresh = useRefresh();
  const answer = trpc.onboarding.chatAnswer.useMutation({ onSuccess: refresh });
  const [draft, setDraft] = React.useState<Answer>("");
  const [facts, setFacts] = React.useState<Record<string, string> | null>(null);
  const [examples, setExamples] = React.useState<{ liked: boolean; text: string }[]>([]);
  const v = q.data?.interview;
  if (!v) return <div className="ld-card" style={{ padding: "16px 18px" }}><span className="ld-muted">Loading...</span></div>;
  const send = (value: unknown) => answer.mutate({ organizationId: currentOrgId, employeeId: emp.id, key: qkey, value: value as never });

  // The Brain part.
  if (qkey === "brain") {
    const done = v.state.step > 0 || v.state.done;
    const f = facts ?? Object.fromEntries(v.brain.map((x) => [x.key, x.value]));
    return (
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="ld-between"><span className="ld-lbl">{`Part 1 of ${v.total} · From your Brain`}</span>{done && <span className="ld-pill green">Done</span>}</div>
        {v.brain.map((x) => (
          <div key={x.key} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 10, alignItems: "center", fontSize: 14 }}>
            <b>{x.label}</b>
            {x.missing && !done ? <input className="ld-in" aria-label={x.label} placeholder={x.placeholder} value={f[x.key] ?? ""} onChange={(e) => setFacts({ ...f, [x.key]: e.target.value })} /> : <span style={{ overflowWrap: "anywhere" }} className={x.missing ? "ld-muted" : ""}>{x.value || "Not set"}</span>}
          </div>
        ))}
        {!done && (
          <div className="ld-row" style={{ gap: 8, paddingTop: 4 }}>
            <button type="button" className="ld-btn p" style={{ width: 128 }} disabled={answer.isPending} onClick={() => send(f)}>Looks right</button>
            <Link href={`${emp.kind === "custom" ? `/chats/e/${emp.id}` : `/chats/${emp.kind}`}/onboarding`} className="ld-btn" style={{ width: 150 }}>Fix on Onboarding</Link>
          </div>
        )}
        <ErrorLine error={answer.error} />
      </div>
    );
  }

  // A follow-up question.
  if (qkey.startsWith("followup:")) {
    const fu = v.state.followups[Number(qkey.split(":")[1])];
    if (!fu) return null;
    return (
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="ld-lbl">Follow-up question</span>
        <span style={{ fontWeight: 800, fontSize: 15 }}>{fu.q}</span>
        {fu.answer ? <span className="ld-pill green" style={{ alignSelf: "flex-start" }}>{fu.answer}</span> : (
          <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
            {fu.options.map((o) => <button key={o} type="button" className="ld-chip" disabled={answer.isPending} onClick={() => send(o)}>{o}</button>)}
          </div>
        )}
        <ErrorLine error={answer.error} />
      </div>
    );
  }

  const si = v.sections.findIndex((s) => s.questions.some((x) => x.key === qkey));
  if (si < 0) return null;
  const section = v.sections[si];
  const qi = section.questions.findIndex((x) => x.key === qkey);
  const qq = section.questions[qi];
  const cur = v.answers[qq.key] as Answer | undefined;
  const isAnswered = qq.type === "examples" ? v.state.examples.length > 0 || v.answers.__examplesSkipped === "yes" : filled(cur) || v.answers[`__skip_${qq.key}`] === "yes";
  const head = (
    <div className="ld-between" style={{ gap: 8 }}>
      <span className="ld-lbl">{`Part ${si + 1} of ${v.total} · ${section.title}`}</span>
      <span style={small}>{`Question ${qi + 1} of ${section.questions.length}`}</span>
    </div>
  );
  if (isAnswered) {
    return (
      <div className="ld-card ld-resultcard" style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 6 }}>
        {head}
        <span style={{ fontWeight: 700, fontSize: 14 }}>{qq.label}</span>
        <span className="ld-body" style={{ overflowWrap: "anywhere" }}>{showAnswer(qq, cur, v as View) || "Skipped"}</span>
      </div>
    );
  }
  const draftVal = qq.type === "multi" ? (Array.isArray(draft) ? draft : []) : draft;
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
      {head}
      <span style={{ fontWeight: 800, fontSize: 15 }}>{qq.label}</span>
      {qq.note && <span style={small}>{qq.note}</span>}
      {qq.type === "choice" && (
        <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {(qq.options ?? []).map((o) => <button key={o} type="button" className="ld-chip" disabled={answer.isPending} onClick={() => send(o)}>{o}</button>)}
        </div>
      )}
      {qq.type === "multi" && (
        <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {(qq.options ?? []).map((o) => {
            const on = (draftVal as string[]).includes(o);
            return <button key={o} type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setDraft(on ? (draftVal as string[]).filter((x) => x !== o) : [...(draftVal as string[]), o])}>{o}</button>;
          })}
        </div>
      )}
      {qq.type === "text" && <input className="ld-in" aria-label={qq.label} placeholder={qq.placeholder} value={String(draftVal)} maxLength={800} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && String(draftVal).trim()) send(draftVal); }} />}
      {qq.type === "samples" && <Samples emp={emp} view={v as View} value={undefined} onChange={(label) => send(label)} />}
      {qq.type === "examples" && <Examples value={examples} onChange={setExamples} />}
      <div className="ld-row" style={{ gap: 8 }}>
        {(qq.type === "multi" || qq.type === "text") && <button type="button" className="ld-btn p" style={{ width: 128 }} disabled={answer.isPending || !filled(draftVal)} onClick={() => send(draftVal)}>Answer</button>}
        {qq.type === "examples" && <button type="button" className="ld-btn p" style={{ width: 128 }} disabled={answer.isPending} onClick={() => send(examples)}>{examples.length ? "Done" : "None for now"}</button>}
        <button type="button" className="ld-btn" style={{ width: 128 }} disabled={answer.isPending} onClick={() => send("__skip")}>Skip</button>
      </div>
      <ErrorLine error={answer.error} />
    </div>
  );
}
