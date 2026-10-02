import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs, UnderlineTabs } from "../ui";
import { fmtDate, parseJson, uploadFile } from "../meta";
import type { Outputs } from "../types";

type Role = Outputs["hiring"]["roles"][number];
type Person = Outputs["hiring"]["people"][number];
type TeamItem = Outputs["hiring"]["team"][number];
type MustHave = { item: string; met: "yes" | "no" | "unknown"; kind: "must" | "nice" };
type Check = { name: string; detail: string; status: "clear" | "flag" | "manual" | "needs_setup"; url: string | null; checkedAt: string };
type Target = { name: string; status: "ready" | "posted"; url: string | null };
type ChecklistItem = { item: string; detail: string; status: "to_do" | "waiting" | "pending" | "done" | "stuck" };
type NewHire = { offerLetter?: string; paperwork: ChecklistItem[]; credentialing: ChecklistItem[] };

const LICENSES = ["LPC", "LMFT", "LCSW", "Licensed candidate", "LADC", "LMHC", "Psychologist", "None"];
const CHECK_PILL: Record<Check["status"], { label: string; cls: string }> = {
  clear: { label: "Clear", cls: "green" },
  flag: { label: "Look closer", cls: "red" },
  manual: { label: "Check by hand", cls: "amber" },
  needs_setup: { label: "Needs setup", cls: "gray" },
};
const ITEM_PILL: Record<ChecklistItem["status"], { label: string; cls: string }> = {
  to_do: { label: "To do", cls: "gray" },
  waiting: { label: "Waiting", cls: "amber" },
  pending: { label: "Pending", cls: "amber" },
  done: { label: "Done", cls: "green" },
  stuck: { label: "Stuck", cls: "red" },
};

/** "04/15/2027" typed in becomes "Apr 15, 2027" on screen. */
function showDate(v: string | null | undefined) {
  const m = (v ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? fmtDate(new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]))) : v ?? "";
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body" style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

function Chips<T extends string>({ options, value, onChange, labels }: { options: T[]; value: T[]; onChange: (v: T[]) => void; labels?: Record<string, string> }) {
  return (
    <div className="ld-row" style={{ flexWrap: "wrap" }}>
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button key={o} type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}>
            {labels?.[o] ?? o}
          </button>
        );
      })}
    </div>
  );
}

function OneOf<T extends string>({ options, value, onChange, labels }: { options: T[]; value: T; onChange: (v: T) => void; labels: Record<string, string> }) {
  return (
    <div className="ld-row" style={{ flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={o} type="button" className={`ld-chip ${value === o ? "on" : ""}`} aria-pressed={value === o} onClick={() => onChange(o)}>
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Quinn's Hiring tab: Roles, Candidates, Outreach, New hires. */
export default function HiringWork({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const initial = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
  const [tab, setTab] = React.useState<"roles" | "candidates" | "outreach" | "hires">(
    initial === "roles" ? "roles" : initial === "outreach" ? "outreach" : initial === "hires" ? "hires" : "candidates"
  );
  const roles = trpc.hiring.roles.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const people = trpc.hiring.people.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 20_000 });
  const all = people.data ?? [];
  const applicants = all.filter((p) => p.source === "applicant" && p.stage !== "hired");
  const prospects = all.filter((p) => p.source === "prospect" && p.stage !== "passed");
  const hires = all.filter((p) => p.stage === "hired");

  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      <TopActions tab={tab} roles={roles.data ?? []} applicants={applicants} onTab={setTab} />
      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "roles", label: `Roles (${(roles.data ?? []).filter((r) => r.status === "open").length})` },
          { key: "candidates", label: `Candidates (${applicants.filter((p) => p.stage !== "passed").length})` },
          { key: "outreach", label: `Outreach (${prospects.length})` },
          { key: "hires", label: `New hires (${hires.length})` },
        ]}
      />
      {tab === "roles" && <Roles list={roles.data ?? []} loading={roles.isLoading} />}
      {tab === "candidates" && <Candidates list={applicants} loading={people.isLoading} />}
      {tab === "outreach" && <Outreach list={prospects} loading={people.isLoading} name={emp.name} />}
      {tab === "hires" && <NewHires list={hires} />}
    </main>
  );
}

// ==========================================
// Buttons above the tabs
// ==========================================

function TopActions({ tab, roles, applicants, onTab }: { tab: string; roles: Role[]; applicants: Person[]; onTab: (t: "roles" | "candidates" | "outreach" | "hires") => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const find = trpc.hiring.find.useMutation({
    onSuccess: async (r) => {
      setNote(r.added ? `Added ${r.added} from ${r.searches} searches.` : `Nothing new from ${r.searches} searches.`);
      await utils.hiring.people.invalidate();
    },
  });
  const rescreen = trpc.hiring.rescreen.useMutation();
  const open = roles.filter((r) => r.status === "open");

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setNote(null);
    let done = 0;
    for (const f of Array.from(files)) {
      setBusy(`Reading ${done + 1} of ${files.length}...`);
      try {
        await uploadFile("resume", f, { organizationId: currentOrgId, ...(open[0] ? { roleId: open[0].id } : {}) });
        done++;
      } catch (e) {
        setError(`${f.name}: ${e instanceof Error ? e.message : "Upload failed."}`);
      }
    }
    setBusy(null);
    setNote(`Screened ${done} resume${done === 1 ? "" : "s"}.`);
    onTab("candidates");
    await utils.hiring.people.invalidate();
  };

  const screenNew = async () => {
    const list = applicants.filter((p) => p.stage === "new");
    setNote(null);
    for (let i = 0; i < list.length; i++) {
      setBusy(`Screening ${i + 1} of ${list.length}...`);
      await rescreen.mutateAsync({ organizationId: currentOrgId, id: list[i].id }).catch(() => {});
    }
    setBusy(null);
    await utils.hiring.people.invalidate();
  };

  return (
    <>
      <div className="ld-row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
        {(busy || note) && <span className="ld-small ld-muted">{busy ?? note}</span>}
        {tab === "roles" && (
          <button type="button" className="ld-btn p" onClick={() => window.dispatchEvent(new CustomEvent("ld-add-role"))}>
            Add role
          </button>
        )}
        {tab === "candidates" && (
          <>
            <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.txt,.md" style={{ display: "none" }} onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
            <button type="button" className="ld-btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>
              Add resumes
            </button>
            <button type="button" className="ld-btn p" disabled={!!busy || !applicants.some((p) => p.stage === "new")} onClick={screenNew}>
              Screen new
            </button>
          </>
        )}
        {tab === "outreach" && (
          <button type="button" className="ld-btn p" disabled={find.isPending} onClick={() => { setNote(null); find.mutate({ organizationId: currentOrgId, roleId: open[0]?.id ?? null }); }}>
            {find.isPending ? "Searching..." : "Find more"}
          </button>
        )}
      </div>
      {error && <p role="alert" className="ld-small" style={{ color: "#b42318", margin: 0, textAlign: "right" }}>{error}</p>}
      <ErrorLine error={find.error} />
    </>
  );
}

