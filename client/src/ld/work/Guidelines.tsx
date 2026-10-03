import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import { ALWAYS_FOLLOWED, GUIDELINE_LABELS, type Kind } from "../meta";

/** Guidelines tab for any employee: name, the guideline sections (from onboarding, chat and you), and fixed rules. */
export default function Guidelines({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId, currentOrg } = useTenant();
  const utils = trpc.useUtils();
  const kind = (emp.kind in GUIDELINE_LABELS ? emp.kind : "custom") as Kind;
  const [editing, setEditing] = React.useState<"employee" | null>(null);
  const [name, setName] = React.useState(emp.name);

  React.useEffect(() => setEditing(null), [emp.id]);

  const update = trpc.employees.update.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await utils.employees.invalidate();
    },
  });

  return (
    <main className="ld-main" style={{ padding: "28px 36px", maxWidth: 860, gap: 16 }}>
      <section className={`ld-card ${editing === "employee" ? "editing" : ""}`}>
        <div className="ld-sh">
          <span className="ld-st">Employee</span>
          {editing === "employee" ? (
            <span className="ld-row">
              <button type="button" className="ld-btn sm" onClick={() => setEditing(null)}>Cancel</button>
              <button
                type="button"
                className="ld-btn p sm"
                disabled={update.isPending || !name.trim()}
                onClick={() => update.mutate({ id: emp.id, organizationId: currentOrgId, name: name.trim() })}
              >
                Save
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="ld-btn sm"
              disabled={editing !== null}
              onClick={() => {
                setName(emp.name);
                update.reset();
                setEditing("employee");
              }}
            >
              Edit
            </button>
          )}
        </div>
        <div className="ld-kv">
          {editing === "employee" ? (
            <label htmlFor="emp-name" className="ld-k">Name</label>
          ) : (
            <span className="ld-k">Name</span>
          )}
          {editing === "employee" ? (
            <input id="emp-name" className="ld-in" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          ) : (
            <span>{emp.name}</span>
          )}
          <span className="ld-k">Job</span>
          <span>{emp.roleTitle}</span>
          <span className="ld-k">Works for</span>
          <span>{currentOrg?.name ?? ""}</span>
        </div>
        {editing === "employee" && (
          <div style={{ padding: "0 18px 14px 18px" }}>
            <ErrorLine error={update.error} />
          </div>
        )}
      </section>

      <GuidelineSections emp={emp} />

      <section className="ld-card">
        <div className="ld-sh">
          <span className="ld-st">Always followed</span>
        </div>
        <div style={{ padding: "14px 18px", fontSize: 14, lineHeight: 1.7, color: "#24332c" }}>
          {ALWAYS_FOLLOWED[kind].map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </section>
    </main>
  );
}

// ==========================================
// Guideline sections
// ==========================================

type GView = { sections: { key: string; title: string; items: { id: string; text: string; source: string; at: string; note?: string }[] }[]; conflicts: { id: string; text: string; options: { label: string; keep: string }[] }[]; examples: number; canLearn: boolean };

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function sourceLabel(i: { source: string; at: string; note?: string }) {
  if (i.source === "interview") return "From your interview";
  if (i.source === "chat") return `Added in chat, ${fmt(i.at)}`;
  if (i.source === "learned") return i.note ?? "Learned from your examples";
  if (i.source === "settled") return `You settled a conflict, ${fmt(i.at)}`;
  return `Added by you, ${fmt(i.at)}`;
}

const WRITES = new Set(["writing", "voice", "style", "pitch"]);

