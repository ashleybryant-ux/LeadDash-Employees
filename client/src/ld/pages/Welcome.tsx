import React from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, Rail } from "../ui";
import { KIND_ORDER, type Kind } from "../meta";

/**
 * The first screen for a workspace opened from LeadDash EHR: what came over
 * (the practice, the EHR connection, who is on it) and the team, then into
 * the chats. Opened again later it just shows the same facts.
 */
export default function Welcome() {
  const { currentOrg, currentOrgId } = useTenant();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const ehr = trpc.ehr.view.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const emps = trpc.employees.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const members = trpc.members.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const me = members.data?.find((m) => m.userId === user?.id);
  const managers = (members.data ?? []).filter((m) => m.userId !== user?.id && (m.role === "owner" || m.role === "admin"));
  const team = [...(emps.data ?? [])].sort((a, b) => KIND_ORDER.indexOf(a.kind as Kind) - KIND_ORDER.indexOf(b.kind as Kind));
  const shown = team.slice(0, 7);
  const roleWord = me?.role === "owner" ? "the owner" : me?.role === "admin" ? "an administrator" : "on the team";
  return (
    <div className="ld">
      <Rail active="chats" />
      <main className="ld-main" style={{ maxWidth: 1100 }}>
        <section className="ld-card" style={{ padding: "40px 48px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 40, alignItems: "start" }}>
          <div>
            <h1 className="ld-h1" style={{ fontSize: 26, marginBottom: 8 }}>{currentOrg?.name ?? "Your workspace"} is set up</h1>
            <p className="ld-body" style={{ margin: "0 0 18px", fontSize: 15, lineHeight: 1.6 }}>
              Your workspace came over from LeadDash EHR: practice name, time zone, your team's roles, and a live connection to your calendar, claims, payments and receptionist. Nothing to paste.
            </p>
            <Check>Workspace created for {currentOrg?.name ?? "your practice"}, healthcare practice</Check>
            <Check>{ehr.data?.connected ? `LeadDash EHR connected as ${ehr.data.practice ?? currentOrg?.name ?? "your practice"}` : "LeadDash EHR connection pending"}</Check>
            <Check>
              You are {roleWord}
              {managers.length ? `; ${managers.map((m) => m.name || m.email).join(", ")} ${managers.length === 1 ? "is" : "are"} ${managers.length === 1 ? "a manager" : "managers"}` : ""}
            </Check>
            <Check>Client names: Show, Initial or Hide from any employee's header</Check>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button type="button" className="ld-btn p" style={{ width: 160 }} onClick={() => navigate("/chats")}>Meet the team</button>
              <button type="button" className="ld-btn" onClick={() => navigate("/workspace")}>Workspace</button>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {shown.map((e) => (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid #e3e9e6", borderRadius: 10, padding: "10px 12px" }}>
                <Avatar name={e.name} kind={e.kind} src={e.avatar} size={36} />
                <div style={{ minWidth: 0 }}>
                  <b style={{ display: "block", fontSize: 14 }}>{e.name}</b>
                  <span style={{ fontSize: 12.5, color: "#1b6b4a", fontWeight: 700 }}>{e.roleTitle}</span>
                </div>
              </div>
            ))}
            {team.length > shown.length && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #e3e9e6", borderRadius: 10, padding: "10px 12px", color: "#5b6b64", fontWeight: 700 }}>
                and {team.length - shown.length} more
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function Check({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 14, padding: "8px 0", borderBottom: "1px solid #eef2f0" }}>
      <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: 999, background: "#1b6b4a", color: "#fff", fontSize: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, flexShrink: 0 }}>✓</span>
      <span>{children}</span>
    </div>
  );
}