// ==========================================
// Roles
// ==========================================

const ROLE_COLS = "minmax(0,2fr) 130px 180px 96px 128px 128px";

type RoleDraft = {
  id?: number;
  title: string;
  employment: "w2" | "1099";
  hours: "full" | "part";
  place: "in_person" | "telehealth" | "both";
  payFrom: string;
  payTo: string;
  licenses: string[];
  mustHave: string;
  niceToHave: string;
};

const blankRole: RoleDraft = { title: "", employment: "w2", hours: "part", place: "both", payFrom: "", payTo: "", licenses: [], mustHave: "", niceToHave: "" };

/** "$40 an hour" and "$55 an hour" read as "$40 to $55 an hour". */
function payRange(from: string | null, to: string | null) {
  const a = (from ?? "").trim();
  const b = (to ?? "").trim();
  if (!a || !b) return a || b;
  const unit = (s: string) => s.replace(/^[$\d,.\sk]+/i, "").trim();
  return unit(a) && unit(a) === unit(b) ? `${a.slice(0, a.length - unit(a).length).trim()} to ${b}` : `${a} to ${b}`;
}

function typeLabel(r: { employment: string; hours: string }) {
  return `${r.employment === "w2" ? "W-2" : "1099"}, ${r.hours === "full" ? "full time" : "part time"}`;
}

function Roles({ list, loading }: { list: Role[]; loading: boolean }) {
  const [open, setOpen] = React.useState<number | null>(null);
  const [opened, setOpened] = React.useState(false);
  const [editing, setEditing] = React.useState<number | "new" | null>(null);
  React.useEffect(() => {
    const h = () => {
      setEditing("new");
      setOpen(null);
    };
    window.addEventListener("ld-add-role", h);
    return () => window.removeEventListener("ld-add-role", h);
  }, []);
  const sorted = [...list].sort((a, b) => (a.status === b.status ? b.applicants - a.applicants || b.id - a.id : a.status === "open" ? -1 : 1));
  React.useEffect(() => {
    if (!opened && sorted[0]) {
      setOpen(sorted[0].id);
      setOpened(true);
    }
  }, [opened, sorted]);
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: ROLE_COLS }}>
        <span>Role</span>
        <span>Type</span>
        <span>Pay</span>
        <span>Applicants</span>
        <span />
        <span />
      </div>
      {editing === "new" && <RoleEditor draft={blankRole} onDone={() => setEditing(null)} />}
      {sorted.length === 0 && editing !== "new" && <div className="ld-empty">{loading ? "Loading..." : "No roles yet. Press Add role."}</div>}
      {sorted.map((r) =>
        editing === r.id ? (
          <RoleEditor
            key={r.id}
            role={r}
            draft={{ id: r.id, title: r.title, employment: r.employment, hours: r.hours, place: r.place, payFrom: r.payFrom ?? "", payTo: r.payTo ?? "", licenses: parseJson<string[]>(r.licenses, []), mustHave: r.mustHave ?? "", niceToHave: r.niceToHave ?? "" }}
            onDone={() => setEditing(null)}
          />
        ) : (
          <RoleRow key={r.id} role={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} onEdit={() => { setEditing(r.id); setOpen(r.id); }} />
        )
      )}
    </div>
  );
}

function RoleRow({ role, open, onToggle, onEdit }: { role: Role; open: boolean; onToggle: () => void; onEdit: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const status = trpc.hiring.setRoleStatus.useMutation({ onSuccess: () => utils.hiring.roles.invalidate() });
  return (
    <>
      <div
        className={`ld-rw ${open ? "open" : ""}`}
        style={{ gridTemplateColumns: ROLE_COLS, cursor: "pointer", opacity: role.status === "closed" ? 0.6 : 1 }}
        aria-expanded={open}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button,a")) return;
          onToggle();
        }}
      >
        <span className="ld-strong">{role.title}{role.status === "closed" ? " (closed)" : ""}</span>
        <span>{typeLabel(role)}</span>
        <span>{payRange(role.payFrom, role.payTo) || "Not set"}</span>
        <span>{role.applicants}</span>
        <button type="button" className="ld-btn" disabled={status.isPending} onClick={() => status.mutate({ organizationId: currentOrgId, id: role.id, status: role.status === "open" ? "closed" : "open" })}>
          {role.status === "open" ? "Close role" : "Reopen"}
        </button>
        <button type="button" className="ld-btn" onClick={onEdit}>Edit</button>
      </div>
      {open && (
        <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 28 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <KV label="Where">{role.place === "both" ? "In person and telehealth" : role.place === "telehealth" ? "Telehealth" : "In person"}</KV>
            <KV label="Licenses accepted">{parseJson<string[]>(role.licenses, []).join(", ") || "Not set"}</KV>
            <KV label="Must have">{role.mustHave || "Not set"}</KV>
            <KV label="Nice to have">{role.niceToHave || "Not set"}</KV>
          </div>
          <JobPost role={role} />
        </div>
      )}
    </>
  );
}

