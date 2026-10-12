import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine, FolderTabs, Page } from "../ui";
import { fmtDate } from "../meta";
import type { Outputs } from "../types";
import { RulesEditor, TableEditor, type HbPart, type HbSection } from "../handbook/parts";

const COLS = "minmax(0,1fr) 90px 170px 128px";
const CH_COLS = "150px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)";

type Row = HbPart & { ruleCount: number; updatedBy: string | null; updatedAt: string | Date | null };

/** LeadDash staff only: the base handbook every workspace follows, and who changed it. */
export default function BaseInstructions() {
  const q = trpc.handbook.base.useQuery();
  const [tab, setTab] = React.useState<"handbook" | "playbooks" | "changes" | "hours">("handbook");
  const [open, setOpen] = React.useState<string | null>(null);
  const parts = (q.data?.parts ?? []) as Row[];
  const plays = (q.data?.playbooks ?? []) as Row[];
  const changes = q.data?.changes ?? [];

  return (
    <Page rail="account" maxWidth={1140}>
      <div className="ld-row" style={{ gap: 12 }}>
        <h1 className="ld-h1">Base instructions</h1>
        <span className="ld-pill amber">LeadDash staff only</span>
      </div>
      <FolderTabs
        tabs={[
          { key: "handbook", label: `Handbook (${parts.length})` },
          { key: "playbooks", label: `Playbooks (${plays.length})` },
          { key: "changes", label: `Changes (${changes.length})` },
          { key: "hours", label: "Work hours" },
        ]}
        value={tab}
        onChange={setTab}
      >
        {tab === "hours" ? (
          <WorkHoursTab />
        ) : tab !== "changes" ? (
          <>
            <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
              <span>{tab === "handbook" ? "Part" : "Playbook"}</span>
              <span>Rules</span>
              <span>Last changed</span>
              <span />
            </div>
            {(tab === "handbook" ? parts : plays).length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load the handbook."}</div>}
            {(tab === "handbook" ? parts : plays).map((p) => {
              const isOpen = open === p.key;
              return (
                <React.Fragment key={p.key}>
                  <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
                    <span className="ld-strong">{p.title}</span>
                    <span><span className="ld-hb-m ld-muted">Rules: </span>{p.ruleCount}</span>
                    <span><span className="ld-hb-m ld-muted">Last changed: </span>{p.updatedAt ? fmtDate(p.updatedAt) : "Original"}</span>
                    <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : p.key)}>{isOpen ? "Close" : "Open"}</button>
                  </div>
                  {isOpen && <PartEditor part={p} workspaces={q.data?.workspaces ?? 0} onDone={() => setOpen(null)} />}
                </React.Fragment>
              );
            })}
          </>
        ) : (
          <>
            <div className="ld-hd" style={{ gridTemplateColumns: CH_COLS }}>
              <span>Date</span>
              <span>Part</span>
              <span>Who</span>
              <span>What changed</span>
            </div>
            {changes.length === 0 && <div className="ld-empty">No changes yet. Every part is the original text.</div>}
            {changes.map((c) => (
              <div key={c.id} className="ld-rw" style={{ gridTemplateColumns: CH_COLS }}>
                <span>{fmtDate(c.createdAt)}</span>
                <span className="ld-strong">{c.part}</span>
                <span>{c.actorName}</span>
                <span>{c.summary}</span>
              </div>
            ))}
          </>
        )}
      </FolderTabs>
      <ErrorLine error={q.error} />
    </Page>
  );
}

const WH_COLS = "minmax(0,1fr) 150px 120px 90px 80px 128px";
const PLAN_OPTIONS: { key: string; label: string }[] = [
  { key: "", label: "No plan (not limited)" },
  { key: "starter", label: "Starter, 50 hours, $49" },
  { key: "growth", label: "Growth, 120 hours, $99" },
  { key: "pro", label: "Pro, 200 hours, $199" },
  { key: "practice_starter", label: "Practice Starter, 50 hours, $99" },
  { key: "practice_growth", label: "Practice Growth, 120 hours, $199" },
  { key: "practice_pro", label: "Practice Pro, 300 hours, $349" },
];
type PlanKey = "starter" | "growth" | "pro" | "practice_starter" | "practice_growth" | "practice_pro";

