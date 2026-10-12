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
 * owner fixes what is off; saved to the Brain), 2 Meet the bench (every
 * employee starts on the bench; the owner brings on the ones they want).
 * A new workspace opens here; later it is reachable from Workspace.
 */

type View = Outputs["setup"]["get"];
type Step = 1 | 2;
const TONES = ["Warm and personal", "Brief and direct", "Formal"];

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
        { n: 2, t: "Meet the bench", s: "Bring on the ones you want" },
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
          <button type="button" className="ld-btn" style={{ width: 128 }} disabled={finish.isPending} onClick={async () => { await finish.mutateAsync({ organizationId: currentOrgId, skipped: true, bench: true }); navigate("/bench"); }}>
            Skip for now
          </button>
        )}
      </div>
      <ErrorLine error={q.error || finish.error} />
      {d && (
        <div className="ld-setup">
          {stepsCard}
          {step === 1 && <Business d={d} onNext={() => setStep(2)} />}
          {step === 2 && <MeetBench d={d} onBack={() => setStep(1)} onDone={async () => { await finish.mutateAsync({ organizationId: currentOrgId, bench: true }); navigate("/bench"); }} busy={finish.isPending} />}
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
      <span className="ld-lbl">1 of 2 · Your business</span>
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
        {field("audience", "Who you serve", "Adults, couples and families in the Denver area", 2)}
        {field("bookingLink", "Booking link", "https://")}
      </div>
      <div className="ld-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {field("brandColors", "Brand colors", "Navy #1f3a5f, gold #d4a017")}
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

function MeetBench({ d, onBack, onDone, busy }: { d: View; onBack: () => void; onDone: () => void; busy: boolean }) {
  const benched = d.team.filter((e) => e.status === "paused");
  const shown = d.done ? benched : d.team;
  return (
    <div className="ld-card" style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
      <span className="ld-lbl">2 of 2 · Meet the bench</span>
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Your team starts on the bench</h2>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "var(--ld-text2)" }}>Read each bio for free, or interview anyone out loud. Bring on the ones you want with one click, and they start onboarding with you in Chats.</p>
      <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
        {shown.slice(0, 12).map((e) => <Avatar key={e.id} name={e.name} kind={e.kind} src={e.avatar} size={44} />)}
      </div>
      <div className="ld-row" style={{ flexWrap: "wrap" }}>
        <span style={{ flex: 1 }} />
        <button type="button" className="ld-btn" style={{ width: 100 }} onClick={onBack}>Back</button>
        <button type="button" className="ld-btn p" style={{ width: 160 }} disabled={busy} onClick={onDone}>{busy ? "Opening" : "Go to the bench"}</button>
      </div>
    </div>
  );
}
