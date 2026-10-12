import React from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";

/**
 * Taking someone off the team, from their chat header. Vacation (onboarded
 * employees, at least 30 days, back on the date picked) or Terminate (asks
 * first whether vacation would do; rehirable in 90 days). Both store
 * everything and free a spot on the team. Opens below the header.
 */

export type LeaveMode = "vacation" | "terminate";
type Emp = { id: number; name: string; kind: string; interview?: string | null };

/** "Nov 11, 2026" from YYYY-MM-DD. */
export const dayText = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** True once the employee finished onboarding. */
export function onboarded(emp: { interview?: string | null }) {
  try {
    return !!JSON.parse(emp.interview || "{}").done;
  } catch {
    return false;
  }
}

export const BEACH = "/brand/beach.webp";

/** Personnel decisions about the AI employees (interview, bring on, vacation, terminate) are for owners and admins. */
export function useCanManage() {
  const { currentOrg } = useTenant();
  const r = currentOrg?.role;
  return !r || r === "owner" || r === "admin";
}

export function LeaveBox({ emp, mode, setMode, onClose }: { emp: Emp; mode: LeaveMode; setMode: (m: LeaveMode) => void; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const v = trpc.bench.view.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const today = v.data?.today ?? new Date().toISOString().slice(0, 10);
  const earliest = addDays(today, v.data?.vacationMinDays ?? 30);
  const [back, setBack] = React.useState("");
  const [reason, setReason] = React.useState("");
  const done = async () => {
    await Promise.all([utils.employees.list.invalidate(), utils.bench.view.invalidate()]);
    navigate("/bench");
  };
  const vacation = trpc.bench.vacation.useMutation({ onSuccess: done });
  const terminate = trpc.bench.terminate.useMutation({ onSuccess: done });
  const ready = onboarded(emp);
  const base = emp.kind === "custom" ? `/chats/e/${emp.id}` : `/chats/${emp.kind}`;
  const rehirable = addDays(today, v.data?.terminateDays ?? 90);

  if (mode === "vacation" && !ready) {
    return (
      <div className="ld-leave">
        <div className="ld-leave-warn">
          <div>
            <b>{`${emp.name} can go on vacation after onboarding.`}</b>
            <p>{`Finish onboarding first. If ${emp.name} isn't working out, use Terminate.`}</p>
          </div>
          <div className="ld-leave-btns">
            <Link href={`${base}/onboarding`} className="ld-btn p">Open onboarding</Link>
            <button type="button" className="ld-btn" onClick={onClose}>OK</button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "vacation") {
    const date = back || earliest;
    return (
      <div className="ld-leave">
        <div className="ld-leave-beach" style={{ backgroundImage: `linear-gradient(90deg, rgba(3, 28, 46, .86) 0%, rgba(3, 28, 46, .62) 55%, rgba(3, 28, 46, .2) 100%), url(${BEACH})` }}>
          <div>
            <b className="t"><span aria-hidden="true">🏖️</span>{` Send ${emp.name} on vacation?`}</b>
            <ul>
              <li>{`${emp.name} leaves Chats and stops all scheduled work, so no work hours are used.`}</li>
              <li>{`${emp.name} doesn't count toward your team, so you can bring on someone else.`}</li>
              <li>Onboarding, Guidelines and the chat history stay as they are.</li>
              <li>{`${emp.name} comes back on the return date and says hello in the chat.`}</li>
            </ul>
            <div className="ld-leave-field">
              <label htmlFor="vac-back">Back on</label>
              <input id="vac-back" type="date" className="ld-in" min={earliest} value={date} onChange={(e) => setBack(e.target.value)} />
              <small>{`Earliest ${dayText(earliest)} (${v.data?.vacationMinDays ?? 30} days)`}</small>
            </div>
            <ErrorLine error={vacation.error} />
          </div>
          <div className="ld-leave-btns col">
            <button type="button" className="ld-btn gold" disabled={vacation.isPending || date < earliest} onClick={() => vacation.mutate({ organizationId: currentOrgId, employeeId: emp.id, back: date })}>
              <span aria-hidden="true">🏖️</span>{vacation.isPending ? "Sending..." : "Send on vacation"}
            </button>
            <button type="button" className="ld-btn light" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ld-leave">
      <div className="ld-leave-ask">{`Would you rather terminate ${emp.name}, or send ${emp.name} on vacation?`}</div>
      <div className="ld-leave-choice">
        <div className="ld-leave-beach" style={{ backgroundImage: `linear-gradient(90deg, rgba(3, 28, 46, .86) 0%, rgba(3, 28, 46, .55) 70%, rgba(3, 28, 46, .3) 100%), url(${BEACH})` }}>
          <div>
            <b className="t"><span aria-hidden="true">🏖️</span> Send on vacation</b>
            <p>{ready ? `${emp.name} comes back on the date you pick, ${v.data?.vacationMinDays ?? 30} days at the earliest, with everything ${emp.name} knows.` : `${emp.name} can go on vacation after onboarding.`}</p>
          </div>
          <div className="ld-leave-btns">
            <button type="button" className="ld-btn gold" disabled={!ready} onClick={() => setMode("vacation")}><span aria-hidden="true">🏖️</span>Pick a return date</button>
          </div>
        </div>
        <div className="ld-leave-term">
          <div>
            <b className="t">{`Terminate ${emp.name}`}</b>
            <p>{`${emp.name}'s chat, Guidelines and files are stored, not deleted. ${emp.name} will be rehirable on ${dayText(rehirable)} (${v.data?.terminateDays ?? 90} days) and waits in Terminated on the bench until then.`}</p>
            <span className="ld-leave-lbl">Why</span>
            <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
              {(v.data?.reasons ?? []).map((r) => (
                <button key={r} type="button" className={`ld-chip ${reason === r ? "on" : ""}`} aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>
              ))}
            </div>
            <ErrorLine error={terminate.error} />
          </div>
          <div className="ld-leave-btns">
            <button type="button" className="ld-btn danger fill" disabled={terminate.isPending} onClick={() => terminate.mutate({ organizationId: currentOrgId, employeeId: emp.id, reason })}>
              {terminate.isPending ? "Terminating..." : `Terminate ${emp.name}`}
            </button>
          </div>
        </div>
      </div>
      <div style={{ padding: "0 0 4px" }}><button type="button" className="ld-btn" onClick={onClose}>Cancel</button></div>
    </div>
  );
}