/** LeadDash staff: each workspace's plan, work hours this month, AI cost and margin; set the plan and add bought hours. */
function WorkHoursTab() {
  const q = trpc.hours.staffList.useQuery();
  const [open, setOpen] = React.useState<number | null>(null);
  const list = q.data ?? [];
  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: WH_COLS }}>
        <span>Workspace</span>
        <span>Plan</span>
        <span>Used / left</span>
        <span>AI cost</span>
        <span>Margin</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : "No workspaces yet."}</div>}
      {list.map((w) => {
        const isOpen = open === w.id;
        return (
          <React.Fragment key={w.id}>
            <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: WH_COLS }}>
              <span className="ld-strong" style={{ overflowWrap: "anywhere" }}>{w.name}</span>
              <span>{w.planName ?? <span className="ld-muted">No plan</span>}</span>
              <span>{w.usedHours} hr{w.leftHours != null ? ` / ${w.leftHours} hr` : ""}</span>
              <span>${w.cost.toFixed(2)}</span>
              <span style={{ fontWeight: 700, color: w.margin == null ? "var(--ld-muted)" : w.margin >= 50 ? "var(--ld-accent)" : w.margin >= 35 ? "#b5651d" : "var(--ld-bad)" }}>{w.margin == null ? "None" : `${w.margin}%`}</span>
              <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : w.id)}>{isOpen ? "Close" : "Open"}</button>
            </div>
            {isOpen && <WorkspaceHours w={w} />}
          </React.Fragment>
        );
      })}
      <ErrorLine error={q.error} />
    </>
  );
}

type StaffRow = Outputs["hours"]["staffList"][number];

