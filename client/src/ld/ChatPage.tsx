import React from "react";
import { Link, Redirect } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, ChatList, EmpHeader, ErrorLine, PersonAvatar, Rail, useEmployees, useGo } from "./ui";
import { SUGGESTIONS, fmtDate, fmtTime, isSameDay, parseJson, type Kind } from "./meta";
import Guidelines from "./work/Guidelines";
import Opportunities from "./work/Opportunities";
import Pitches from "./work/Pitches";
import Drafts from "./work/Drafts";
import Posts from "./work/Posts";
import Articles from "./work/Articles";
import Pages from "./work/Pages";
import Videos from "./work/Videos";

export type EmployeeRow = ReturnType<typeof useEmployees>["list"][number];

const WORK: Partial<Record<Kind, React.FC<{ emp: EmployeeRow }>>> = {
  grants: Opportunities,
  speaking: Pitches,
  inbox: Drafts,
  social: Posts,
  blog: Articles,
  website: Pages,
  video: Videos,
};

/** /chats, /chats/:kind, /chats/:kind/work, /chats/:kind/guidelines, /chats/e/:id[...] */
export default function ChatPage({ params }: { params: { kind?: string; id?: string; tab?: string } }) {
  const { list, isLoading } = useEmployees();
  const emp = params.id ? list.find((e) => e.id === Number(params.id)) : params.kind ? list.find((e) => e.kind === params.kind) : null;
  const tab = (params.tab === "work" || params.tab === "guidelines" ? params.tab : "chat") as "chat" | "work" | "guidelines";

  if (!params.kind && !params.id && list.length > 0) {
    const first = list.find((e) => e.kind === "grants") ?? list[0];
    return <Redirect to={first.kind === "custom" ? `/chats/e/${first.id}` : `/chats/${first.kind}`} />;
  }

  const base = emp ? (emp.kind === "custom" ? `/chats/e/${emp.id}` : `/chats/${emp.kind}`) : "/chats";
  const Work = emp ? WORK[emp.kind as Kind] : undefined;
  const activeKey = emp ? (emp.kind === "custom" ? `e${emp.id}` : emp.kind) : null;

  return (
    <div className="ld">
      <Rail active="chats" />
      <ChatList activeKind={activeKey} />
      <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        {!emp ? (
          <div className="ld-empty" style={{ marginTop: 120 }}>{isLoading ? "Loading..." : "Pick an employee on the left."}</div>
        ) : (
          <>
            <EmpHeader emp={emp} active={tab} base={base} />
            {tab === "chat" && <ChatPane emp={emp} />}
            {tab === "work" && Work && <Work emp={emp} />}
            {tab === "guidelines" && <Guidelines emp={emp} />}
          </>
        )}
      </section>
    </div>
  );
}

// ==========================================
// Chat pane
// ==========================================

type Card = {
  type: "grant" | "event" | "video" | "page" | "post" | "article" | "reply";
  id: number;
  title: string;
  subtitle?: string;
  body?: string;
  url?: string | null;
  imageUrl?: string | null;
};

function ChatPane({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
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
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: 1, padding: "24px 32px", display: "flex", flexDirection: "column", gap: 22, maxWidth: 900, boxSizing: "border-box", width: "100%" }}>
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
          return (
            <React.Fragment key={m.id}>
              {sep && <DaySep date={day} />}
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                {m.role === "user" ? <PersonAvatar name={m.authorName.replace(/^Scheduled task: /, "Task")} /> : <Avatar name={emp.name} kind={emp.kind} src={emp.avatar} size={36} />}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div>
                    <div>
                      <span style={{ fontWeight: 800, fontSize: 14 }}>{m.authorName}</span>
                      <span style={{ fontSize: 12, color: "#5b6b64", fontWeight: 500, marginLeft: 6 }}>{fmtTime(m.createdAt)}</span>
                    </div>
                    <div style={{ fontSize: 15, lineHeight: 1.55, marginTop: 2, whiteSpace: "pre-wrap" }}>{m.content}</div>
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
              <PersonAvatar name="You" />
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

      <div style={{ padding: "0 32px 24px 32px", display: "flex", flexDirection: "column", gap: 12, maxWidth: 900, boxSizing: "border-box", width: "100%", position: "sticky", bottom: 0, background: "#f8fafb", paddingTop: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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

function ResultCard({ card, emp }: { card: Card; emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const go = useGo();
  const base = `/chats/${emp.kind}`;
  const [done, setDone] = React.useState<string | null>(null);
  const start = trpc.grants.startProposal.useMutation({
    onSuccess: async () => {
      await utils.grants.invalidate();
      go(`${base}/work?tab=proposals`);
    },
  });
  const dismissGrant = trpc.grants.dismissOpportunity.useMutation({ onSuccess: () => { setDone("Dismissed"); utils.grants.invalidate(); } });
  const pitch = trpc.speaking.writePitch.useMutation({ onSuccess: async () => { await utils.speaking.invalidate(); go(`${base}/work`); } });
  const dismissEvent = trpc.speaking.dismiss.useMutation({ onSuccess: () => { setDone("Dismissed"); utils.speaking.invalidate(); } });

  let actions: React.ReactNode = null;
  if (done) actions = <span className="ld-pill gray">{done}</span>;
  else if (card.type === "grant")
    actions = (
      <>
        <button type="button" className="ld-btn p" disabled={start.isPending} onClick={() => start.mutate({ organizationId: currentOrgId, opportunityId: card.id })}>
          {start.isPending ? "Starting..." : "Start proposal"}
        </button>
        <button type="button" className="ld-btn" onClick={() => dismissGrant.mutate({ organizationId: currentOrgId, id: card.id })}>Dismiss</button>
      </>
    );
  else if (card.type === "event")
    actions = (
      <>
        <button type="button" className="ld-btn p" disabled={pitch.isPending} onClick={() => pitch.mutate({ organizationId: currentOrgId, id: card.id })}>
          {pitch.isPending ? "Writing..." : "Write pitch"}
        </button>
        <button type="button" className="ld-btn" onClick={() => dismissEvent.mutate({ organizationId: currentOrgId, id: card.id })}>Dismiss</button>
      </>
    );
  else if (card.type === "post" || card.type === "article" || card.type === "reply")
    actions = (
      <Link href="/approvals" className="ld-btn p">Review</Link>
    );
  else
    actions = (
      <Link href={`${base}/work`} className="ld-btn">Open plan</Link>
    );

  return (
    <div className="ld-card" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: card.imageUrl ? "96px minmax(0, 1fr) 128px" : "minmax(0, 1fr) 128px", gap: 16, alignItems: "start" }}>
      {card.imageUrl && <img src={card.imageUrl} alt="" style={{ width: 96, height: 120, objectFit: "cover", borderRadius: 8 }} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <span style={{ fontWeight: 800, fontSize: 15 }}>{card.title}</span>
        {card.subtitle && <span style={{ fontSize: 14, color: "#3d4c45" }}>{card.subtitle}</span>}
        {card.body && <span style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-line" }}>{card.body}</span>}
        {card.url && (
          <a href={card.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>
            {card.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
          </a>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{actions}</div>
    </div>
  );
}
