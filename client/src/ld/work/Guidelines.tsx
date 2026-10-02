import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import { ALWAYS_FOLLOWED, GUIDELINE_LABELS, parseJson, type Kind } from "../meta";

type G = { focus: string; avoid: string; signAs: string };

/** Guidelines tab for any employee: name, instructions, and fixed rules. */
export default function Guidelines({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId, currentOrg } = useTenant();
  const utils = trpc.useUtils();
  const kind = (emp.kind in GUIDELINE_LABELS ? emp.kind : "custom") as Kind;
  const labels = GUIDELINE_LABELS[kind];
  const saved = parseJson<Partial<G>>(emp.guidelines, {});
  const g: G = { focus: saved.focus ?? "", avoid: saved.avoid ?? "", signAs: saved.signAs ?? "" };

  const [editing, setEditing] = React.useState<"employee" | "instructions" | null>(null);
  const [name, setName] = React.useState(emp.name);
  const [form, setForm] = React.useState<G>(g);

  React.useEffect(() => setEditing(null), [emp.id]);

  const update = trpc.employees.update.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await utils.employees.invalidate();
    },
  });

  const val = (v: string) => (v.trim() ? <span className="ld-pre">{v}</span> : <span className="ld-muted">Not set</span>);

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

      <section className={`ld-card ${editing === "instructions" ? "editing" : ""}`}>
        <div className="ld-sh">
          <span className="ld-st">Your instructions</span>
          {editing === "instructions" ? (
            <span className="ld-row">
              <button type="button" className="ld-btn sm" onClick={() => setEditing(null)}>Cancel</button>
              <button
                type="button"
                className="ld-btn p sm"
                disabled={update.isPending}
                onClick={() => update.mutate({ id: emp.id, organizationId: currentOrgId, guidelines: { focus: form.focus.trim(), avoid: form.avoid.trim(), signAs: form.signAs.trim() } })}
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
                setForm(g);
                update.reset();
                setEditing("instructions");
              }}
            >
              Edit
            </button>
          )}
        </div>
        {editing === "instructions" ? (
          <div className="ld-kv" style={{ alignItems: "start" }}>
            <label htmlFor="g-focus" className="ld-k" style={{ paddingTop: 6 }}>{labels.focus}</label>
            <textarea id="g-focus" className="ld-ta" rows={2} maxLength={2000} value={form.focus} onChange={(e) => setForm({ ...form, focus: e.target.value })} />
            <label htmlFor="g-avoid" className="ld-k" style={{ paddingTop: 6 }}>{labels.avoid}</label>
            <textarea id="g-avoid" className="ld-ta" rows={2} maxLength={2000} value={form.avoid} onChange={(e) => setForm({ ...form, avoid: e.target.value })} />
            <label htmlFor="g-sign" className="ld-k" style={{ paddingTop: 6 }}>{labels.signAs}</label>
            <input id="g-sign" className="ld-in" maxLength={200} value={form.signAs} onChange={(e) => setForm({ ...form, signAs: e.target.value })} />
          </div>
        ) : (
          <div className="ld-kv" style={{ alignItems: "start" }}>
            <span className="ld-k">{labels.focus}</span>
            {val(g.focus)}
            <span className="ld-k">{labels.avoid}</span>
            {val(g.avoid)}
            <span className="ld-k">{labels.signAs}</span>
            {val(g.signAs)}
          </div>
        )}
        {editing === "instructions" && (
          <div style={{ padding: "0 18px 14px 18px" }}>
            <ErrorLine error={update.error} />
          </div>
        )}
      </section>

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