function WorkspaceHours({ w }: { w: StaffRow }) {
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.hours.staffList.invalidate(), utils.hours.get.invalidate()]);
  const [editing, setEditing] = React.useState(false);
  const [plan, setPlan] = React.useState<string>(w.plan ?? "");
  const [internal, setInternal] = React.useState<boolean>(w.internal);
  const [hours, setHours] = React.useState("");
  const [note, setNote] = React.useState("");
  const savePlan = trpc.hours.setPlan.useMutation();
  const saveInternal = trpc.hours.setInternal.useMutation();
  const save = async () => {
    try {
      if ((plan || null) !== w.plan) await savePlan.mutateAsync({ organizationId: w.id, plan: (plan || null) as PlanKey | null });
      if (internal !== w.internal) await saveInternal.mutateAsync({ organizationId: w.id, internal });
      setEditing(false);
      await refresh();
    } catch {
      // The error shows under the fields.
    }
  };
  const add = trpc.hours.addPack.useMutation({ onSuccess: async () => { setHours(""); setNote(""); await refresh(); } });
  const hoursOk = /^\d+(\.\d)?$/.test(hours.trim()) && Number(hours) >= 0.5;
  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <span className="ld-lbl">Plan</span>
        {!editing ? (
          <span>{w.planName ? `${w.planName}, ${w.planHours} work hours a month` : "No plan. Work is counted but not limited."}</span>
        ) : (
          <select className="ld-in" style={{ maxWidth: 320 }} aria-label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
            {PLAN_OPTIONS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        )}
        <span className="ld-lbl" style={{ marginTop: 8 }}>Whose workspace</span>
        {!editing ? (
          <span>{w.internal ? "LeadDash's own. Kai and Zara are on the team." : "A customer's. Kai and Zara are off the team."}</span>
        ) : (
          <span className="ld-row" style={{ gap: 18, fontSize: 13.5, flexWrap: "wrap" }}>
            <label className="ld-row" style={{ gap: 6 }}><input type="radio" name={`own-${w.id}`} checked={internal} onChange={() => setInternal(true)} />LeadDash's own</label>
            <label className="ld-row" style={{ gap: 6 }}><input type="radio" name={`own-${w.id}`} checked={!internal} onChange={() => setInternal(false)} />A customer's</label>
          </span>
        )}
        <span className="ld-lbl" style={{ marginTop: 8 }}>Add bought hours</span>
        <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input className="ld-in" style={{ width: 90 }} inputMode="decimal" placeholder="Hours" aria-label="Hours bought" value={hours} onChange={(e) => setHours(e.target.value)} />
          <input className="ld-in" style={{ flex: "1 1 180px", minWidth: 0 }} placeholder="Note (paid Oct 11, 2026)" aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="ld-btn p" style={{ width: 100 }} disabled={!hoursOk || add.isPending} onClick={() => add.mutate({ organizationId: w.id, hours: Number(hours), note })}>{add.isPending ? "Adding" : "Add"}</button>
        </div>
        <span className="ld-small ld-muted">Bought hours are used after the plan's hours each month and last 12 months.</span>
        <ErrorLine error={savePlan.error ?? saveInternal.error ?? add.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <span className="ld-lbl">Bought hours</span>
        {w.packs.length === 0 && <span className="ld-muted">None yet.</span>}
        {w.packs.map((p) => (
          <span key={p.id} className="ld-small" style={{ lineHeight: 1.5 }}>
            <b>{p.hours} hr</b> added {p.added}{p.addedBy ? ` by ${p.addedBy}` : ""}, {p.left} hr left, good through {p.expires}{p.note ? `. ${p.note}` : ""}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {!editing ? (
          <button type="button" className="ld-btn" onClick={() => { setPlan(w.plan ?? ""); setInternal(w.internal); setEditing(true); }}>Edit</button>
        ) : (
          <>
            <button type="button" className="ld-btn p" disabled={savePlan.isPending || saveInternal.isPending} onClick={() => void save()}>{savePlan.isPending || saveInternal.isPending ? "Saving" : "Save"}</button>
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        )}
      </div>
    </div>
  );
}

function PartEditor({ part, workspaces, onDone }: { part: Row; workspaces: number; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [lead, setLead] = React.useState(part.lead);
  const [sections, setSections] = React.useState<HbSection[]>(() => part.sections.map((s) => ({ title: s.title, rules: [...s.rules], table: s.table ? { columns: [...s.table.columns], rows: s.table.rows.map((r) => [...r]) } : null })));
  const done = async () => {
    await utils.handbook.base.invalidate();
    onDone();
  };
  const save = trpc.handbook.saveBase.useMutation({ onSuccess: done });
  const reset = trpc.handbook.resetBase.useMutation({ onSuccess: done });
  const setSec = (i: number, s: HbSection) => setSections(sections.map((x, k) => (k === i ? s : x)));
  const submit = () =>
    save.mutate({
      partKey: part.key,
      part: {
        title: part.title,
        lead: lead.trim(),
        sections: sections
          .map((s) => ({ title: s.title.trim(), rules: s.rules.map((r) => r.trim()).filter(Boolean), table: s.table ? { columns: s.table.columns, rows: s.table.rows.filter((r) => r.some((c) => c.trim())) } : null }))
          .filter((s) => s.title || s.rules.length || (s.table && s.table.rows.length)),
      },
    });

  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <label className="ld-hb-sub" htmlFor={`lead-${part.key}`}>Opening line</label>
        <textarea id={`lead-${part.key}`} className="ld-ta" rows={2} value={lead} onChange={(e) => setLead(e.target.value)} />
        {sections.map((s, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 10, borderTop: i ? "1px solid var(--ld-line)" : 0, marginTop: i ? 8 : 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 8, alignItems: "center" }}>
              <input className="ld-in" style={{ fontWeight: 800 }} value={s.title} aria-label={`Section ${i + 1} title`} onChange={(e) => setSec(i, { ...s, title: e.target.value })} placeholder="Section title" />
              <button type="button" className="ld-btn" onClick={() => setSections(sections.filter((_, k) => k !== i))}>Remove section</button>
            </div>
            <RulesEditor rules={s.rules} onChange={(rules) => setSec(i, { ...s, rules })} label="Rule" />
            {(s.rules.length > 0 || !s.table) && (
              <div style={{ padding: "4px 0 0 36px" }}>
                <button type="button" className="ld-btn" onClick={() => setSec(i, { ...s, rules: [...s.rules, ""] })}>Add rule</button>
              </div>
            )}
            {s.table && <TableEditor table={s.table} onChange={(table) => setSec(i, { ...s, table })} />}
          </div>
        ))}
        <div style={{ paddingTop: 10 }}>
          <button type="button" className="ld-btn" onClick={() => setSections([...sections, { title: "", rules: [""], table: null }])}>Add section</button>
        </div>
        <span className="ld-small" style={{ color: "#8a5a00", fontWeight: 700, paddingTop: 10 }}>
          Saving updates every workspace: {workspaces} workspace{workspaces === 1 ? "" : "s"}. Their own additions stay as they are.
        </span>
        <ErrorLine error={save.error ?? reset.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={save.isPending} onClick={submit}>{save.isPending ? "Saving..." : "Save"}</button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
        {part.updatedAt && (
          <button type="button" className="ld-btn" disabled={reset.isPending} onClick={() => reset.mutate({ partKey: part.key })}>Use original</button>
        )}
      </div>
    </div>
  );
}
