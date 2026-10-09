import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { ErrorLine, Page, PersonAvatar } from "../ui";

const COLS = "44px minmax(0,1fr) 190px 150px 120px 128px";

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
type LimitMode = "default" | "custom" | "none";

type ChatAccess = "own" | "some" | "all";
type Member = { userId: number; email: string; name: string | null; avatarUrl?: string | null; role: Role; chatAccess?: ChatAccess; chatAccessList?: string | null };

/** What a member sees in the AI employees' chats beyond their own messages, as stored on their membership. */
function accessOf(m: Member): { mode: ChatAccess; users: number[]; workspace: boolean } {
  if (m.role === "owner" || m.role === "admin") return { mode: "all", users: [], workspace: true };
  let list: { users?: unknown; workspace?: unknown } = {};
  try {
    list = m.chatAccessList ? JSON.parse(m.chatAccessList) : {};
  } catch {
    list = {};
  }
  return { mode: m.chatAccess === "some" || m.chatAccess === "all" ? m.chatAccess : "own", users: Array.isArray(list.users) ? list.users.filter((u): u is number => Number.isInteger(u)) : [], workspace: list.workspace === true };
}

/** The Sees column: Everything, Own only, or Own + how many more. */
function accessLabel(m: Member) {
  const a = accessOf(m);
  if (a.mode === "all") return "Everything";
  const n = a.mode === "some" ? a.users.length + (a.workspace ? 1 : 0) : 0;
  return n ? `Own + ${n}` : "Own only";
}
type Ai = { userId: number; used: number; limit: number | null; source: "own" | "workspace" | "none" | "exempt" | "chat"; mode: LimitMode; own: number | null; month: string };
type Limits = { defaultDollars: number | null; ownersExempt: boolean; warnPct: 0 | 80 | 90; atLimit: "stop" | "warn" };

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const radio: React.CSSProperties = { margin: 0, accentColor: "#1b6b4a" };

/** This month's AI cost against the person's limit, with a bar that turns orange near it and red at it. */
function AiCell({ a, warnPct }: { a?: Ai; warnPct: number }) {
  if (!a) return <span />;
  if (a.source === "chat") return <span className="ld-small ld-muted">Team chat only</span>;
  if (a.limit == null)
    return (
      <span style={{ fontSize: 14 }}>
        <b>{money(a.used)}</b> <span className="ld-muted">· No limit</span>
      </span>
    );
  const pct = a.limit > 0 ? Math.min(100, Math.round((a.used / a.limit) * 100)) : 100;
  const reached = a.used >= a.limit;
  const color = reached ? "#b42318" : warnPct && pct >= warnPct ? "#e88a3a" : "#1b6b4a";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 14 }}>
        <b>{money(a.used)}</b> <span className="ld-muted">of {money(a.limit)}</span>
      </span>
      <div style={{ height: 6, borderRadius: 999, background: "#e8eeeb", overflow: "hidden" }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="AI used this month">
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
      {reached && <span style={{ fontSize: 12, fontWeight: 700, color: "#b42318" }}>Limit reached</span>}
    </div>
  );
}

