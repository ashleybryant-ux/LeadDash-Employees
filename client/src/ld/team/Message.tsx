import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, ErrorLine, PersonAvatar, useEmployees } from "../ui";
import { Menu } from "../goals/shared";
import { fmtTime, parseJson } from "../meta";
import { AttachmentChip } from "../chat/Extras";
import { TeamText, type Names } from "./text";
import { Composer, EmojiPicker, EMOJIS, type Mentionable } from "./Composer";
import type { Outputs } from "../types";

/**
 * One message in a channel, a thread or a list: who, when, the text, files,
 * reactions, the "N replies" row, and the actions that show on hover (react,
 * reply in thread, pin, save, more). Editing opens the text with Save and
 * Cancel; nothing edits on a click.
 */

export type Msg = Outputs["teamChat"]["messages"]["messages"][number];
export type Person = { userId: number; name: string; avatarUrl: string | null };
export type Emp = { id: number; name: string; roleTitle: string; kind: string; avatar: string | null };

type Att = { id?: number; name: string; size?: number; kind?: string; url?: string | null; note?: string };

export function Files({ raw }: { raw: string | null }) {
  const list = parseJson<Att[]>(raw, []);
  if (!list.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
      {list.map((f, i) =>
        f.url ? (
          <AttachmentChip key={f.id ?? i} f={{ name: f.name, size: f.size ?? 0, kind: f.kind, url: f.url }} />
        ) : (
          <span key={f.id ?? i} className="ld-att" title="This file is stored in Slack; re-attach it here if you still need it.">
            <span className="ic">FILE</span>
            <span className="nm">{f.name}</span>
            <span className="sz">{f.note ?? "In Slack"}</span>
          </span>
        )
      )}
    </div>
  );
}

type Preview = Msg["previews"][number];

const fmtLen = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * The card under a link: a video (Loom, YouTube, Vimeo) with Play here, a
 * Google file by name, or a page with its picture, title and description.
 * Hide preview takes the card away for everyone; the link itself stays.
 */
