import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import { fmtDate, parseJson } from "../meta";

type Section = { label: string; heading: string; content: string };
type PlanData = { page?: string; suggestedPath?: string; sections?: Section[]; callToAction?: string; goal?: string };

/** Jordan's Work tab: website page plans. */
export default function Pages({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [page, setPage] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [selected, setSelected] = React.useState<number | null>(null);

  const plans = trpc.website.list.useQuery({ organizationId: currentOrgId });
  const plan = trpc.website.plan.useMutation({
    onSuccess: async (r) => {
      setPage("");
      setGoal("");
      await utils.website.invalidate();
      if (r?.id) setSelected(r.id);
    },
  });
  const dismiss = trpc.website.dismiss.useMutation({
    onSuccess: async () => {
      setSelected(null);
      await utils.website.invalidate();
    },
  });

  const list = plans.data ?? [];
  const current = list.find((p) => p.id === selected) ?? list[0] ?? null;
  const canPlan = page.trim().length >= 2 && goal.trim().length >= 2;

  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      <form
        className="ld-card"
        style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 16, alignItems: "end" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canPlan) return;
          plan.mutate({ organizationId: currentOrgId, page: page.trim(), goal: goal.trim() });
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="pg-page" className="ld-lbl">Page</label>
          <input id="pg-page" className="ld-in lg" value={page} onChange={(e) => setPage(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="pg-goal" className="ld-lbl">Goal</label>
          <input id="pg-goal" className="ld-in lg" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </div>
        <button type="submit" className="ld-btn p" disabled={!canPlan || plan.isPending}>
          {plan.isPending ? "Planning..." : "Plan page"}
        </button>
      </form>
      <ErrorLine error={plan.error} />

      {list.length === 0 ? (
        <div className="ld-card ld-empty">{plans.isLoading ? "Loading..." : `No page plans yet. Plan a page above or ask ${emp.name} in Chat.`}</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", gap: 20, alignItems: "start" }}>
          <div className="ld-card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
            {list.map((p) => {
              const on = current?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSelected(p.id)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    padding: "10px 12px",
                    borderRadius: 9,
                    font: "inherit",
                    fontSize: 14,
                    border: 0,
                    background: on ? "#eef5f1" : "transparent",
                    color: "#14221c",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span className="ld-strong">{p.title}</span>
                  <span style={{ fontSize: 12, color: "#5b6b64" }}>{fmtDate(p.createdAt)}</span>
                </button>
              );
            })}
          </div>
          {current && <PlanCard key={current.id} item={current} onDismiss={() => dismiss.mutate({ organizationId: currentOrgId, id: current.id })} dismissing={dismiss.isPending} />}
        </div>
      )}
      <ErrorLine error={dismiss.error} />
    </main>
  );
}

function PlanCard({ item, onDismiss, dismissing }: { item: { id: number; title: string; data: string }; onDismiss: () => void; dismissing: boolean }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const d = parseJson<PlanData>(item.data, {});
  const sections = d.sections ?? [];
  const [editing, setEditing] = React.useState<number | null>(null);
  const [heading, setHeading] = React.useState("");
  const [content, setContent] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const save = trpc.website.updateSection.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await utils.website.invalidate();
    },
  });
  const ctaInSections = sections.some((s) => /call to action/i.test(s.label));
  const showCta = !!d.callToAction && !ctaInSections;

  const copyAll = () => {
    const text = [
      d.page || item.title,
      d.suggestedPath ? `Path: ${d.suggestedPath}` : "",
      ...sections.map((s) => `${s.label}\n${s.heading}\n${s.content}`),
      showCta ? `Call to action\n${d.callToAction}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const secStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "36px minmax(0,1fr) 128px",
    gap: 14,
    padding: "16px 18px",
    borderBottom: "1px solid #eef2f0",
    alignItems: "start",
  };
  const num = (n: number) => (
    <span style={{ width: 28, height: 28, borderRadius: 999, background: "#eef2f0", color: "#3d4c45", fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {n}
    </span>
  );

  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-between" style={{ padding: "16px 18px", borderBottom: "1px solid #e3e9e6" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 800, fontSize: 17 }}>{d.page || item.title}</span>
          {d.suggestedPath && <span className="ld-small ld-muted">{d.suggestedPath}</span>}
        </div>
        <div className="ld-row">
          <button type="button" className="ld-btn" disabled={dismissing} onClick={onDismiss}>Dismiss</button>
          <button type="button" className="ld-btn" onClick={copyAll}>{copied ? "Copied" : "Copy all"}</button>
        </div>
      </div>
      {sections.length === 0 && <div className="ld-empty">This plan has no sections.</div>}
      {sections.map((s, i) => {
        const isEditing = editing === i;
        return (
          <div
            key={i}
            style={{ ...secStyle, background: isEditing ? "#f4f8f6" : undefined, ...(i === sections.length - 1 && !showCta ? { borderBottom: 0 } : {}) }}
          >
            {num(i + 1)}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="ld-lbl">{s.label}</span>
              {isEditing ? (
                <>
                  <label className="ld-sr" htmlFor={`sec-h-${item.id}-${i}`}>Heading</label>
                  <input id={`sec-h-${item.id}-${i}`} className="ld-in" value={heading} onChange={(e) => setHeading(e.target.value)} />
                  <label className="ld-sr" htmlFor={`sec-c-${item.id}-${i}`}>Copy</label>
                  <textarea id={`sec-c-${item.id}-${i}`} className="ld-ta" rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
                  <ErrorLine error={save.error} />
                </>
              ) : (
                <>
                  {s.heading && <span style={{ fontSize: i === 0 ? 18 : 15, fontWeight: 800 }}>{s.heading}</span>}
                  {s.content && <span className="ld-pre" style={{ fontSize: 14, lineHeight: 1.6, color: i === 0 ? "#3d4c45" : undefined }}>{s.content}</span>}
                </>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {isEditing ? (
                <>
                  <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: item.id, index: i, heading, content })}>
                    Save
                  </button>
                  <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <button
                  type="button"
                  className="ld-btn"
                  disabled={editing !== null}
                  onClick={() => {
                    setHeading(s.heading ?? "");
                    setContent(s.content ?? "");
                    setEditing(i);
                  }}
                >
                  Edit
                </button>
              )}
            </div>
          </div>
        );
      })}
      {showCta && (
        <div style={{ ...secStyle, borderBottom: 0 }}>
          {num(sections.length + 1)}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="ld-lbl">Call to action</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{d.callToAction}</span>
          </div>
          <span />
        </div>
      )}
    </div>
  );
}
