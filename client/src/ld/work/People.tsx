import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, UnderlineTabs } from "../ui";
import { fmtDate } from "../meta";
import type { Outputs } from "../types";

type View = Outputs["people"]["list"];
type Hire = View["hires"][number];
type Leaving = View["leaving"][number];
type Item = { item: string; detail: string; status: "to_do" | "waiting" | "pending" | "done" | "stuck" };
type Plan = Hire["plan"];
type Group<K extends string> = { key: K; title: string; items: Item[] };
type Tab = "hires" | "leaving" | "customers";

const COLS = "minmax(0,2fr) minmax(0,1.3fr) 130px 160px 128px";
const STATUS: Record<Item["status"], { label: string; cls: string }> = {
  to_do: { label: "To do", cls: "gray" },
  waiting: { label: "Waiting", cls: "amber" },
  pending: { label: "Pending", cls: "amber" },
  done: { label: "Done", cls: "green" },
  stuck: { label: "Stuck", cls: "red" },
};

/** "2026-10-26" on screen as "Oct 26, 2026", read at noon so no time zone moves the day. */
const day = (ymd: string | null | undefined) => (ymd ? fmtDate(new Date(`${ymd.slice(0, 10)}T12:00:00`)) : "");
/** MM/DD/YYYY in an input, from YYYY-MM-DD. */
const mdy = (ymd: string | null | undefined) => (ymd && /^\d{4}-\d{2}-\d{2}/.test(ymd) ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}` : "");

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span className="im-prog">
      <span className="ld-small ld-muted">{`${done} of ${total} done`}</span>
      <span className="im-bar"><i style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></span>
    </span>
  );
}

function planText(plan: Plan, fallback: string) {
  if (!plan) return fallback;
  const n = `${plan.tasks} ${plan.tasks === 1 ? "task" : "tasks"}`;
  return plan.status === "planning" ? `Waiting for your OK: "${plan.name}", ${n}` : `In Projects: "${plan.name}", ${n}`;
}

function OpenPlan({ plan }: { plan: Plan }) {
  if (!plan) return null;
  return <Link className="ld-btn" href={plan.listId ? `/projects?list=${plan.listId}` : "/chats/projects/work"}>Open plan</Link>;
}

function Lists<K extends string>({ groups }: { groups: Group<K>[] }) {
  return (
    <>
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <div key={g.key}>
            <span className="ld-lbl">{g.title}</span>
            <div className="im-list">
              {g.items.map((it, i) => (
                <React.Fragment key={i}>
                  <span>{it.item}</span>
                  <span className={`ld-pill ${STATUS[it.status].cls}`}>{STATUS[it.status].label}</span>
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}
    </>
  );
}

/** Edit: every step as a name and a status, with a blank "Add a step" row at the end of each list. */
function EditLists<K extends string>({ groups, onChange }: { groups: Group<K>[]; onChange: (key: K, items: Item[]) => void }) {
  return (
    <>
      {groups.map((g) => {
        const rows = [...g.items, { item: "", detail: "", status: "to_do" as const }];
        const set = (i: number, patch: Partial<Item>) => {
          const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
          onChange(g.key, next.filter((r, j) => j < g.items.length || r.item.trim()));
        };
        return (
          <div key={g.key}>
            <span className="ld-lbl">{g.title}</span>
            <div className="im-list edit">
              {rows.map((it, i) => (
                <React.Fragment key={i}>
                  <input className="ld-in" value={it.item} placeholder={i === g.items.length ? "Add a step" : ""} aria-label={`${g.title} step`} onChange={(e) => set(i, { item: e.target.value })} />
                  <select className="ld-in" value={it.status} aria-label="Status" onChange={(e) => set(i, { status: e.target.value as Item["status"] })}>
                    {Object.entries(STATUS).map(([k, v]) => (
                      <option key={k} value={k}>{v.label}</option>
                    ))}
                  </select>
                </React.Fragment>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Imani's Work tab: new hires, people leaving, and customers being onboarded. */
export default function People({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const q = trpc.people.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 30_000 });
  const initial = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
  const [tab, setTab] = React.useState<Tab>(initial === "leaving" ? "leaving" : initial === "customers" ? "customers" : "hires");
  const v = q.data ?? { hires: [], leaving: [], customers: [] };
  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "hires", label: `New hires (${v.hires.length})` },
          { key: "leaving", label: `Leaving (${v.leaving.length})` },
          { key: "customers", label: `Customers (${v.customers.length})` },
        ]}
      />
      {tab === "hires" && <Hires list={v.hires} loading={q.isLoading} name={emp.name} />}
      {tab === "leaving" && <LeavingList list={v.leaving} loading={q.isLoading} name={emp.name} />}
      {tab === "customers" && <Customers list={v.customers} loading={q.isLoading} name={emp.name} />}
    </main>
  );
}

// ==========================================
// New hires
// ==========================================

function Hires({ list, loading, name }: { list: Hire[]; loading: boolean; name: string }) {
  const [open, setOpen] = React.useState<number | null>(null);
  // The first row starts open, once.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (!opened.current && list[0]) {
      opened.current = true;
      setOpen(list[0].id);
    }
  }, [list]);
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
        <span>New hire</span>
        <span>Role</span>
        <span>Starts</span>
        <span>Progress</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : `Nobody is onboarding. Tell ${name} in Chat who's starting, or press Hired on Quinn's Hiring tab.`}</div>}
      {list.map((h) => {
        const isOpen = open === h.id;
        return (
          <React.Fragment key={h.id}>
            <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
              <span className="ld-strong">{h.name}</span>
              <span>{h.role}</span>
              <span>{day(h.start) || "Not set"}</span>
              <Progress done={h.done} total={h.total} />
              <button type="button" className="ld-btn" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : h.id)}>{isOpen ? "Close" : "Open"}</button>
            </div>
            {isOpen && <HireDetail h={h} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function welcomePill(h: Hire) {
  const w = h.welcome;
  if (!w) return <span className="ld-pill gray">{h.email ? "Not written" : "No email on file"}</span>;
  if (w.status === "published") return <span className="ld-pill green">{w.at ? `Sent ${fmtDate(w.at)}` : "Sent"}</span>;
  if (w.status === "approved" || w.status === "scheduled") return <span className="ld-pill green">{w.at ? `Approved ${fmtDate(w.at)}` : "Approved"}</span>;
  if (w.status === "cancelled") return <span className="ld-pill gray">Not sent</span>;
  if (w.status === "blocked_connection") return <span className="ld-pill red">Email not connected</span>;
  return <span className="ld-pill amber">Waiting for your OK</span>;
}

function HireDetail({ h }: { h: Hire }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const current = () => ({ paperwork: h.paperwork as Item[], accounts: h.accounts as Item[], credentialing: h.credentialing as Item[] });
  const [lists, setLists] = React.useState(current);
  const [note, setNote] = React.useState<string | null>(null);
  const save = trpc.people.saveOnboarding.useMutation({ onSuccess: async () => { setEditing(false); await utils.people.list.invalidate(); } });
  const remind = trpc.people.remind.useMutation({
    onSuccess: (r) => setNote(r.queued ? "The reminder is waiting for your OK in Approvals." : r.posted ? "No email on file, so the reminder is in chat." : "Nothing is open."),
  });
  const groups = (src: ReturnType<typeof current>): Group<"paperwork" | "accounts" | "credentialing">[] => [
    { key: "paperwork", title: "Paperwork", items: src.paperwork },
    { key: "accounts", title: "Accounts and training", items: src.accounts },
    ...(src.credentialing.length || h.credentialing.length ? [{ key: "credentialing" as const, title: "Credentialing", items: src.credentialing }] : []),
  ];
  const startEdit = () => {
    setLists(current());
    setEditing(true);
  };
  return (
    <div className={`ld-expand im-exp ${editing ? "editing" : ""}`}>
      <div className="im-col">
        <div className="im-kv">
          <b>Welcome email</b>
          <span>{welcomePill(h)}</span>
          <b>First-week plan</b>
          <span>{planText(h.plan, "Not planned")}</span>
          <b>Check-ins</b>
          <span>{h.checkins.length ? h.checkins.map((c) => `${c.days} days ${day(c.date)}`).join(" · ") : "Not set"}</span>
        </div>
        {editing ? <EditLists groups={groups(lists)} onChange={(k, items) => setLists((l) => ({ ...l, [k]: items }))} /> : <Lists groups={groups(current())} />}
        {note && !editing && <span className="ld-small ld-muted">{note}</span>}
        <ErrorLine error={save.error || remind.error} />
      </div>
      <div className="im-btns">
        {editing ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: h.id, lists })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="ld-btn" onClick={startEdit}>Edit</button>
            <OpenPlan plan={h.plan} />
            <button type="button" className="ld-btn" disabled={remind.isPending || remind.isSuccess} onClick={() => remind.mutate({ organizationId: currentOrgId, id: h.id })}>{remind.isSuccess ? "Reminded" : "Remind them"}</button>
          </>
        )}
      </div>
    </div>
  );
}

// ==========================================
// People leaving
// ==========================================

function LeavingList({ list, loading, name }: { list: Leaving[]; loading: boolean; name: string }) {
  const [open, setOpen] = React.useState<number | null>(null);
  // The first row starts open, once.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (!opened.current && list[0]) {
      opened.current = true;
      setOpen(list[0].id);
    }
  }, [list]);
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
        <span>Person</span>
        <span>Role</span>
        <span>Last day</span>
        <span>Progress</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : `Nobody is leaving. Tell ${name} in Chat when someone gives notice.`}</div>}
      {list.map((p) => {
        const isOpen = open === p.id;
        return (
          <React.Fragment key={p.id}>
            <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
              <span className="ld-strong">{p.name}</span>
              <span>{p.role}</span>
              <span>{day(p.lastDay)}</span>
              <Progress done={p.done} total={p.total} />
              <button type="button" className="ld-btn" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.id)}>{isOpen ? "Close" : "Open"}</button>
            </div>
            {isOpen && <LeavingDetail p={p} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function LeavingDetail({ p }: { p: Leaving }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const fresh = () => ({ clients: p.clients as Item[], access: p.access as Item[], pay: p.pay as Item[] });
  const [lists, setLists] = React.useState(fresh);
  const [reason, setReason] = React.useState(p.reason);
  const [exit, setExit] = React.useState(mdy(p.exitInterview));
  const save = trpc.people.saveOffboarding.useMutation({ onSuccess: async () => { setEditing(false); await utils.people.list.invalidate(); } });
  const groups = (src: ReturnType<typeof fresh>): Group<"clients" | "access" | "pay">[] => [
    ...(src.clients.length || p.caseload ? [{ key: "clients" as const, title: "Clients and records", items: src.clients }] : []),
    { key: "access", title: "Access and property", items: src.access },
    { key: "pay", title: "Pay and paperwork", items: src.pay },
  ];
  const startEdit = () => {
    setLists(fresh());
    setReason(p.reason);
    setExit(mdy(p.exitInterview));
    setEditing(true);
  };
  return (
    <div className={`ld-expand im-exp ${editing ? "editing" : ""}`}>
      <div className="im-col">
        {editing ? (
          <div className="im-kv">
            <label htmlFor={`im-r-${p.id}`}><b>Reason</b></label>
            <input id={`im-r-${p.id}`} className="ld-in" value={reason} onChange={(e) => setReason(e.target.value)} />
            <b>Plan</b>
            <span>{planText(p.plan, "Not planned")}</span>
            <label htmlFor={`im-x-${p.id}`}><b>Exit interview</b></label>
            <input id={`im-x-${p.id}`} className="ld-in im-date" value={exit} placeholder="MM/DD/YYYY" inputMode="numeric" onChange={(e) => setExit(e.target.value)} />
          </div>
        ) : (
          <div className="im-kv">
            <b>Reason</b>
            <span>{p.reason || "Not given"}</span>
            <b>Plan</b>
            <span>{planText(p.plan, "Not planned")}</span>
            <b>Exit interview</b>
            <span>{day(p.exitInterview) || "Not set"}</span>
          </div>
        )}
        {editing ? <EditLists groups={groups(lists)} onChange={(k, items) => setLists((l) => ({ ...l, [k]: items }))} /> : <Lists groups={groups(fresh())} />}
        <ErrorLine error={save.error} />
      </div>
      <div className="im-btns">
        {editing ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: p.id, lists, reason, exitInterview: exit.trim() || null })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="ld-btn" onClick={startEdit}>Edit</button>
            <OpenPlan plan={p.plan} />
          </>
        )}
      </div>
    </div>
  );
}

// ==========================================
// Customers
// ==========================================

const CUST_COLS = "minmax(0,2fr) 130px 160px 128px";

function Customers({ list, loading, name }: { list: View["customers"]; loading: boolean; name: string }) {
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: CUST_COLS }}>
        <span>Customer</span>
        <span>Go-live</span>
        <span>Progress</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : `No customers onboarding. Tell ${name} in Chat who signed.`}</div>}
      {list.map((c) => (
        <div key={c.id} className="ld-rw" style={{ gridTemplateColumns: CUST_COLS }}>
          <span className="ld-strong">{c.name}</span>
          <span>{fmtDate(c.goLive)}</span>
          <Progress done={c.done} total={c.total} />
          <Link className="ld-btn" href={c.listId ? `/projects?list=${c.listId}` : "/chats/projects/work"}>Open plan</Link>
        </div>
      ))}
    </div>
  );
}
