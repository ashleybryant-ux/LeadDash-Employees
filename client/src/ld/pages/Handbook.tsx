import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, FolderTabs, Page } from "../ui";
import { PartView, RuleList, RulesEditor, type HbPart } from "../handbook/parts";
import Sops from "../sops/Sops";

const COLS = "minmax(0,1fr) 120px 140px 128px";

type Row = HbPart & { ruleCount: number; additions: string[] };

/** The handbook every employee follows: the LeadDash base, plus this workspace's additions under each part. */
export default function Handbook() {
  const { currentOrgId } = useTenant();
  const q = trpc.handbook.view.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const sopsQ = trpc.sops.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const wantSops = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "sops";
  const [top, setTop] = React.useState<"handbook" | "sops">(wantSops ? "sops" : "handbook");
  const [tab, setTab] = React.useState<"all" | "mine">("all");
  const [open, setOpen] = React.useState<string | null>(null);
  const parts = (q.data?.parts ?? []) as Row[];
  const mineCount = parts.reduce((n, p) => n + p.additions.length, 0);
  const list = tab === "all" ? parts : parts.filter((p) => p.additions.length > 0);

  const sopCount = sopsQ.data?.counts.all ?? 0;
  const due = sopsQ.data?.reviewDue ?? 0;
  return (
    <Page rail="workspace" maxWidth={1140}>
      <h1 className="ld-h1">Handbook</h1>
      <div className="ld-ftabs" role="tablist" style={{ marginBottom: 14 }}>
        <button type="button" role="tab" aria-selected={top === "handbook"} className={`ld-ft ${top === "handbook" ? "on" : ""}`} onClick={() => setTop("handbook")}>Employee handbook ({parts.length})</button>
        <button type="button" role="tab" aria-selected={top === "sops"} className={`ld-ft ${top === "sops" ? "on" : ""}`} onClick={() => setTop("sops")}>SOPs ({sopCount}){due ? <span className="ld-pill amber" style={{ marginLeft: 8 }}>{due} to review</span> : null}</button>
      </div>
      {top === "sops" && <Sops />}
      {top === "handbook" && (
      <FolderTabs
        tabs={[
          { key: "all", label: `All parts (${parts.length})` },
          { key: "mine", label: `Your additions (${mineCount})` },
        ]}
        value={tab}
        onChange={setTab}
      >
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Part</span>
          <span>Base rules</span>
          <span>Your additions</span>
          <span />
        </div>
        {list.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : tab === "mine" ? "No additions yet. Open a part to add your own rules." : "Could not load the handbook."}</div>}
        {list.map((p) => {
          const isOpen = open === p.key;
          return (
            <React.Fragment key={p.key}>
              <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
                <span className="ld-strong">{p.title}</span>
                <span><span className="ld-hb-m ld-muted">Base rules: </span>{p.ruleCount}</span>
                <span><span className="ld-hb-m ld-muted">Your additions: </span>{p.additions.length || "None"}</span>
                <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : p.key)}>{isOpen ? "Close" : "Open"}</button>
              </div>
              {isOpen && (
                <div className="ld-expand" style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 14 }}>
                  <section className="ld-card">
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid #e3e9e6", display: "flex", flexDirection: "column", gap: 2 }}>
                      <span className="ld-strong">LeadDash base</span>
                      <span className="ld-small ld-muted">Updates reach you on their own.</span>
                    </div>
                    <div style={{ padding: "4px 16px 12px 16px" }}>
                      <PartView part={p} />
                    </div>
                  </section>
                  <Additions orgId={currentOrgId} part={p} canEdit={Boolean(q.data?.canEdit)} />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </FolderTabs>
      )}
      {top === "handbook" && <ErrorLine error={q.error} />}
    </Page>
  );
}

function Additions({ orgId, part, canEdit }: { orgId: number; part: Row; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<string[]>(part.additions);
  const save = trpc.handbook.saveAdditions.useMutation({
    onSuccess: async () => {
      await utils.handbook.view.invalidate();
      setEditing(false);
    },
  });
  const start = () => {
    setDraft(part.additions.length ? part.additions : [""]);
    setEditing(true);
  };
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`} style={editing ? { outline: "2px solid #1b6b4a" } : undefined}>
      <div className="ld-between" style={{ padding: "12px 16px", borderBottom: "1px solid #e3e9e6" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="ld-strong">Your additions</span>
          <span className="ld-small ld-muted">Where they disagree with the base, yours win.</span>
        </div>
        {canEdit &&
          (editing ? (
            <div className="ld-row">
              <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
              <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, partKey: part.key, rules: draft.map((r) => r.trim()).filter(Boolean) })}>
                {save.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          ) : (
            <button type="button" className="ld-btn" onClick={start}>Edit</button>
          ))}
      </div>
      <div style={{ padding: "4px 16px 12px 16px" }}>
        {editing ? (
          <>
            <RulesEditor rules={draft} onChange={setDraft} label="Your rule" />
            <div style={{ padding: "6px 0 0 36px" }}>
              <button type="button" className="ld-btn" onClick={() => setDraft([...draft, ""])}>Add rule</button>
            </div>
            <ErrorLine error={save.error} />
          </>
        ) : part.additions.length ? (
          <RuleList rules={part.additions} />
        ) : (
          <p className="ld-small ld-muted" style={{ margin: "10px 0 0 0" }}>None yet.</p>
        )}
      </div>
    </section>
  );
}
