import React from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, ErrorLine, Page } from "../ui";
import { DictateButton, appendText } from "../Dictate";
import { WebsiteRead } from "../onboarding/WebsiteRead";
import type { Outputs } from "../types";

/**
 * Set up your team, once: 1 Your business (the team reads the website, the
 * owner fixes what is off; saved to the Brain), 2 Who starts first (three
 * picked for the kind of business), 3 Say hello (a first job waits in each
 * chat). A new workspace opens here; later it is reachable from Workspace.
 */

type View = Outputs["setup"]["get"];
type Step = 1 | 2 | 3;
const TONES = ["Warm and personal", "Brief and direct", "Formal"];
/** The first clause of an employee's description, short enough for a card. */
const blurb = (d: string) => {
  const first = d.split(/[:.](\s|$)/)[0].trim();
  if (first.length <= 96) return first ? `${first}.` : "";
  const cut = first.slice(0, 96);
  return `${cut.slice(0, cut.lastIndexOf(" "))}.`;
};

export default function Setup() {
  const { currentOrgId, refetchOrgs } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.setup.get.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [step, setStep] = React.useState<Step>(1);
  const [, navigate] = useLocation();
  const finish = trpc.setup.finish.useMutation({ onSuccess: async () => { await Promise.all([utils.setup.get.invalidate(), refetchOrgs()]); } });
  const d = q.data;
  const stepsCard = (
    <div className="ld-card" style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
      <span className="ld-lbl" style={{ margin: "0 8px 10px" }}>Setup</span>
      {[
        { n: 1, t: "Your business", s: d?.done || step > 1 ? "Saved to the Brain" : "6 fields, the team fills most of them" },
        { n: 2, t: "Who starts first", s: step > 2 ? (d?.team ?? []).filter((e) => e.status !== "paused").map((e) => e.name).slice(0, 4).join(", ") || "Picked" : "Pick three, add the rest anytime" },
        { n: 3, t: "Say hello", s: "Each employee has a first job ready" },
      ].map((x) => (
        <button key={x.n} type="button" className={`ld-setup-step ${step === x.n ? "on" : ""} ${step > x.n ? "done" : ""}`} onClick={() => setStep(x.n as Step)}>
          <i>{step > x.n ? "✓" : x.n}</i>
          <span>
            {x.t}
            <small>{x.s}</small>
          </span>
        </button>
      ))}
    </div>
  );
  return (
    <Page rail="chats" maxWidth={1180}>
      <div className="ld-between" style={{ marginBottom: 16, alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="ld-h1">Set up your team</h1>
          <p className="ld-body ld-muted" style={{ margin: "4px 0 0" }}>{d?.done ? "Your team is working from what is in the Brain. Change anything here." : "About five minutes. Your employees start working the moment you finish."}</p>
        </div>
        {!d?.done && (
          <button type="button" className="ld-btn" style={{ width: 128 }} disabled={finish.isPending} onClick={async () => { await finish.mutateAsync({ organizationId: currentOrgId, skipped: true }); navigate("/chats"); }}>
            Skip for now
          </button>
        )}
      </div>
      <ErrorLine error={q.error || finish.error} />
      {d && (
        <div className="ld-setup">
          {stepsCard}
          {step === 1 && <Business d={d} onNext={() => setStep(2)} />}
          {step === 2 && <Team d={d} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
          {step === 3 && <Hello d={d} onDone={async () => { await finish.mutateAsync({ organizationId: currentOrgId }); navigate("/chats"); }} busy={finish.isPending} />}
        </div>
      )}
      {!d && q.isLoading && <div className="ld-empty">Loading...</div>}
    </Page>
  );
}

function Business({ d, onNext }: { d: View; onNext: () => void }) {
  const { currentOrgId, refetchOrgs } = useTenant();
  const utils = trpc.useUtils();
  const b = d.business;
  const [f, setF] = React.useState({ website: b.website, description: b.description, audience: b.audience, bookingLink: b.bookingLink, brandColors: b.brandColors, tone: b.tone });
  const [reading, setReading] = React.useState(false);
  React.useEffect(() => {
    setF({ website: b.website, description: b.description, audience: b.audience, bookingLink: b.bookingLink, brandColors: b.brandColors, tone: b.tone });
  }, [b.website, b.description, b.audience, b.bookingLink, b.brandColors, b.tone]);
  const save = trpc.setup.saveBusiness.useMutation({ onSuccess: async () => { await Promise.all([utils.setup.get.invalidate(), refetchOrgs()]); onNext(); } });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const field = (k: keyof typeof f, label: string, placeholder: string, rows = 0) => (
    <div className="ld-field">
      <label className="ld-lbl" htmlFor={`su-${k}`}>{label}</label>
      {rows ? (
        <textarea id={`su-${k}`} className="ld-ta" rows={rows} value={f[k]} placeholder={placeholder} onChange={(e) => set(k)(e.target.value)} />
      ) : (
        <input id={`su-${k}`} className="ld-in" value={f[k]} placeholder={placeholder} onChange={(e) => set(k)(e.target.value)} />
      )}
      {rows > 0 && <DictateButton small onText={(t) => setF((p) => ({ ...p, [k]: appendText(p[k], t) }))} />}
    </div>
  );
  return (
    <div className="ld-card" style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
      <span className="ld-lbl">1 of 3 · Your business</span>
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Tell the team about {b.name}</h2>
      <p className="ld-small ld-muted" style={{ margin: 0 }}>Paste your website and press Read my website. The team fills in the rest from it and shows you what it found; you keep what is right. Or type or dictate each one.</p>
      {reading ? (
        <WebsiteRead website={f.website} onSaved={async () => { await Promise.all([utils.setup.get.invalidate(), refetchOrgs()]); }} onClose={() => setReading(false)} />
      ) : (
        <div className="ld-field">
          <label className="ld-lbl" htmlFor="su-website">Website</label>
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            <input id="su-website" className="ld-in" style={{ flex: 1, minWidth: 240 }} placeholder="https://" value={f.website} onChange={(e) => set("website")(e.target.value)} />
            <button type="button" className="ld-btn" style={{ width: 150 }} onClick={() => setReading(true)}>Read my website</button>
          </div>
        </div>
      )}
      {field("description", "What you do", "Group therapy practice offering individual, couples and family therapy", 2)}
      <div className="ld-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {field("audience", "Who you serve", "Adults, couples and families in central Oklahoma", 2)}
        {field("bookingLink", "Booking link", "https://")}
      </div>
      <div className="ld-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {field("brandColors", "Brand colors", "Green #1b6b4a, orange #e88a3a")}
        <div className="ld-field">
          <span className="ld-lbl">How the team should sound</span>
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            {TONES.map((t) => (
              <button key={t} type="button" className={`ld-chip ${f.tone === t ? "on" : ""}`} aria-pressed={f.tone === t} onClick={() => set("tone")(t)}>{t}</button>
            ))}
          </div>
        </div>
      </div>
      <ErrorLine error={save.error} />
      <div className="ld-row" style={{ flexWrap: "wrap" }}>
        <span className="ld-small ld-muted">Saved to the Brain. You can change it there anytime.</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ld-btn p" style={{ width: 160 }} disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, ...f })}>{save.isPending ? "Saving" : "Save and continue"}</button>
      </div>
    </div>
  );
}

function Team({ d, onBack, onNext }: { d: View; onBack: () => void; onNext: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [picked, setPicked] = React.useState<Set<number>>(() => new Set(d.done ? d.team.filter((e) => e.status !== "paused").map((e) => e.id) : d.team.filter((e) => e.suggested).map((e) => e.id)));
  const [all, setAll] = React.useState(false);
  const save = trpc.setup.pickTeam.useMutation({ onSuccess: async () => { await utils.setup.get.invalidate(); onNext(); } });
  const kind = d.business.orgType === "healthcare" ? "a therapy practice" : d.business.orgType === "nonprofit" ? "a nonprofit" : "a business like yours";
  const shown = all ? d.team : [...d.team.filter((e) => e.suggested), ...d.team.filter((e) => !e.suggested).slice(0, 3)];
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div className="ld-card" style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
      <span className="ld-lbl">2 of 3 · Who starts first</span>
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Start with three</h2>
      <p className="ld-small ld-muted" style={{ margin: 0 }}>These three are picked for {kind}. Every employee already knows your business from the Brain. The rest stay paused in Chats until you start them.</p>
      <div className="ld-setup-emps">
        {shown.map((e) => (
          <button key={e.id} type="button" className={`ld-setup-emp ${picked.has(e.id) ? "on" : ""}`} aria-pressed={picked.has(e.id)} onClick={() => toggle(e.id)}>
            <Avatar name={e.name} kind={e.kind} src={e.avatar} size={40} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <b>{e.name}</b>
              <span className="r">{e.roleTitle}</span>
              <span className="w">{blurb(e.description)}</span>
            </span>
            <i aria-hidden="true">{picked.has(e.id) ? "✓" : ""}</i>
          </button>
        ))}
      </div>
      <ErrorLine error={save.error} />
      <div className="ld-row" style={{ flexWrap: "wrap" }}>
        {!all && d.team.length > shown.length && <button type="button" className="gp-link" onClick={() => setAll(true)}>Show all {d.team.length} employees</button>}
        <span style={{ flex: 1 }} />
        <button type="button" className="ld-btn" style={{ width: 100 }} onClick={onBack}>Back</button>
        <button type="button" className="ld-btn p" style={{ width: 170 }} disabled={save.isPending || !picked.size} onClick={() => save.mutate({ organizationId: currentOrgId, employeeIds: Array.from(picked) })}>
          {save.isPending ? "Saving" : `Start with ${picked.size === 1 ? "this one" : `these ${picked.size}`}`}
        </button>
      </div>
    </div>
  );
}

function Hello({ d, onDone, busy }: { d: View; onDone: () => void; busy: boolean }) {
  const [, navigate] = useLocation();
  const starting = d.team.filter((e) => e.status !== "paused");
  return (
    <div className="ld-card" style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
      <span className="ld-lbl">3 of 3 · Say hello</span>
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Your team is ready</h2>
      <p className="ld-small ld-muted" style={{ margin: 0 }}>Each one has a first job waiting in chat. Nothing goes to a client or outside contact without your approval.</p>
      <div>
        {starting.map((e) => (
          <div key={e.id} className="ld-row" style={{ gap: 12, padding: "10px 0", borderBottom: "1px solid var(--ld-line2)" }}>
            <Avatar name={e.name} kind={e.kind} src={e.avatar} size={34} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
              {e.name}, {e.roleTitle}
              <span className="ld-small ld-muted" style={{ display: "block", marginTop: 2 }}>First job: {e.firstJob}</span>
            </span>
            <button type="button" className="ld-btn" style={{ width: 110 }} disabled={!d.done} title={d.done ? undefined : "Press Go to Chats first"} onClick={() => navigate(`/chats/${e.kind}`)}>Open chat</button>
          </div>
        ))}
      </div>
      <div className="ld-row" style={{ flexWrap: "wrap" }}>
        <span className="ld-small ld-muted">Want an employee to know more? Its Onboarding tab has a short card it fills in from the Brain; you only fix what is off.</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ld-btn p" style={{ width: 128 }} disabled={busy} onClick={onDone}>{busy ? "Starting" : d.done ? "Go to Chats" : "Go to Chats"}</button>
      </div>
    </div>
  );
}