/** The workspace's AI limits: read view with Edit, and the edit state with Save and Cancel. */
function AiLimitsSection({ canEdit }: { canEdit: boolean }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.usage.limits.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [edit, setEdit] = React.useState<null | { amount: string; ownersExempt: boolean; warnPct: 0 | 80 | 90; atLimit: "stop" | "warn" }>(null);
  const save = trpc.usage.saveLimits.useMutation({
    onSuccess: async () => {
      setEdit(null);
      await Promise.all([utils.usage.limits.invalidate(), utils.members.ai.invalidate(), utils.usage.byPerson.invalidate()]);
    },
  });
  const l = q.data as Limits | undefined;
  if (!l) return null;
  const amountOk = !edit || edit.amount.trim() === "" || /^\d+(\.\d{1,2})?$/.test(edit.amount.trim().replace(/^\$/, ""));
  return (
    <section className="ld-card" style={edit ? { borderColor: "#1b6b4a" } : undefined}>
      <div className="ld-between" style={{ padding: "14px 18px", borderBottom: "1px solid #eef2f0" }}>
        <span className="ld-st">AI limits</span>
        {edit ? (
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
            <button
              type="button"
              className="ld-btn p"
              disabled={save.isPending || !amountOk}
              onClick={() => {
                const a = edit.amount.trim().replace(/^\$/, "");
                save.mutate({ organizationId: currentOrgId, defaultDollars: a === "" ? null : Number(a), ownersExempt: edit.ownersExempt, warnPct: edit.warnPct, atLimit: edit.atLimit });
              }}
            >
              Save
            </button>
          </span>
        ) : (
          canEdit && (
            <button type="button" className="ld-btn" onClick={() => setEdit({ amount: l.defaultDollars == null ? "" : String(l.defaultDollars), ownersExempt: l.ownersExempt, warnPct: l.warnPct, atLimit: l.atLimit })}>
              Edit
            </button>
          )
        )}
      </div>
      {!edit ? (
        <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "8px 16px", padding: "14px 18px", fontSize: 14, lineHeight: 1.55 }}>
          <span className="ld-muted" style={{ fontWeight: 600 }}>Workspace limit</span>
          <span>{l.defaultDollars == null ? "No limit" : `${money(l.defaultDollars)} a person, each month`}</span>
          <span className="ld-muted" style={{ fontWeight: 600 }}>Owners and admins</span>
          <span>{l.ownersExempt ? "No limit" : "Same limit as everyone"}</span>
          <span className="ld-muted" style={{ fontWeight: 600 }}>Heads-up</span>
          <span>{l.warnPct ? `At ${l.warnPct}%, to the person and to the owner` : "Off"}</span>
          <span className="ld-muted" style={{ fontWeight: 600 }}>At the limit</span>
          <span>{l.atLimit === "stop" ? "Employees stop starting new work for that person" : "Employees keep working; the owner is told"}</span>
          <span className="ld-muted" style={{ fontWeight: 600 }}>Resets</span>
          <span>The 1st of each month</span>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", padding: "14px 18px", fontSize: 14, alignItems: "center" }}>
          <label htmlFor="ai-default" className="ld-muted" style={{ fontWeight: 600 }}>Workspace limit</label>
          <span className="ld-row" style={{ gap: 6 }}>
            <span className="ld-muted">$</span>
            <input id="ai-default" className="ld-in" style={{ width: 90, height: 32 }} inputMode="decimal" placeholder="None" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} />
            <span className="ld-muted">a person, each month. Leave it blank for no limit.</span>
          </span>
          <span className="ld-muted" style={{ fontWeight: 600 }}>Owners and admins</span>
          <span className="ld-row" style={{ gap: 18, fontSize: 13.5 }}>
            <label className="ld-row" style={{ gap: 6 }}><input type="radio" name="ai-oa" style={radio} checked={edit.ownersExempt} onChange={() => setEdit({ ...edit, ownersExempt: true })} />No limit</label>
            <label className="ld-row" style={{ gap: 6 }}><input type="radio" name="ai-oa" style={radio} checked={!edit.ownersExempt} onChange={() => setEdit({ ...edit, ownersExempt: false })} />Same limit as everyone</label>
          </span>
          <label htmlFor="ai-warn" className="ld-muted" style={{ fontWeight: 600 }}>Heads-up at</label>
          <span className="ld-row" style={{ gap: 8 }}>
            <select id="ai-warn" className="ld-in" style={{ width: 90, height: 32 }} value={String(edit.warnPct)} onChange={(e) => setEdit({ ...edit, warnPct: Number(e.target.value) as 0 | 80 | 90 })}>
              <option value="80">80%</option>
              <option value="90">90%</option>
              <option value="0">Off</option>
            </select>
            <span className="ld-muted">to the person and to the owner</span>
          </span>
          <span className="ld-muted" style={{ fontWeight: 600, alignSelf: "start", paddingTop: 2 }}>At the limit</span>
          <span style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13.5 }}>
            <label className="ld-row" style={{ gap: 6 }}><input type="radio" name="ai-at" style={radio} checked={edit.atLimit === "stop"} onChange={() => setEdit({ ...edit, atLimit: "stop" })} />Employees stop starting new work for that person</label>
            <label className="ld-row" style={{ gap: 6 }}><input type="radio" name="ai-at" style={radio} checked={edit.atLimit === "warn"} onChange={() => setEdit({ ...edit, atLimit: "warn" })} />Keep working, just tell me</label>
          </span>
          {!amountOk && <span style={{ gridColumn: "1 / -1", color: "#b42318", fontSize: 13 }}>Type the limit in dollars, like 20 or 25.50.</span>}
          <div style={{ gridColumn: "1 / -1" }}><ErrorLine error={save.error} /></div>
        </div>
      )}
    </section>
  );
}

