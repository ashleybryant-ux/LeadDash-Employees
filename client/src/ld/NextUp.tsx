import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";

/**
 * Next up: a slim bar across the top of every page with the next appointment
 * on the workspace's calendars and a live countdown ("in 24 min", then
 * "24 min left" while it runs). Join on Zoom or Meet when the event has a
 * link. Shown only when a calendar is connected.
 */

const SHORT: Record<string, string> = { zoom: "Zoom", meet: "Meet", teams: "Teams" };
const timeText = (at: Date | string, tz: string) => new Date(at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const ymdIn = (at: Date | string, tz: string) => {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
};
const dayText = (at: Date | string, tz: string) => new Date(at).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });

export function NextUpBar() {
  const { currentOrgId } = useTenant();
  const q = trpc.calendar.nextUp.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 60_000, staleTime: 30_000 });
  const start = trpc.calendar.start.useMutation();
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const show = !!q.data?.connected;
  React.useEffect(() => {
    document.documentElement.classList.toggle("ld-next", show);
    return () => document.documentElement.classList.remove("ld-next");
  }, [show]);
  if (!show) return null;
  const it = q.data!.item;
  const tz = q.data!.tz;
  if (!it) {
    return (
      <div className="ld-nextbar" role="status">
        <span className="ld-nextbar-k">Next up</span>
        <span className="ld-nextbar-t">Nothing scheduled in the next 7 days</span>
        <span className="ld-nextbar-sp" />
        <Link href="/calendar" className="ld-nextbar-b">Open calendar</Link>
      </div>
    );
  }
  const s = new Date(it.start).getTime();
  const e = new Date(it.end).getTime();
  const live = now >= s && now < e;
  const mins = live ? Math.max(1, Math.ceil((e - now) / 60_000)) : Math.max(1, Math.round((s - now) / 60_000));
  const today = ymdIn(it.start, tz) === ymdIn(new Date(now), tz);
  const when = `${today ? "" : `${dayText(it.start, tz)}, `}${timeText(it.start, tz)} to ${timeText(it.end, tz)}`;
  const count = live ? `${mins} min left` : mins < 60 ? `in ${mins} min` : mins < 24 * 60 ? `in ${Math.round(mins / 60)} h` : `in ${Math.round(mins / 1440)} d`;
  const join = () => {
    if (!it.meeting) return;
    const w = window.open("about:blank", "_blank");
    start.mutate(
      { organizationId: currentOrgId, url: it.meeting.url },
      {
        onSuccess: (r) => {
          const url = r.url ?? it.meeting!.url;
          if (w) w.location.href = url;
          else window.location.href = url;
        },
        onError: () => {
          if (w) w.location.href = it.meeting!.url;
        },
      }
    );
  };
  return (
    <div className="ld-nextbar" role="status">
      <span className="ld-nextbar-k">{live ? "Now" : "Next up"}</span>
      <span className="ld-nextbar-t" title={`${it.title} · ${when}`}>{it.title} · {when}</span>
      <span className={`ld-nextbar-c ${live ? "live" : ""}`}>{count}</span>
      <span className="ld-nextbar-sp" />
      <Link href="/calendar" className="ld-nextbar-b">Open calendar</Link>
      {it.meeting && (
        <button type="button" className="ld-nextbar-b p" onClick={join}>
          {it.meeting.platform === "zoom" && it.host ? "Start on Zoom" : `Join on ${SHORT[it.meeting.platform] ?? "the call"}`}
        </button>
      )}
    </div>
  );
}
