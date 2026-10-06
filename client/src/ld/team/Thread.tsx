import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { useAttachments } from "../chat/Extras";
import { Composer, type Mentionable } from "./Composer";
import { Message, type Emp, type Person } from "./Message";
import type { Names } from "./text";

/** A thread on the right: the message, its replies, and a reply box that can also send to the channel. */
export function Thread({ messageId, channel, onClose, people, employees, names, who, admin }: { messageId: number; channel: string; onClose: () => void; people: Person[]; employees: Emp[]; names: Names; who: Mentionable; admin: boolean }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.teamChat.thread.useQuery({ organizationId: currentOrgId, messageId }, { enabled: currentOrgId > 0, refetchInterval: 4_000 });
  const files = useAttachments(currentOrgId, 0, "team");
  const [text, setText] = React.useState("");
  const [also, setAlso] = React.useState(false);
  const send = trpc.teamChat.send.useMutation({
    onSuccess: async () => {
      setText("");
      setAlso(false);
      files.clear();
      await Promise.all([utils.teamChat.thread.invalidate(), utils.teamChat.messages.invalidate(), utils.teamChat.channels.invalidate()]);
    },
  });
  const panel = React.useRef<HTMLElement>(null);
  const n = q.data?.replies.length ?? 0;
  React.useEffect(() => {
    // The panel scrolls on its own; the page stays where it is.
    if (panel.current) panel.current.scrollTop = panel.current.scrollHeight;
  }, [n, messageId]);
  const submit = () => {
    const v = text.trim();
    if ((!v && !files.ready.length) || send.isPending || files.uploading) return;
    send.mutate({ organizationId: currentOrgId, channel, content: v, attachmentIds: files.ready.map((f) => f.id), threadOf: messageId, alsoToChannel: also });
  };
  const d = q.data;
  return (
    <aside ref={panel} className="tc-side tc-thread" aria-label="Thread">
      <div className="tc-sidehead">
        <b>Thread</b>
        <span className="ld-small ld-muted gp-ell">{d ? (d.parent.channel.startsWith("dm:") ? d.channelName : `# ${d.channelName}`) : ""}</span>
        <button type="button" className="ld-btn sm" onClick={onClose}>Close</button>
      </div>
      <div className="tc-threadmsgs">
        <ErrorLine error={q.error} />
        {d && (
          <>
            <Message m={d.parent} people={people} employees={employees} names={names} who={who} admin={admin} inThread />
            <div className="ld-teamday">{d.replies.length} {d.replies.length === 1 ? "reply" : "replies"}</div>
            {d.replies.map((r) => (
              <Message key={r.id} m={r} people={people} employees={employees} names={names} who={who} admin={admin} inThread />
            ))}
          </>
        )}
      </div>
      <div style={{ padding: "8px 10px 12px" }}>
        <Composer
          value={text}
          onChange={setText}
          onSend={submit}
          placeholder="Reply in thread"
          who={who}
          busy={send.isPending || files.uploading}
          disabled={!d}
          sendLabel="Reply"
          attach={files.button}
          chips={files.chips}
          note={files.note}
          compact
          extra={
            !d?.parent.channel.startsWith("dm:") ? (
              <label className="ld-row ld-small" style={{ gap: 6, marginLeft: 6, whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} /> Also send to {d ? `#${d.channelName}` : "the channel"}
              </label>
            ) : null
          }
        />
        <ErrorLine error={send.error} />
      </div>
    </aside>
  );
}
