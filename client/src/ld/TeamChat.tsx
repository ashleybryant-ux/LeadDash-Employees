import React from "react";
import { Link, useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { ChatList, ClientNamesSwitch, ErrorLine, PersonAvatar, Rail, useDmsElsewhere, useIsMobile, useOpenElsewhere } from "./ui";
import { Menu } from "./goals/shared";
import { fmtAgo, fmtTime, isSameDay } from "./meta";
import { DropFiles, useAttachments } from "./chat/Extras";
import { Composer, type Mentionable } from "./team/Composer";
import { Message, type Emp, type Person } from "./team/Message";
import { Thread } from "./team/Thread";
import { Details } from "./team/Details";
import { ScheduledBar, useScheduled } from "./team/Schedule";
import type { Names } from "./team/text";

/**
 * Team chat: a channel or a direct message, like Slack. Messages by day with
 * a New line, hover actions, reactions and threads; the composer below; a
 * thread or the channel details on the right.
 */

export function TeamIcon({ size = 46, priv = false }: { size?: number; priv?: boolean }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: Math.round(size * 0.26), background: priv ? "var(--ld-muted)" : "var(--ld-accent)", color: "#fff", fontSize: Math.round(size * (priv ? 0.4 : 0.44)), fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {priv ? "🔒" : "#"}
    </span>
  );
}

export function OnlineAvatar({ name, src, size, online }: { name: string; src: string | null; size: number; online: boolean }) {
  return (
    <span style={{ position: "relative", display: "flex", flexShrink: 0 }}>
      <PersonAvatar name={name} src={src} size={size} />
      {online && <span aria-label="Online" style={{ position: "absolute", right: -1, bottom: -1, width: Math.max(9, Math.round(size * 0.26)), height: Math.max(9, Math.round(size * 0.26)), borderRadius: 999, background: "#22a06b", border: "2px solid var(--ld-surface)" }} />}
    </span>
  );
}

