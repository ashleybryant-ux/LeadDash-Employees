import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import type { Outputs } from "../types";

type Rule = Outputs["onboarding"]["get"]["rules"][number];
type Mode = Rule["mode"];

const MODES: { key: Mode; label: string }[] = [
  { key: "ask", label: "Ask me first" },
  { key: "first5", label: "Ask for the first 5, then on its own" },
  { key: "auto", label: "On its own" },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 29 }, (_, i) => {
  const mins = 6 * 60 + i * 30;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return { v: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, label: `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}` };
});
const hourLabel = (v: string) => HOURS.find((h) => h.v === v)?.label ?? v;

const grid: React.CSSProperties = { padding: "18px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 };
const col: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const small: React.CSSProperties = { fontSize: 12, color: "#5b6b64", lineHeight: 1.45 };

function Choice<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="ld-row" style={{ flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={o.key} type="button" className={`ld-chip ${value === o.key ? "on" : ""}`} aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Buttons({ editing, saving, onEdit, onSave, onCancel }: { editing: boolean; saving: boolean; onEdit: () => void; onSave: () => void; onCancel: () => void }) {
  return (
    <div style={col}>
      {editing ? (
        <>
          <button type="button" className="ld-btn p" disabled={saving} onClick={onSave}>{saving ? "Saving..." : "Save"}</button>
          <button type="button" className="ld-btn" onClick={onCancel}>Cancel</button>
        </>
      ) : (
        <button type="button" className="ld-btn" onClick={onEdit}>Edit</button>
      )}
    </div>
  );
}

/** Works on its own: what this employee does without asking. */
export function WorksOnOwnCard({ emp, rules, alwaysAsks, firstN }: { emp: EmployeeRow; rules: Rule[]; alwaysAsks: string; firstN: number }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, Mode>>({});
  const save = trpc.onboarding.saveRules.useMutation({ onSuccess: async () => { setEditing(false); await utils.onboarding.get.invalidate(); } });
  if (!rules.length) return null;
  const pronoun = ["Sienna", "Jada", "Riley", "Morgan", "Elena", "Avery", "Taylor", "Jordan"].includes(emp.name) ? "her" : ["Theo", "Malik", "Quinn"].includes(emp.name) ? "his" : "its";
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div style={grid} className="ld-keep-check">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="ld-lbl">Works on {pronoun} own</span>
          {rules.map((r) => {
            const mode = editing ? draft[r.key] ?? r.mode : r.mode;
            return (
              <div key={r.key} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr)", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid #eef2f0" }}>
                <span className="ld-strong" style={{ fontSize: 14 }}>{r.label}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  {editing ? <Choice options={MODES} value={mode} onChange={(v) => setDraft({ ...draft, [r.key]: v })} /> : <span className="ld-body">{MODES.find((m) => m.key === mode)?.label}</span>}
                  {mode === "first5" && <span style={small}>{r.approved >= firstN ? `${firstN} of ${firstN} approved. Now on ${pronoun} own.` : `${r.approved} of ${firstN} approved so far. After ${firstN}, these go without asking.`}</span>}
                </div>
              </div>
            );
          })}
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="ld-lbl">Always asks you</span>
            <span className="ld-body">{alwaysAsks}</span>
          </div>
          <ErrorLine error={save.error} />
        </div>
        <Buttons editing={editing} saving={save.isPending} onEdit={() => { setDraft(Object.fromEntries(rules.map((r) => [r.key, r.mode]))); setEditing(true); }} onSave={() => save.mutate({ organizationId: currentOrgId, employeeId: emp.id, rules: draft })} onCancel={() => setEditing(false)} />
      </div>
    </section>
  );
}

