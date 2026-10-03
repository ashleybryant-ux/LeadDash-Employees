import React from "react";
import { Link, Redirect } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, BottomNav, ChatList, EmpHeader, ErrorLine, PersonAvatar, Rail, useEmployees, useGo, useIsMobile } from "./ui";
import { SUGGESTIONS, fmtDate, fmtTime, isSameDay, parseJson, type Kind } from "./meta";
import Guidelines from "./work/Guidelines";
import ApplyWork from "./apply/ApplyWork";
import ApplicationPage from "./apply/ApplicationPage";
import Knowledge from "./apply/Knowledge";
import Drafts from "./work/Drafts";
import Posts from "./work/Posts";
import Articles from "./work/Articles";
import Pages from "./work/Pages";
import Videos from "./work/Videos";
import HiringWork from "./hiring/HiringWork";
import Prospects from "./work/Prospects";
import Outreach from "./work/Outreach";
import Leads from "./work/Leads";
import Launches from "./work/Launches";
import Meetings from "./work/Meetings";
import { LaunchPlanCard, MeetingAgendaCard, MeetingNotesCard } from "./lead/Cards";
import { OnboardingCard, OnboardingQuestionCard } from "./onboarding/ChatCards";
import Onboarding from "./Onboarding";
import type { Outputs } from "./types";

export type EmployeeRow = ReturnType<typeof useEmployees>["list"][number];

const WORK: Partial<Record<Kind, React.FC<{ emp: EmployeeRow }>>> = {
  grants: ApplyWork,
  speaking: ApplyWork,
  inbox: Drafts,
  social: Posts,
  blog: Articles,
  website: Pages,
  video: Videos,
  hiring: HiringWork,
  prospecting: Prospects,
  outreach: Outreach,
  leads: Leads,
  projects: Launches,
  coo: Meetings,
};

/** /chats, /chats/:kind, /chats/:kind/work, /chats/:kind/guidelines, /chats/e/:id[...] */
export default function ChatPage({ params }: { params: { kind?: string; id?: string; tab?: string; appId?: string; view?: string } }) {
  const { list, isLoading } = useEmployees();
  const emp = params.id ? list.find((e) => e.id === Number(params.id)) : params.kind ? list.find((e) => e.kind === params.kind) : null;
  const tab = (params.appId ? "work" : params.tab === "work" || params.tab === "guidelines" || params.tab === "knowledge" || params.tab === "onboarding" ? params.tab : "chat") as "chat" | "work" | "knowledge" | "onboarding" | "guidelines";

  const mobile = useIsMobile();
  // On a phone, /chats is the list of employees; on a computer it opens the first chat.
  const listOnly = !params.kind && !params.id && mobile;
  if (!params.kind && !params.id && list.length > 0 && !listOnly) {
    const first = list.find((e) => e.kind === "grants") ?? list[0];
    return <Redirect to={first.kind === "custom" ? `/chats/e/${first.id}` : `/chats/${first.kind}`} />;
  }

  const base = emp ? (emp.kind === "custom" ? `/chats/e/${emp.id}` : `/chats/${emp.kind}`) : "/chats";
  const Work = emp ? WORK[emp.kind as Kind] : undefined;
  const activeKey = emp ? (emp.kind === "custom" ? `e${emp.id}` : emp.kind) : null;

  return (
    <div className={`ld ${emp ? "has-emp" : "list-only"}`}>
      <Rail active="chats" />
      <ChatList activeKind={activeKey} />
      <section className="ld-chatmain" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        {!emp ? (
          <div className="ld-empty" style={{ marginTop: 120 }}>{isLoading ? "Loading..." : "Pick an employee on the left."}</div>
        ) : (
          <>
            <EmpHeader emp={emp} active={tab} base={base} />
            {tab === "chat" && <ChatPane emp={emp} />}
            {tab === "work" && params.appId && <ApplicationPage emp={emp} appId={Number(params.appId)} view={params.view === "review" ? "review" : "main"} />}
            {tab === "work" && !params.appId && Work && <Work emp={emp} />}
            {tab === "knowledge" && <Knowledge emp={emp} />}
            {tab === "onboarding" && <Onboarding emp={emp} />}
            {tab === "guidelines" && <Guidelines emp={emp} />}
          </>
        )}
      </section>
      {(!emp || tab !== "chat") && <BottomNav active="chats" />}
    </div>
  );
}

