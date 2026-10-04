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
import Changes, { DevChangeCard } from "./work/Changes";
import Workflows from "./work/Workflows";
import { FindingsCard, PlatformPageCard, WebTaskCard } from "./chat/Platform";
import { CampaignDirectionsCard, DramaEpisodeCard, DramaKeyframesCard, DramaSeasonCard } from "./chat/Drama";
import { LaunchPlanCard, MeetingAgendaCard, MeetingNotesCard } from "./lead/Cards";
import { OnboardingCard, OnboardingQuestionCard } from "./onboarding/ChatCards";
import Onboarding from "./Onboarding";
import type { Outputs } from "./types";
import { SpokenTag, TalkButton, VoiceBar, useOneOnOne } from "./chat/OneOnOne";
import { AvatarVideoCard } from "./chat/Avatar";
import { AnswerCard, ApplicationDraftCard, LayoutChoiceCard, MessageAttachments, PagePreviewCard, QuickReplies, useAttachments } from "./chat/Extras";

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
  developer: Changes,
  platform: Workflows,
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
  type: "opportunity" | "application" | "application_draft" | "answer" | "choices" | "layout_choice" | "question" | "submitted" | "grant" | "event" | "video" | "page" | "post" | "article" | "reply" | "prospect" | "candidate" | "schedule_plan" | "prospect_sales" | "launch_plan" | "meeting_agenda" | "meeting_notes" | "onboarding" | "onboarding_q" | "bidprime_code" | "portal_code" | "bidprime_screen" | "browser_live" | "avatar_video" | "dev_change" | "web_task" | "web_code" | "platform_findings" | "platform_page" | "schedule" | "drama_season" | "drama_episode" | "drama_keyframes" | "campaign_directions";
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
  version?: number;
  before?: string;
  events?: { when: string; day?: string; title: string; calendar: string; color: string; clash?: boolean }[];
};

type Plan = Outputs["social"]["schedulePlan"];

