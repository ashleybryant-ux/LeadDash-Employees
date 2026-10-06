import React from "react";
import { createPortal } from "react-dom";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, PersonAvatar } from "../ui";

/**
 * New channel: name, what it's for, private or not, members, and whether AI
 * employees may answer in it. The same dialog changes a channel's settings.
 */

type Editing = { id: number; name: string; purpose: string; private: boolean; aiAllowed: boolean; general: boolean };

export function Toggle({ on, onChange, label, sub, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; sub?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="tc-sw" disabled={disabled} onClick={() => onChange(!on)}>
      <span className={`tc-tog ${on ? "on" : ""}`} />
      <span>
        <b>{label}</b>
        {sub && <span className="ld-small ld-muted"> · {sub}</span>}
      </span>
    </button>
  );
}

export function NewChannel({ onClose, onMade, editing }: { onClose: () => void; onMade: (key: string) => void; editing?: Editing | null }) {
  const { currentOrgId, chatOnly } = useTenant();
  const utils = trpc.useUtils();
  const list = trpc.teamChat.channels.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [name, setName] = React.useState(editing?.name ?? "");
  const [purpose, setPurpose] = React.useState(editing?.purpose ?? "");
  const [priv, setPriv] = React.useState(editing?.private ?? false);
  const [ai, setAi] = React.useState(editing?.aiAllowed ?? true);
  const [members, setMembers] = React.useState<number[]>([]);
  const [pickOpen, setPickOpen] = React.useState(false);
  const refresh = () => Promise.all([utils.teamChat.channels.invalidate(), utils.teamChat.messages.invalidate(), utils.teamChat.details.invalidate()]);
  const create = trpc.teamChat.createChannel.useMutation({
    onSuccess: async (r) => {
      await refresh();
      onMade(r.key);
    },
  });
  const update = trpc.teamChat.updateChannel.useMutation({
    onSuccess: async (r) => {
      await refresh();
      onMade(r.key);
    },
  });
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);
  const people = list.data?.dms ?? [];
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const go = () => {
    if (!slug) return;
    if (editing) update.mutate({ organizationId: currentOrgId, channelId: editing.id, name: editing.general ? undefined : slug, purpose, aiAllowed: ai, private: editing.general ? undefined : priv });
    else create.mutate({ organizationId: currentOrgId, name: slug, purpose, private: priv, memberIds: members, aiAllowed: ai });
  };
  const busy = create.isPending || update.isPending;
  // On the page body, so it sits above the sticky chat list and the channel.
  return createPortal(
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={editing ? "Change the channel" : "New channel"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox tc-dlg">
        <div className="ld-between gp-mhead" style={{ padding: "16px 20px", borderBottom: "1px solid #e3e9e6" }}>
          <b style={{ fontSize: 16 }}>{editing ? "Change the channel" : "New channel"}</b>
          <button type="button" className="ld-btn sm" onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="tc-lbl">
            Name
            <span className="tc-namein">
              <span aria-hidden="true">#</span>
              <input className="ld-in" autoFocus={!editing} value={name} disabled={editing?.general} placeholder="clinical-supervision" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} aria-label="Channel name" />
            </span>
            <span className="ld-small ld-muted" style={{ fontWeight: 500 }}>{editing?.general ? "The general channel keeps its name." : `Lowercase, no spaces. People find it by this name${slug && slug !== name ? `: #${slug}` : ""}.`}</span>
          </label>
          <label className="tc-lbl">
            What it&apos;s for
            <input className="ld-in" value={purpose} placeholder="Supervision questions and case consults. No client names." onChange={(e) => setPurpose(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} aria-label="What the channel is for" />
          </label>
          <Toggle on={priv} onChange={setPriv} label="Private" sub="only the people you add can see it or find it" disabled={editing?.general} />
          {!editing && priv && (
            <div className="tc-lbl">
              Members
              <div className="tc-mem">
                <span className="tc-chip">You</span>
                {members.map((id) => {
                  const p = people.find((x) => x.userId === id);
                  return (
                    <span key={id} className="tc-chip">
                      <PersonAvatar name={p?.name ?? ""} src={p?.avatarUrl ?? null} size={20} />
                      {p?.name}
                      <button type="button" aria-label={`Remove ${p?.name}`} onClick={() => setMembers((m) => m.filter((x) => x !== id))}>×</button>
                    </span>
                  );
                })}
                <span style={{ position: "relative" }}>
                  <button type="button" className="tc-chip add" onClick={() => setPickOpen((v) => !v)}>+ Add people</button>
                  {pickOpen && (
                    <div className="gp-qpop" style={{ width: 260 }}>
                      {people.filter((p) => !members.includes(p.userId)).map((p) => (
                        <button key={p.userId} type="button" className="gp-qi" onClick={() => { setMembers((m) => [...m, p.userId]); setPickOpen(false); }}>
                          <PersonAvatar name={p.name} src={p.avatarUrl} size={22} />
                          {p.name}
                        </button>
                      ))}
                      {!people.some((p) => !members.includes(p.userId)) && <span className="ld-small ld-muted" style={{ padding: 8 }}>Everyone is in.</span>}
                    </div>
                  )}
                </span>
              </div>
            </div>
          )}
          {!chatOnly && <Toggle on={ai} onChange={setAi} label="Let AI employees in" sub="mention @Nora or @Simone here and they can answer in a thread" />}
          <div className="ld-row" style={{ justifyContent: "flex-end", paddingTop: 4 }}>
            <button type="button" className="ld-btn sm" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p gp-auto" disabled={!slug || busy} onClick={go}>{editing ? "Save" : "Create channel"}</button>
          </div>
          <ErrorLine error={create.error ?? update.error} />
        </div>
      </div>
    </div>,
    document.body
  );
}
