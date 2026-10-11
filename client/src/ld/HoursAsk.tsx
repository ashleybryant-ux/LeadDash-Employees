import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";

/**
 * Asking before a job of 3 work hours or more, from a button. On a plan, the
 * button opens a short question in place ("A full grant application uses 8
 * work hours. You have 82 hr left.") with Go ahead and Not now. Without a plan,
 * the job just starts.
 */

export const BIG_JOB = {
  grant: "A full grant application uses 8 work hours",
  application: "A full application uses 3 work hours",
  video: "A talking video uses 8 work hours for each minute (16 in Pro quality)",
  audit: "Reading your workflows uses 1 work hour for each one Zara opens",
};

const left = (minutes: number | null | undefined) => {
  const h = Math.max(0, minutes ?? 0) / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hr`;
};

export function useHoursAsk() {
  const { currentOrgId } = useTenant();
  const q = trpc.hours.get.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, staleTime: 30_000 });
  const [ask, setAsk] = React.useState<null | { key: string; what: string; run: () => void }>(null);
  const confirm = (key: string, what: string, run: () => void) => {
    if (!q.data?.metered) return run();
    setAsk({ key, what, run });
  };
  /** The question, shown where the caller puts it, for the button with this key. */
  const question = (key: string) =>
    ask && ask.key === key ? (
      <div className="ld-hours-ask" role="group" aria-label="Before this starts">
        <span>
          {ask.what}. You have {left(q.data?.leftMinutes)} left.
        </span>
        <span className="ld-row" style={{ gap: 8 }}>
          <button
            type="button"
            className="ld-btn p"
            style={{ width: 110 }}
            onClick={() => {
              const run = ask.run;
              setAsk(null);
              run();
            }}
          >
            Go ahead
          </button>
          <button type="button" className="ld-btn" style={{ width: 110 }} onClick={() => setAsk(null)}>
            Not now
          </button>
        </span>
      </div>
    ) : null;
  return { confirm, question, asking: (key: string) => ask?.key === key };
}
