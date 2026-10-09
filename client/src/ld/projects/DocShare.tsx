import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { OwnerAvatar } from "../goals/shared";

/**
 * Sharing a doc, the way ClickUp's Share this Doc works: everyone in the
 * workspace or only these people (teammates, AI employees, an outside email
 * for this doc only) with Can edit / Can comment / Can view, a team link for
 * people who sign in, and a public link anyone can open with no sign-in.
 */

const LEVELS = [
  { v: "edit", label: "Can edit" },
  { v: "comment", label: "Can comment" },
  { v: "view", label: "Can view" },
] as const;
type Level = (typeof LEVELS)[number]["v"];

export function DocShare({ orgId, docId, name, canChange, onClose }: { orgId: number; docId: number; name: string; canChange: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.pj.docShares.useQuery({ organizationId: orgId, id: docId });
  const after = { onSuccess: () => { void q.refetch(); void utils.pj.allDocs.invalidate(); void utils.pj.doc.invalidate(); } };
  const share = trpc.pj.shareDoc.useMutation({ onSuccess: () => { setWho(""); setPick(null); after.onSuccess(); } });
  const setLevel = trpc.pj.setDocShareLevel.useMutation(after);
  const unshare = trpc.pj.unshareDoc.useMutation(after);
  const setVis = trpc.pj.setDocVisibility.useMutation(after);
  const setLink = trpc.pj.setDocLink.useMutation(after);
  const [who, setWho] = React.useState("");
  const [level, setLevelPick] = React.useState<Level>("edit");
  const [copied, setCopied] = React.useState<"" | "team" | "public">("");
  const [pick, setPick] = React.useState<{ kind: "user" | "employee"; id: number; name: string } | null>(null);
  const d = q.data;
  const matches = (d?.can ?? []).filter((x) => x.name.toLowerCase().includes(who.trim().toLowerCase())).slice(0, 6);
  const invite = () => {
    if (pick) share.mutate({ organizationId: orgId, id: docId, level, kind: pick.kind, personId: pick.id });
    else if (who.includes("@")) share.mutate({ organizationId: orgId, id: docId, level, email: who.trim() });
  };
  const copy = (text: string, which: "team" | "public") => {
    void navigator.clipboard?.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(""), 1500);
  };
  const seen = d?.workspaceWide ? "workspace" : d?.private ? "private" : "project";
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={`Share ${name}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox">
        <div className="ld-between gp-mhead">
          <span>
            <b style={{ fontSize: 17 }}>Share</b>
            <span className="ld-small ld-muted" style={{ display: "block" }}>{name}</span>
          </span>
          <button type="button" className="ld-btn" onClick={onClose}>Done</button>
        </div>
        <div style={{ padding: "4px 20px 20px", display: "flex", flexDirection: "column", gap: 4 }}>
          {d && (
            <div className="gp-share">
              <span className="gp-share-ic" aria-hidden="true">👥</span>
              <span style={{ minWidth: 0 }}>
                <b>Who sees it</b>
                <br />
                <span className="ld-small ld-muted">{seen === "workspace" ? "Everyone in the workspace. Guests are never included." : seen === "private" ? "Only you, owners and admins, and the people below." : d.inherits ? `Everyone who can see ${d.inherits}, plus the people below.` : "Everyone in the workspace, plus any outside people below."}</span>
              </span>
              <select className="ld-in xs" aria-label="Who sees it" disabled={!canChange} value={seen} onChange={(e) => setVis.mutate({ organizationId: orgId, id: docId, private: e.target.value === "private", workspaceWide: e.target.value === "workspace" })}>
                {d.inherits && <option value="project">People on {d.inherits}</option>}
                {!d.inherits && <option value="project">Everyone in the workspace</option>}
                {d.inherits && <option value="workspace">Everyone in the workspace</option>}
                <option value="private">Only these people</option>
              </select>
              <span />
            </div>
          )}
          {canChange && (
            <div style={{ position: "relative", margin: "6px 0" }}>
              <div className="ld-row gp-invite">
                <input className="ld-in" style={{ flex: 1 }} aria-label="A person, an employee, or an outside email" placeholder="Add a person, an employee, or an outside email" value={pick ? pick.name : who} onChange={(e) => { setPick(null); setWho(e.target.value); }} onKeyDown={(e) => e.key === "Enter" && invite()} />
                <select className="ld-in xs" style={{ width: 140 }} aria-label="Access" value={level} onChange={(e) => setLevelPick(e.target.value as Level)}>
                  {LEVELS.map((l) => (
                    <option key={l.v} value={l.v}>{l.label}</option>
                  ))}
                </select>
                <button type="button" className="ld-btn p" disabled={(!pick && !who.includes("@")) || share.isPending} onClick={invite}>Add</button>
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
                  {p.name} {p.kind === "guest" && <span className="gp-chip">Outside</span>}
                </b>
                <span className="ld-small ld-muted">{p.note}</span>
              </span>
              {p.fixed || !canChange ? (
                <span className="ld-small" style={{ fontWeight: 700 }}>{p.fixed ? p.note : LEVELS.find((l) => l.v === p.level)?.label}</span>
              ) : (
                <select className="ld-in xs" aria-label={`Access for ${p.name}`} value={p.level} onChange={(e) => p.shareId && setLevel.mutate({ organizationId: orgId, id: docId, shareId: p.shareId, level: e.target.value as Level })}>
                  {LEVELS.map((l) => (
                    <option key={l.v} value={l.v}>{l.label}</option>
                  ))}
                </select>
              )}
              {!p.fixed && canChange ? <button type="button" className="ld-btn sm" onClick={() => p.shareId && unshare.mutate({ organizationId: orgId, id: docId, shareId: p.shareId })}>Remove</button> : <span />}
            </div>
          ))}
          {d && (
            <>
              <div className="gp-share">
                <span className="gp-share-ic" aria-hidden="true">↗</span>
                <span style={{ minWidth: 0 }}>
                  <b>Team link</b>
                  <br />
                  <span className="ld-small ld-muted gp-ell" style={{ display: "block" }}>Opens in the app after sign-in · {d.teamLink.replace(/^https?:\/\//, "")}</span>
                </span>
                <span />
                <button type="button" className="ld-btn sm" onClick={() => copy(d.teamLink, "team")}>{copied === "team" ? "Copied" : "Copy link"}</button>
              </div>
              <div className="gp-share">
                <span className="gp-share-ic" aria-hidden="true">🌐</span>
                <span style={{ minWidth: 0 }}>
                  <b>Public link</b>
                  <br />
                  <span className="ld-small ld-muted gp-ell" style={{ display: "block" }}>{d.link ? `On. View only, no sign-in · ${d.link.replace(/^https?:\/\//, "")}` : "Off. A view-only page anyone can open, no sign-in. Turning it off breaks the link."}</span>
                </span>
                <select className="ld-in xs" aria-label="Public link" disabled={!canChange} value={d.link ? "on" : "off"} onChange={(e) => setLink.mutate({ organizationId: orgId, id: docId, on: e.target.value === "on" })}>
                  <option value="off">Off</option>
                  <option value="on">On</option>
                </select>
                <button type="button" className="ld-btn sm" disabled={!d.link} onClick={() => d.link && copy(d.link, "public")}>{copied === "public" ? "Copied" : "Copy link"}</button>
              </div>
            </>
          )}
          <span className="ld-small ld-muted" style={{ marginTop: 8 }}>An outside person signs in with their email and sees only this doc. Owners and admins always see every doc.</span>
          <ErrorLine error={q.error || share.error || setLevel.error || unshare.error || setVis.error || setLink.error} />
        </div>
      </div>
    </div>
  );
}
