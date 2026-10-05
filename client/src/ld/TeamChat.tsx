import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { ChatList, ErrorLine, PersonAvatar, Rail } from "./ui";
import { fmtTime, isSameDay } from "./meta";
import { MessageAttachments, useAttachments } from "./chat/Extras";

/**
 * Team chat: the people in this workspace talking to each other. The
 * Everyone channel, and a direct message with each person. No AI employees.
 */

export function TeamIcon({ size = 46 }: { size?: number }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: Math.round(size * 0.26), background: "#1b6b4a", color: "#fff", fontSize: Math.round(size * 0.44), fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      #
    </span>
  );
}

export function OnlineAvatar({ name, src, size, online }: { name: string; src: string | null; size: number; online: boolean }) {
  return (
    <span style={{ position: "relative", display: "flex", flexShrink: 0 }}>
      <PersonAvatar name={name} src={src} size={size} />
      {online && <span aria-label="Online" style={{ position: "absolute", right: -1, bottom: -1, width: 11, height: 11, borderRadius: 999, background: "#22a06b", border: "2px solid #fff" }} />}
    </span>
  );
}

/** /chats/team/:channel */
export default function TeamChatPage({ params }: { params: { channel: string } }) {
  return (
    <div className="ld has-emp">
      <Rail active="chats" />
      <ChatList activeKind={`team:${params.channel}`} />
      <section className="ld-chatmain" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <TeamPane channel={params.channel} />
      </section>
    </div>
  );
}

function DaySep({ date }: { date: Date }) {
  return (
    <div className="ld-teamday">
      {isSameDay(date, new Date()) ? "Today, " : ""}
      {date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
    </div>
  );
}

function TeamPane({ channel }: { channel: string }) {
  const { currentOrgId } = useTenant();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const q = trpc.teamChat.messages.useQuery({ organizationId: currentOrgId, channel }, { enabled: currentOrgId > 0, refetchInterval: 4_000 });
  const markRead = trpc.teamChat.markRead.useMutation({ onSuccess: () => utils.teamChat.channels.invalidate() });
  const files = useAttachments(currentOrgId, 0, "team");
  const [text, setText] = React.useState("");
  const send = trpc.teamChat.send.useMutation({
    onSuccess: async () => {
      setText("");
      files.clear();
      await Promise.all([utils.teamChat.messages.invalidate(), utils.teamChat.channels.invalidate()]);
    },
  });
  const bottom = React.useRef<HTMLDivElement>(null);
  const d = q.data;
  const list = d?.messages ?? [];
  const lastId = list.length ? list[list.length - 1].id : 0;

  React.useEffect(() => {
    if (lastId) markRead.mutate({ organizationId: currentOrgId, channel, lastId });
    bottom.current?.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, channel, currentOrgId]);

  const submit = () => {
    const v = text.trim();
    if ((!v && !files.ready.length) || send.isPending || files.uploading) return;
    send.mutate({ organizationId: currentOrgId, channel, content: v, attachmentIds: files.ready.map((f) => f.id) });
  };
  const photo = (id: number) => d?.people.find((p) => p.userId === id)?.avatarUrl ?? null;
  const myLast = [...list].reverse().find((m) => m.userId === user?.id);
  let lastDay: Date | null = null;

  return (
    <>
      <header className="ld-emphead" style={{ boxSizing: "border-box", height: 72, padding: "0 24px", background: "#fff", borderBottom: "1px solid #e3e9e6", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 10 }}>
        <Link href="/chats?list=1" className="ld-mobile-only" aria-label="Back to chats" style={{ color: "#14221c", display: "flex" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </Link>
        {channel === "everyone" ? <TeamIcon size={44} /> : <OnlineAvatar name={d?.title ?? ""} src={d?.people.find((p) => p.name === d.title)?.avatarUrl ?? null} size={44} online={!!d?.online} />}
        <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25, minWidth: 0 }}>
          <b style={{ fontSize: 16 }}>{d?.title ?? (channel === "everyone" ? "Everyone" : "")}</b>
          <span className="ld-small ld-muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d?.sub ?? ""}</span>
        </span>
      </header>
      <div className="ld-chatpane" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="ld-chatmsgs" style={{ flex: 1, padding: "20px 32px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 900, boxSizing: "border-box", width: "100%" }}>
          <ErrorLine error={q.error} />
          {d && list.length === 0 && <div className="ld-empty" style={{ textAlign: "left", padding: "8px 0" }}>{channel === "everyone" ? "Say hello to your team. Everyone in this workspace sees this channel." : `Only you and ${d.title} see this conversation.`}</div>}
          {list.map((m) => {
            const day = new Date(m.createdAt);
            const sep = !lastDay || !isSameDay(lastDay, day);
            lastDay = day;
            return (
              <React.Fragment key={m.id}>
                {sep && <DaySep date={day} />}
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <PersonAvatar name={m.authorName} src={photo(m.userId)} size={36} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div>
                      <span style={{ fontWeight: 800, fontSize: 14 }}>{m.authorName}</span>
                      <span style={{ fontSize: 12, color: "#5b6b64", fontWeight: 500, marginLeft: 6 }}>{fmtTime(m.createdAt)}</span>
                    </div>
                    {m.content && <div style={{ fontSize: 15, lineHeight: 1.55, marginTop: 2, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.content}</div>}
                    <MessageAttachments raw={m.attachments} />
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          {d?.seenAt && myLast && myLast.id === lastId && <div className="ld-small ld-muted" style={{ textAlign: "right" }}>Seen {fmtTime(d.seenAt)}</div>}
          <ErrorLine error={send.error} />
          <div ref={bottom} />
        </div>
        <div className="ld-composer" style={{ padding: "12px 32px 24px 32px", maxWidth: 900, boxSizing: "border-box", width: "100%", position: "sticky", bottom: 0, background: "#f8fafb" }}>
          <form
            className="ld-card"
            style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
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
              <label htmlFor="team-input" className="ld-sr">Message {d?.title ?? "your team"}</label>
              <textarea
                id="team-input"
                rows={2}
                value={text}
                placeholder={`Message ${d?.title ?? "your team"}`}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                style={{ flex: 1, border: 0, outline: "none", resize: "none", font: "inherit", fontSize: 15, background: "transparent", color: "#14221c" }}
              />
              <button type="submit" className="ld-btn p sm" disabled={send.isPending || files.uploading || (!text.trim() && !files.ready.length)}>
                Send
              </button>
            </div>
            {files.note && <span className="ld-small" role="alert" style={{ color: "#b42318" }}>{files.note}</span>}
          </form>
        </div>
      </div>
    </>
  );
}
