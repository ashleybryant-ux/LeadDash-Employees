import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import { BudgetEditor, PlatformTag, SetBody, SetStatus, longDate, money, type CampaignView } from "../chat/Ads";

/**
 * Reese's Ads tab, the file cabinet: every campaign on the left, the one you
 * pick on the right with one row per platform (only the one you are working
 * on is open), then the budget. The work itself happens in Chat, one
 * platform at a time; this is where the sets stay for Copy and Download.
 */

const PLATFORMS: { key: CampaignView["rows"][number]["platform"]; label: string }[] = [
  { key: "meta", label: "Meta (Facebook and Instagram)" },
  { key: "google", label: "Google Search" },
  { key: "youtube", label: "YouTube" },
  { key: "microsoft", label: "Microsoft Ads" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "tiktok", label: "TikTok" },
  { key: "reddit", label: "Reddit" },
  { key: "spotify", label: "Spotify" },
  { key: "nextdoor", label: "Nextdoor" },
  { key: "yelp", label: "Yelp" },
];

function campaignPill(c: CampaignView) {
  if (c.status === "budget") return <span className="ld-pill amber">Split waits for you</span>;
  if (c.status === "writing") return <span className="ld-pill gray">Writing</span>;
  if (c.status === "review") return <span className="ld-pill amber">Waiting for you</span>;
  return <span className="ld-pill green">Approved</span>;
}

export default function AdsWork({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const list = trpc.ads.campaigns.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 15_000 });
  const cards = list.data ?? [];
  const [picked, setPicked] = React.useState<number | null>(null);
  const [making, setMaking] = React.useState(false);
  const current = picked && cards.some((c) => c.id === picked) ? picked : cards[0]?.id ?? null;
  const q = trpc.ads.campaign.useQuery({ organizationId: currentOrgId, id: current ?? 0 }, { enabled: currentOrgId > 0 && !!current, refetchInterval: 5_000 });
  const c = q.data;
  return (
    <main className="ld-main" style={{ padding: "20px 32px" }}>
      <div className="ld-pjwrap">
        <aside className="ld-pjlist" aria-label="Campaigns">
          <div className="ld-between">
            <span className="ld-lbl" style={{ margin: 0 }}>Campaigns · {cards.length}</span>
            <button type="button" className="ld-btn p sm" onClick={() => setMaking(true)}>+ New campaign</button>
          </div>
          {cards.map((x) => {
            const on = x.id === current;
            const names = x.rows.filter((r) => !r.leftOut).map((r) => r.name);
            return (
              <button key={x.id} type="button" className={`ld-pjcard ${on ? "on" : ""}`} aria-pressed={on} onClick={() => { setPicked(x.id); setMaking(false); }}>
                <span className="nm"><span className="gp-ell">{x.name}</span>{campaignPill(x)}</span>
                <span className="meta">
                  <span className="gp-ell">{names.length > 3 ? `${names.length} platforms` : names.join(" · ")}</span>
                  <span>{x.status === "done" ? `Approved ${longDate((x.updatedAt as unknown as string).slice(0, 10))}` : x.status === "budget" ? x.budget : `${x.counts.approved} of ${x.counts.platforms} approved`}</span>
                </span>
              </button>
            );
          })}
          {!list.isLoading && cards.length === 0 && <span className="ld-small ld-muted">No campaigns yet. Make one here, or tell {emp.name} in Chat what the ads are for.</span>}
        </aside>
        <section className="ld-pjmain">
          {making ? (
            <NewCampaign emp={emp} onClose={() => setMaking(false)} onMade={(id) => { setMaking(false); setPicked(id); }} />
          ) : !current ? null : !c ? (
            <div className="ld-empty">Loading...</div>
          ) : (
            <Campaign c={c} />
          )}
        </section>
      </div>
    </main>
  );
}

