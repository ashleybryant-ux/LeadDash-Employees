import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine, FolderTabs, Page } from "../ui";
import { fmtDate } from "../meta";
import { RulesEditor, TableEditor, type HbPart, type HbSection } from "../handbook/parts";

const COLS = "minmax(0,1fr) 90px 170px 128px";
const CH_COLS = "150px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)";

type Row = HbPart & { ruleCount: number; updatedBy: string | null; updatedAt: string | Date | null };

/** LeadDash staff only: the base handbook every workspace follows, and who changed it. */
export default function BaseInstructions() {
  const q = trpc.handbook.base.useQuery();
  const [tab, setTab] = React.useState<"handbook" | "changes">("handbook");
  const [open, setOpen] = React.useState<string | null>(null);
  const parts = (q.data?.parts ?? []) as Row[];
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
          { key: "changes", label: `Changes (${changes.length})` },
        ]}
        value={tab}
        onChange={setTab}
      >
        {tab === "handbook" ? (
          <>
            <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
              <span>Part</span>
              <span>Rules</span>
              <span>Last changed</span>
              <span />
            </div>
            {parts.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load the handbook."}</div>}
            {parts.map((p) => {
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
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 10, borderTop: i ? "1px solid #e3e9e6" : 0, marginTop: i ? 8 : 0 }}>
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