/** Riley: what the workspace sells, and for a practice, which referral partners to look for. */
export function SellsCard() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.sales.settings.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [editing, setEditing] = React.useState(false);
  const [d, setD] = React.useState({ sells: "therapy" as "software" | "therapy", partnerTypes: [] as string[], area: "" });
  const save = trpc.sales.saveSettings.useMutation({ onSuccess: async () => { setEditing(false); await utils.sales.settings.invalidate(); } });
  if (!q.data) return null;
  const s = q.data;
  const cur = editing ? d : { sells: s.sells, partnerTypes: s.partnerTypes, area: s.area };
  const therapy = cur.sells === "therapy";
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div style={grid}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={col}>
            <span className="ld-lbl">This workspace sells</span>
            {editing ? <Choice options={[{ key: "software", label: "Software or services to practices" }, { key: "therapy", label: "Therapy to clients" }]} value={d.sells} onChange={(v) => setD({ ...d, sells: v })} /> : <span className="ld-body">{therapy ? "Therapy to clients" : "Software or services to practices"}</span>}
          </div>
          {therapy && (
            <div style={col}>
              <span className="ld-lbl">Riley finds</span>
              {editing ? (
                <div className="ld-row" style={{ flexWrap: "wrap" }}>
                  {s.partnerOptions.map((o) => {
                    const on = d.partnerTypes.includes(o);
                    return <button key={o} type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setD({ ...d, partnerTypes: on ? d.partnerTypes.filter((x) => x !== o) : [...d.partnerTypes, o] })}>{o}</button>;
                  })}
                </div>
              ) : (
                <span className="ld-body">{s.partnerTypes.join(", ") || "Not set"}</span>
              )}
            </div>
          )}
          <div style={col}>
            <label className="ld-lbl" htmlFor="sales-area">Area</label>
            {editing ? <input id="sales-area" className="ld-in" style={{ maxWidth: 360 }} placeholder={therapy ? "Within 25 miles of Oklahoma City, OK" : "Texas and Oklahoma"} value={d.area} onChange={(e) => setD({ ...d, area: e.target.value })} /> : <span className="ld-body">{s.area || "Not set"}</span>}
          </div>
          <div style={col}>
            <span className="ld-lbl">How the team works for this choice</span>
            <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", gap: "6px 14px", fontSize: 14, lineHeight: 1.5 }}>
              <b>Riley</b>
              <span>{therapy ? "Finds referral partners nearby and the person to contact at each." : "Finds practices that fit and the owner to contact at each."}</span>
              <b>Jada</b>
              <span>{therapy ? "Writes introductions sent from your Gmail." : "Sends a 3-email sequence from your Gmail and stops when they book or reply."}</span>
              <b>Malik</b>
              <span>{therapy ? "Answers new client inquiries with consultation times. Every reply waits for your approval." : "Answers new leads within minutes and books the meeting."}</span>
            </div>
          </div>
          <ErrorLine error={save.error} />
        </div>
        <Buttons editing={editing} saving={save.isPending} onEdit={() => { setD({ sells: s.sells, partnerTypes: s.partnerTypes, area: s.area }); setEditing(true); }} onSave={() => save.mutate({ organizationId: currentOrgId, ...d })} onCancel={() => setEditing(false)} />
      </div>
    </section>
  );
}

