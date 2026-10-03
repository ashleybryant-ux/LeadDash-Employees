import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, ErrorLine, FolderTabs } from "../ui";

type Tab = "this" | "last";
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hrs = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const tile: React.CSSProperties = { border: "1px solid #e3e9e6", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, background: "#fff", minWidth: 0 };
const lbl: React.CSSProperties = { fontSize: 13, color: "#5b6b64", fontWeight: 600 };
const num: React.CSSProperties = { fontSize: 28, fontWeight: 800, color: "#14221c", lineHeight: 1.1 };
const COLS = "40px minmax(0,1fr) 90px 70px 90px";

/** Hours saved, tasks done and estimated AI cost for the workspace, by employee. */
export function UsageCard() {
  const { currentOrgId } = useTenant();
  const [tab, setTab] = React.useState<Tab>("this");
  const q = trpc.usage.summary.useQuery({ organizationId: currentOrgId, back: tab === "this" ? 0 : 1 }, { enabled: currentOrgId > 0 });
  const u = q.data;
  const rows = (u?.employees ?? []).filter((e) => e.tasks > 0 || e.cost > 0);
  return (
    <section className="ld-card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="ld-between">
        <span className="ld-st">Usage</span>
        {u && <span className="ld-small ld-muted">{u.month}</span>}
      </div>
      <FolderTabs
        tabs={[
          { key: "this" as Tab, label: "This month" },
          { key: "last" as Tab, label: "Last month" },
        ]}
        value={tab}
        onChange={setTab}
      >
        {!u ? (
          <div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load usage."}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 12 }}>
            <div className="ld-usage-tiles ld-keep" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12 }}>
              <div style={tile}>
                <span style={lbl}>Hours saved</span>
                <span style={num}>{hrs(u.hours)}</span>
              </div>
              <div style={tile}>
                <span style={lbl}>Tasks done</span>
                <span style={num}>{u.tasks.toLocaleString("en-US")}</span>
              </div>
              <div style={tile}>
                <span style={lbl}>AI cost (est.)</span>
                <span style={num}>{money(u.cost)}</span>
              </div>
            </div>
            {rows.length === 0 && u.shared === 0 ? (
              <div className="ld-empty">{`No work in ${u.month}.`}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div className="ld-usage-row ld-keep" style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "0 0 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5b6b64" }}>
                  <span />
                  <span>Employee</span>
                  <span style={{ textAlign: "right" }}>Hours</span>
                  <span style={{ textAlign: "right" }}>Tasks</span>
                  <span style={{ textAlign: "right" }}>Cost</span>
                </div>
                {rows.map((e) => (
                  <div key={e.id} className="ld-usage-row ld-keep" style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid #eef2f0", fontSize: 14 }}>
                    <Avatar name={e.name} kind={e.kind} src={e.avatar} size={36} />
                    <span style={{ minWidth: 0 }}>
                      <b>{e.name}</b>
                      <span className="ld-small ld-muted" style={{ display: "block" }}>{e.roleTitle}</span>
                    </span>
                    <span style={{ textAlign: "right", fontWeight: 700 }}>{hrs(e.hours)}</span>
                    <span style={{ textAlign: "right" }}>{e.tasks}</span>
                    <span style={{ textAlign: "right" }}>{money(e.cost)}</span>
                  </div>
                ))}
                {u.shared > 0 && (
                  <div className="ld-usage-row ld-keep" style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid #eef2f0", fontSize: 14 }}>
                    <span />
                    <b>Shared</b>
                    <span style={{ textAlign: "right" }}>0</span>
                    <span style={{ textAlign: "right" }}>0</span>
                    <span style={{ textAlign: "right" }}>{money(u.shared)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </FolderTabs>
      <ErrorLine error={q.error} />
    </section>
  );
}