function JobPost({ role }: { role: Role }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [copied, setCopied] = React.useState(false);
  const write = trpc.hiring.writePost.useMutation({ onSuccess: () => utils.hiring.roles.invalidate() });
  const posted = trpc.hiring.markPosted.useMutation({ onSuccess: () => utils.hiring.roles.invalidate() });
  const targets = parseJson<Target[]>(role.targets, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <span className="ld-lbl">Job post</span>
      {role.post ? (
        <div className="ld-card ld-body ld-pre" style={{ padding: "14px 16px", lineHeight: 1.6 }}>{role.post}</div>
      ) : (
        <span className="ld-body ld-muted">{write.isPending ? "Quinn is writing the post..." : "No post yet."}</span>
      )}
      <div className="ld-row">
        <button type="button" className="ld-btn" disabled={write.isPending} onClick={() => write.mutate({ organizationId: currentOrgId, id: role.id })}>
          {write.isPending ? "Writing..." : role.post ? "Rewrite" : "Write post"}
        </button>
        {role.post && (
          <button type="button" className="ld-btn" onClick={async () => setCopied(await copy(role.post ?? ""))}>
            {copied ? "Copied" : "Copy post"}
          </button>
        )}
      </div>
      <ErrorLine error={write.error} />
      {targets.length > 0 && (
        <>
          <span className="ld-lbl" style={{ marginTop: 6 }}>Post to</span>
          <div>
            {targets.map((t) => (
              <div key={t.name} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 72px 128px", gap: 12, alignItems: "center", padding: "8px 0", borderBottom: "1px solid #eef2f0" }}>
                <span className="ld-body">{t.name}</span>
                <span className={`ld-pill ${t.status === "posted" ? "green" : "amber"}`}>{t.status === "posted" ? "Posted" : "Ready"}</span>
                {t.status === "ready" ? (
                  <button
                    type="button"
                    className="ld-btn"
                    disabled={!role.post || posted.isPending}
                    onClick={async () => {
                      await copy(role.post ?? "");
                      if (t.url) window.open(t.url, "_blank", "noopener");
                      posted.mutate({ organizationId: currentOrgId, id: role.id, target: t.name, posted: true });
                    }}
                  >
                    Copy and open
                  </button>
                ) : (
                  <button type="button" className="ld-btn" onClick={() => posted.mutate({ organizationId: currentOrgId, id: role.id, target: t.name, posted: false })}>
                    Not posted
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RoleEditor({ draft: start, role, onDone }: { draft: RoleDraft; role?: Role; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [d, setD] = React.useState<RoleDraft>(start);
  const save = trpc.hiring.saveRole.useMutation({
    onSuccess: async () => {
      await utils.hiring.roles.invalidate();
      onDone();
    },
  });
  const set = <K extends keyof RoleDraft>(k: K, v: RoleDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const submit = () => save.mutate({ organizationId: currentOrgId, ...d });
  return (
    <>
      <div className="ld-rw open" style={{ gridTemplateColumns: ROLE_COLS }}>
        <span className="ld-strong">{d.title || "New role"}</span>
        <span>{typeLabel(d)}</span>
        <span>{payRange(d.payFrom, d.payTo)}</span>
        <span>{role?.applicants ?? 0}</span>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
        <button type="button" className="ld-btn p" disabled={save.isPending || d.title.trim().length < 2} onClick={submit}>Save</button>
      </div>
      <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: role ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr)", gap: 28 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 620 }}>
          <div className="ld-field">
            <label className="ld-lbl" htmlFor="r-title">Title</label>
            <input id="r-title" className="ld-in" value={d.title} maxLength={120} onChange={(e) => set("title", e.target.value)} placeholder="Outpatient therapist" />
          </div>
          <div className="ld-field">
            <span className="ld-lbl">Employment</span>
            <OneOf options={["w2", "1099"] as ("w2" | "1099")[]} value={d.employment} onChange={(v) => set("employment", v)} labels={{ w2: "W-2", "1099": "1099" }} />
          </div>
          <div className="ld-field">
            <span className="ld-lbl">Hours</span>
            <OneOf options={["full", "part"] as ("full" | "part")[]} value={d.hours} onChange={(v) => set("hours", v)} labels={{ full: "Full time", part: "Part time" }} />
          </div>
          <div className="ld-field">
            <span className="ld-lbl">Where</span>
            <OneOf options={["in_person", "telehealth", "both"] as ("in_person" | "telehealth" | "both")[]} value={d.place} onChange={(v) => set("place", v)} labels={{ in_person: "In person", telehealth: "Telehealth", both: "Both" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="ld-field">
              <label className="ld-lbl" htmlFor="r-min">Pay from</label>
              <input id="r-min" className="ld-in" value={d.payFrom} maxLength={60} onChange={(e) => set("payFrom", e.target.value)} placeholder="$40 an hour" />
            </div>
            <div className="ld-field">
              <label className="ld-lbl" htmlFor="r-max">Pay to</label>
              <input id="r-max" className="ld-in" value={d.payTo} maxLength={60} onChange={(e) => set("payTo", e.target.value)} placeholder="$55 an hour" />
            </div>
          </div>
          <div className="ld-field">
            <span className="ld-lbl">Licenses accepted</span>
            <Chips options={LICENSES} value={d.licenses} onChange={(v) => set("licenses", v)} />
          </div>
          <div className="ld-field">
            <label className="ld-lbl" htmlFor="r-must">Must have</label>
            <input id="r-must" className="ld-in" value={d.mustHave} maxLength={1000} onChange={(e) => set("mustHave", e.target.value)} placeholder="Oklahoma license, 2 evenings a week, comfortable with telehealth" />
          </div>
          <div className="ld-field">
            <label className="ld-lbl" htmlFor="r-nice">Nice to have</label>
            <input id="r-nice" className="ld-in" value={d.niceToHave} maxLength={1000} onChange={(e) => set("niceToHave", e.target.value)} placeholder="Spanish, SoonerCare credentialed" />
          </div>
          <ErrorLine error={save.error} />
        </div>
        {role && <JobPost role={role} />}
      </div>
    </>
  );
}

// ==========================================
// Candidates
// ==========================================

const CAND_COLS = "minmax(0,1.5fr) minmax(0,1.3fr) 116px 116px 128px 128px";
type CandStage = "new" | "interview" | "hold" | "offer" | "passed";

function scorePill(p: Person) {
  const checks = parseJson<Check[]>(p.checks, []);
  const lic = checks.find((c) => c.name === "License");
  if (lic?.status === "flag" || checks.some((c) => c.status === "flag")) return <span className="ld-pill red">Look closer</span>;
  return <span className={`ld-pill ${p.fitScore >= 60 ? "green" : "gray"}`}>{p.fitScore}</span>;
}

function Candidates({ list, loading }: { list: Person[]; loading: boolean }) {
  const [stage, setStage] = React.useState<CandStage>("new");
  const [open, setOpen] = React.useState<number | null>(null);
  const shown = list.filter((p) => p.stage === stage);
  const n = (s: CandStage) => list.filter((p) => p.stage === s).length;
  return (
    <>
      <FolderTabs
        value={stage}
        onChange={(s) => { setStage(s); setOpen(null); }}
        tabs={[
          { key: "new", label: `New (${n("new")})` },
          { key: "interview", label: `Interview (${n("interview")})` },
          { key: "hold", label: `Hold (${n("hold")})` },
          { key: "offer", label: `Offer (${n("offer")})` },
          { key: "passed", label: `Passed (${n("passed")})` },
        ]}
      >
        <div className="ld-hd" style={{ gridTemplateColumns: CAND_COLS }}>
          <span>Candidate</span>
          <span>Role</span>
          <span>Applied</span>
          <span>Quinn's score</span>
          <span />
          <span />
        </div>
        {shown.length === 0 && <div className="ld-empty">{loading ? "Loading..." : stage === "new" ? "No new applicants. Press Add resumes." : "Nobody here yet."}</div>}
        {shown.map((p) => (
          <CandidateRow key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />
        ))}
      </FolderTabs>
      <span className="ld-small ld-muted">Scores count only your must-haves and nice-to-haves.</span>
    </>
  );
}

function flagged(p: Person) {
  return parseJson<Check[]>(p.checks, []).some((c) => c.status === "flag");
}

function CandidateRow({ p, open, onToggle }: { p: Person; open: boolean; onToggle: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.hiring.people.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const move = trpc.hiring.move.useMutation({ onSuccess: refresh });
  const hire = trpc.hiring.hire.useMutation({ onSuccess: refresh });
  const go = (stage: Person["stage"]) => move.mutate({ organizationId: currentOrgId, id: p.id, stage });
  const buttons: Record<CandStage, [string, () => void, boolean][]> = {
    new:
      p.fitScore >= 60 && !flagged(p)
        ? [["Interview", () => go("interview"), true], ["Hold", () => go("hold"), false]]
        : [[open ? "Close" : "Open", onToggle, false], ["Pass", () => go("passed"), false]],
    interview: [["Offer", () => go("offer"), true], ["Hold", () => go("hold"), false]],
    hold: [["Interview", () => go("interview"), true], ["Pass", () => go("passed"), false]],
    offer: [["Hired", () => hire.mutate({ organizationId: currentOrgId, id: p.id }), true], ["Pass", () => go("passed"), false]],
    passed: [["Move back", () => go("new"), false], ["", () => {}, false]],
  };
  const st = (p.stage as CandStage) in buttons ? (p.stage as CandStage) : "new";
  return (
    <>
      <div
        className={`ld-rw ${open ? "open" : ""}`}
        style={{ gridTemplateColumns: CAND_COLS, cursor: "pointer" }}
        aria-expanded={open}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button,a")) return;
          onToggle();
        }}
      >
        <span className="ld-strong">{[p.name, p.credentials].filter(Boolean).join(", ")}</span>
        <span>{p.roleTitle ?? "No role"}</span>
        <span>{p.appliedOn ?? fmtDate(p.createdAt)}</span>
        {scorePill(p)}
        {buttons[st].map(([label, fn, primary], i) =>
          label ? (
            <button key={i} type="button" className={`ld-btn ${primary ? "p" : ""}`} disabled={move.isPending || hire.isPending} onClick={fn}>
              {label}
            </button>
          ) : (
            <span key={i} />
          )
        )}
      </div>
      {open && <CandidateDetail p={p} />}
      {(move.error || hire.error) && (
        <div style={{ padding: "6px 18px" }}>
          <ErrorLine error={move.error || hire.error} />
        </div>
      )}
    </>
  );
}

function CandidateDetail({ p }: { p: Person }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const checks = trpc.hiring.runChecks.useMutation({ onSuccess: () => utils.hiring.people.invalidate() });
  const move = trpc.hiring.move.useMutation({ onSuccess: () => utils.hiring.people.invalidate() });
  const must = parseJson<MustHave[]>(p.mustHaves, []);
  const list = parseJson<Check[]>(p.checks, []);
  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.35fr) 128px", gap: 28 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <span className="ld-lbl">Against your must-haves</span>
        {must.length === 0 && <span className="ld-body ld-muted">Add must-haves to the role, then press Screen new.</span>}
        {must.map((m, i) => (
          <div key={i} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 90px", gap: 12, padding: "6px 0", borderBottom: "1px solid #eef2f0", fontSize: 14 }}>
            <span>{m.item}{m.kind === "nice" ? " (nice to have)" : ""}</span>
            <span style={{ fontWeight: 700, color: m.met === "yes" ? "#155c3e" : m.met === "no" ? "#b42318" : "#5b6b64" }}>{m.met === "yes" ? "Yes" : m.met === "no" ? "No" : "Not said"}</span>
          </div>
        ))}
        {p.fitReason && <KV label="Why">{p.fitReason}</KV>}
        {p.email && <KV label="Email">{p.email}</KV>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <span className="ld-lbl">Checks</span>
        {list.length === 0 && <span className="ld-body ld-muted">{checks.isPending ? "Running license, NPI, OIG and SAM.gov checks..." : "Not checked yet."}</span>}
        {list.map((c) => (
          <div key={c.name} className="ld-keep ld-keep-check" style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1fr) 112px", gap: 10, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #eef2f0", fontSize: 14 }}>
            <span className="ld-strong">{c.name}</span>
            <span style={{ overflowWrap: "anywhere" }}>
              {c.detail}
              {c.url && (
                <>
                  {" "}
                  <a href={c.url} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600 }}>Open</a>
                </>
              )}
            </span>
            <span className={`ld-pill ${CHECK_PILL[c.status].cls}`}>{CHECK_PILL[c.status].label}</span>
          </div>
        ))}
        {p.queued && <span className="ld-pill amber">Email waiting in Approvals</span>}
        {p.stage === "offer" && <OfferBox p={p} />}
        <ErrorLine error={checks.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {p.resumeUrl && (
          <a className="ld-btn" href={p.resumeUrl} target="_blank" rel="noreferrer noopener">Resume</a>
        )}
        <button type="button" className="ld-btn" disabled={checks.isPending} onClick={() => checks.mutate({ organizationId: currentOrgId, id: p.id })}>
          {checks.isPending ? "Checking..." : list.length ? "Check again" : "Run checks"}
        </button>
        {p.stage !== "passed" && p.stage !== "hold" && (
          <button type="button" className="ld-btn" disabled={move.isPending} onClick={() => move.mutate({ organizationId: currentOrgId, id: p.id, stage: "passed" })}>Pass</button>
        )}
      </div>
    </div>
  );
}

function OfferBox({ p }: { p: Person }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const hire = parseJson<NewHire>(p.onboarding, { paperwork: [], credentialing: [] });
  const [start, setStart] = React.useState(p.startDate ?? "");
  const [pay, setPay] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [letter, setLetter] = React.useState(hire.offerLetter ?? "");
  const [copied, setCopied] = React.useState(false);
  const write = trpc.hiring.offer.useMutation({ onSuccess: (r) => { setLetter(parseJson<NewHire>(r?.onboarding, { paperwork: [], credentialing: [] }).offerLetter ?? ""); utils.hiring.people.invalidate(); } });
  const save = trpc.hiring.saveOffer.useMutation({ onSuccess: () => { setEditing(false); utils.hiring.people.invalidate(); } });
  const email = trpc.hiring.emailPerson.useMutation({ onSuccess: () => utils.hiring.people.invalidate() });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
      <span className="ld-lbl">Offer letter</span>
      {!hire.offerLetter ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", gap: 10 }}>
            <div className="ld-field">
              <label className="ld-lbl" htmlFor={`st-${p.id}`}>Start date</label>
              <input id={`st-${p.id}`} className="ld-in" value={start} onChange={(e) => setStart(e.target.value)} placeholder="MM/DD/YYYY" inputMode="numeric" />
            </div>
            <div className="ld-field">
              <label className="ld-lbl" htmlFor={`pay-${p.id}`}>Pay</label>
              <input id={`pay-${p.id}`} className="ld-in" value={pay} onChange={(e) => setPay(e.target.value)} placeholder="$48 an hour" />
            </div>
          </div>
          <button type="button" className="ld-btn p" disabled={write.isPending || !start || !pay} onClick={() => write.mutate({ organizationId: currentOrgId, id: p.id, startDate: start, pay })}>
            {write.isPending ? "Writing..." : "Write offer"}
          </button>
        </>
      ) : editing ? (
        <>
          <textarea className="ld-ta" rows={12} value={letter} onChange={(e) => setLetter(e.target.value)} aria-label="Offer letter" />
          <div className="ld-row">
            <button type="button" className="ld-btn" onClick={() => { setEditing(false); setLetter(hire.offerLetter ?? ""); }}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: p.id, letter })}>Save</button>
          </div>
        </>
      ) : (
        <>
          <div className="ld-card ld-body ld-pre" style={{ padding: "12px 14px", maxHeight: 260, overflow: "auto" }}>{hire.offerLetter}</div>
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className="ld-btn" onClick={async () => setCopied(await copy(hire.offerLetter ?? ""))}>{copied ? "Copied" : "Copy letter"}</button>
            {p.email && (
              <button type="button" className="ld-btn" disabled={email.isPending || p.queued} onClick={() => email.mutate({ organizationId: currentOrgId, id: p.id, purpose: "offer" })}>Offer email</button>
            )}
          </div>
          <span className="ld-small ld-muted">Have your attorney review offer letters before they go out.</span>
        </>
      )}
      <ErrorLine error={write.error || save.error || email.error} />
    </div>
  );
}

// ==========================================
// Outreach
// ==========================================

const OUT_COLS = "minmax(0,1.5fr) minmax(0,1.5fr) 140px 90px 128px 128px";
type OutStage = "prospect" | "contacted" | "replied" | "dnc";

function Outreach({ list, loading, name }: { list: Person[]; loading: boolean; name: string }) {
  const [stage, setStage] = React.useState<OutStage>("prospect");
  const [open, setOpen] = React.useState<number | null>(null);
  const n = (s: OutStage) => list.filter((p) => p.stage === s).length;
  const shown = list.filter((p) => p.stage === stage);
  React.useEffect(() => {
    if (open === null && stage === "prospect" && shown[0]) setOpen(shown[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.length, stage]);
  return (
    <>
      <FolderTabs
        value={stage}
        onChange={(s) => { setStage(s); setOpen(null); }}
        tabs={[
          { key: "prospect", label: `Prospects (${n("prospect")})` },
          { key: "contacted", label: `Contacted (${n("contacted")})` },
          { key: "replied", label: `Replied (${n("replied")})` },
          { key: "dnc", label: `Do not contact (${n("dnc")})` },
        ]}
      >
        <div className="ld-hd" style={{ gridTemplateColumns: OUT_COLS }}>
          <span>Person</span>
          <span>Now</span>
          <span>Found on</span>
          <span>Fit</span>
          <span />
          <span />
        </div>
        {shown.length === 0 && <div className="ld-empty">{loading ? "Loading..." : stage === "prospect" ? `No prospects yet. Press Find more and ${name} will search.` : "Nobody here yet."}</div>}
        {shown.map((p) => (
          <ProspectRow key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />
        ))}
      </FolderTabs>
      <span className="ld-small ld-muted">LinkedIn messages are sent from your own account. Quinn drafts them and tracks replies.</span>
    </>
  );
}

function ProspectRow({ p, open, onToggle }: { p: Person; open: boolean; onToggle: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.hiring.people.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const move = trpc.hiring.move.useMutation({ onSuccess: refresh });
  const email = trpc.hiring.emailPerson.useMutation({ onSuccess: refresh });
  const go = (stage: Person["stage"]) => move.mutate({ organizationId: currentOrgId, id: p.id, stage });
  const openProfile = () => p.sourceUrl && window.open(p.sourceUrl, "_blank", "noopener");
  let a: React.ReactNode;
  let b: React.ReactNode;
  if (p.stage === "prospect") {
    a = p.email ? (
      <button type="button" className="ld-btn p" disabled={email.isPending || p.queued} onClick={() => email.mutate({ organizationId: currentOrgId, id: p.id, purpose: "outreach" })}>
        {p.queued ? "In Approvals" : "Send email"}
      </button>
    ) : (
      <button type="button" className="ld-btn p" disabled={!p.sourceUrl} onClick={openProfile}>Open profile</button>
    );
    b = <button type="button" className="ld-btn" disabled={move.isPending} onClick={() => go("passed")}>Pass</button>;
  } else if (p.stage === "contacted") {
    a = <button type="button" className="ld-btn p" disabled={move.isPending} onClick={() => go("replied")}>Replied</button>;
    b = <button type="button" className="ld-btn" disabled={move.isPending} onClick={() => go("dnc")}>Do not contact</button>;
  } else if (p.stage === "replied") {
    a = <button type="button" className="ld-btn p" disabled={move.isPending} onClick={() => go("interview")}>Interview</button>;
    b = <button type="button" className="ld-btn" disabled={move.isPending} onClick={() => go("dnc")}>Not interested</button>;
  } else {
    a = <span className="ld-pill gray">Do not contact</span>;
    b = <span />;
  }
  return (
    <>
      <div
        className={`ld-rw ${open ? "open" : ""}`}
        style={{ gridTemplateColumns: OUT_COLS, cursor: "pointer" }}
        aria-expanded={open}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button,a")) return;
          onToggle();
        }}
      >
        <span className="ld-strong">{[p.name, p.credentials].filter(Boolean).join(", ")}</span>
        <span>{[p.currentRole, p.location].filter(Boolean).join(", ")}</span>
        <span>{p.foundOn ?? ""}</span>
        <span className={`ld-pill ${p.fitScore >= 60 ? "green" : "gray"}`}>{p.fitScore}</span>
        {a}
        {b}
      </div>
      {open && p.stage !== "dnc" && <ProspectDetail p={p} />}
      {(move.error || email.error) && (
        <div style={{ padding: "6px 18px" }}>
          <ErrorLine error={move.error || email.error} />
        </div>
      )}
    </>
  );
}

function ProspectDetail({ p }: { p: Person }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [copied, setCopied] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(p.message ?? "");
  const rewrite = trpc.hiring.rewriteMessage.useMutation({ onSuccess: () => utils.hiring.people.invalidate() });
  const saveMsg = trpc.hiring.saveMessage.useMutation({ onSuccess: () => { setEditing(false); utils.hiring.people.invalidate(); } });
  const sent = trpc.hiring.markSent.useMutation({ onSuccess: () => utils.hiring.people.invalidate() });
  const move = trpc.hiring.move.useMutation({ onSuccess: () => utils.hiring.people.invalidate() });
  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.3fr) 128px", gap: 28 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        <KV label="For role">{p.roleTitle ?? "Any open role"}</KV>
        {p.fitReason && <KV label="Why they fit">{p.fitReason}</KV>}
        {p.email && <KV label="Work email">{p.email}</KV>}
        {p.sourceUrl && (
          <KV label="Source">
            <a href={p.sourceUrl} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600 }}>
              {p.sourceUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
            </a>
          </KV>
        )}
        {p.contactedAt && <KV label="Contacted">{fmtDate(p.contactedAt)}</KV>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <span className="ld-lbl">Message</span>
        {editing ? (
          <textarea className="ld-ta" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Message" />
        ) : (
          <div className="ld-card ld-body ld-pre" style={{ padding: "14px 16px", lineHeight: 1.6 }}>{p.message || (rewrite.isPending ? "Writing..." : "No message yet. Press Rewrite.")}</div>
        )}
        <div className="ld-row" style={{ flexWrap: "wrap" }}>
          {editing ? (
            <>
              <button type="button" className="ld-btn" onClick={() => { setEditing(false); setDraft(p.message ?? ""); }}>Cancel</button>
              <button type="button" className="ld-btn p" disabled={saveMsg.isPending} onClick={() => saveMsg.mutate({ organizationId: currentOrgId, id: p.id, message: draft })}>Save</button>
            </>
          ) : (
            <>
              <button type="button" className="ld-btn" onClick={() => { setDraft(p.message ?? ""); setEditing(true); }}>Edit</button>
              <button type="button" className="ld-btn" disabled={rewrite.isPending} onClick={() => rewrite.mutate({ organizationId: currentOrgId, id: p.id })}>{rewrite.isPending ? "Writing..." : "Rewrite"}</button>
              <button type="button" className="ld-btn" disabled={!p.message} onClick={async () => setCopied(await copy(p.message ?? ""))}>{copied ? "Copied" : "Copy message"}</button>
              {p.stage === "prospect" && (
                <button type="button" className="ld-btn p" disabled={sent.isPending} onClick={() => sent.mutate({ organizationId: currentOrgId, id: p.id })}>Mark sent</button>
              )}
            </>
          )}
        </div>
        <ErrorLine error={rewrite.error || saveMsg.error || sent.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {p.stage === "prospect" && p.email && p.sourceUrl && <a className="ld-btn" href={p.sourceUrl} target="_blank" rel="noreferrer noopener">Open profile</a>}
        {p.stage === "prospect" && <button type="button" className="ld-btn" disabled={move.isPending} onClick={() => move.mutate({ organizationId: currentOrgId, id: p.id, stage: "dnc" })}>Do not contact</button>}
      </div>
    </div>
  );
}

// ==========================================
// New hires and team expirations
// ==========================================

function NewHires({ list }: { list: Person[] }) {
  return (
    <>
      {list.length === 0 && <div className="ld-card ld-empty">Nobody is onboarding. Press Hired on a candidate in the Offer folder to start a checklist.</div>}
      {list.map((p) => (
        <HireCard key={p.id} p={p} />
      ))}
      <TeamCard />
    </>
  );
}

function HireCard({ p }: { p: Person }) {
  const hire = parseJson<NewHire>(p.onboarding, { paperwork: [], credentialing: [] });
  const [showLetter, setShowLetter] = React.useState(false);
  const all = [...hire.paperwork, ...hire.credentialing];
  const done = all.filter((i) => i.status === "done").length;
  return (
    <div className="ld-card" style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="ld-between">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontWeight: 800, fontSize: 17 }}>{[p.name, p.credentials].filter(Boolean).join(", ")}</span>
          <span className="ld-body" style={{ color: "#3d4c45" }}>
            {[p.roleTitle, p.startDate && `Starts ${showDate(p.startDate)}`, `${done} of ${all.length} done`].filter(Boolean).join(" · ")}
          </span>
        </div>
        {hire.offerLetter && (
          <button type="button" className="ld-btn" onClick={() => setShowLetter((v) => !v)}>{showLetter ? "Hide letter" : "Offer letter"}</button>
        )}
      </div>
      {showLetter && <div className="ld-card ld-body ld-pre" style={{ padding: "12px 14px", maxHeight: 320, overflow: "auto" }}>{hire.offerLetter}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 32 }}>
        <Checklist p={p} list="paperwork" title="Paperwork" items={hire.paperwork} />
        <Checklist p={p} list="credentialing" title="Insurance credentialing" items={hire.credentialing} />
      </div>
    </div>
  );
}

