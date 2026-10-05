import React from "react";
import { trpc } from "@/lib/trpc";

/** My running timer, wherever I am in Projects: the time, the task, and Stop. */
export function RunningTimer({ orgId, onOpen }: { orgId: number; onOpen: (id: number) => void }) {
  const utils = trpc.useUtils();
  const me = trpc.pj.me.useQuery({ organizationId: orgId }, { refetchInterval: 60_000 });
  const stop = trpc.pj.stopTimer.useMutation({ onSuccess: () => Promise.all([utils.pj.me.invalidate(), utils.pj.task.invalidate(), utils.pj.view.invalidate()]) });
  const r = me.data?.running;
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!r) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [r]);
  if (!r) return null;
  const s = Math.max(0, Math.floor((Date.now() - new Date(r.startedAt ?? Date.now()).getTime()) / 1000));
  const text = `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return (
    <span className="gp-run">
      <button type="button" className="gp-stop sm" aria-label="Stop my timer" disabled={stop.isPending} onClick={() => stop.mutate({ organizationId: orgId })} />
      <b>{text}</b>
      <button type="button" className="gp-link gp-ell" style={{ maxWidth: 160 }} onClick={() => onOpen(r.taskId)}>{r.taskName}</button>
    </span>
  );
}