// ==========================================
// Chat pane
// ==========================================

type Card = {
  type: "opportunity" | "application" | "question" | "submitted" | "grant" | "event" | "video" | "page" | "post" | "article" | "reply" | "prospect" | "candidate" | "schedule_plan" | "prospect_sales" | "launch_plan" | "meeting_agenda" | "meeting_notes" | "onboarding" | "onboarding_q" | "bidprime_code" | "portal_code";
  id: number;
  title: string;
  subtitle?: string;
  body?: string;
  url?: string | null;
  imageUrl?: string | null;
  call?: string;
  score?: number;
  status?: string;
  options?: string[];
  plan?: Plan;
};

type Plan = Outputs["social"]["schedulePlan"];

function ChatPane({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const { user } = useAuth();
  const team = trpc.members.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, staleTime: 60_000 });
  const photoOf = (userId: number | null | undefined) => (userId && userId === user?.id ? user?.avatarUrl : team.data?.find((t) => t.userId === userId)?.avatarUrl) ?? null;
  const utils = trpc.useUtils();
  const messages = trpc.chat.list.useQuery({ organizationId: currentOrgId, employeeId: emp.id }, { refetchInterval: 20_000 });
  const markRead = trpc.chat.markRead.useMutation({ onSuccess: () => utils.chat.summaries.invalidate() });
  const [text, setText] = React.useState("");
  const [pending, setPending] = React.useState<string | null>(null);
  const send = trpc.chat.send.useMutation({
    onSuccess: async () => {
      setPending(null);
      await Promise.all([utils.chat.list.invalidate(), utils.chat.summaries.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
    },
    onError: () => setPending(null),
  });
  const bottom = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    markRead.mutate({ organizationId: currentOrgId, employeeId: emp.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id, currentOrgId, messages.data?.length]);

  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.data?.length, pending]);

  const submit = (value: string) => {
    const v = value.trim();
    if (!v || send.isPending) return;
    setPending(v);
    setText("");
    send.mutate({ organizationId: currentOrgId, employeeId: emp.id, text: v });
  };

  const list = messages.data ?? [];
  let lastDay: Date | null = null;

  return (
    <div className="ld-chatpane" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="ld-chatmsgs" style={{ flex: 1, padding: "24px 32px", display: "flex", flexDirection: "column", gap: 22, maxWidth: 900, boxSizing: "border-box", width: "100%" }}>
        {list.length === 0 && !pending && (
          <div className="ld-empty" style={{ textAlign: "left", padding: "8px 0" }}>
            {emp.description}
          </div>
        )}
        {list.map((m) => {
          const day = new Date(m.createdAt);
          const sep = !lastDay || !isSameDay(lastDay, day);
          lastDay = day;
          const cards = parseJson<Card[]>(m.cards, []);
          const queries = parseJson<string[]>(m.searchQueries, []);
          if (m.role === "handoff") {
            return (
              <React.Fragment key={m.id}>
                {sep && <DaySep date={day} />}
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#3d4c45", background: "#eef3f0", borderRadius: 10, padding: "8px 12px" }}>
                  <span style={{ fontWeight: 800, color: "#155c3e" }}>Handoff</span>
                  <span style={{ flex: 1, minWidth: 0 }}>{m.content}</span>
                  <span style={{ fontSize: 12, color: "#5b6b64", whiteSpace: "nowrap" }}>{fmtTime(m.createdAt)}</span>
                </div>
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={m.id}>
              {sep && <DaySep date={day} />}
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                {m.role === "user" ? <PersonAvatar name={m.authorName.replace(/^Scheduled task: /, "Task")} src={photoOf(m.userId)} /> : <Avatar name={emp.name} kind={emp.kind} src={emp.avatar} size={36} />}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div>
                    <div>
                      <span style={{ fontWeight: 800, fontSize: 14 }}>{m.authorName}</span>
                      <span style={{ fontSize: 12, color: "#5b6b64", fontWeight: 500, marginLeft: 6 }}>{fmtTime(m.createdAt)}</span>
                    </div>
                    {m.content && <div style={{ fontSize: 15, lineHeight: 1.55, marginTop: 2, whiteSpace: "pre-wrap" }}>{m.content}</div>}
                  </div>
                  {cards.map((c) => (
                    <ResultCard key={`${c.type}-${c.id}`} card={c} emp={emp} />
                  ))}
                  {queries.length > 0 && (
                    <details style={{ fontSize: 13, color: "#3d4c45" }}>
                      <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                        Searches {emp.name} ran ({queries.length})
                      </summary>
                      <div style={{ padding: "8px 0 0 14px", lineHeight: 1.7 }}>
                        {queries.map((q, i) => (
                          <div key={i}>{q}</div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            </React.Fragment>
          );
        })}
        {pending && (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", opacity: 0.8 }}>
              <PersonAvatar name="You" src={user?.avatarUrl} />
              <div style={{ fontSize: 15, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{pending}</div>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Avatar name={emp.name} kind={emp.kind} src={emp.avatar} size={36} />
              <span className="ld-dots" aria-label={`${emp.name} is working`}>
                <span />
                <span />
                <span />
              </span>
              <span className="ld-small ld-muted">{["grants", "speaking", "video"].includes(emp.kind) ? "Searching the web can take a minute or two." : ""}</span>
            </div>
          </>
        )}
        <ErrorLine error={send.error} />
        <div ref={bottom} />
      </div>

      <div className="ld-composer" style={{ padding: "0 32px 24px 32px", display: "flex", flexDirection: "column", gap: 12, maxWidth: 900, boxSizing: "border-box", width: "100%", position: "sticky", bottom: 0, background: "#f8fafb", paddingTop: 12 }}>
        <div className="ld-sugs" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(SUGGESTIONS[emp.kind as Kind] ?? []).map((s) => (
            <button key={s} type="button" className="ld-sug" onClick={() => (s.startsWith("Paste") ? setText("") : submit(s))} disabled={send.isPending}>
              {s}
            </button>
          ))}
        </div>
        <form
          className="ld-card"
          style={{ padding: "10px 12px", display: "flex", alignItems: "flex-end", gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            submit(text);
          }}
        >
          <label htmlFor="chat-input" className="ld-sr">Message {emp.name}</label>
          <textarea
            id="chat-input"
            rows={2}
            value={text}
            placeholder={`Message ${emp.name}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(text);
              }
            }}
            style={{ flex: 1, border: 0, outline: "none", resize: "none", font: "inherit", fontSize: 15, background: "transparent", color: "#14221c" }}
          />
          <button type="submit" className="ld-btn p sm" disabled={send.isPending || !text.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function DaySep({ date }: { date: Date }) {
  const today = isSameDay(date, new Date());
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, color: "#5b6b64", fontSize: 13, fontWeight: 700 }}>
      <span style={{ flex: 1, height: 1, background: "#e3e9e6" }} />
      {today ? `Today, ${fmtDate(date)}` : fmtDate(date)}
      <span style={{ flex: 1, height: 1, background: "#e3e9e6" }} />
    </div>
  );
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "10/06/2026" to "Tue, Oct 6, 2026". */
function dayLabel(mmddyyyy: string) {
  const [m, d, y] = mmddyyyy.split("/").map(Number);
  return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MO[m - 1]} ${d}, ${y}`;
}

/** Sienna's plan for the next posts on one account: Schedule all, Other times, Open calendar. */
function PlanCard({ card, emp }: { card: Card; emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [plan, setPlan] = React.useState<Plan>(card.plan!);
  const [others, setOthers] = React.useState(false);
  const [done, setDone] = React.useState<string | null>(null);
  const apply = trpc.social.applyPlan.useMutation({
    onSuccess: async (r) => {
      setDone(r.waiting ? `Scheduled ${r.scheduled + r.waiting}. ${r.waiting} post once approved.` : `Scheduled ${r.scheduled}`);
      await Promise.all([utils.social.listPosts.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
    },
  });
  const other = trpc.social.schedulePlan.useMutation({
    onSuccess: (p) => {
      setPlan(p);
      setOthers(false);
    },
  });
  const base = emp.kind === "custom" ? `/chats/e/${emp.id}` : `/chats/${emp.kind}`;
  return (
    <div className="ld-card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="ld-lbl">{card.title}</span>
      <span className="ld-small ld-muted">{plan.label}</span>
      {plan.rows.map((r) => (
        <div key={r.itemId} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "150px 80px minmax(0,1fr)", gap: 12, padding: "7px 0", borderBottom: "1px solid #eef2f0", fontSize: 14 }}>
          <span>{dayLabel(r.date)}</span>
          <span>{r.time}</span>
          <span style={{ minWidth: 0 }}>
            {r.title}
            {r.needsApproval && <span className="ld-muted" style={{ fontSize: 12, marginLeft: 6 }}>Needs approval</span>}
          </span>
        </div>
      ))}
      {done ? (
        <div className="ld-row" style={{ marginTop: 10, flexWrap: "wrap" }}>
          <span className="ld-pill green">{done}</span>
          <Link href={`${base}/work`} className="ld-btn">Open calendar</Link>
        </div>
      ) : (
        <>
          <div className="ld-row" style={{ marginTop: 10, flexWrap: "wrap" }}>
            <button type="button" className="ld-btn p" style={{ width: "auto", minWidth: 128 }} disabled={apply.isPending || plan.rows.length === 0} onClick={() => apply.mutate({ organizationId: currentOrgId, rows: plan.rows.map((r) => ({ itemId: r.itemId, at: r.at })) })}>
              {apply.isPending ? "Scheduling..." : `Schedule all ${plan.rows.length}`}
            </button>
            <button type="button" className="ld-btn" aria-expanded={others} onClick={() => setOthers(!others)}>Other times</button>
            <Link href={`${base}/work`} className="ld-btn">Open calendar</Link>
          </div>
          {others && (
            <div className="ld-row" style={{ flexWrap: "wrap", marginTop: 6 }}>
              {plan.choices.map((c) => (
                <button key={c.key} type="button" className={`ld-chip ${plan.patternKey === c.key ? "on" : ""}`} disabled={other.isPending} onClick={() => other.mutate({ organizationId: currentOrgId, channel: plan.channel, itemIds: plan.rows.map((r) => r.itemId), patternKey: c.key })}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <ErrorLine error={apply.error || other.error} />
    </div>
  );
}

function ResultCard({ card, emp }: { card: Card; emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const go = useGo();
  const base = `/chats/${emp.kind}`;
  const [done, setDone] = React.useState<string | null>(null);
  const start = trpc.applications.start.useMutation({
    onSuccess: async (app) => {
      await Promise.all([utils.applications.invalidate(), utils.opps.invalidate()]);
      go(`${base}/app/${app.id}`);
    },
  });
  const skip = trpc.opps.skip.useMutation({ onSuccess: () => { setDone("Skipped"); utils.opps.invalidate(); } });
  const submit = trpc.applications.submit.useMutation({ onSuccess: () => { setDone("Approved"); utils.applications.invalidate(); } });
  const answer = trpc.applications.answer.useMutation({ onSuccess: (_r, v) => { setDone(v.answer); utils.applications.invalidate(); } });
  const move = trpc.hiring.move.useMutation({
    onSuccess: (_r, v) => {
      setDone(v.stage === "interview" ? "Moved to Interview" : v.stage === "hold" ? "On hold" : "Passed");
      utils.hiring.people.invalidate();
      utils.publishing.listApprovalQueue.invalidate();
    },
  });
  const outreach = trpc.sales.startOutreach.useMutation({ onSuccess: () => { setDone("Passed to Jada"); utils.sales.invalidate(); } });
  const notFit = trpc.sales.notFit.useMutation({ onSuccess: () => { setDone("Not a fit"); utils.sales.invalidate(); } });
  const err = start.error || skip.error || submit.error || answer.error || move.error || outreach.error || notFit.error;

  if (card.type === "schedule_plan" && card.plan) return <PlanCard card={card} emp={emp} />;
  if (card.type === "launch_plan") return <LaunchPlanCard id={card.id} />;
  if (card.type === "meeting_agenda") return <MeetingAgendaCard id={card.id} />;
  if (card.type === "meeting_notes") return <MeetingNotesCard id={card.id} />;
  if (card.type === "onboarding") return <OnboardingCard emp={emp} />;
  if (card.type === "onboarding_q") return <OnboardingQuestionCard emp={emp} qkey={card.title} />;
  if (card.type === "bidprime_code" || card.type === "portal_code") return <CodeCard card={card} />;

  if (card.type === "question") {
    return (
      <div className="ld-card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <span className="ld-lbl">{card.title}</span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{card.body}</span>
        {done ? (
          <span className="ld-pill green">{done}</span>
        ) : (
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            {(card.options ?? []).map((o) => (
              <button key={o} type="button" className="ld-sug" style={{ borderRadius: 9, height: 36, fontWeight: 700, color: "#14221c" }} disabled={answer.isPending} onClick={() => answer.mutate({ organizationId: currentOrgId, questionId: card.id, answer: o })}>
                {o}
              </button>
            ))}
          </div>
        )}
        <ErrorLine error={err} />
      </div>
    );
  }

  let pill: React.ReactNode = null;
  let actions: React.ReactNode = null;
  if (done) actions = <span className="ld-pill gray">{done}</span>;
  else if (card.type === "opportunity") {
    pill = card.call ? <span className={`ld-pill ${card.call === "skip" ? "gray" : card.call === "partner" ? "amber" : "green"}`}>{`${card.call === "skip" ? "Skip" : card.call === "partner" ? "Partner" : "Apply"} · ${card.score ?? 0}`}</span> : null;
    actions = (
      <>
        <button type="button" className={`ld-btn ${card.call === "skip" ? "" : "p"}`} disabled={start.isPending} onClick={() => start.mutate({ organizationId: currentOrgId, opportunityId: card.id })}>
          {start.isPending ? "Starting..." : "Apply"}
        </button>
        <button type="button" className="ld-btn" onClick={() => skip.mutate({ organizationId: currentOrgId, id: card.id })}>Skip</button>
      </>
    );
  } else if (card.type === "application") {
    const ready = card.status === "ready";
    pill = card.status ? <span className={`ld-pill ${ready || card.status === "needs_answer" ? "amber" : card.status === "error" ? "red" : "gray"}`}>{ready ? "Waiting for you" : card.status === "needs_answer" ? "Needs an answer" : card.status === "writing" ? "Writing" : card.status === "needs_setup" ? "Needs Grants.gov" : card.status === "approved" ? "Approved" : card.status === "error" ? "Needs attention" : card.status}</span> : null;
    actions = (
      <>
        {ready && (
          <button type="button" className="ld-btn p" disabled={submit.isPending} onClick={() => submit.mutate({ organizationId: currentOrgId, id: card.id })}>Approve</button>
        )}
        <Link href={`${base}/app/${card.id}`} className="ld-btn">Open</Link>
      </>
    );
  } else if (card.type === "submitted") {
    pill = <span className="ld-pill green">Submitted</span>;
    actions = <Link href={`${base}/app/${card.id}`} className="ld-btn">Open</Link>;
  } else if (card.type === "prospect") {
    pill = <span className={`ld-pill ${(card.score ?? 0) >= 60 ? "green" : "gray"}`}>{`Fit · ${card.score ?? 0}`}</span>;
    actions = (
      <>
        <Link href={`${base}/work?tab=outreach`} className="ld-btn p">Reach out</Link>
        <button type="button" className="ld-btn" disabled={move.isPending} onClick={() => move.mutate({ organizationId: currentOrgId, id: card.id, stage: "passed" })}>Pass</button>
      </>
    );
  } else if (card.type === "candidate") {
    pill = <span className={`ld-pill ${(card.score ?? 0) >= 60 ? "green" : "gray"}`}>{card.score ?? 0}</span>;
    actions =
      card.status === "new" ? (
        <>
          <button type="button" className="ld-btn p" disabled={move.isPending} onClick={() => move.mutate({ organizationId: currentOrgId, id: card.id, stage: "interview" })}>Interview</button>
          <button type="button" className="ld-btn" disabled={move.isPending} onClick={() => move.mutate({ organizationId: currentOrgId, id: card.id, stage: "hold" })}>Hold</button>
        </>
      ) : (
        <Link href={`${base}/work?tab=candidates`} className="ld-btn">Open</Link>
      );
  } else if (card.type === "prospect_sales") {
    pill = <span className={`ld-pill ${(card.score ?? 0) >= 70 ? "green" : "gray"}`}>{`Fit · ${card.score ?? 0}`}</span>;
    actions =
      card.status === "new" ? (
        <>
          <button type="button" className="ld-btn p" disabled={outreach.isPending} onClick={() => outreach.mutate({ organizationId: currentOrgId, ids: [card.id] })}>Start outreach</button>
          <button type="button" className="ld-btn" disabled={notFit.isPending} onClick={() => notFit.mutate({ organizationId: currentOrgId, id: card.id })}>Not a fit</button>
        </>
      ) : (
        <Link href={`${base}/work`} className="ld-btn">Open</Link>
      );
  } else if (card.type === "post" || card.type === "article" || card.type === "reply") actions = <Link href="/approvals" className="ld-btn p">Review</Link>;
  else if (card.type === "page" || card.type === "video") actions = <Link href={`${base}/work`} className="ld-btn">Open plan</Link>;
  else actions = <Link href={`${base}/work`} className="ld-btn">Open</Link>;

  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: card.imageUrl ? "96px minmax(0, 1fr) 128px" : "minmax(0, 1fr) 128px", gap: 16, alignItems: "start" }}>
      {card.imageUrl && <img src={card.imageUrl} alt="" style={{ width: 96, height: 120, objectFit: "cover", borderRadius: 8 }} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{card.title}</span>
          {pill}
        </div>
        {card.subtitle && <span style={{ fontSize: 14, color: "#3d4c45" }}>{card.subtitle}</span>}
        {card.body && <span style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-line" }}>{card.body}</span>}
        {card.type === "application" && card.status === "ready" && (
          <span style={{ fontSize: 12, color: "#5b6b64", lineHeight: 1.5, marginTop: 4 }}>Approving certifies the application is true and complete and that you are authorized to submit it.</span>
        )}
        {card.url && (
          <a href={card.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>
            {card.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
          </a>
        )}
        <ErrorLine error={err} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{actions}</div>
    </div>
  );
}

/** A sign-in code a site sent: held in memory for 10 minutes, never saved. */
function CodeCard({ card }: { card: Card }) {
  const { currentOrgId } = useTenant();
  const [code, setCode] = React.useState("");
  const bp = trpc.bidprime.code.useMutation();
  const portal = trpc.bidprime.portalCode.useMutation();
  const m = card.type === "bidprime_code" ? bp : portal;
  const send = () => {
    if (card.type === "bidprime_code") bp.mutate({ organizationId: currentOrgId, code: code.trim() });
    else portal.mutate({ organizationId: currentOrgId, portalId: card.id, applicationId: Number(card.url), code: code.trim() });
  };
  const inputId = `code-${card.type}-${card.id}-${card.url ?? ""}`;
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 128px", gap: 16, alignItems: "end" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <span style={{ fontWeight: 800, fontSize: 15 }}>{card.title}</span>
        {card.subtitle && <span style={{ fontSize: 14, color: "#3d4c45" }}>{card.subtitle}</span>}
        {m.isSuccess ? (
          <span className="ld-pill green" style={{ alignSelf: "flex-start" }}>Got it. Signing in now</span>
        ) : (
          <>
            <label htmlFor={inputId} className="ld-lbl" style={{ marginTop: 4 }}>Code</label>
            <input
              id={inputId}
              className="ld-in"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              maxLength={12}
              style={{ maxWidth: 200, letterSpacing: 2 }}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && code.trim().length >= 4) send(); }}
            />
          </>
        )}
        <ErrorLine error={m.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {!m.isSuccess && (
          <button type="button" className="ld-btn p" disabled={m.isPending || code.trim().length < 4} onClick={send}>
            {m.isPending ? "Sending..." : "Send code"}
          </button>
        )}
      </div>
    </div>
  );
}