function Checklist({ p, list, title, items }: { p: Person; list: "paperwork" | "credentialing"; title: string; items: ChecklistItem[] }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [rows, setRows] = React.useState<ChecklistItem[]>(items);
  const save = trpc.hiring.saveChecklist.useMutation({ onSuccess: () => { setEditing(false); utils.hiring.people.invalidate(); } });
  const setRow = (i: number, patch: Partial<ChecklistItem>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div className="ld-between" style={{ marginBottom: 6 }}>
        <span className="ld-lbl">{title}</span>
        {editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => { setEditing(false); setRows(items); }}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: p.id, list, items: rows.filter((r) => r.item.trim()) })}>Save</button>
          </span>
        ) : (
          <button type="button" className="ld-btn sm" onClick={() => { setRows(items); setEditing(true); }}>Edit</button>
        )}
      </div>
      {!editing && items.length === 0 && <span className="ld-body ld-muted">Nothing on this list.</span>}
      {!editing &&
        items.map((it, i) => (
          <div key={i} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1.6fr) 90px", gap: 12, padding: "8px 0", borderBottom: "1px solid #eef2f0", fontSize: 14, alignItems: "center" }}>
            <span>{it.item}</span>
            <span className="ld-muted">{it.detail}</span>
            <span className={`ld-pill ${ITEM_PILL[it.status].cls}`}>{ITEM_PILL[it.status].label}</span>
          </div>
        ))}
      {editing && (
        <>
          {rows.map((it, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1.4fr) 110px", gap: 8, padding: "4px 0" }}>
              <input className="ld-in" value={it.item} aria-label="Item" onChange={(e) => setRow(i, { item: e.target.value })} />
              <input className="ld-in" value={it.detail} aria-label="Detail" placeholder="Date or note" onChange={(e) => setRow(i, { detail: e.target.value })} />
              <select className="ld-in" value={it.status} aria-label="Status" onChange={(e) => setRow(i, { status: e.target.value as ChecklistItem["status"] })}>
                {Object.entries(ITEM_PILL).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
          ))}
          <button type="button" className="ld-btn sm" style={{ marginTop: 6 }} onClick={() => setRows((r) => [...r, { item: "", detail: "", status: "to_do" }])}>Add item</button>
          <ErrorLine error={save.error} />
        </>
      )}
    </div>
  );
}