function ChatPane({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const { user } = useAuth();
  const team = trpc.members.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, staleTime: 60_000 });
  const photoOf = (userId: number | null | undefined) => (userId && userId === user?.id ? user?.avatarUrl : team.data?.find((t) => t.userId === userId)?.avatarUrl) ?? null;
  const utils = trpc.useUtils();
  // While the employee works in the background, the chat shows it and picks up their messages as they post.
  const working = trpc.chat.working.useQuery({ organizationId: currentOrgId, employeeId: emp.id }, { refetchInterval: 3000 });
  const busy = Boolean(working.data?.busy);
  const messages = trpc.chat.list.useQuery({ organizationId: currentOrgId, employeeId: emp.id }, { refetchInterval: busy ? 4000 : 20_000 });
  const markRead = trpc.chat.markRead.useMutation({ onSuccess: () => utils.chat.summaries.invalidate() });
  const [text, setText] = React.useState("");
  const [pending, setPending] = React.useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = React.useState<{ id: number; name: string; size: number; kind: "image" | "document"; url: string }[]>([]);
  const files = useAttachments(currentOrgId, emp.id);
  const send = trpc.chat.send.useMutation({
    onSuccess: async (r, v) => {
      setPending(null);
      setPendingFiles([]);
      // In a one-on-one, the answer is also played out loud.
      if (v.spoken) talk.heard(r);
      await Promise.all([utils.chat.list.invalidate(), utils.chat.summaries.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
    },
    onError: () => { setPending(null); setPendingFiles([]); },
  });
  const lastMsgId = messages.data?.length ? messages.data[messages.data.length - 1].id : null;
  const talk = useOneOnOne({
    orgId: currentOrgId,
    emp,
    lastId: lastMsgId,
    sending: send.isPending,
    say: (value) => {
      setPending(value);
      send.mutate({ organizationId: currentOrgId, employeeId: emp.id, text: value, attachmentIds: [], spoken: true });
    },
    onEnded: () => {
      void utils.chat.list.invalidate();
      void utils.coo.invalidate();
    },
  });
  const bottom = React.useRef<HTMLDivElement>(null);
  const composer = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    markRead.mutate({ organizationId: currentOrgId, employeeId: emp.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id, currentOrgId, messages.data?.length]);

  React.useEffect(() => {
    // Cards (page previews, drafts) load after the message, so scroll again once they have height.
    const go = () => {
      // The message box sits over the bottom of the chat, so leave room for it.
      if (bottom.current && composer.current) bottom.current.style.scrollMarginBottom = `${composer.current.offsetHeight + 12}px`;
      bottom.current?.scrollIntoView({ block: "end" });
    };
    go();
    const t1 = setTimeout(go, 400);
    const t2 = setTimeout(go, 1500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [messages.data?.length, pending, busy]);

  const submit = (value: string) => {
    const v = value.trim();
    const attached = files.ready;
    if ((!v && !attached.length) || send.isPending || files.uploading) return;
    setPending(v);
    setPendingFiles(attached);
    setText("");
    files.clear();
    send.mutate({ organizationId: currentOrgId, employeeId: emp.id, text: v, attachmentIds: attached.map((f) => f.id), spoken: talk.active });
  };
  /** A tapped quick reply goes out as the person's message, without touching files waiting in the box. */
  const pick = (value: string) => {
    if (send.isPending) return;
    setPending(value);
    send.mutate({ organizationId: currentOrgId, employeeId: emp.id, text: value, attachmentIds: [], spoken: talk.active });
  };

  const list = messages.data ?? [];
  const lastId = list.length ? list[list.length - 1].id : null;
  const lastHasReplies = list.length > 0 && parseJson<Card[]>(list[list.length - 1].cards, []).some((c) => c.type === "choices" || c.type === "layout_choice");
  let lastDay: Date | null = null;

  return (
    <div className="ld-chatpane" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="ld-chatmsgs" style={{ flex: 1, padding: "24px 32px", display: "flex", flexDirection: "column", gap: 22, maxWidth: 900, boxSizing: "border-box", width: "100%" }}>
        {list.length === 0 && pending === null && (
          <div className="ld-empty" style={{ textAlign: "left", padding: "8px 0" }}>
            {emp.description}
          </div>
        )}
        {list.map((m) => {
          const day = new Date(m.createdAt);
          const sep = !lastDay || !isSameDay(lastDay, day);
          lastDay = day;
          const allCards = parseJson<Card[]>(m.cards, []);
          const cards = allCards.filter((c) => c.type !== "choices");
          // Quick replies show only under the latest message, while nothing is being sent.
          const replies = m.id === lastId && pending === null && !busy ? allCards.filter((c) => c.type === "choices").flatMap((c) => c.options ?? []) : [];
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
                    {m.content && <div style={{ fontSize: 15, lineHeight: 1.55, marginTop: 2, whiteSpace: "pre-wrap" }}>{m.role === "user" ? m.content : <Rich text={m.content} />}</div>}
                    {m.role === "user" && <MessageAttachments raw={m.attachments} />}
                    {m.spoken && <SpokenTag role={m.role} />}
                  </div>
                  {cards.map((c) =>
                    c.type === "layout_choice" ? (
                      <LayoutChoiceCard key={`${c.type}-${c.id}`} options={c.options ?? []} onPick={pick} disabled={m.id !== lastId || pending !== null || send.isPending} />
                    ) : c.type === "avatar_video" ? (
                      <AvatarVideoCard key={`${c.type}-${c.id}`} id={c.id} />
                    ) : c.type === "dev_change" ? (
                      <DevChangeCard key={`${c.type}-${c.id}`} id={c.id} />
                    ) : c.type === "web_task" ? (
                      <WebTaskCard key={`${c.type}-${c.id}`} id={c.id} empName={emp.name} />
                    ) : c.type === "platform_findings" ? (
                      <FindingsCard key={`${c.type}-${c.id}`} />
                    ) : c.type === "drama_season" ? (
                      <DramaSeasonCard key={`${c.type}-${c.id}`} firstId={c.id} />
                    ) : c.type === "drama_keyframes" ? (
                      <DramaKeyframesCard key={`${c.type}-${c.id}`} id={c.id} />
                    ) : c.type === "campaign_directions" ? (
                      <CampaignDirectionsCard key={`${c.type}-${c.id}`} id={c.id} />
                    ) : c.type === "drama_episode" ? (
                      <DramaEpisodeCard key={`${c.type}-${c.id}`} id={c.id} />
                    ) : c.type === "platform_page" ? (
                      <PlatformPageCard key={`${c.type}-${c.id}`} id={c.id} />
                    ) : (
                      <ResultCard key={`${c.type}-${c.id}`} card={c} emp={emp} />
                    )
                  )}
                  <QuickReplies options={replies} onPick={pick} disabled={send.isPending} />
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
        {pending !== null && (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", opacity: 0.8 }}>
              <PersonAvatar name="You" src={user?.avatarUrl} />
              <div style={{ minWidth: 0 }}>
                {pending && <div style={{ fontSize: 15, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{pending}</div>}
                {pendingFiles.length > 0 && <MessageAttachments raw={JSON.stringify(pendingFiles)} />}
              </div>
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
        {pending === null && busy && (
          <div style={{ display: "flex", gap: 12, alignItems: "center" }} role="status" aria-live="polite">
            <Avatar name={emp.name} kind={emp.kind} src={emp.avatar} size={36} />
            <span className="ld-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{emp.name} is working</span>
              {working.data?.what && <span className="ld-small ld-muted" style={{ overflowWrap: "anywhere" }}>{working.data.what}</span>}
            </span>
          </div>
        )}
        <ErrorLine error={send.error} />
        <div ref={bottom} />
      </div>

      <div ref={composer} className="ld-composer" style={{ padding: "0 32px 24px 32px", display: "flex", flexDirection: "column", gap: 12, maxWidth: 900, boxSizing: "border-box", width: "100%", position: "sticky", bottom: 0, background: "#f8fafb", paddingTop: 12 }}>
        <VoiceBar o={talk} emp={emp} thinking={send.isPending} />
        {!lastHasReplies && !talk.active && <div className="ld-sugs" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(SUGGESTIONS[emp.kind as Kind] ?? []).map((s) => (
            <button key={s} type="button" className="ld-sug" onClick={() => (s.startsWith("Paste") ? setText("") : submit(s))} disabled={send.isPending}>
              {s}
            </button>
          ))}
        </div>}
        <form
          className="ld-card"
          style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            submit(text);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            files.onDrop(e.dataTransfer.files);
          }}
        >
          {files.chips}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
          {files.button}
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
          <TalkButton o={talk} name={emp.name} />
          <button type="submit" className="ld-btn p sm" disabled={send.isPending || files.uploading || (!text.trim() && !files.ready.length)}>
            Send
          </button>
          </div>
          {files.note && <span className="ld-small" role="alert" style={{ color: "#b42318" }}>{files.note}</span>}
        </form>
      </div>
    </div>
  );
}

/** An employee's message with **bold** shown as bold and "# " heading marks dropped, so no stray asterisks show. */
function Rich({ text }: { text: string }) {
  const clean = text.replace(/^#{1,6}\s+/gm, "");
  const parts = clean.split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : <React.Fragment key={i}>{p.replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|[.,!?]|$)/g, "$1$2")}</React.Fragment>))}</>;
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
  const research = trpc.applications.research.useMutation({
    onSuccess: (r) => {
      setDone(r.status === "found" ? `Found: ${r.answer}` : r.status === "emailed" ? "Not public. The email to the host is in Approvals" : r.status === "answered" ? r.answer : "Not found anywhere public");
      utils.applications.invalidate();
    },
  });
  const move = trpc.hiring.move.useMutation({
    onSuccess: (_r, v) => {
      setDone(v.stage === "interview" ? "Moved to Interview" : v.stage === "hold" ? "On hold" : "Passed");
      utils.hiring.people.invalidate();
      utils.publishing.listApprovalQueue.invalidate();
    },
  });
  const outreach = trpc.sales.startOutreach.useMutation({ onSuccess: () => { setDone("Passed to Jada"); utils.sales.invalidate(); } });
  const notFit = trpc.sales.notFit.useMutation({ onSuccess: () => { setDone("Not a fit"); utils.sales.invalidate(); } });
  const err = start.error || skip.error || submit.error || answer.error || research.error || move.error || outreach.error || notFit.error;

  if (card.type === "schedule_plan" && card.plan) return <PlanCard card={card} emp={emp} />;
  if (card.type === "page" && (card.version || card.subtitle?.includes("version"))) return <PagePreviewCard id={card.id} version={card.version ?? (Number(card.subtitle?.match(/version (\d+)/)?.[1]) || undefined)} title={card.title} kind={card.subtitle?.startsWith("Website") ? "Website page" : "Landing page"} />;
  if (card.type === "application_draft") return <ApplicationDraftCard id={card.id} base={base} />;
  if (card.type === "answer") return <AnswerCard title={card.title} body={card.body ?? ""} before={card.before ?? ""} subtitle={card.subtitle} />;
  if (card.type === "launch_plan") return <LaunchPlanCard id={card.id} />;
  if (card.type === "meeting_agenda") return <MeetingAgendaCard id={card.id} />;
  if (card.type === "meeting_notes") return <MeetingNotesCard id={card.id} />;
  if (card.type === "onboarding") return <OnboardingCard emp={emp} />;
  if (card.type === "onboarding_q") return <OnboardingQuestionCard emp={emp} qkey={card.title} />;
  if (card.type === "bidprime_code" || card.type === "portal_code" || card.type === "web_code") return <CodeCard card={card} />;
  if (card.type === "browser_live") return <BrowserCard card={card} />;
  if (card.type === "schedule") return <ScheduleCard events={card.events ?? []} />;
  if (card.type === "bidprime_screen" && card.imageUrl)
    return (
      <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="ld-lbl">{card.title}</span>
        <a href={card.imageUrl} target="_blank" rel="noreferrer noopener"><img src={card.imageUrl} alt={card.title} style={{ width: "100%", maxWidth: 640, borderRadius: 8, border: "1px solid #e3e9e6" }} /></a>
      </div>
    );

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
            <button type="button" className="ld-sug" style={{ borderRadius: 9, height: 36, fontWeight: 700, color: "#155c3e", borderColor: "#1b6b4a" }} disabled={research.isPending} onClick={() => research.mutate({ organizationId: currentOrgId, questionId: card.id })}>
              {research.isPending ? "Looking it up..." : "Look it up"}
            </button>
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
        <Link href={`${base}/work?opp=${card.id}`} className="ld-btn">Details</Link>
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
  else if (card.type === "page" && card.subtitle?.includes("version")) actions = <PageCardActions id={card.id} href={`${base}/work?page=${card.id}`} />;
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

/** Avery's schedule: every calendar together, each event tagged by its calendar; overlaps shaded. */
function ScheduleCard({ events }: { events: NonNullable<Card["events"]> }) {
  let lastDay = "";
  return (
    <div className="ld-card" style={{ padding: 0, overflow: "hidden" }}>
      {events.map((e, i) => {
        const header = e.day && e.day !== lastDay ? e.day : "";
        if (e.day) lastDay = e.day;
        return (
          <React.Fragment key={i}>
            {header && <div style={{ padding: "10px 16px 6px", fontSize: 12, fontWeight: 700, color: "#5b6b64", textTransform: "uppercase", letterSpacing: "0.06em", borderTop: i ? "1px solid #e3e9e6" : 0 }}>{header}</div>}
            <div className="ld-sched" style={{ display: "grid", gridTemplateColumns: "170px minmax(0,1fr) 200px", gap: 14, padding: "11px 16px", borderBottom: i < events.length - 1 ? "1px solid #eef2f0" : 0, fontSize: 14, alignItems: "center", background: e.clash ? "#fdf6ee" : undefined }}>
              <b>{e.when}</b>
              <span style={{ overflowWrap: "anywhere" }}>{e.title}{e.clash ? <span className="ld-small" style={{ color: "#8a4510", marginLeft: 8, fontWeight: 700 }}>Overlaps</span> : null}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#3d4c45", fontWeight: 600, minWidth: 0 }}>
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 999, background: e.color, flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.calendar}</span>
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** A sign-in code a site sent: held in memory for 10 minutes, never saved. */
function CodeCard({ card }: { card: Card }) {
  const { currentOrgId } = useTenant();
  const [code, setCode] = React.useState("");
  const bp = trpc.bidprime.code.useMutation();
  const portal = trpc.bidprime.portalCode.useMutation();
  const web = trpc.web.code.useMutation();
  const m = card.type === "bidprime_code" ? bp : card.type === "web_code" ? web : portal;
  const send = () => {
    if (card.type === "bidprime_code") bp.mutate({ organizationId: currentOrgId, code: code.trim() });
    else if (card.type === "web_code") web.mutate({ organizationId: currentOrgId, id: card.id, code: code.trim() });
    else portal.mutate({ organizationId: currentOrgId, portalId: card.id, applicationId: Number(card.url), code: code.trim() });
  };
  const inputId = `code-${card.type}-${card.id}-${card.url ?? ""}`;
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 128px", gap: 16, alignItems: "end" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <span style={{ fontWeight: 800, fontSize: 15 }}>{card.title}</span>
        {card.subtitle && <span style={{ fontSize: 14, color: "#3d4c45" }}>{card.subtitle}</span>}
        {card.imageUrl && (
          <a href={card.imageUrl} target="_blank" rel="noreferrer noopener"><img src={card.imageUrl} alt="What the site showed" style={{ width: "100%", maxWidth: 480, borderRadius: 8, border: "1px solid #e3e9e6", marginTop: 4 }} /></a>
        )}
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

const LIVE_KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** An employee's browser, live: watch it, take over when it's stuck, hand it back. */
function BrowserCard({ card }: { card: Card }) {
  const { currentOrgId } = useTenant();
  const id = card.url ?? "";
  const [ended, setEnded] = React.useState(false);
  const q = trpc.browser.live.useQuery({ organizationId: currentOrgId }, { refetchInterval: ended ? false : 1000 });
  const utils = trpc.useUtils();
  const after = () => utils.browser.live.invalidate();
  const takeOver = trpc.browser.takeOver.useMutation({ onSuccess: after });
  const handBack = trpc.browser.handBack.useMutation({ onSuccess: after });
  const stop = trpc.browser.stop.useMutation({ onSuccess: after });
  const input = trpc.browser.input.useMutation({ onSuccess: after });
  const [text, setText] = React.useState("");
  const v = q.data;
  const mine = v && v.id === id;
  const state = mine ? v.state : v ? "ended" : "starting";
  React.useEffect(() => {
    if (state === "done" || state === "stopped" || state === "ended") setEnded(true);
  }, [state]);
  const control = state === "control";
  const active = state === "starting" || state === "running" || state === "waiting" || state === "control";
  const send = (i: { kind: "click"; x: number; y: number } | { kind: "type"; text: string } | { kind: "key"; key: string } | { kind: "scroll"; dy: number }) =>
    input.mutate({ organizationId: currentOrgId, id, ...i } as Parameters<typeof input.mutate>[0]);

  if (state === "ended")
    return (
      <div className="ld-card" style={{ padding: "14px 18px" }}>
        <span className="ld-small ld-muted">{card.title}: this session has ended.</span>
      </div>
    );

  const pill =
    state === "control" ? <span className="ld-pill" style={{ background: "#e8effd", color: "#1e3a8a" }}>You're in control</span>
    : state === "waiting" ? <span className="ld-pill amber">Waiting for you</span>
    : state === "done" ? <span className="ld-pill green">Finished</span>
    : state === "stopped" ? <span className="ld-pill gray">Stopped</span>
    : <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#155c3e" }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: "#1b8a5a" }} />Live</span>;

  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{card.title}</span>
          {pill}
        </div>
        {control && (
          <div style={{ background: "#e8effd", border: "1px solid #c7d6fb", borderRadius: 10, padding: "10px 14px", fontSize: 14, color: "#1e3a8a", lineHeight: 1.5 }}>
            {card.title.replace(/'s browser$/, "")} is paused. Click and type right in the page. What you type goes straight to the site and isn't saved.
          </div>
        )}
        <div style={{ border: control ? "2px solid #1d4ed8" : "1px solid #cfd9d4", boxShadow: control ? "0 0 0 4px #dbe6fd" : undefined, borderRadius: 10, overflow: "hidden", background: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "8px 10px", background: "#eef2f0", borderBottom: "1px solid #dbe4df" }}>
            <span style={{ flex: 1, background: "#fff", border: "1px solid #dbe4df", borderRadius: 6, padding: "4px 10px", fontSize: 12, color: "#3d4c45", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {mine && v.url ? v.url.replace(/^https?:\/\//, "") : "Opening..."}
            </span>
          </div>
          <div
            tabIndex={control ? 0 : -1}
            role={control ? "application" : undefined}
            aria-label={control ? "The site. Click to click there; typing goes to the site." : undefined}
            style={{ position: "relative", aspectRatio: "1280 / 900", background: "#f4f6f8", cursor: control ? "pointer" : "default", outline: "none" }}
            onClick={(e) => {
              if (!control) return;
              const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              (e.currentTarget as HTMLDivElement).focus();
              send({ kind: "click", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
            }}
            onWheel={(e) => {
              if (control) send({ kind: "scroll", dy: Math.round(e.deltaY) });
            }}
            onKeyDown={(e) => {
              if (!control) return;
              if (LIVE_KEYS.has(e.key)) {
                e.preventDefault();
                send({ kind: "key", key: e.key });
              } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                send({ kind: "type", text: e.key });
              }
            }}
          >
            {mine && v.frame ? (
              <img src={v.frame} alt={`What ${card.title.replace(/'s browser$/, "")} sees`} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
            ) : (
              <span className="ld-small ld-muted" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>Opening the browser...</span>
            )}
          </div>
        </div>
        {mine && !control && (state === "waiting" ? v.reason : v.step) && <span style={{ fontSize: 13, color: "#3d4c45", lineHeight: 1.6 }}>{state === "waiting" ? v.reason : v.step}</span>}
        {control && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 96px", gap: 8, alignItems: "end" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label className="ld-lbl" htmlFor={`live-type-${id}`}>Type into the page</label>
              <input id={`live-type-${id}`} className="ld-in" value={text} autoComplete="off" placeholder="Text goes into the box you clicked" onChange={(e) => setText(e.target.value)} />
            </div>
            <button type="button" className="ld-btn" style={{ width: 96 }} disabled={input.isPending} onClick={async () => {
              if (text) await input.mutateAsync({ organizationId: currentOrgId, id, kind: "type", text });
              await input.mutateAsync({ organizationId: currentOrgId, id, kind: "key", key: "Enter" });
              setText("");
            }}>Enter</button>
          </div>
        )}
        <ErrorLine error={takeOver.error || handBack.error || stop.error || input.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {active && (control ? (
          <button type="button" className="ld-btn p" disabled={handBack.isPending} onClick={() => handBack.mutate({ organizationId: currentOrgId, id })}>Hand back</button>
        ) : (
          <button type="button" className={`ld-btn ${state === "waiting" ? "p" : ""}`} disabled={takeOver.isPending} onClick={() => takeOver.mutate({ organizationId: currentOrgId, id })}>Take over</button>
        ))}
        {active && <button type="button" className="ld-btn" disabled={stop.isPending} onClick={() => stop.mutate({ organizationId: currentOrgId, id })}>Stop</button>}
      </div>
    </div>
  );
}

/** A page Jordan built: open its preview, or copy its HTML straight from chat. */
function PageCardActions({ id, href }: { id: number; href: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    const r = await utils.pages.get.fetch({ organizationId: currentOrgId, id });
    await navigator.clipboard.writeText(r.html);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <>
      <Link href={href} className="ld-btn p">Preview</Link>
      <button type="button" className="ld-btn" onClick={copy}>{copied ? "Copied" : "Copy HTML"}</button>
    </>
  );
}