export function DaySep({ date }: { date: Date }) {
  return (
    <div className="ld-teamday">
      {isSameDay(date, new Date()) ? "Today, " : ""}
      {date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
    </div>
  );
}

/** /chats/team/:channel */
export default function TeamChatPage({ params }: { params: { channel: string } }) {
  return (
    <div className="ld has-emp">
      <Rail active="chats" />
      <ChatList activeKind={`team:${params.channel}`} />
      <section className="ld-chatmain tc-main" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <TeamPane channel={params.channel} />
      </section>
    </div>
  );
}

export function useNamesFor(d: { people: Person[]; employees: Emp[] } | undefined, channels: { name: string; key: string }[]): { names: Names; who: Mentionable } {
  return React.useMemo(
    () => ({
      names: { people: d?.people.map((p) => p.name) ?? [], employees: d?.employees.map((e) => e.name) ?? [], channels },
      who: { people: d?.people ?? [], employees: d?.employees ?? [] },
    }),
    [d, channels]
  );
}

type Face = { userId: number; name: string; avatarUrl: string | null };
type Live = { lastMineId: number; typing: Face[]; seenBy: (Face & { at: Date })[] } | undefined;

const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

/** "4:48 PM" today; "yesterday 4:48 PM"; "Oct 10, 4:48 PM" before that. */
function seenWhen(at: Date) {
  const d = new Date(at);
  const today = new Date();
  if (isSameDay(d, today)) return fmtTime(d);
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (isSameDay(d, y)) return `yesterday ${fmtTime(d)}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${fmtTime(d)}`;
}

/**
 * Under my last message: who has opened it and when. One person in a direct
 * message; in a channel, everyone who has, newest first, with the latest time.
 */
function SeenLine({ live, lastId, mine, dm }: { live: Live; lastId: number; mine: boolean; dm: boolean }) {
  if (!live || !mine || !live.seenBy.length || live.lastMineId !== lastId) return null;
  const by = live.seenBy;
  const faces = by.slice(0, 3).map((p) => <PersonAvatar key={p.userId} name={p.name} src={p.avatarUrl} size={16} />);
  if (dm) {
    return (
      <div className="tc-seen">
        {faces}
        <span>Seen {seenWhen(by[0].at)}</span>
      </div>
    );
  }
  const names = by.map((p) => firstName(p.name));
  const text = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : `${names[0]}, ${names[1]} and ${names.length - 2} others`;
  return (
    <div className="tc-seen">
      {faces}
      <span>Seen by {text} · last at {seenWhen(by[0].at)}</span>
    </div>
  );
}

/** Above the composer: who is typing right now. Up to two names, then a count. */
function TypingLine({ who }: { who: Face[] }) {
  if (!who.length) return null;
  const names = who.map((p) => (who.length === 1 ? p.name : firstName(p.name)));
  const text = names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : `${names[0]}, ${names[1]} and ${names.length - 2} others are typing`;
  return (
    <div className="tc-typing">
      {who.slice(0, 2).map((p) => <PersonAvatar key={p.userId} name={p.name} src={p.avatarUrl} size={22} />)}
      <span>{text}</span>
      <span className="tc-dots"><i /><i /><i /></span>
    </div>
  );
}

function TeamPane({ channel }: { channel: string }) {
  const { currentOrgId, currentOrg } = useTenant();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [, go] = useLocation();
  const search = useSearch();
  const mobile = useIsMobile();
  const sp = new URLSearchParams(search);
  const threadId = Number(sp.get("thread")) || null;
  const info = sp.get("info") === "1";
  const at = Number(sp.get("at")) || null;

  const q = trpc.teamChat.messages.useQuery({ organizationId: currentOrgId, channel }, { enabled: currentOrgId > 0, refetchInterval: 4_000 });
  const live = trpc.teamChat.presence.useQuery({ organizationId: currentOrgId, channel }, { enabled: currentOrgId > 0, refetchInterval: 2_500 });
  const typingMut = trpc.teamChat.typing.useMutation();
  const chans = trpc.teamChat.channels.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const markRead = trpc.teamChat.markRead.useMutation({ onSuccess: () => utils.teamChat.channels.invalidate() });
  const setNotify = trpc.teamChat.setNotify.useMutation({ onSuccess: () => Promise.all([utils.teamChat.messages.invalidate(), utils.teamChat.channels.invalidate()]) });
  const files = useAttachments(currentOrgId, 0, "team");
  // The newest unread direct message from another workspace, for the bar under the header.
  const elsewhere = useDmsElsewhere();
  const openElsewhere = useOpenElsewhere();
  const [text, setText] = React.useState("");
  const send = trpc.teamChat.send.useMutation({
    onSuccess: async () => {
      setText("");
      files.clear();
      await Promise.all([utils.teamChat.messages.invalidate(), utils.teamChat.channels.invalidate()]);
    },
  });
  // Messages this person scheduled here; the clock beside Send adds one.
  const sched = useScheduled({ channel });
  const scheduleIt = (when: Date) => {
    const v = text.trim();
    if ((!v && !files.ready.length) || files.uploading) return;
    sched.schedule(v, files.ready.map((f) => f.id), when, () => {
      setText("");
      files.clear();
      if (wasTyping.current) {
        wasTyping.current = false;
        typedAt.current = 0;
        typingMut.mutate({ organizationId: currentOrgId, channel, on: false });
      }
    });
  };
  const bottom = React.useRef<HTMLDivElement>(null);
  const d = q.data;
  const list = d?.messages ?? [];
  const lastId = list.length ? list[list.length - 1].id : 0;
  const admin = !!chans.data?.admin;
  const channelNames = React.useMemo(() => (chans.data?.channels ?? []).map((c) => ({ name: c.name, key: c.key })), [chans.data]);
  const { names, who } = useNamesFor(d, channelNames);

  // The New line stays where it was when the channel opened; reading it doesn't move it.
  const [newAfter, setNewAfter] = React.useState<{ channel: string; id: number } | null>(null);
  React.useEffect(() => {
    if (d && (!newAfter || newAfter.channel !== channel)) setNewAfter({ channel, id: d.lastReadId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.channel, channel]);
  React.useEffect(() => {
    if (lastId) markRead.mutate({ organizationId: currentOrgId, channel, lastId });
    if (at) {
      document.getElementById(`m${at}`)?.scrollIntoView({ block: "center" });
    } else {
      // The composer sticks to the bottom of the window, so the page itself scrolls to the newest message.
      window.scrollTo(0, document.body.scrollHeight);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, channel, currentOrgId]);

  // Typing: a check-in every three seconds while the box has text, and an
  // "off" the moment it is emptied or sent, so the other side's line goes away.
  const typedAt = React.useRef(0);
  const wasTyping = React.useRef(false);
  const onChange = (v: string) => {
    setText(v);
    const has = v.trim().length > 0;
    if (has && Date.now() - typedAt.current > 3_000) {
      typedAt.current = Date.now();
      wasTyping.current = true;
      typingMut.mutate({ organizationId: currentOrgId, channel, on: true });
    } else if (!has && wasTyping.current) {
      wasTyping.current = false;
      typedAt.current = 0;
      typingMut.mutate({ organizationId: currentOrgId, channel, on: false });
    }
  };
  React.useEffect(() => {
    wasTyping.current = false;
    typedAt.current = 0;
  }, [channel]);

  const submit = () => {
    const v = text.trim();
    if ((!v && !files.ready.length) || send.isPending || files.uploading) return;
    if (wasTyping.current) {
      wasTyping.current = false;
      typedAt.current = 0;
      typingMut.mutate({ organizationId: currentOrgId, channel, on: false });
    }
    send.mutate({ organizationId: currentOrgId, channel, content: v, attachmentIds: files.ready.map((f) => f.id) });
  };
  const setUrl = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    go(`/chats/team/${channel}${s ? `?${s}` : ""}`, { replace: true });
  };
  const openThread = (id: number) => setUrl({ thread: String(id), info: null });
  const isDm = d?.kind === "dm";
  let lastDay: Date | null = null;
  let newShown = false;
  const side = threadId ? (
    <Thread messageId={threadId} channel={channel} onClose={() => setUrl({ thread: null })} people={d?.people ?? []} employees={d?.employees ?? []} names={names} who={who} admin={admin} />
  ) : info ? (
    <Details channel={channel} onClose={() => setUrl({ info: null })} onLeft={() => go("/chats/team/everyone")} people={d?.people ?? []} employees={d?.employees ?? []} names={names} who={who} admin={admin} onOpenThread={openThread} />
  ) : null;

  return (
    <div className={`tc-wrap ${side ? "with-side" : ""}`}>
      <div className={`tc-pane ${side && mobile ? "ld-hide-sm" : ""}`}>
        <header className="ld-emphead tc-head2">
          <Link href="/chats?list=1" className="ld-mobile-only" aria-label="Back to chats" style={{ color: "var(--ld-ink)", display: "flex" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </Link>
          {isDm ? <OnlineAvatar name={d?.title ?? ""} src={d?.people.find((p) => p.name === d.title)?.avatarUrl ?? null} size={40} online={!!d?.online} /> : <span className="tc-hash" aria-hidden="true">{d?.private ? "🔒" : "#"}</span>}
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25, minWidth: 0, flex: 1 }}>
            <b style={{ fontSize: 16 }} className="gp-ell">{d?.title ?? (channel === "everyone" ? "general" : "")}</b>
            <span className="ld-small ld-muted gp-ell">{d?.sub || (d && !isDm ? "No purpose yet. Add one from the details." : "")}</span>
          </span>
          {d && (
            <span className="tc-hbtns">
              {!isDm && (
                <button type="button" className="tc-members" onClick={() => setUrl({ info: "1", thread: null })} aria-label={`${d.memberCount} members`}>
                  <span className="avs">
                    {d.members.slice(0, 3).map((m) => (
                      <PersonAvatar key={m.userId} name={m.name} src={m.avatarUrl} size={22} />
                    ))}
                  </span>
                  <b>{d.memberCount}</b>
                </button>
              )}
              <button type="button" className={`tc-ic ${d.pinnedCount ? "on" : ""}`} title={`${d.pinnedCount} pinned`} aria-label={`${d.pinnedCount} pinned messages`} onClick={() => setUrl({ info: "1", thread: null })}>📌{d.pinnedCount ? <i>{d.pinnedCount}</i> : null}</button>
              {!isDm && d.id && (
                <Menu label="Notifications for this channel" buttonClass={`tc-ic ${d.muted ? "muted" : ""}`} button={d.muted ? "🔕" : "🔔"}>
                  {(close) => (
                    <>
                      {([["all", "All messages"], ["mentions", "Mentions only"], ["none", "Nothing"]] as const).map(([k, label]) => (
                        <button key={k} type="button" role="menuitemradio" aria-checked={d.notify === k && !d.muted} onClick={() => { setNotify.mutate({ organizationId: currentOrgId, channelId: d.id!, notify: k, muted: false }); close(); }}>
                          {d.notify === k && !d.muted ? "✓ " : ""}{label}
                        </button>
                      ))}
                      <button type="button" role="menuitem" onClick={() => { setNotify.mutate({ organizationId: currentOrgId, channelId: d.id!, notify: d.notify, muted: !d.muted }); close(); }}>{d.muted ? "Unmute" : "Mute channel"}</button>
                    </>
                  )}
                </Menu>
              )}
              <Link href={`/chats/search?in=${encodeURIComponent(channel)}`} className="tc-ic" aria-label="Search in this conversation" title="Search here">🔍</Link>
              <button type="button" className={`tc-ic ${info ? "on" : ""}`} aria-label="Details" title="Details" onClick={() => setUrl({ info: info ? null : "1", thread: null })}>ⓘ</button>
            </span>
          )}
          {currentOrg?.orgType === "healthcare" && <ClientNamesSwitch />}
        </header>
        {elsewhere.length > 0 && (
          <div className="tc-xbar" role="status">
            <PersonAvatar name={elsewhere[0].name} src={elsewhere[0].avatar} size={24} />
            <span className="tx">
              <b>{elsewhere[0].name}</b> messaged you in <b>{elsewhere[0].orgName}</b> {fmtAgo(elsewhere[0].lastAt)}.
            </span>
            <button type="button" className="ld-btn sm" onClick={() => openElsewhere(elsewhere[0])}>Open</button>
          </div>
        )}
        <DropFiles className="ld-chatpane tc-body" onDrop={files.onDrop}>
          <div className="ld-chatmsgs tc-msgs">
            <ErrorLine error={q.error} />
            {d && list.length === 0 && <div className="ld-empty" style={{ textAlign: "left", padding: "8px 0" }}>{isDm ? `Only you and ${d.title} see this conversation.` : `Say hello. ${d.general ? "Everyone in this workspace sees this channel." : d.private ? "Only its members see this channel." : "Everyone in this workspace can see this channel."}`}</div>}
            {list.map((m) => {
              const day = new Date(m.createdAt);
              const sep = !lastDay || !isSameDay(lastDay, day);
              lastDay = day;
              const isNew = !newShown && newAfter?.channel === channel && m.id > newAfter.id && m.userId !== user?.id;
              if (isNew) newShown = true;
              return (
                <React.Fragment key={m.id}>
                  {sep && <DaySep date={day} />}
                  {isNew && <div className="tc-new">New</div>}
                  <Message m={m} people={d!.people} employees={d!.employees} names={names} who={who} admin={admin} onOpenThread={openThread} highlight={at === m.id} />
                </React.Fragment>
              );
            })}
            <SeenLine live={live.data} lastId={lastId} mine={list.length > 0 && list[list.length - 1].userId === user?.id} dm={isDm} />
            <TypingLine who={live.data?.typing ?? []} />
            <ErrorLine error={send.error} />
            <div ref={bottom} />
          </div>
          <div className="ld-composer tc-compwrap">
            <ScheduledBar rows={sched.list} onSent={() => Promise.all([utils.teamChat.messages.invalidate(), utils.teamChat.channels.invalidate()])} />
            <ErrorLine error={sched.create.error} />
            <Composer value={text} onChange={onChange} onSend={submit} placeholder={`Message ${d ? (isDm ? d.title : `#${d.title}`) : "your team"}`} who={who} busy={send.isPending || files.uploading || sched.create.isPending} attach={files.button} chips={files.chips} note={files.note} onFiles={files.onDrop} onSchedule={scheduleIt} />
          </div>
        </DropFiles>
      </div>
      {side}
    </div>
  );
}