function TeamCard() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const team = trpc.hiring.team.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [reminded, setReminded] = React.useState<number[]>([]);
  const remind = trpc.hiring.remind.useMutation({ onSuccess: (_r, v) => setReminded((x) => [...x, v.id]) });
  const del = trpc.hiring.deleteTeamItem.useMutation({ onSuccess: () => utils.hiring.team.invalidate() });
  const list = team.data ?? [];
  const COLS = "minmax(0,1.2fr) minmax(0,2fr) 110px 128px 128px";
  const pill = (t: TeamItem) => {
    if (t.daysLeft === null) return <span className="ld-pill gray">{t.progress ? "Tracking" : "No date"}</span>;
    if (t.daysLeft < 0) return <span className="ld-pill red">Expired</span>;
    return <span className={`ld-pill ${t.daysLeft <= 30 ? "red" : t.daysLeft <= 90 ? "amber" : "gray"}`}>{`${t.daysLeft} days`}</span>;
  };
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-sh">
        <span className="ld-st">Coming up for the team</span>
        <button type="button" className="ld-btn" onClick={() => { setAdding(true); setEditing(null); }}>Add</button>
      </div>
      {adding && <TeamEditor onDone={() => setAdding(false)} />}
      {list.length === 0 && !adding && <div className="ld-empty">Add licenses, CE hours, supervision hours and certifications to track.</div>}
      {list.map((t) =>
        editing === t.id ? (
          <TeamEditor key={t.id} item={t} onDone={() => setEditing(null)} />
        ) : (
          <div key={t.id} className="ld-rw" style={{ gridTemplateColumns: COLS }}>
            <span className="ld-strong">{t.person}</span>
            <span>
              {t.item}
              {t.due ? ` · ${t.daysLeft !== null && t.daysLeft < 0 ? "expired" : "expires"} ${showDate(t.due)}` : ""}
              {t.progress ? ` · ${t.progress}` : ""}
            </span>
            {pill(t)}
            <button type="button" className="ld-btn" disabled={remind.isPending || reminded.includes(t.id)} onClick={() => remind.mutate({ organizationId: currentOrgId, id: t.id })}>
              {reminded.includes(t.id) ? "Reminded" : "Remind"}
            </button>
            <button type="button" className="ld-btn" onClick={() => { setEditing(t.id); setAdding(false); }}>Edit</button>
          </div>
        )
      )}
      {editing !== null && (
        <div style={{ padding: "0 18px 12px" }}>
          <button type="button" className="ld-btn danger" disabled={del.isPending} onClick={() => { del.mutate({ organizationId: currentOrgId, id: editing }); setEditing(null); }}>Remove</button>
        </div>
      )}
      <div style={{ padding: "0 18px" }}>
        <ErrorLine error={remind.error || del.error} />
      </div>
    </div>
  );
}

