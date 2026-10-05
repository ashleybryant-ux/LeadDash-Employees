import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtYmd } from "../goals/shared";
import { AddInline, Counts, Flag, People } from "./bits";
import type { PjCtx, TaskRow } from "../pages/Projects";

/** Board view: a column per status; drag a card to another column to change its status. */
export function BoardView({ c }: { c: PjCtx }) {
  const up = trpc.pj.update.useMutation({ onSuccess: () => c.refresh() });
  const [drag, setDrag] = React.useState<number | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const move = (t: TaskRow, status: string) => {
    if (t.status === status) return;
    const list = c.data.lists.find((l) => l.id === t.listId);
    if (list && !list.statuses.some((s) => s.name === status)) return;
    up.mutate({ organizationId: c.orgId, id: t.id, patch: { status } });
  };
  return (
    <div>
      <ErrorLine error={up.error} />
      <div className="gp-board">
        {c.data.statuses.map((s) => {
          const ts = c.tasks.filter((t) => t.status === s.name);
          return (
            <div
              key={s.name}
              className={`gp-col ${over === s.name ? "over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(s.name);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={() => {
                const t = c.tasks.find((x) => x.id === drag);
                setOver(null);
                setDrag(null);
                if (t) move(t, s.name);
              }}
            >
              <div className="ld-between">
                <span className="gp-sgp" style={{ background: s.color }}>{s.name}</span>
                <span className="ld-small ld-muted">{ts.length}</span>
              </div>
              {ts.map((t) => (
                <div
                  key={t.id}
                  className={`gp-kc ${drag === t.id ? "dragging" : ""}`}
                  draggable
                  onDragStart={() => setDrag(t.id)}
                  onDragEnd={() => setDrag(null)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t.name}, ${t.status}`}
                  onClick={() => c.open(t.id)}
                  onKeyDown={(e) => e.key === "Enter" && c.open(t.id)}
                >
                  {t.cover && <img className="cover" src={t.cover} alt="" />}
                  <b>{t.name}</b>
                  {t.goal && <span className="gp-chip gp-ell">◎ {t.goal}</span>}
                  <span className="ld-between">
                    <People c={c} list={t.assignees} />
                    <span className="ld-small" style={!t.closed && t.dueDate && t.dueDate < c.data.today ? { color: "#c2253c", fontWeight: 700 } : { color: "#5b6b64" }}>{t.dueDate ? fmtYmd(t.dueDate) : ""}</span>
                  </span>
                  <span className="ld-between">
                    <Flag p={t.priority} />
                    <Counts t={t} />
                  </span>
                </div>
              ))}
              {c.listId && <AddInline c={c} listId={c.listId} status={s.name} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