function GuidelineSections({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.guidelines.get.useQuery({ organizationId: currentOrgId, employeeId: emp.id }, { enabled: currentOrgId > 0 });
  const done = () => Promise.all([utils.guidelines.get.invalidate(), utils.onboarding.get.invalidate()]);
  const learn = trpc.guidelines.learn.useMutation({ onSuccess: done });
  const check = trpc.guidelines.check.useMutation({ onSuccess: done });
  const resolve = trpc.guidelines.resolve.useMutation({ onSuccess: done });
  const [editing, setEditing] = React.useState<string | null>(null);
  const g = q.data as GView | undefined;
  if (!g) return <div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load the guidelines."}</div>;
  const writes = g.sections.some((s) => WRITES.has(s.key));
  return (
    <>
      {g.conflicts.length > 0 && (
        <section className="ld-card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10, borderColor: "#e8b36b", background: "#fffaf2" }}>
          <div className="ld-row" style={{ gap: 10 }}>
            <span className="ld-pill amber">{`${g.conflicts.length} conflict${g.conflicts.length === 1 ? "" : "s"}`}</span>
            <span style={{ fontWeight: 800 }}>{`${emp.name} found guidelines that disagree`}</span>
          </div>
          {g.conflicts.map((c) => (
            <div key={c.id} style={{ border: "1px solid #e3e9e6", borderRadius: 10, background: "#fff", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 14, lineHeight: 1.5 }}>{c.text}</span>
              <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
                {c.options.map((o, i) => (
                  <button key={i} type="button" className="ld-chip" title={o.keep} disabled={resolve.isPending} onClick={() => resolve.mutate({ organizationId: currentOrgId, employeeId: emp.id, conflictId: c.id, option: i })}>{o.label}</button>
                ))}
                <button type="button" className="ld-chip" disabled={resolve.isPending} onClick={() => resolve.mutate({ organizationId: currentOrgId, employeeId: emp.id, conflictId: c.id, option: -1 })}>Not a conflict</button>
              </div>
            </div>
          ))}
          <ErrorLine error={resolve.error} />
        </section>
      )}

      <section className="ld-card" style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{writes ? "Learn from your examples" : "Check for conflicts"}</span>
          <span className="ld-body" style={{ color: "#3d4c45" }}>
            {writes
              ? g.canLearn
                ? `${emp.name} reads the ${g.examples} example${g.examples === 1 ? "" : "s"} you gave in onboarding and writes your style into these guidelines for you to check.`
                : `Add examples you liked in ${emp.name}'s onboarding, then ${emp.name} can write your style from them.`
              : `${emp.name} checks these guidelines for lines that disagree.`}
          </span>
          <ErrorLine error={learn.error || check.error} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {writes && <button type="button" className="ld-btn p" disabled={!g.canLearn || learn.isPending} onClick={() => learn.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>{learn.isPending ? "Learning..." : "Learn"}</button>}
          <button type="button" className="ld-btn" disabled={check.isPending} onClick={() => check.mutate({ organizationId: currentOrgId, employeeId: emp.id })}>{check.isPending ? "Checking..." : "Check"}</button>
        </div>
      </section>

      {g.sections.map((s) =>
        editing === s.key ? (
          <SectionEdit key={s.key} emp={emp} section={s} onClose={() => setEditing(null)} />
        ) : (
          <section key={s.key} className="ld-card" style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontWeight: 800, fontSize: 15, paddingBottom: 6 }}>{s.title}</span>
              {s.items.length === 0 && <span className="ld-body ld-muted" style={{ padding: "6px 0" }}>Nothing yet. Answers from onboarding, and rules you give in chat, show up here.</span>}
              {s.items.map((i, n) => (
                <div key={i.id} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr)", gap: 10, padding: "8px 0", borderBottom: n === s.items.length - 1 ? 0 : "1px solid #eef2f0" }}>
                  <span style={{ width: 22, height: 22, borderRadius: 6, background: "#eef3f0", color: "#1b6b4a", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{n + 1}</span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{i.text}</span>
                    <span className="ld-small ld-muted">{sourceLabel(i)}</span>
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button type="button" className="ld-btn" disabled={editing !== null} onClick={() => setEditing(s.key)}>Edit</button>
            </div>
          </section>
        )
      )}
    </>
  );
}

function SectionEdit({ emp, section, onClose }: { emp: EmployeeRow; section: GView["sections"][number]; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [rows, setRows] = React.useState(section.items.map((i) => ({ id: i.id as string | undefined, text: i.text })));
  const save = trpc.guidelines.saveSection.useMutation({ onSuccess: async () => { await Promise.all([utils.guidelines.get.invalidate(), utils.onboarding.get.invalidate()]); onClose(); } });
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
  };
  return (
    <section className="ld-card editing" style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span style={{ fontWeight: 800, fontSize: 15, paddingBottom: 6 }}>{section.title}</span>
        {rows.map((r, i) => (
          <div key={i} className="ld-keep ld-guide-row" style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr) 64px 64px 96px", gap: 8, alignItems: "start", padding: "4px 0" }}>
            <span style={{ fontWeight: 800, color: "#5b6b64", paddingTop: 8 }}>{i + 1}</span>
            <textarea className="ld-ta" rows={r.text.length > 110 ? 3 : 1} aria-label={`Guideline ${i + 1}`} value={r.text} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} style={{ minHeight: 34 }} />
            <button type="button" className="ld-btn" style={{ width: 64, padding: 0 }} disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
            <button type="button" className="ld-btn" style={{ width: 64, padding: 0 }} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>Down</button>
            <button type="button" className="ld-btn" style={{ width: 96 }} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div style={{ paddingTop: 8, paddingLeft: 36 }}>
          <button type="button" className="ld-btn" style={{ width: 150 }} disabled={rows.length >= 40} onClick={() => setRows([...rows, { id: undefined, text: "" }])}>Add guideline</button>
        </div>
        <span className="ld-small ld-muted" style={{ paddingLeft: 36 }}>Edited interview lines become yours, and their onboarding answer is cleared.</span>
        <ErrorLine error={save.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, employeeId: emp.id, section: section.key, lines: rows.filter((r) => r.text.trim()) })}>{save.isPending ? "Saving..." : "Save"}</button>
        <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
      </div>
    </section>
  );
}