/** Malik: where leads come from, replies, and the meeting he books. */
export function LeadSetupCard({ emp, rule }: { emp: EmployeeRow; rule: Rule | undefined }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.sales.settings.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [editing, setEditing] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [d, setD] = React.useState({ meetingMinutes: 30, hoursFrom: "09:00", hoursTo: "16:00", days: [1, 2, 3, 4, 5] as number[], reply: "auto" as Mode });
  const saveSettings = trpc.sales.saveSettings.useMutation();
  const saveRules = trpc.onboarding.saveRules.useMutation();
  const [error, setError] = React.useState<string | null>(null);
  if (!q.data) return null;
  const s = q.data;
  const replyMode = rule?.mode ?? "auto";
  const therapy = s.sells === "therapy";
  const copy = async (k: string, v: string) => {
    try {
      await navigator.clipboard.writeText(v);
      setCopied(k);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };
  const save = async () => {
    setError(null);
    try {
      await saveSettings.mutateAsync({ organizationId: currentOrgId, meetingMinutes: d.meetingMinutes, hoursFrom: d.hoursFrom, hoursTo: d.hoursTo, days: d.days });
      if (rule) await saveRules.mutateAsync({ organizationId: currentOrgId, employeeId: emp.id, rules: { reply: d.reply } });
      await Promise.all([utils.sales.settings.invalidate(), utils.onboarding.get.invalidate()]);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const cur = editing ? d : { meetingMinutes: s.meetingMinutes, hoursFrom: s.hoursFrom, hoursTo: s.hoursTo, days: s.days, reply: replyMode };
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div style={grid}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={col}>
            <span className="ld-lbl">Where leads come from</span>
            <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "180px minmax(0,1fr) 128px", gap: 10, alignItems: "center", fontSize: 14 }}>
              <span className="ld-strong">Website form</span>
              <input className="ld-in" readOnly value={s.links.form} aria-label="Lead form link" onFocus={(e) => e.target.select()} />
              <button type="button" className="ld-btn" onClick={() => copy("form", s.links.form)}>{copied === "form" ? "Copied" : "Copy link"}</button>
              <span className="ld-strong">LeadDash platform</span>
              <input className="ld-in" readOnly value={s.links.hook} aria-label="Lead address for LeadDash platform workflows" onFocus={(e) => e.target.select()} />
              <button type="button" className="ld-btn" onClick={() => copy("hook", s.links.hook)}>{copied === "hook" ? "Copied" : "Copy address"}</button>
            </div>
            <span style={small}>Paste the address into a LeadDash platform workflow (a webhook step) so new contacts come to {emp.name}.</span>
          </div>
          <div style={col}>
            <span className="ld-lbl">Replies</span>
            {therapy ? (
              <span className="ld-body">Wait for your approval. Client inquiries can carry health information.</span>
            ) : editing ? (
              <Choice options={[{ key: "ask", label: "Wait for my approval" }, { key: "auto", label: "Send on my own" }]} value={d.reply === "first5" ? "ask" : d.reply} onChange={(v) => setD({ ...d, reply: v })} />
            ) : (
              <span className="ld-body">{replyMode === "auto" ? "Send on my own" : "Wait for my approval"}</span>
            )}
            {!therapy && <span style={small}>On its own, replies go out within 5 minutes from 8:00 AM to 8:00 PM, and at 8:00 AM for leads that come in overnight.</span>}
          </div>
          <div style={col}>
            <span className="ld-lbl">Meeting</span>
            <div className="ld-row" style={{ flexWrap: "wrap", gap: 16 }}>
              {editing ? <Choice options={[15, 30, 45].map((n) => ({ key: String(n), label: `${n} min` }))} value={String(d.meetingMinutes)} onChange={(v) => setD({ ...d, meetingMinutes: Number(v) })} /> : <span className="ld-body">{s.meetingMinutes} minutes</span>}
              <span className="ld-body">{s.google ? "On your Google Calendar" : "Connect Google on Integrations to offer open times"}</span>
            </div>
          </div>
          <div style={col}>
            <span className="ld-lbl">Hours offered</span>
            {editing ? (
              <>
                <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "150px 20px 150px", gap: 8, alignItems: "center" }}>
                  <select className="ld-in" aria-label="From" value={d.hoursFrom} onChange={(e) => setD({ ...d, hoursFrom: e.target.value })}>{HOURS.map((h) => <option key={h.v} value={h.v}>{h.label}</option>)}</select>
                  <span style={{ textAlign: "center" }}>to</span>
                  <select className="ld-in" aria-label="To" value={d.hoursTo} onChange={(e) => setD({ ...d, hoursTo: e.target.value })}>{HOURS.map((h) => <option key={h.v} value={h.v}>{h.label}</option>)}</select>
                </div>
                <div className="ld-row" style={{ flexWrap: "wrap" }}>
                  {DAYS.map((dn, i) => {
                    const on = d.days.includes(i);
                    return <button key={dn} type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setD({ ...d, days: on ? d.days.filter((x) => x !== i) : [...d.days, i].sort() })}>{dn}</button>;
                  })}
                </div>
              </>
            ) : (
              <span className="ld-body">{`${hourLabel(cur.hoursFrom)} to ${hourLabel(cur.hoursTo)}, ${cur.days.map((i) => DAYS[i]).join(", ") || "no days"}`}</span>
            )}
          </div>
          <div style={col}>
            <span className="ld-lbl">Booking page</span>
            <a href={s.links.booking} target="_blank" rel="noreferrer noopener" className="ld-body" style={{ overflowWrap: "anywhere" }}>{s.links.booking}</a>
          </div>
          {error && <span className="ld-small" style={{ color: "#b42318" }}>{error}</span>}
        </div>
        <Buttons editing={editing} saving={saveSettings.isPending || saveRules.isPending} onEdit={() => { setD({ meetingMinutes: s.meetingMinutes, hoursFrom: s.hoursFrom, hoursTo: s.hoursTo, days: s.days, reply: replyMode }); setEditing(true); }} onSave={save} onCancel={() => setEditing(false)} />
      </div>
    </section>
  );
}

