import React from "react";

export type HbTable = { columns: string[]; rows: string[][] };
export type HbSection = { title: string; rules: string[]; table?: HbTable | null };
export type HbPart = { key: string; title: string; lead: string; sections: HbSection[] };

const num: React.CSSProperties = { fontWeight: 800, color: "#5b6b64" };
const ro: React.CSSProperties = { display: "grid", gridTemplateColumns: "28px minmax(0,1fr)", gap: 10, padding: "8px 0", borderBottom: "1px solid #eef2f0", fontSize: 14, lineHeight: 1.5 };
const sub: React.CSSProperties = { fontSize: 13, fontWeight: 800, padding: "12px 0 4px 0" };

/** One rule, read-only. Templates keep their line breaks. */
function RuleText({ text }: { text: string }) {
  return <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text.replace(/\*\*/g, "")}</span>;
}

export function RuleList({ rules }: { rules: string[] }) {
  return (
    <div>
      {rules.map((r, i) => (
        <div key={i} style={ro}>
          <span style={num}>{i + 1}</span>
          <RuleText text={r} />
        </div>
      ))}
    </div>
  );
}

function TableView({ table }: { table: HbTable }) {
  const cols = `repeat(${table.columns.length}, minmax(0,1fr))`;
  return (
    <div style={{ border: "1px solid #e3e9e6", borderRadius: 10, overflow: "hidden", margin: "6px 0", overflowX: "auto" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: cols, minWidth: 520 }}>
        {table.columns.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      {table.rows.map((row, i) => (
        <div key={i} className="ld-rw" style={{ gridTemplateColumns: cols, alignItems: "start", minWidth: 520 }}>
          {table.columns.map((_, j) => (
            <span key={j} style={{ fontWeight: j === 0 ? 700 : 400 }}>{row[j] ?? ""}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A whole part, read-only: opening line, then each section's rules and table. */
export function PartView({ part }: { part: HbPart }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {part.lead && <p className="ld-body" style={{ margin: "8px 0 4px 0" }}>{part.lead}</p>}
      {part.sections.map((s, i) => (
        <div key={i}>
          {s.title && <div style={sub}>{s.title}</div>}
          {s.rules.length > 0 && <RuleList rules={s.rules} />}
          {s.table && s.table.rows.length > 0 && <TableView table={s.table} />}
        </div>
      ))}
    </div>
  );
}

/** Rules as a compact list of inputs with Up, Down and Remove. Long rules get a small text box. */
export function RulesEditor({ rules, onChange, label }: { rules: string[]; onChange: (r: string[]) => void; label: string }) {
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {rules.map((r, i) => {
        const long = r.length > 160 || r.includes("\n");
        return (
          <div key={i} className="ld-hb-ed">
            <span style={num}>{i + 1}</span>
            {long ? (
              <textarea className="ld-ta" rows={Math.min(10, Math.max(2, r.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 95)), 0)))} value={r} aria-label={`${label} ${i + 1}`} onChange={(e) => onChange(rules.map((x, k) => (k === i ? e.target.value : x)))} />
            ) : (
              <input className="ld-in" value={r} aria-label={`${label} ${i + 1}`} onChange={(e) => onChange(rules.map((x, k) => (k === i ? e.target.value : x)))} />
            )}
            <button type="button" className="ld-btn ld-hb-mini" onClick={() => move(i, -1)} disabled={i === 0}>Up</button>
            <button type="button" className="ld-btn ld-hb-mini" onClick={() => move(i, 1)} disabled={i === rules.length - 1}>Down</button>
            <button type="button" className="ld-btn ld-hb-mini wide" onClick={() => onChange(rules.filter((_, k) => k !== i))}>Remove</button>
          </div>
        );
      })}
    </div>
  );
}

/** Table rows as inputs, one per cell, with Remove per row. */
export function TableEditor({ table, onChange }: { table: HbTable; onChange: (t: HbTable) => void }) {
  const cols = `${table.columns.map((_, j) => (j === 0 ? "minmax(0,0.8fr)" : "minmax(0,1.4fr)")).join(" ")} 96px`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, overflowX: "auto" }}>
      <div className="ld-lbl" style={{ display: "grid", gridTemplateColumns: cols, gap: 8, minWidth: 560 }}>
        {table.columns.map((c) => (
          <span key={c}>{c}</span>
        ))}
        <span />
      </div>
      {table.rows.map((row, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: cols, gap: 8, alignItems: "center", minWidth: 560 }}>
          {table.columns.map((c, j) => (
            <input key={j} className="ld-in" value={row[j] ?? ""} aria-label={`${c}, row ${i + 1}`} onChange={(e) => onChange({ ...table, rows: table.rows.map((r, k) => (k === i ? table.columns.map((_, m) => (m === j ? e.target.value : r[m] ?? "")) : r)) })} />
          ))}
          <button type="button" className="ld-btn ld-hb-mini wide" onClick={() => onChange({ ...table, rows: table.rows.filter((_, k) => k !== i) })}>Remove</button>
        </div>
      ))}
      <div>
        <button type="button" className="ld-btn" onClick={() => onChange({ ...table, rows: [...table.rows, table.columns.map(() => "")] })}>Add row</button>
      </div>
    </div>
  );
}
