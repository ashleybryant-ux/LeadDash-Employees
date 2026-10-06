import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { ErrorLine, Page, PersonAvatar } from "../ui";

const COLS = "44px minmax(0,1fr) 140px 128px";

type Role = "owner" | "admin" | "member" | "chat" | "reviewer";
const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", chat: "Team chat only", reviewer: "Reviewer" };
const ROLE_NOTE: Record<Role, string> = {
  owner: "Everything, plus billing and who is on the team.",
  admin: "Everything, plus the team.",
  member: "AI employees, Projects, Goals, Approvals, Brain, team chat.",
  chat: "Channels and direct messages, the Team page and their account. No AI employees, Projects or Goals.",
  reviewer: "Looks, cannot change anything.",
};
const ROLES: Role[] = ["owner", "admin", "member", "chat", "reviewer"];
type InviteRole = "admin" | "member" | "chat" | "reviewer";

type Member = { userId: number; email: string; name: string | null; avatarUrl?: string | null; role: Role };

export default function Team() {
  const { currentOrgId, chatOnly } = useTenant();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const q = trpc.members.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [editing, setEditing] = React.useState<number | null>(null);
  const [role, setRole] = React.useState<Role>("member");
  const [inviting, setInviting] = React.useState(false);
  const [inv, setInv] = React.useState<{ name: string; email: string; role: InviteRole }>({ name: "", email: "", role: "member" });

  const refresh = () => utils.members.list.invalidate();
  const updateRole = trpc.members.updateRole.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const remove = trpc.members.remove.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const add = trpc.members.add.useMutation({
    onSuccess: async () => {
      setInviting(false);
      setInv({ name: "", email: "", role: "member" });
      await refresh();
    },
  });

  const members = (q.data ?? []) as Member[];
  const ownerCount = members.filter((m) => m.role === "owner").length;
  const me = members.find((m) => m.userId === user?.id);
  const canMakeOwner = user?.role === "admin" || me?.role === "owner";
  // The app review account and team chat only people can see the team but not change it.
  const readOnly = !!user?.reviewer || chatOnly;

  return (
    <Page rail="team" maxWidth={980}>
      <div className="ld-between">
        <h1 className="ld-h1">Team</h1>
        {!readOnly && (
          <button type="button" className="ld-btn p" onClick={() => setInviting(true)}>
            Invite
          </button>
        )}
      </div>

      <div className="ld-card" style={{ overflow: "hidden" }}>
        {members.length === 0 && !inviting && <div className="ld-empty">{q.isLoading ? "Loading..." : "No one on this team yet."}</div>}
        {members.map((m) => {
          const name = m.name?.trim() || m.email;
          const isOpen = editing === m.userId;
          const hideEdit = readOnly || (m.userId === user?.id && m.role === "owner" && ownerCount === 1);
          return (
            <React.Fragment key={m.userId}>
              <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
                <PersonAvatar name={name} src={m.avatarUrl} size={40} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800 }}>{name}</div>
                  {m.name?.trim() && <div className="ld-small ld-muted" style={{ overflowWrap: "anywhere" }}>{m.email}</div>}
                </div>
                <span className="ld-strong">{ROLE_LABEL[m.role] ?? m.role}</span>
                {hideEdit ? (
                  <span />
                ) : (
                  <button
                    type="button"
                    className="ld-btn"
                    onClick={() => {
                      updateRole.reset();
                      remove.reset();
                      setRole(m.role);
                      setEditing(isOpen ? null : m.userId);
                    }}
                  >
                    {isOpen ? "Close" : "Edit"}
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "44px minmax(0,1fr) 128px", gap: 14, alignItems: "start" }}>
                  <span />
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="ld-lbl">Role</span>
                    <div role="radiogroup" aria-label="Role" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {ROLES.filter((r) => r !== "owner" || canMakeOwner || m.role === "owner").map((r) => (
                        <label key={r} style={{ display: "grid", gridTemplateColumns: "18px 118px minmax(0,1fr)", gap: 10, alignItems: "start", fontSize: 13.5, lineHeight: 1.35, cursor: "pointer" }}>
                          <input type="radio" name={`role-${m.userId}`} value={r} checked={role === r} onChange={() => setRole(r)} style={{ margin: "2px 0 0", accentColor: "#1b6b4a" }} />
                          <b>{ROLE_LABEL[r]}</b>
                          <span className="ld-muted">{ROLE_NOTE[r]}</span>
                        </label>
                      ))}
                    </div>
                    <ErrorLine error={updateRole.error ?? remove.error} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <button
                      type="button"
                      className="ld-btn p"
                      disabled={updateRole.isPending || role === m.role}
                      onClick={() => updateRole.mutate({ organizationId: currentOrgId, userId: m.userId, role })}
                    >
                      Save
                    </button>
                    <button type="button" className="ld-btn" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="ld-btn danger"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`Remove ${name} from this workspace?`)) remove.mutate({ organizationId: currentOrgId, userId: m.userId });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {inviting && (
        <form
          className="ld-card"
          style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 220px", gap: 12, alignItems: "end" }}
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ organizationId: currentOrgId, email: inv.email.trim(), name: inv.name.trim() || undefined, role: inv.role });
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label htmlFor="inv-name" className="ld-lbl">Name</label>
            <input id="inv-name" className="ld-in" type="text" value={inv.name} onChange={(e) => setInv((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label htmlFor="inv-email" className="ld-lbl">Email</label>
            <input id="inv-email" className="ld-in" type="email" required value={inv.email} onChange={(e) => setInv((p) => ({ ...p, email: e.target.value }))} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label htmlFor="inv-role" className="ld-lbl">Role</label>
            <select id="inv-role" className="ld-in" value={inv.role} onChange={(e) => setInv((p) => ({ ...p, role: e.target.value as InviteRole }))}>
              {ROLES.filter((r) => r !== "owner").map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span className="ld-small ld-muted" style={{ lineHeight: 1.4 }}>
              They get an email with a sign-in link. {inv.role === "chat" ? "Team chat only people see the channels, direct messages and the Team page, nothing else." : ROLE_NOTE[inv.role]}
            </span>
            <span className="ld-row" style={{ flexShrink: 0 }}>
              <button type="button" className="ld-btn" onClick={() => setInviting(false)}>
                Cancel
              </button>
              <button type="submit" className="ld-btn p" disabled={add.isPending}>
                Send invite
              </button>
            </span>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <ErrorLine error={add.error} />
          </div>
        </form>
      )}
    </Page>
  );
}