export default function Team() {
  const { currentOrgId, chatOnly } = useTenant();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const q = trpc.members.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const ai = trpc.members.ai.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const lim = trpc.usage.limits.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [editing, setEditing] = React.useState<number | null>(null);
  const [role, setRole] = React.useState<Role>("member");
  const [limitMode, setLimitMode] = React.useState<LimitMode>("default");
  const [own, setOwn] = React.useState("");
  // What they see in the chats: their own messages, their own plus the people checked (and scheduled task reports), or everything.
  const [access, setAccess] = React.useState<{ mode: ChatAccess; users: number[]; workspace: boolean }>({ mode: "own", users: [], workspace: false });
  const [inviting, setInviting] = React.useState(false);
  const [inv, setInv] = React.useState<{ name: string; email: string; role: InviteRole }>({ name: "", email: "", role: "member" });

  const refresh = () => Promise.all([utils.members.list.invalidate(), utils.members.ai.invalidate(), utils.usage.byPerson.invalidate()]);
  const updateRole = trpc.members.updateRole.useMutation();
  const setLimit = trpc.members.setAiLimit.useMutation();
  const setChatAccess = trpc.members.setChatAccess.useMutation();
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
  const aiBy = new Map(((ai.data ?? []) as Ai[]).map((a) => [a.userId, a]));
  const workspaceLimit = (lim.data as Limits | undefined)?.defaultDollars ?? null;
  const warnPct = (lim.data as Limits | undefined)?.warnPct ?? 80;
  const ownerCount = members.filter((m) => m.role === "owner").length;
  const me = members.find((m) => m.userId === user?.id);
  const canMakeOwner = user?.role === "admin" || me?.role === "owner";
  // Owners, admins and LeadDash staff change the team; everyone else only sees it.
  const canManage = !user?.reviewer && !chatOnly && (user?.role === "admin" || me?.role === "owner" || me?.role === "admin");
  const ownOk = limitMode !== "custom" || /^\d+(\.\d{1,2})?$/.test(own.trim().replace(/^\$/, ""));
  const saving = updateRole.isPending || setLimit.isPending || setChatAccess.isPending;

  const saveMember = async (m: Member) => {
    updateRole.reset();
    setLimit.reset();
    setChatAccess.reset();
    const a = aiBy.get(m.userId);
    try {
      if (role !== m.role) await updateRole.mutateAsync({ organizationId: currentOrgId, userId: m.userId, role });
      const dollars = limitMode === "custom" ? Number(own.trim().replace(/^\$/, "")) : null;
      if (limitMode !== a?.mode || (limitMode === "custom" && dollars !== a?.own)) await setLimit.mutateAsync({ organizationId: currentOrgId, userId: m.userId, mode: limitMode, dollars });
      const was = accessOf(m);
      const picked = { ...access, users: access.mode === "some" ? access.users : [], workspace: access.mode === "some" ? access.workspace : false };
      const changed = picked.mode !== was.mode || picked.workspace !== was.workspace || picked.users.slice().sort().join() !== was.users.slice().sort().join();
      if (role !== "owner" && role !== "admin" && changed) await setChatAccess.mutateAsync({ organizationId: currentOrgId, userId: m.userId, mode: picked.mode, users: picked.users, workspace: picked.workspace });
      setEditing(null);
      await refresh();
    } catch {
      // The error shows under the fields.
    }
  };

  return (
    <Page rail="team" maxWidth={1060}>
      <div className="ld-between">
        <h1 className="ld-h1">Team</h1>
        {canManage && (
          <button type="button" className="ld-btn p" onClick={() => setInviting(true)}>
            Invite
          </button>
        )}
      </div>

      <div className="ld-card" style={{ overflow: "hidden" }}>
        {members.length > 0 && (
          <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: COLS, gap: 16, padding: "12px 18px 8px", borderBottom: "1px solid #eef2f0", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5b6b64" }}>
            <span />
            <span>Person</span>
            <span>AI this month</span>
            <span>Sees in chats</span>
            <span>Role</span>
            <span />
          </div>
        )}
        {members.length === 0 && !inviting && <div className="ld-empty">{q.isLoading ? "Loading..." : "No one on this team yet."}</div>}
        {members.map((m) => {
          const name = m.name?.trim() || m.email;
          const isOpen = editing === m.userId;
          const a = aiBy.get(m.userId);
          const hideEdit = !canManage || (m.userId === user?.id && m.role === "owner" && ownerCount === 1 && !canMakeOwner);
          return (
            <React.Fragment key={m.userId}>
              <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
                <PersonAvatar name={name} src={m.avatarUrl} size={40} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800 }}>{name}</div>
                  {m.name?.trim() && <div className="ld-small ld-muted" style={{ overflowWrap: "anywhere" }}>{m.email}</div>}
                </div>
                <AiCell a={a} warnPct={warnPct} />
                <span>{m.role === "chat" ? <span className="ld-small ld-muted">Team chat only</span> : accessLabel(m)}</span>
                <span className="ld-strong">{ROLE_LABEL[m.role] ?? m.role}</span>
                {hideEdit ? (
                  <span />
                ) : (
                  <button
                    type="button"
                    className="ld-btn"
                    onClick={() => {
                      updateRole.reset();
                      setLimit.reset();
                      remove.reset();
                      setRole(m.role);
                      setLimitMode(a?.mode ?? "default");
                      setOwn(a?.own == null ? "" : String(a.own));
                      setAccess(accessOf(m));
                      setEditing(isOpen ? null : m.userId);
                    }}
                  >
                    {isOpen ? "Close" : "Edit"}
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "44px minmax(0,1fr) minmax(0,1fr) 128px", gap: 18, alignItems: "start" }}>
                  <span />
                  <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                    <legend className="ld-lbl" style={{ padding: 0, marginBottom: 6 }}>Role</legend>
                    {ROLES.filter((r) => r !== "owner" || canMakeOwner || m.role === "owner").map((r) => (
                      <label key={r} style={{ display: "grid", gridTemplateColumns: "18px 118px minmax(0,1fr)", gap: 10, alignItems: "start", fontSize: 13.5, lineHeight: 1.35, cursor: "pointer" }}>
                        <input type="radio" name={`role-${m.userId}`} value={r} checked={role === r} onChange={() => setRole(r)} style={{ ...radio, marginTop: 2 }} />
                        <b>{ROLE_LABEL[r]}</b>
                        <span className="ld-muted">{ROLE_NOTE[r]}</span>
                      </label>
                    ))}
                  </fieldset>
                  <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                    <legend className="ld-lbl" style={{ padding: 0, marginBottom: 6 }}>Monthly AI limit</legend>
                    <label style={{ display: "grid", gridTemplateColumns: "18px 130px minmax(0,1fr)", gap: 10, alignItems: "center", fontSize: 13.5, cursor: "pointer" }}>
                      <input type="radio" name={`lim-${m.userId}`} checked={limitMode === "default"} onChange={() => setLimitMode("default")} style={radio} />
                      <b>Workspace limit</b>
                      <span className="ld-muted">{workspaceLimit == null ? "None set" : money(workspaceLimit)}</span>
                    </label>
                    <label style={{ display: "grid", gridTemplateColumns: "18px 130px minmax(0,1fr)", gap: 10, alignItems: "center", fontSize: 13.5, cursor: "pointer" }}>
                      <input type="radio" name={`lim-${m.userId}`} checked={limitMode === "custom"} onChange={() => setLimitMode("custom")} style={radio} />
                      <b>Their own limit</b>
                      <span className="ld-row" style={{ gap: 6 }}>
                        <span className="ld-muted">$</span>
                        <input className="ld-in" style={{ width: 80, height: 30 }} inputMode="decimal" aria-label={`${name}'s monthly limit in dollars`} value={own} onFocus={() => setLimitMode("custom")} onChange={(e) => setOwn(e.target.value)} />
                        <span className="ld-muted">a month</span>
                      </span>
                    </label>
                    <label style={{ display: "grid", gridTemplateColumns: "18px 130px minmax(0,1fr)", gap: 10, alignItems: "center", fontSize: 13.5, cursor: "pointer" }}>
                      <input type="radio" name={`lim-${m.userId}`} checked={limitMode === "none"} onChange={() => setLimitMode("none")} style={radio} />
                      <b>No limit</b>
                      <span />
                    </label>
                    {a && <span className="ld-small ld-muted">Used in {a.month}: {money(a.used)}{a.limit != null ? ` of ${money(a.limit)}` : ""}</span>}
                    {!ownOk && <span style={{ color: "#b42318", fontSize: 13 }}>Type the limit in dollars, like 25 or 40.50.</span>}
                    <ErrorLine error={updateRole.error ?? setLimit.error ?? setChatAccess.error ?? remove.error} />
                  </fieldset>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, gridColumn: 4, gridRow: "1 / 3" }}>
                    <button type="button" className="ld-btn p" disabled={saving || !ownOk} onClick={() => saveMember(m)}>
                      Save
                    </button>
                    <button type="button" className="ld-btn" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    {!(m.userId === user?.id && m.role === "owner" && ownerCount === 1) && (
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
                    )}
                  </div>
                  <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8, minWidth: 0, gridColumn: "2 / 4", marginTop: 6 }}>
                    <legend className="ld-lbl" style={{ padding: 0, marginBottom: 6 }}>What they see in the chats</legend>
                    {role === "owner" || role === "admin" ? (
                      <span className="ld-muted" style={{ fontSize: 13.5 }}>Everything. Owners and admins see every message in every AI employee's chat.</span>
                    ) : (
                      <>
                        <label style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 10, alignItems: "start", fontSize: 13.5, lineHeight: 1.35, cursor: "pointer" }}>
                          <input type="radio" name={`see-${m.userId}`} checked={access.mode === "own"} onChange={() => setAccess({ ...access, mode: "own" })} style={{ ...radio, marginTop: 2 }} />
                          <span><b>Their own only</b><br /><span className="ld-muted">Their messages and the employees' answers to them.</span></span>
                        </label>
                        <label style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 10, alignItems: "start", fontSize: 13.5, lineHeight: 1.35, cursor: "pointer" }}>
                          <input type="radio" name={`see-${m.userId}`} checked={access.mode === "some"} onChange={() => setAccess({ ...access, mode: "some" })} style={{ ...radio, marginTop: 2 }} />
                          <b>Their own, plus these people's</b>
                        </label>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", margin: "0 0 2px 28px", fontSize: 13.5 }}>
                          {members.filter((o) => o.userId !== m.userId && o.role !== "chat").map((o) => (
                            <label key={o.userId} style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                              <input type="checkbox" style={radio} checked={access.users.includes(o.userId)} onChange={(e) => setAccess({ ...access, mode: "some", users: e.target.checked ? [...access.users, o.userId] : access.users.filter((id) => id !== o.userId) })} />
                              {o.name?.trim() || o.email}
                            </label>
                          ))}
                          <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                            <input type="checkbox" style={radio} checked={access.workspace} onChange={(e) => setAccess({ ...access, mode: "some", workspace: e.target.checked })} />
                            Scheduled task reports
                          </label>
                        </div>
                        <label style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 10, alignItems: "start", fontSize: 13.5, lineHeight: 1.35, cursor: "pointer" }}>
                          <input type="radio" name={`see-${m.userId}`} checked={access.mode === "all"} onChange={() => setAccess({ ...access, mode: "all" })} style={{ ...radio, marginTop: 2 }} />
                          <span><b>Everything</b><br /><span className="ld-muted">Every message in every chat.</span></span>
                        </label>
                      </>
                    )}
                  </fieldset>
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

      <AiLimitsSection canEdit={canManage} />
    </Page>
  );
}
