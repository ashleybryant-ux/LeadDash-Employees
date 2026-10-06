import React from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ChatList, ErrorLine, Rail, BottomNav } from "../ui";
import type { Outputs } from "../types";

/**
 * Import from Slack: upload the export zip, check how channels and people
 * map, then import. Running it again updates instead of copying.
 */

type Plan = Outputs["teamChat"]["slackPlan"] & { token: string };

export default function SlackImportPage() {
  const { currentOrgId } = useTenant();
  const [, go] = useLocation();
  const utils = trpc.useUtils();
  const input = React.useRef<HTMLInputElement>(null);
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const [channels, setChannels] = React.useState<{ id: string; take: boolean; name: string }[]>([]);
  const [people, setPeople] = React.useState<{ id: string; userId: number | null }[]>([]);
  const [dms, setDms] = React.useState<{ id: string; take: boolean }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = trpc.teamChat.slackImport.useMutation({ onSuccess: () => Promise.all([utils.teamChat.channels.invalidate(), utils.teamChat.messages.invalidate()]) });

  const upload = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const q = new URLSearchParams({ organizationId: String(currentOrgId), name: file.name });
      const res = await fetch(`/api/upload/slack?${q.toString()}`, { method: "POST", body: file, credentials: "include", headers: { "content-type": "application/zip" } });
      const data = await res.json().catch(() => ({ error: res.status === 413 ? "That file is too large for the server." : "Upload failed." }));
      if (!res.ok) throw new Error(data.error || "Upload failed.");
      const p = data as Plan;
      setPlan(p);
      setChannels(p.channels.map((c) => ({ id: c.id, take: c.take, name: c.becomes })));
      setPeople(p.people.map((x) => ({ id: x.id, userId: x.userId })));
      setDms(p.dms.map((d) => ({ id: d.id, take: d.take })));
      run.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };
  const pick = (id: string) => channels.find((c) => c.id === id)!;
  const taking = channels.filter((c) => c.take).length;
  // A direct message needs both people on the team here; a group one needs at least two. Picks on the People table count.
  const matched = (slackId: string) => {
    const p = people.find((y) => y.id === slackId);
    if (p?.userId) return plan?.members.find((m) => m.userId === p.userId)?.name ?? null;
    return null;
  };
  const dmState = (d: Plan["dms"][number]) => {
    const here = d.members.map(matched);
    const n = here.filter(Boolean).length;
    const missing = d.names.filter((_, i) => !here[i]);
    const ready = d.group ? n >= 2 : n === 2 && d.members.length === 2;
    return { ready, missing, here: here.filter(Boolean) as string[] };
  };
  const takingDms = plan ? plan.dms.filter((d) => dms.find((x) => x.id === d.id)?.take && dmState(d).ready).length : 0;
  const r = run.data;

  return (
    <div className="ld has-emp">
      <Rail active="chats" />
      <ChatList activeKind="team:import" />
      <section className="ld-chatmain tc-main" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <header className="ld-emphead tc-head2">
          <Link href="/chats?list=1" className="ld-mobile-only" aria-label="Back to chats" style={{ color: "#14221c", display: "flex" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </Link>
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25, minWidth: 0 }}>
            <b style={{ fontSize: 16 }}>Import from Slack</b>
            <span className="ld-small ld-muted">Your Slack channels and messages, into this workspace&apos;s team chat</span>
          </span>
        </header>
        <div className="tc-page" style={{ maxWidth: 1040 }}>
          <input ref={input} type="file" accept=".zip,application/zip" style={{ display: "none" }} onChange={(e) => { upload(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          <div className="ld-card tc-card">
            <div className="ld-between">
              <b style={{ fontSize: 15 }}>{plan ? plan.file : "The Slack export zip"}</b>
              {plan && <span className="gp-sd s-on">Read</span>}
            </div>
            <span className="ld-small ld-muted">In Slack: Workspace settings, Import/Export data, Export, then download the zip. Upload it here. Nothing in Slack changes.</span>
            {plan && (
              <span style={{ fontSize: 13 }}>
                {plan.counts.channels} channels · {plan.counts.dms} direct messages · {plan.counts.messages} messages · {plan.counts.reactions} reactions · {plan.counts.replies} thread replies · {plan.counts.files} files · {plan.counts.active} people still in Slack, {plan.counts.left} who left
              </span>
            )}
            <span className="ld-row">
              <button type="button" className="ld-btn p gp-auto" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Reading the export" : plan ? "Choose another file" : "Upload the zip"}</button>
            </span>
            {error && <span className="ld-small" role="alert" style={{ color: "#b42318" }}>{error}</span>}
          </div>

          {plan && !r && (
            <>
              <div className="ld-card tc-card">
                <b>Channels</b>
                <div className="tc-imp h"><span>Slack channel</span><span>Messages</span><span>Becomes</span><span>Members</span></div>
                {plan.channels.map((c) => {
                  const p = pick(c.id);
                  return (
                    <div key={c.id} className="tc-imp">
                      <label className="ld-row" style={{ gap: 8 }}>
                        <input type="checkbox" checked={p.take} onChange={(e) => setChannels((l) => l.map((x) => (x.id === c.id ? { ...x, take: e.target.checked } : x)))} />
                        <span className="gp-ell"># {c.name}{c.archived ? <span className="ld-small ld-muted"> · archived</span> : null}</span>
                      </label>
                      <span>{c.messages}</span>
                      <span>
                        {c.general ? (
                          <span>general <span className="ld-small ld-muted">· this workspace&apos;s general</span></span>
                        ) : (
                          <span className="ld-row" style={{ gap: 4 }}>
                            <span aria-hidden="true">#</span>
                            <input className="ld-in xs" value={p.name} aria-label={`Name here for ${c.name}`} onChange={(e) => setChannels((l) => l.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))} />
                            {c.existing && <span className="ld-small ld-muted" style={{ whiteSpace: "nowrap" }}>exists</span>}
                          </span>
                        )}
                      </span>
                      <span className="ld-small ld-muted">{c.members ? `${c.members} ${c.members === 1 ? "person" : "people"}` : "Nobody"}</span>
                    </div>
                  );
                })}
              </div>
              <div className="ld-card tc-card">
                <b>People</b>
                <div className="tc-imp h"><span>In Slack</span><span>Messages</span><span>Here</span><span></span></div>
                {plan.people.map((x) => {
                  const p = people.find((y) => y.id === x.id)!;
                  return (
                    <div key={x.id} className="tc-imp">
                      <span className="gp-ell">{x.name}{x.left ? <span className="ld-small ld-muted"> · left Slack</span> : x.email ? <span className="ld-small ld-muted"> · {x.email}</span> : null}</span>
                      <span>{x.messages}</span>
                      <span>
                        <select className="ld-in xs" value={p.userId ?? ""} aria-label={`Who ${x.name} is here`} onChange={(e) => setPeople((l) => l.map((y) => (y.id === x.id ? { ...y, userId: e.target.value ? Number(e.target.value) : null } : y)))}>
                          <option value="">{x.name} (name only)</option>
                          {plan.members.map((m) => (
                            <option key={m.userId} value={m.userId}>{m.name}</option>
                          ))}
                        </select>
                      </span>
                      <span className="ld-small ld-muted">{x.matched === "email" ? "matched by email" : x.left ? "messages keep their name" : "not on the team here yet"}</span>
                    </div>
                  );
                })}
              </div>
              <div className="ld-card tc-card">
                <b>Direct messages</b>
                {plan.dms.length === 0 ? (
                  <span className="ld-small ld-muted">None in this export. Direct messages come only in a full export (Slack: Export all conversations, on Business+ and up). Upload that one and they show here.</span>
                ) : (
                  <>
                    <div className="tc-imp h"><span>In Slack</span><span>Messages</span><span>Becomes</span><span></span></div>
                    {plan.dms.map((d) => {
                      const st = dmState(d);
                      const t = dms.find((x) => x.id === d.id)?.take ?? false;
                      return (
                        <div key={d.id} className="tc-imp">
                          <label className="ld-row" style={{ gap: 8 }}>
                            <input type="checkbox" checked={t && st.ready} disabled={!st.ready} onChange={(e) => setDms((l) => l.map((x) => (x.id === d.id ? { ...x, take: e.target.checked } : x)))} />
                            <span className="gp-ell">{d.names.join(", ")}</span>
                          </label>
                          <span>{d.messages}</span>
                          <span className="gp-ell">{d.group ? `Private channel for ${st.here.length ? st.here.join(", ") : "its people"}${d.existing ? " (exists)" : ""}` : "Their direct message here"}</span>
                          <span className="ld-small ld-muted gp-ell">{st.ready ? "ready" : `${st.missing.join(", ")} ${st.missing.length === 1 ? "is" : "are"} not on the team here`}</span>
                        </div>
                      );
                    })}
                    <span className="ld-small ld-muted">A direct message needs both people on this team; add someone as Team chat only on the Team page, then run the export again. A group message becomes a private channel for the people who are here.</span>
                  </>
                )}
              </div>
              <div className="ld-card tc-card">
                <b>What comes over</b>
                <span className="ld-small ld-muted">
                  Messages with their dates, who wrote them, @mentions, reactions, threads, pins and edits. Links to Loom, Google Drive and the web stay links and get a preview. Files Slack stored itself ({plan.counts.files} of them) can&apos;t be pulled from the export: they show by name with a note, and you can re-attach the ones you still need. Channel join notices and bot posts are left out. Running it again updates instead of copying twice. Imported history starts as read for everyone.
                </span>
              </div>
              <div className="ld-row">
                <button type="button" className="ld-btn p gp-auto" disabled={run.isPending || (!taking && !takingDms)} onClick={() => run.mutate({ organizationId: currentOrgId, token: plan.token, channels, people, dms })}>
                  {run.isPending ? "Importing" : `Import ${taking} ${taking === 1 ? "channel" : "channels"}${takingDms ? ` and ${takingDms} direct ${takingDms === 1 ? "message" : "messages"}` : ""}`}
                </button>
                <button type="button" className="ld-btn gp-auto" disabled={run.isPending} onClick={() => setPlan(null)}>Cancel</button>
              </div>
              <ErrorLine error={run.error} />
            </>
          )}

          {r && (
            <div className="ld-card tc-card">
              <b>Done</b>
              <span style={{ fontSize: 14 }}>
                {r.added} messages added{r.updated ? `, ${r.updated} updated` : ""}, {r.channelsMade} {r.channelsMade === 1 ? "channel" : "channels"} made, {r.dms} direct {r.dms === 1 ? "message" : "messages"}, {r.reactions} reactions, {r.files} files by name.
              </span>
              <ul className="ld-small ld-muted" style={{ margin: 0, paddingLeft: 18 }}>
                {r.log.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <span className="ld-row">
                <button type="button" className="ld-btn p gp-auto" onClick={() => go("/chats/team/everyone")}>Open general</button>
              </span>
            </div>
          )}
        </div>
      </section>
      <BottomNav active="chats" />
    </div>
  );
}