function Campaign({ c }: { c: CampaignView }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [budgetEdit, setBudgetEdit] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const download = trpc.ads.download.useMutation({ onSuccess: (r) => window.open(r.url, "_blank", "noopener") });
  const writeAnyway = trpc.ads.writePlatform.useMutation({ onSuccess: () => Promise.all([utils.ads.invalidate(), utils.chat.list.invalidate()]) });
  // One platform open at a time: the one waiting for you unless you opened another.
  const waiting = c.rows.find((r) => r.set?.status === "review" || r.set?.status === "writing")?.platform ?? null;
  const openKey = open && c.rows.some((r) => r.platform === open) ? open : waiting;
  const sub = [c.goal ? `Goal: ${c.goal}` : "", c.page, `${c.budget}${c.days ? `, ${longDate(c.startDate)} to ${longDate(c.endDate)}` : ""}`, `${c.counts.platforms} platform${c.counts.platforms === 1 ? "" : "s"}`, `${c.counts.approved} of ${c.counts.platforms} sets approved`].filter(Boolean).join(" · ");
  if (editing) return <CampaignForm c={c} onClose={() => setEditing(false)} />;
  return (
    <>
      <div className="ld-pjhead">
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{c.name}</h2>
          <span className="ld-small ld-muted">{sub}</span>
        </div>
        <div className="ld-row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button type="button" className="ld-btn gp-auto" onClick={() => setEditing(true)}>Edit campaign</button>
          <button type="button" className="ld-btn gp-auto" disabled={download.isPending || !c.rows.some((r) => r.set)} onClick={() => download.mutate({ organizationId: currentOrgId, id: c.id })}>{download.isPending ? "Zipping" : "Download all"}</button>
        </div>
        <ErrorLine error={download.error ?? writeAnyway.error} />
      </div>

      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ad-sech"><b>Creative, one set per platform</b><span className="ld-small ld-muted">One platform open at a time. The work happens in Chat; approved sets stay here with Copy and Download.</span></div>
        {c.rows.map((r) => {
          const isOpen = r.platform === openKey && !!r.set;
          const status = r.leftOut ? "left" : r.set ? r.set.status : "none";
          return (
            <React.Fragment key={r.platform}>
              <div className={`ad-prow ${isOpen ? "open" : ""}`}>
                <PlatformTag platform={r.platform} name={r.name} />
                <span className="sum">{r.leftOut ? `${c.leftOutWhy || "Left out of this campaign."}` : r.set ? r.set.summary || r.set.name : c.status === "budget" ? "Waits for the split." : "Not written yet."}</span>
                <SetStatus status={status} />
                {r.leftOut ? (
                  <button type="button" className="ld-btn sm" disabled={writeAnyway.isPending} onClick={() => writeAnyway.mutate({ organizationId: currentOrgId, id: c.id, platform: r.platform })}>Write anyway</button>
                ) : r.set ? (
                  <button type="button" className="ld-btn sm" onClick={() => setOpen(isOpen ? "" : r.platform)}>{isOpen ? "Close" : "Open"}</button>
                ) : (
                  <span />
                )}
              </div>
              {isOpen && r.set && (
                <div className="ad-open">
                  <OpenSet id={r.set.id} />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ad-sech">
          <b>Budget · {c.budget}{c.days ? ` · ${longDate(c.startDate)} to ${longDate(c.endDate)} (${c.days} days)` : ""}</b>
          <span className="ld-row" style={{ gap: 10 }}>
            <span className="ld-small ld-muted">{c.splitMode === "even" ? "Split evenly." : c.splitMode === "custom" ? "Your split." : "Reese's split, by where this audience is and what each click costs."}</span>
            {!budgetEdit && <button type="button" className="ld-btn sm" onClick={() => setBudgetEdit(true)}>Edit</button>}
          </span>
        </div>
        {budgetEdit ? (
          <BudgetEditor c={c} onDone={() => setBudgetEdit(false)} onSaved={() => setBudgetEdit(false)} />
        ) : (
          <>
            <div className="ad-bud wide h"><span>Platform</span><span>Share</span><span>Total</span><span>Per day</span><span>Why</span></div>
            {c.rows.filter((r) => !r.leftOut).map((r) => (
              <div key={r.platform} className="ad-bud wide">
                <PlatformTag platform={r.platform} name={r.name} size={18} />
                <span>{r.share}%</span>
                <span><b>{money(r.totalCents)}</b></span>
                <span>{c.days ? money(r.perDayCents) : "set dates"}</span>
                <span className="why">{r.why}</span>
              </div>
            ))}
            <div className="ad-bud wide t"><span>Total</span><span>{c.rows.filter((r) => !r.leftOut).reduce((n, r) => n + r.share, 0)}%</span><span>{c.budget}</span><span>{c.days ? money(c.perDayCents) : ""}</span><span className="why">Set each platform's daily budget to the Per day amount when you build the campaign there.</span></div>
          </>
        )}
      </div>
      {c.notes.length > 0 && (
        <div className="ld-card" style={{ padding: "12px 16px" }}>
          <span className="ld-lbl">Notes for every set</span>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14 }}>{c.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}
    </>
  );
}

function OpenSet({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const q = trpc.ads.set.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0, refetchInterval: (r) => (r.state.data?.status === "writing" ? 3000 : false) });
  if (!q.data) return <div className="ld-small ld-muted" style={{ padding: 14 }}>Loading...</div>;
  return (
    <div style={{ padding: "4px 14px 14px" }}>
      <SetBody s={q.data} text={q.data.text} />
    </div>
  );
}

/** New campaign: the brief. Reese writes the creative and suggests the split; the split card lands in Chat. */
function NewCampaign({ emp, onClose, onMade }: { emp: EmployeeRow; onClose: () => void; onMade: (id: number) => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [d, setD] = React.useState({ name: "", goal: "", page: "", audience: "", platforms: ["meta", "google", "youtube", "microsoft", "linkedin", "tiktok", "reddit", "spotify", "nextdoor", "yelp"] as string[], budget: "", startDate: "", endDate: "", splitMode: "reese" as "reese" | "even", formats: "any", versions: 1, mustSay: "", neverSay: "" });
  const create = trpc.ads.create.useMutation({ onSuccess: async (r) => { await Promise.all([utils.ads.invalidate(), utils.chat.list.invalidate()]); onMade(r.id); } });
  const toggle = (k: string) => setD({ ...d, platforms: d.platforms.includes(k) ? d.platforms.filter((x) => x !== k) : [...d.platforms, k] });
  const ok = d.name.trim() && d.platforms.length > 0;
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ad-sech"><b>New campaign</b><span className="ld-small ld-muted">Tell {emp.name} the goal, who it is for and the budget. {emp.name} writes the creative for each platform and suggests the split.</span></div>
      <div className="ad-form">
        <label className="ad-f"><span className="k">Name</span><input className="ld-in" autoFocus value={d.name} placeholder="EHR demo requests" onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
        <label className="ad-f"><span className="k">Goal</span><input className="ld-in" value={d.goal} placeholder="Demo requests" onChange={(e) => setD({ ...d, goal: e.target.value })} /></label>
        <label className="ad-f w"><span className="k">Offer or page the ads go to</span><input className="ld-in" value={d.page} placeholder="leaddash.io/demo" onChange={(e) => setD({ ...d, page: e.target.value })} /></label>
        <label className="ad-f w"><span className="k">Who it is for</span><textarea className="ld-ta" rows={2} value={d.audience} placeholder="Owners of group therapy practices, 3 to 20 clinicians, United States" onChange={(e) => setD({ ...d, audience: e.target.value })} /></label>
        <div className="ad-f w">
          <span className="k">Platforms</span>
          <div className="ad-chk">
            {PLATFORMS.map((p) => (
              <label key={p.key}><input type="checkbox" checked={d.platforms.includes(p.key)} onChange={() => toggle(p.key)} />{p.label}</label>
            ))}
          </div>
        </div>
        <label className="ad-f"><span className="k">Total budget</span><input className="ld-in" value={d.budget} placeholder="$2,000" onChange={(e) => setD({ ...d, budget: e.target.value })} /></label>
        <label className="ad-f"><span className="k">Split</span><select className="ld-in" value={d.splitMode} onChange={(e) => setD({ ...d, splitMode: e.target.value as "reese" | "even" })}><option value="reese">{emp.name} suggests a split, I decide</option><option value="even">The same for every platform</option></select></label>
        <label className="ad-f"><span className="k">Starts (MM/DD/YYYY)</span><input className="ld-in" value={d.startDate} placeholder="MM/DD/YYYY" onChange={(e) => setD({ ...d, startDate: e.target.value })} /></label>
        <label className="ad-f"><span className="k">Ends (MM/DD/YYYY)</span><input className="ld-in" value={d.endDate} placeholder="MM/DD/YYYY" onChange={(e) => setD({ ...d, endDate: e.target.value })} /></label>
        <label className="ad-f"><span className="k">Formats</span><select className="ld-in" value={d.formats} onChange={(e) => setD({ ...d, formats: e.target.value })}><option value="any">Image, video and text, whatever each platform takes</option><option value="text">Text only, no pictures</option></select></label>
        <label className="ad-f"><span className="k">Versions per platform</span><select className="ld-in" value={d.versions} onChange={(e) => setD({ ...d, versions: Number(e.target.value) })}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
        <label className="ad-f w"><span className="k">Must say</span><input className="ld-in" value={d.mustSay} placeholder="No add-on fees. Built by a practice owner." onChange={(e) => setD({ ...d, mustSay: e.target.value })} /></label>
        <label className="ad-f w"><span className="k">Never say</span><input className="ld-in" value={d.neverSay} placeholder="Guaranteed results. Anything about client health information." onChange={(e) => setD({ ...d, neverSay: e.target.value })} /></label>
      </div>
      <div className="ld-row" style={{ justifyContent: "flex-end", padding: "0 16px 16px" }}>
        <button type="button" className="ld-btn gp-auto" onClick={onClose}>Cancel</button>
        <button type="button" className="ld-btn p gp-auto" disabled={!ok || create.isPending} onClick={() => create.mutate({ organizationId: currentOrgId, ...d, platforms: d.platforms as never })}>{create.isPending ? "Working out the split" : "Write the creative"}</button>
      </div>
      <div style={{ padding: "0 16px 12px" }}><ErrorLine error={create.error} /></div>
      <div className="ld-small ld-muted" style={{ padding: "0 16px 16px" }}>{emp.name} writes from your Brain, the page the ads go to and each platform's own specs. Nothing is posted anywhere: you put each approved set into the platform's ads manager yourself.</div>
    </div>
  );
}

/** Edit campaign: the brief's fields with Save and Cancel. The budget has its own Edit. */
function CampaignForm({ c, onClose }: { c: CampaignView; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [d, setD] = React.useState({ name: c.name, goal: c.goal, page: c.page, audience: c.audience, platforms: c.platforms as string[], mustSay: c.mustSay, neverSay: c.neverSay });
  const save = trpc.ads.save.useMutation({ onSuccess: async () => { await utils.ads.invalidate(); onClose(); } });
  const toggle = (k: string) => setD({ ...d, platforms: d.platforms.includes(k) ? d.platforms.filter((x) => x !== k) : [...d.platforms, k] });
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ad-sech"><b>Change the campaign</b></div>
      <div className="ad-form">
        <label className="ad-f"><span className="k">Name</span><input className="ld-in" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
        <label className="ad-f"><span className="k">Goal</span><input className="ld-in" value={d.goal} onChange={(e) => setD({ ...d, goal: e.target.value })} /></label>
        <label className="ad-f w"><span className="k">Offer or page the ads go to</span><input className="ld-in" value={d.page} onChange={(e) => setD({ ...d, page: e.target.value })} /></label>
        <label className="ad-f w"><span className="k">Who it is for</span><textarea className="ld-ta" rows={2} value={d.audience} onChange={(e) => setD({ ...d, audience: e.target.value })} /></label>
        <div className="ad-f w">
          <span className="k">Platforms</span>
          <div className="ad-chk">
            {PLATFORMS.map((p) => (
              <label key={p.key}><input type="checkbox" checked={d.platforms.includes(p.key)} onChange={() => toggle(p.key)} />{p.label}</label>
            ))}
          </div>
        </div>
        <label className="ad-f w"><span className="k">Must say</span><input className="ld-in" value={d.mustSay} onChange={(e) => setD({ ...d, mustSay: e.target.value })} /></label>
        <label className="ad-f w"><span className="k">Never say</span><input className="ld-in" value={d.neverSay} onChange={(e) => setD({ ...d, neverSay: e.target.value })} /></label>
      </div>
      <div className="ld-row" style={{ justifyContent: "flex-end", padding: "0 16px 16px" }}>
        <button type="button" className="ld-btn gp-auto" onClick={onClose}>Cancel</button>
        <button type="button" className="ld-btn p gp-auto" disabled={!d.name.trim() || !d.platforms.length || save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: c.id, ...d, platforms: d.platforms as never })}>Save</button>
      </div>
      <div style={{ padding: "0 16px 12px" }}><ErrorLine error={save.error} /></div>
    </div>
  );
}
