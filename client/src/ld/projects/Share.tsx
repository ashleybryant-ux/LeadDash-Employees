import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { OwnerAvatar } from "../goals/shared";

/**
 * Sharing a list: teammates and employees with an access level, outside
 * guests by email (they see only this list), a Private switch, and a
 * view-only link anyone can open.
 */

const LEVELS = [
  { v: "full", label: "Full access" },
  { v: "edit", label: "Can edit" },
  { v: "comment", label: "Can comment" },
  { v: "view", label: "Can view" },
] as const;
type Level = (typeof LEVELS)[number]["v"];

export function ShareList({ orgId, listId, name, canChange, onClose }: { orgId: number; listId: number; name: string; canChange: boolean; onClose: () => void }) {
  const q = trpc.pj.shares.useQuery({ organizationId: orgId, listId });
  const after = { onSuccess: () => void q.refetch() };
  const share = trpc.pj.share.useMutation({ onSuccess: () => { setWho(""); setPick(null); void q.refetch(); } });
  const setLevel = trpc.pj.setShareLevel.useMutation(after);
  const unshare = trpc.pj.unshare.useMutation(after);
  const setPrivate = trpc.pj.setPrivate.useMutation(after);
  const setLink = trpc.pj.setLink.useMutation(after);
  const [who, setWho] = React.useState("");
  const [level, setLevelPick] = React.useState<Level>("edit");
  const [copied, setCopied] = React.useState(false);
  const d = q.data;
  const [pick, setPick] = React.useState<{ kind: "user" | "employee"; id: number; name: string } | null>(null);
  const matches = (d?.can ?? []).filter((x) => x.name.toLowerCase().includes(who.trim().toLowerCase())).slice(0, 6);
  const invite = () => {
    if (pick) share.mutate({ organizationId: orgId, listId, level, kind: pick.kind, id: pick.id });
    else if (who.includes("@")) share.mutate({ organizationId: orgId, listId, level, email: who.trim() });
  };
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={`Share ${name}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox">
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>Share {name}</b>
          <button type="button" className="ld-btn" onClick={onClose}>Done</button>
        </div>
        <div style={{ padding: "4px 20px 20px", display: "flex", flexDirection: "column", gap: 4 }}>
          {canChange && (
            <div style={{ position: "relative", marginBottom: 6 }}>
              <div className="ld-row">
                <input className="ld-in" style={{ flex: 1 }} aria-label="A teammate, an employee, or a guest's email" placeholder="Add a teammate or a guest's email" value={pick ? pick.name : who} onChange={(e) => { setPick(null); setWho(e.target.value); }} onKeyDown={(e) => e.key === "Enter" && invite()} />
                <select className="ld-in xs" style={{ width: 150 }} aria-label="Access" value={level} onChange={(e) => setLevelPick(e.target.value as Level)}>
                  {LEVELS.map((l) => (
                    <option key={l.v} value={l.v}>{l.label}</option>
                  ))}
                </select>
                <button type="button" className="ld-btn p" disabled={(!pick && !who.includes("@")) || share.isPending} onClick={invite}>Invite</button>
              </div>
              {!pick && who.trim() && matches.length > 0 && (
                <div className="gp-suggest" role="listbox" aria-label="On the team">
                  {matches.map((x) => (
                    <button key={`${x.kind}:${x.id}`} type="button" role="option" aria-selected={false} onClick={() => { setPick(x); setWho(""); }}>
                      {x.name}
                      {x.kind === "employee" ? <span className="ld-small ld-muted"> · AI employee</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {d?.people.map((p) => (
            <div key={`${p.kind}:${p.id}`} className="gp-share">
              <OwnerAvatar o={{ type: p.kind === "employee" ? "employee" : "user", id: p.id, name: p.name, avatarUrl: p.avatarUrl }} size={30} />
              <span style={{ minWidth: 0 }}>
                <b className="gp-ell" style={{ display: "block" }}>
                  {p.name} {p.kind === "guest" && <span className="gp-chip">Guest</span>}
                </b>
                <span className="ld-small ld-muted">{p.note}</span>
              </span>
              {p.fixed || !canChange ? (
                <span className="ld-small" style={{ fontWeight: 700 }}>{p.level === "owner" ? "Owner" : LEVELS.find((l) => l.v === p.level)?.label}</span>
              ) : (
                <select className="ld-in xs" aria-label={`Access for ${p.name}`} value={p.level} onChange={(e) => p.shareId && setLevel.mutate({ organizationId: orgId, listId, shareId: p.shareId, level: e.target.value as Level })}>
                  {LEVELS.map((l) => (
                    <option key={l.v} value={l.v}>{l.label}</option>
                  ))}
                </select>
              )}
              {!p.fixed && canChange ? <button type="button" className="ld-btn sm" onClick={() => p.shareId && unshare.mutate({ organizationId: orgId, listId, shareId: p.shareId })}>Remove</button> : <span />}
            </div>
          ))}
          {d && (
            <>
              <div className="gp-share">
                <span className="gp-share-ic" aria-hidden="true">🔗</span>
                <span style={{ minWidth: 0 }}>
                  <b>Anyone with the link</b>
                  <br />
                  <span className="ld-small ld-muted">{d.link ? "On. A view-only page anyone with the link can open." : "Off. A view-only page anyone can open."}</span>
                </span>
                <select className="ld-in xs" aria-label="View-only link" disabled={!canChange} value={d.link ? "on" : "off"} onChange={(e) => setLink.mutate({ organizationId: orgId, listId, on: e.target.value === "on" })}>
                  <option value="off">Off</option>
                  <option value="on">Can view</option>
                </select>
                <button
                  type="button"
                  className="ld-btn sm"
                  disabled={!d.link}
                  onClick={() => {
                    if (!d.link) return;
                    void navigator.clipboard?.writeText(d.link);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
              <div className="gp-share">
                <span className="gp-share-ic" aria-hidden="true">🔒</span>
                <span style={{ minWidth: 0 }}>
                  <b>Private</b>
                  <br />
                  <span className="ld-small ld-muted">{d.private ? "Only the people above see this list. Others in the workspace don't." : "Everyone in the workspace can see this list."}</span>
                </span>
                <select className="ld-in xs" aria-label="Private" disabled={!canChange} value={d.private ? "on" : "off"} onChange={(e) => setPrivate.mutate({ organizationId: orgId, listId, on: e.target.value === "on" })}>
                  <option value="off">Off</option>
                  <option value="on">On</option>
                </select>
                <span />
              </div>
            </>
          )}
          <span className="ld-small ld-muted" style={{ marginTop: 8 }}>Guests see only what you share with them, never the rest of the workspace, chats or the Brain. Owners and admins always have full access.</span>
          <ErrorLine error={q.error || share.error || setLevel.error || unshare.error || setPrivate.error || setLink.error} />
        </div>
      </div>
    </div>
  );
}