function TeamEditor({ item, onDone }: { item?: TeamItem; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [person, setPerson] = React.useState(item?.person ?? "");
  const [what, setWhat] = React.useState(item?.item ?? "");
  const [due, setDue] = React.useState(item?.due ?? "");
  const [prog, setProg] = React.useState(item?.progress ?? "");
  const save = trpc.hiring.saveTeamItem.useMutation({ onSuccess: async () => { await utils.hiring.team.invalidate(); onDone(); } });
  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) 140px minmax(0,1fr) 128px 128px", gap: 10, alignItems: "end", paddingTop: 14 }}>
      <div className="ld-field"><label className="ld-lbl" htmlFor="t-p">Person</label><input id="t-p" className="ld-in" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Name or role" /></div>
      <div className="ld-field"><label className="ld-lbl" htmlFor="t-i">What</label><input id="t-i" className="ld-in" value={what} onChange={(e) => setWhat(e.target.value)} placeholder="LPC license" /></div>
      <div className="ld-field"><label className="ld-lbl" htmlFor="t-d">Due</label><input id="t-d" className="ld-in" value={due} onChange={(e) => setDue(e.target.value)} placeholder="MM/DD/YYYY" inputMode="numeric" /></div>
      <div className="ld-field"><label className="ld-lbl" htmlFor="t-g">Progress</label><input id="t-g" className="ld-in" value={prog} onChange={(e) => setProg(e.target.value)} placeholder="12 of 20 CE hours" /></div>
      <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      <button type="button" className="ld-btn p" disabled={save.isPending || !person.trim() || !what.trim()} onClick={() => save.mutate({ organizationId: currentOrgId, id: item?.id, person, item: what, due, progress: prog })}>Save</button>
      <div style={{ gridColumn: "1 / -1" }}><ErrorLine error={save.error} /></div>
    </div>
  );
}
