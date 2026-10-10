import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { AgendaList, meetingStatus, NotesBody, notesState } from "../work/Meetings";

const day = (d: Date | string | number, tz: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const time = (d: Date | string | number, tz: string) => new Date(d).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const card: React.CSSProperties = { padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" };

/** Nora's plan card in chat. Reads the launch live, so it always shows where the plan stands. */
export function LaunchPlanCard({ id }: { id: number }) {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const utils = trpc.useUtils();
  const q = trpc.projects.launch.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0 });
  const approve = trpc.projects.approvePlan.useMutation({ onSuccess: () => utils.projects.invalidate() });
  const drop = trpc.projects.dropLaunch.useMutation({ onSuccess: () => utils.projects.invalidate() });
  const v = q.data;
  if (!v) return <div className="ld-card" style={{ padding: "16px 18px" }}><span className="ld-muted">{q.error ? "This plan was removed." : "Loading the plan..."}</span></div>;
  const owners = new Set(v.tasks.map((t) => t.ownerName)).size;
  const st = v.launch.status;
  return (
    <div className="ld-card ld-resultcard" style={card}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{v.launch.name}</span>
          <span className={`ld-pill ${st === "planning" ? "amber" : st === "dropped" ? "gray" : "green"}`}>{st === "planning" ? "Waiting for you" : st === "dropped" ? "Not now" : st === "done" ? "Done" : "Started"}</span>
        </div>
        <span style={{ fontSize: 14, color: "var(--ld-text2)" }}>{`Launch day ${day(v.launch.launchDate, tz)} · ${v.milestones.length} milestones · ${v.tasks.length} task${v.tasks.length === 1 ? "" : "s"} · ${owners} owner${owners === 1 ? "" : "s"}`}</span>
        <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "170px minmax(0,1fr)", gap: "4px 14px", fontSize: 14, lineHeight: 1.5 }}>
          {v.milestones.map((m) => (
            <React.Fragment key={m.id}>
              <span>{day(m.dueDate, tz)}</span>
              <b>{m.name}</b>
            </React.Fragment>
          ))}
        </div>
        <span style={{ fontSize: 13, color: "var(--ld-muted)" }}>
          {v.launch.pjListId ? <>In Projects: <Link href={`/projects?list=${v.launch.pjListId}`}>{`Launches › ${v.launch.name}`}</Link></> : `Goes to Projects: Launches folder, new list "${v.launch.name}"`}
        </span>
        <ErrorLine error={approve.error || drop.error} />
        {approve.data?.error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{`Started, but Projects said: ${approve.data.error}`}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {st === "planning" && <button type="button" className="ld-btn p" disabled={approve.isPending} onClick={() => approve.mutate({ organizationId: currentOrgId, id })}>{approve.isPending ? "Starting..." : "Approve plan"}</button>}
        <Link href="/chats/projects/work" className="ld-btn">Open</Link>
        {st === "planning" && <button type="button" className="ld-btn" disabled={drop.isPending} onClick={() => drop.mutate({ organizationId: currentOrgId, id })}>Not now</button>}
      </div>
    </div>
  );
}

/** Simone's agenda card in chat. */
export function MeetingAgendaCard({ id }: { id: number }) {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const utils = trpc.useUtils();
  const q = trpc.coo.meeting.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0 });
  const invite = trpc.coo.sendInvite.useMutation({ onSuccess: () => utils.coo.invalidate() });
  const [later, setLater] = React.useState(false);
  const m = q.data;
  if (!m) return <div className="ld-card" style={{ padding: "16px 18px" }}><span className="ld-muted">{q.error ? "This meeting was removed." : "Loading the agenda..."}</span></div>;
  const end = new Date(new Date(m.startsAt).getTime() + m.minutes * 60_000);
  const st = m.state === "cancelled" ? { l: "Cancelled", c: "gray" } : meetingStatus(m, tz, false);
  return (
    <div className="ld-card ld-resultcard" style={card}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{m.title}</span>
          <span className={`ld-pill ${st.c}`}>{st.l}</span>
        </div>
        <span style={{ fontSize: 14, color: "var(--ld-text2)" }}>{`${day(m.startsAt, tz)}, ${time(m.startsAt, tz)} to ${time(end, tz)} · ${m.linkKind === "zoom" ? "Zoom" : "Google Meet"} · ${m.attendees.map((a: { name: string }) => a.name).join(", ") || "No one yet"}`}</span>
        <AgendaList items={m.agenda} />
        <ErrorLine error={invite.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {m.status === "invited" && m.link ? (
          <a className="ld-btn p" href={m.link} target="_blank" rel="noreferrer noopener">Join</a>
        ) : m.state === "upcoming" && !later ? (
          <button type="button" className="ld-btn p" disabled={invite.isPending} onClick={() => invite.mutate({ organizationId: currentOrgId, id })}>{invite.isPending ? "Sending..." : "Send invite"}</button>
        ) : null}
        <Link href="/chats/coo/work" className="ld-btn">Edit</Link>
        {m.status !== "invited" && m.state === "upcoming" && !later && <button type="button" className="ld-btn" onClick={() => setLater(true)}>Not now</button>}
      </div>
    </div>
  );
}

/** Simone's notes card in chat, after a meeting she sat in on. */
export function MeetingNotesCard({ id }: { id: number }) {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const utils = trpc.useUtils();
  const q = trpc.coo.notes.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0 });
  const recap = trpc.coo.sendNotesRecap.useMutation({ onSuccess: () => utils.coo.invalidate() });
  const r = q.data;
  if (!r) return <div className="ld-card" style={{ padding: "16px 18px" }}><span className="ld-muted">{q.error ? "These notes were removed." : "Loading the notes..."}</span></div>;
  const st = notesState(r);
  const who = r.attendees.map((a: { name: string }) => a.name).join(", ");
  const owners = r.actionItems.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.owner]: (acc[i.owner] ?? 0) + 1 }), {});
  const byOwner = Object.entries(owners).map(([o, n]) => `${n} for ${o}`).join(", ");
  return (
    <div className="ld-card ld-resultcard" style={card}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{r.title}</span>
          <span className={`ld-pill ${st.c}`}>{st.l}</span>
        </div>
        <span style={{ fontSize: 14, color: "var(--ld-text2)" }}>{[`${day(r.startsAt, tz)}`, r.heldMinutes ? `${r.heldMinutes} minute${r.heldMinutes === 1 ? "" : "s"}` : null, who || null].filter(Boolean).join(" · ")}</span>
        {r.summary && <NotesBody summary={r.summary.summary} decisions={r.summary.decisions} questions={r.summary.questions} items={r.actionItems} compact />}
        {r.actionItems.length > 0 && <span className="ld-small ld-muted">{byOwner}</span>}
        <ErrorLine error={recap.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {r.status === "ready" && <button type="button" className="ld-btn p" disabled={recap.isPending} onClick={() => recap.mutate({ organizationId: currentOrgId, id })}>{recap.isPending ? "Sending..." : r.recapSentAt ? "Send again" : "Send recap"}</button>}
        <Link href="/chats/coo/work?tab=notes" className="ld-btn">Open</Link>
      </div>
    </div>
  );
}
