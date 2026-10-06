import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, PersonAvatar } from "../ui";
import { OnlineAvatar } from "../TeamChat";
import { NewChannel } from "./NewChannel";
import { Message, type Emp, type Person } from "./Message";
import type { Names } from "./text";
import type { Mentionable } from "./Composer";

/**
 * The channel's details on the right: what it's for, Edit, Mute and Leave,
 * members with roles and Add, pinned messages, files, and notifications.
 */

const fmtAt = (d: Date | string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function Details({ channel, onClose, onLeft, people, employees, names, who, admin, onOpenThread }: { channel: string; onClose: () => void; onLeft: () => void; people: Person[]; employees: Emp[]; names: Names; who: Mentionable; admin: boolean; onOpenThread: (id: number) => void }) {
  const { currentOrgId, chatOnly } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.teamChat.details.useQuery({ organizationId: currentOrgId, channel }, { enabled: currentOrgId > 0, refetchInterval: 15_000 });
  const refresh = () => Promise.all([utils.teamChat.details.invalidate(), utils.teamChat.channels.invalidate(), utils.teamChat.messages.invalidate()]);
  const setNotify = trpc.teamChat.setNotify.useMutation({ onSuccess: refresh });
  const leave = trpc.teamChat.leaveChannel.useMutation({ onSuccess: async () => { await refresh(); onLeft(); } });
  const archive = trpc.teamChat.archiveChannel.useMutation({ onSuccess: async () => { await refresh(); onLeft(); } });
  const add = trpc.teamChat.addMembers.useMutation({ onSuccess: refresh });
  const [edit, setEdit] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [leaving, setLeaving] = React.useState<"leave" | "archive" | null>(null);
  const d = q.data;
  if (!d) return <aside className="tc-side"><ErrorLine error={q.error} />{!q.error && <p className="ld-muted" style={{ padding: 20 }}>Loading</p>}</aside>;
  const isChannel = d.kind === "channel";
  const notify = (mode: "all" | "mentions" | "none") => d.id && setNotify.mutate({ organizationId: currentOrgId, channelId: d.id, notify: mode, muted: d.muted });
  return (
    <aside className="tc-side" aria-label="Channel details">
      {edit && d.id && <NewChannel onClose={() => setEdit(false)} onMade={() => { setEdit(false); refresh(); }} editing={{ id: d.id, name: d.name, purpose: d.purpose, private: d.private, aiAllowed: d.aiAllowed, general: d.general }} />}
      <div className="tc-sec">
        <div className="ld-between">
          <b style={{ fontSize: 15 }}>{isChannel ? `${d.private ? "🔒 " : "# "}${d.name}` : d.name}</b>
          <button type="button" className="ld-btn sm" onClick={onClose}>Close</button>
        </div>
        {isChannel && <span className="ld-small ld-muted">{d.purpose || "No purpose yet."}</span>}
        {isChannel && d.aiAllowed && !chatOnly && <span className="ld-small ld-muted">AI employees answer @mentions here.</span>}
        {isChannel && (
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            {d.canEdit && <button type="button" className="ld-btn sm" onClick={() => setEdit(true)}>Edit</button>}
            {d.id && (
              <button type="button" className="ld-btn sm" onClick={() => setNotify.mutate({ organizationId: currentOrgId, channelId: d.id!, notify: d.notify, muted: !d.muted })}>
                {d.muted ? "Unmute" : "Mute"}
              </button>
            )}
            {!d.general && <button type="button" className="ld-btn sm" onClick={() => setLeaving("leave")}>Leave</button>}
            {!d.general && d.canEdit && <button type="button" className="ld-btn sm" onClick={() => setLeaving("archive")}>Archive</button>}
          </div>
        )}
        {leaving && d.id && (
          <div className="tc-confirm">
            <span className="ld-small">{leaving === "leave" ? `Leave #${d.name}? ${d.private ? "Someone in it would have to add you back." : "You can join again from the channel list."}` : `Archive #${d.name}? It leaves everyone's list; its messages stay in search.`}</span>
            <span className="ld-row">
              <button type="button" className="ld-btn sm" onClick={() => setLeaving(null)}>Cancel</button>
              <button type="button" className="ld-btn sm danger" disabled={leave.isPending || archive.isPending} onClick={() => (leaving === "leave" ? leave.mutate({ organizationId: currentOrgId, channelId: d.id! }) : archive.mutate({ organizationId: currentOrgId, channelId: d.id! }))}>
                {leaving === "leave" ? "Leave" : "Archive"}
              </button>
            </span>
            <ErrorLine error={leave.error ?? archive.error} />
          </div>
        )}
      </div>
      <div className="tc-sec">
        <div className="ld-between">
          <b>Members · {d.members.length}</b>
          {isChannel && d.notIn.length > 0 && <button type="button" className="gp-link" onClick={() => setAdding((v) => !v)}>+ Add</button>}
        </div>
        {adding && (
          <div className="tc-addlist">
            {d.notIn.map((p) => (
              <button key={p.userId} type="button" className="gp-qi" disabled={add.isPending} onClick={() => add.mutate({ organizationId: currentOrgId, channelId: d.id!, userIds: [p.userId] }, { onSuccess: () => setAdding(false) })}>
                <PersonAvatar name={p.name} size={22} /> {p.name}
              </button>
            ))}
            <ErrorLine error={add.error} />
          </div>
        )}
        {d.members.map((m) => (
          <div key={m.userId} className="tc-pr">
            <OnlineAvatar name={m.name} src={m.avatarUrl} size={26} online={m.online} />
            <span className="gp-ell">{m.name}</span>
            <span className="ld-small ld-muted" style={{ marginLeft: "auto" }}>{m.role}</span>
          </div>
        ))}
      </div>
      <div className="tc-sec">
        <b>Pinned · {d.pinned.length}</b>
        {d.pinned.map((m) => (
          <Message key={m.id} m={m} people={people} employees={employees} names={names} who={who} admin={admin} compact onOpenThread={onOpenThread} onChanged={refresh} />
        ))}
        {!d.pinned.length && <span className="ld-small ld-muted">Pin a message from its ··· menu or the pin on hover.</span>}
      </div>
      <div className="tc-sec">
        <b>Files · {d.files.length}</b>
        {d.files.map((f, i) => (
          <div key={`${f.messageId}-${i}`} className="tc-pr">
            <span aria-hidden="true">{f.url ? "📎" : "🔗"}</span>
            {f.url ? (
              <a className="gp-ell" href={f.url} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 700, color: "#14221c" }}>{f.name}</a>
            ) : (
              <span className="gp-ell" title="Stored in Slack">{f.name} <span className="ld-small ld-muted">· in Slack</span></span>
            )}
            <span className="ld-small ld-muted" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{fmtAt(f.at)}</span>
          </div>
        ))}
        {!d.files.length && <span className="ld-small ld-muted">Files shared here show up in this list.</span>}
      </div>
      {isChannel && d.id && (
        <div className="tc-sec">
          <b>Notifications</b>
          <div className="tc-radios" role="radiogroup" aria-label="Notifications for this channel">
            {([["all", "All messages"], ["mentions", "Mentions only"], ["none", "Nothing"]] as const).map(([k, label]) => (
              <label key={k} className="ld-row ld-small" style={{ gap: 6 }}>
                <input type="radio" name="tc-notify" checked={d.notify === k} onChange={() => notify(k)} /> {label}
              </label>
            ))}
          </div>
          <span className="ld-small ld-muted">Push and sounds follow My account.{d.muted ? " This channel is muted." : ""}</span>
          <ErrorLine error={setNotify.error} />
        </div>
      )}
    </aside>
  );
}