export function LinkPreview({ p, onHide, hiding }: { p: Preview; onHide: () => void; hiding?: boolean }) {
  const [playing, setPlaying] = React.useState(false);
  const act = (label: string, onClick: () => void, key: string) => (
    <button key={key} type="button" className="tc-lp-act" onClick={onClick}>{label}</button>
  );
  const link = (label: string) => (
    <a key="open" className="tc-lp-act" href={p.url} target="_blank" rel="noreferrer noopener">{label}</a>
  );
  const hide = act("Hide preview", onHide, "hide");
  if (p.kind === "video") {
    const title = p.title ?? `Video on ${p.site}`;
    return (
      <div className="tc-lp">
        <span className="site">{p.site}{p.duration ? ` · ${fmtLen(p.duration)}` : ""}</span>
        <a className="t" href={p.url} target="_blank" rel="noreferrer noopener">{title}</a>
        {playing && p.embed ? (
          <iframe className="tc-lp-player" src={`${p.embed}${p.embed.includes("?") ? "&" : "?"}autoplay=1`} title={title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
        ) : (
          <button type="button" className="tc-lp-thumb" onClick={() => p.embed && setPlaying(true)} aria-label={`Play ${title} here`} disabled={!p.embed}>
            {p.image && <img src={p.image} alt="" loading="lazy" />}
            <i aria-hidden="true">▶</i>
            {p.duration ? <span>{fmtLen(p.duration)}</span> : null}
          </button>
        )}
        <div className="acts">
          {!playing && p.embed && act("Play here", () => setPlaying(true), "play")}
          {link(`Open in ${p.site}`)}
          {!hiding && hide}
        </div>
      </div>
    );
  }
  if (p.kind === "file") {
    return (
      <div className="tc-lp">
        <span className="site">{p.site}</span>
        <div className="row">
          <div style={{ minWidth: 0 }}>
            <a className="t" href={p.url} target="_blank" rel="noreferrer noopener">{p.title ?? "Shared file"}</a>
            <div className="d">{hostOf(p.url)}{p.title ? " · shared with the team" : " · opens for the people it is shared with"}</div>
          </div>
        </div>
        <div className="acts">
          {link("Open")}
          {!hiding && hide}
        </div>
      </div>
    );
  }
  return (
    <div className="tc-lp">
      <span className="site">{p.site || hostOf(p.url)}</span>
      <div className="row">
        {p.image && <img src={p.image} alt="" loading="lazy" />}
        <div style={{ minWidth: 0 }}>
          <a className="t" href={p.url} target="_blank" rel="noreferrer noopener">{p.title ?? hostOf(p.url)}</a>
          {p.description && <div className="d">{p.description}</div>}
        </div>
      </div>
      <div className="acts">
        {link("Open")}
        {!hiding && hide}
      </div>
    </div>
  );
}

export function Who({ m, people, employees, size = 36 }: { m: { userId: number; employeeId: number | null; authorName: string }; people: Person[]; employees: Emp[]; size?: number }) {
  // An employee can write in a direct message too (Simone sending a meeting link), where the channel lists no employees.
  const everyone = useEmployees().list;
  const e = m.employeeId ? employees.find((x) => x.id === m.employeeId) ?? everyone.find((x) => x.id === m.employeeId) : null;
  if (e) return <Avatar name={e.name} kind={e.kind} src={e.avatar} size={size} />;
  return <PersonAvatar name={m.authorName} src={people.find((p) => p.userId === m.userId)?.avatarUrl ?? null} size={size} />;
}

export function Reactions({ m, onReact }: { m: Msg; onReact: (emoji: string) => void }) {
  const [open, setOpen] = React.useState(false);
  if (m.deleted) return null;
  return (
    <div className="tc-rx">
      {m.reactions.map((r) => (
        <button key={r.emoji} type="button" className={r.me ? "me" : ""} title={r.names.join(", ")} onClick={() => onReact(r.emoji)} aria-pressed={r.me} aria-label={`${r.emoji} ${r.count}`}>
          {r.emoji} {r.count}
        </button>
      ))}
      <span style={{ position: "relative", display: "inline-flex" }}>
        <button type="button" className="add" aria-label="Add a reaction" onClick={() => setOpen((v) => !v)}>+</button>
        {open && (
          <EmojiPicker
            onPick={(e) => {
              onReact(e);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </span>
    </div>
  );
}

const fmtDayTime = (d: Date | string) => {
  const date = new Date(d);
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} at ${fmtTime(date)}`;
};

type Props = {
  m: Msg;
  people: Person[];
  employees: Emp[];
  names: Names;
  who: Mentionable;
  inThread?: boolean;
  onOpenThread?: (id: number) => void;
  highlight?: boolean;
  showWhere?: string;
  onChanged?: () => void;
  compact?: boolean;
  admin?: boolean;
};

export function Message({ m, people, employees, names, who, inThread, onOpenThread, highlight, showWhere, onChanged, compact, admin }: Props) {
  const { currentOrgId } = useTenant();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const refresh = async () => {
    await Promise.all([utils.teamChat.messages.invalidate(), utils.teamChat.thread.invalidate(), utils.teamChat.channels.invalidate(), utils.teamChat.view.invalidate(), utils.teamChat.details.invalidate()]);
    onChanged?.();
  };
  const react = trpc.teamChat.react.useMutation({ onSuccess: refresh });
  const pin = trpc.teamChat.pin.useMutation({ onSuccess: refresh });
  const save = trpc.teamChat.save.useMutation({ onSuccess: refresh });
  const edit = trpc.teamChat.edit.useMutation({ onSuccess: () => { setEditing(false); refresh(); } });
  const remove = trpc.teamChat.remove.useMutation({ onSuccess: refresh });
  const hidePreview = trpc.teamChat.hidePreview.useMutation({ onSuccess: refresh });
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(m.content);
  const [emoji, setEmoji] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const mine = m.userId === user?.id;
  const org = currentOrgId;
  const isAi = !!m.employeeId;
  const emp = isAi ? employees.find((e) => e.id === m.employeeId) : null;
  const quick = (e: string) => react.mutate({ organizationId: org, messageId: m.id, emoji: e });

  return (
    <div className={`tc-m ${highlight ? "hl" : ""} ${m.pinned ? "pinned" : ""}`} id={`m${m.id}`}>
      {!m.deleted && !editing && (
        <div className="tc-acts" role="toolbar" aria-label="Message actions">
          {EMOJIS.slice(0, 3).map((e) => (
            <button key={e} type="button" title={`React ${e}`} aria-label={`React ${e}`} onClick={() => quick(e)}>{e}</button>
          ))}
          <span style={{ position: "relative", display: "inline-flex" }}>
            <button type="button" title="More reactions" aria-label="More reactions" onClick={() => setEmoji((v) => !v)}>😊</button>
            {emoji && (
              <EmojiPicker
                align="right"
                onPick={(e) => {
                  quick(e);
                  setEmoji(false);
                }}
                onClose={() => setEmoji(false)}
              />
            )}
          </span>
          {!inThread && !m.threadOf && onOpenThread && <button type="button" title="Reply in thread" aria-label="Reply in thread" onClick={() => onOpenThread(m.id)}>💬</button>}
          <button type="button" title={m.pinned ? "Unpin" : "Pin to channel"} aria-label={m.pinned ? "Unpin" : "Pin to channel"} className={m.pinned ? "on" : ""} onClick={() => pin.mutate({ organizationId: org, messageId: m.id })}>📌</button>
          <button type="button" title={m.saved ? "Remove from saved" : "Save for later"} aria-label={m.saved ? "Remove from saved" : "Save for later"} className={m.saved ? "on" : ""} onClick={() => save.mutate({ organizationId: org, messageId: m.id })}>{m.saved ? "★" : "☆"}</button>
          <Menu label="More">
            {(close) => (
              <>
                <button type="button" role="menuitem" onClick={() => { navigator.clipboard?.writeText(`${location.origin}/chats/team/${m.channel}?at=${m.id}`).catch(() => null); close(); }}>Copy link</button>
                {mine && !isAi && <button type="button" role="menuitem" onClick={() => { setDraft(m.content); setEditing(true); close(); }}>Edit message</button>}
                {(mine || admin) && <button type="button" role="menuitem" className="danger" onClick={() => { setConfirm(true); close(); }}>Delete message</button>}
              </>
            )}
          </Menu>
        </div>
      )}
      <Who m={m} people={people} employees={employees} size={compact ? 30 : 36} />
      <div style={{ minWidth: 0, flex: 1 }}>
        {m.pinned && <div className="tc-pinline">📌 Pinned</div>}
        {showWhere && <div className="ld-small ld-muted" style={{ fontWeight: 700 }}>{showWhere}</div>}
        <div className="tc-head">
          <span className="tc-who">{m.authorName}</span>
          {emp && <span className="ld-small ld-muted">· {emp.roleTitle}, AI employee</span>}
          <span className="tc-when" title={fmtDayTime(m.createdAt)}>{fmtTime(m.createdAt)}</span>
          {m.editedAt && !m.deleted && <span className="ld-small ld-muted">(edited)</span>}
        </div>
        {m.deleted ? (
          <div className="ld-small ld-muted" style={{ fontStyle: "italic" }}>This message was deleted.</div>
        ) : editing ? (
          <div style={{ marginTop: 4 }}>
            <Composer value={draft} onChange={setDraft} onSend={() => draft.trim() && edit.mutate({ organizationId: org, messageId: m.id, content: draft })} placeholder="Edit your message" who={who} busy={edit.isPending} sendLabel="Save" compact autoFocus onCancel={() => setEditing(false)} />
            <ErrorLine error={edit.error} />
          </div>
        ) : (
          <>
            {m.content && <TeamText text={m.content} names={names} />}
            <Files raw={m.attachments} />
            {(m.previews ?? []).map((p) => (
              <LinkPreview key={p.url} p={p} hiding={hidePreview.isPending} onHide={() => hidePreview.mutate({ organizationId: org, messageId: m.id, url: p.url })} />
            ))}
          </>
        )}
        {!editing && m.reactions.length > 0 && <Reactions m={m} onReact={quick} />}
        {m.thread && !inThread && onOpenThread && (
          <button type="button" className="tc-rep" onClick={() => onOpenThread(m.id)}>
            <span className="avs">
              {m.thread.who.slice(0, 3).map((w) => (
                <Who key={w.name} m={{ userId: w.userId, employeeId: w.employeeId, authorName: w.name }} people={people} employees={employees} size={20} />
              ))}
            </span>
            {m.thread.count} {m.thread.count === 1 ? "reply" : "replies"}
            <span className="ld-small ld-muted" style={{ fontWeight: 600 }}>· last {fmtTime(m.thread.lastAt)}</span>
          </button>
        )}
        {confirm && (
          <div className="tc-confirm" role="alertdialog" aria-label="Delete this message?">
            <span className="ld-small">Delete this message? It stays in the record as deleted.</span>
            <span className="ld-row">
              <button type="button" className="ld-btn sm" onClick={() => setConfirm(false)}>Keep it</button>
              <button type="button" className="ld-btn sm danger" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: org, messageId: m.id }, { onSettled: () => setConfirm(false) })}>Delete</button>
            </span>
            <ErrorLine error={remove.error} />
          </div>
        )}
        <ErrorLine error={react.error ?? pin.error ?? save.error ?? hidePreview.error} />
      </div>
    </div>
  );
}
