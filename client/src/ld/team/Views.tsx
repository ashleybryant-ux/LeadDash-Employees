import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ChatList, ErrorLine, Rail, BottomNav } from "../ui";
import { Message, type Msg } from "../team/Message";
import { useNamesFor } from "../TeamChat";

/** Unreads, Mentions and Saved: messages from every channel and direct message in one place. */

const TITLES = { unreads: ["Unreads", "Everything you haven't read yet, by conversation"], mentions: ["Mentions", "Messages that @mention you"], saved: ["Saved", "Messages you saved for later"] } as const;

export default function TeamViewPage({ params }: { params: { kind: string } }) {
  const kind = (["unreads", "mentions", "saved"].includes(params.kind) ? params.kind : "unreads") as "unreads" | "mentions" | "saved";
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.teamChat.view.useQuery({ organizationId: currentOrgId, kind }, { enabled: currentOrgId > 0, refetchInterval: 10_000 });
  const chans = trpc.teamChat.channels.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const general = trpc.teamChat.messages.useQuery({ organizationId: currentOrgId, channel: "everyone" }, { enabled: currentOrgId > 0 });
  const markRead = trpc.teamChat.markRead.useMutation({ onSuccess: () => Promise.all([utils.teamChat.view.invalidate(), utils.teamChat.channels.invalidate()]) });
  const channelNames = React.useMemo(() => (chans.data?.channels ?? []).map((c) => ({ name: c.name, key: c.key })), [chans.data]);
  const { names, who } = useNamesFor(general.data, channelNames);
  const people = general.data?.people ?? [];
  const employees = general.data?.employees ?? [];
  const admin = !!chans.data?.admin;
  const d = q.data;
  const [title, sub] = TITLES[kind];
  const row = (m: Msg & { channelName: string; dm: boolean }) => (
    <div key={m.id} className="tc-hit">
      <div className="ld-between">
        <span className="ld-small ld-muted" style={{ fontWeight: 700 }}>{m.dm ? `Direct message · ${m.channelName}` : `# ${m.channelName}`} · {new Date(m.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
        <Link href={`/chats/team/${m.channel}?${m.threadOf ? `thread=${m.threadOf}` : `at=${m.id}`}`} className="gp-link" style={{ fontWeight: 700, whiteSpace: "nowrap" }}>Open →</Link>
      </div>
      <Message m={m} people={people} employees={employees} names={names} who={who} admin={admin} compact inThread />
    </div>
  );
  return (
    <div className="ld has-emp">
      <Rail active="chats" />
      <ChatList activeKind={`team:view:${kind}`} />
      <section className="ld-chatmain tc-main" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <header className="ld-emphead tc-head2">
          <Link href="/chats?list=1" className="ld-mobile-only" aria-label="Back to chats" style={{ color: "var(--ld-ink)", display: "flex" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </Link>
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25, minWidth: 0 }}>
            <b style={{ fontSize: 16 }}>{title}</b>
            <span className="ld-small ld-muted">{sub}</span>
          </span>
        </header>
        <div className="tc-page">
          <ErrorLine error={q.error} />
          {!d && !q.error && <p className="ld-muted">Loading</p>}
          {d?.kind === "unreads" && (
            <>
              {!d.groups.length && <p className="ld-muted">You are caught up.</p>}
              {d.groups.map((g) => (
                <div key={g.channel} className="tc-group">
                  <div className="ld-between">
                    <b>{g.dm ? g.channelName : `# ${g.channelName}`} <span className="ld-small ld-muted">· {g.messages.length} new</span></b>
                    <span className="ld-row">
                      <button type="button" className="ld-btn sm" onClick={() => markRead.mutate({ organizationId: currentOrgId, channel: g.channel, lastId: g.messages[g.messages.length - 1].id })}>Mark read</button>
                      <Link href={`/chats/team/${g.channel}`} className="ld-btn sm">Open</Link>
                    </span>
                  </div>
                  {g.messages.map((m) => (
                    <Message key={m.id} m={m} people={people} employees={employees} names={names} who={who} admin={admin} compact inThread />
                  ))}
                </div>
              ))}
            </>
          )}
          {d && d.kind !== "unreads" && (
            <>
              {!d.messages.length && <p className="ld-muted">{kind === "mentions" ? "Nobody has @mentioned you yet." : "Nothing saved yet. Use the star on a message."}</p>}
              <div className="tc-hits">{d.messages.map(row)}</div>
            </>
          )}
        </div>
      </section>
      <BottomNav active="chats" />
    </div>
  );
}