/** Jada: the LinkedIn step she adds to each sequence. The owner sends it from their own LinkedIn. */
export function LinkedInStepCard({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.sales.settings.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [editing, setEditing] = React.useState(false);
  const [d, setD] = React.useState({ on: true, when: "next_day" as "next_day" | "same_day", note: true });
  const save = trpc.sales.saveSettings.useMutation({ onSuccess: async () => { setEditing(false); await utils.sales.settings.invalidate(); } });
  if (!q.data) return null;
  const s = q.data.linkedin;
  const cur = editing ? d : s;
  const row = (label: string, view: string, edit: React.ReactNode, note?: string) => (
    <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr)", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid #eef2f0" }}>
      <span className="ld-strong" style={{ fontSize: 14 }}>{label}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        {editing ? edit : <span className="ld-body">{view}</span>}
        {note && <span style={small}>{note}</span>}
      </div>
    </div>
  );
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div style={grid} className="ld-keep-check">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="ld-lbl">LinkedIn step</span>
          {row("Add a LinkedIn step", cur.on ? "Yes" : "No", <Choice options={[{ key: "yes", label: "Yes" }, { key: "no", label: "No" }]} value={d.on ? "yes" : "no"} onChange={(v) => setD({ ...d, on: v === "yes" })} />, `${emp.name} finds the owner's profile and writes the note. You send it from your LinkedIn.`)}
          {cur.on && row("When", cur.when === "same_day" ? "Same day as email 1" : "Day after email 1", <Choice options={[{ key: "next_day", label: "Day after email 1" }, { key: "same_day", label: "Same day as email 1" }]} value={d.when} onChange={(v) => setD({ ...d, when: v })} />)}
          {cur.on && row("Note", cur.note ? "Short note" : "No note", <Choice options={[{ key: "yes", label: "Short note" }, { key: "no", label: "No note" }]} value={d.note ? "yes" : "no"} onChange={(v) => setD({ ...d, note: v === "yes" })} />, "Notes can be up to 200 characters on a free LinkedIn account (300 with Premium). Free accounts can send only a few notes a month.")}
          <ErrorLine error={save.error} />
        </div>
        <Buttons editing={editing} saving={save.isPending} onEdit={() => { setD({ ...s }); setEditing(true); }} onSave={() => save.mutate({ organizationId: currentOrgId, linkedin: d })} onCancel={() => setEditing(false)} />
      </div>
    </section>
  );
}
