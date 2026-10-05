import React from "react";
import { fmtYmd } from "../goals/shared";
import { Flag } from "./bits";
import { repeatText } from "./TaskModal";
import type { PjCtx } from "../pages/Projects";

/**
 * My work on the phone: today's tasks, what's overdue, and what's next, as
 * simple rows that open the task. Shown in place of the wide views on small
 * screens.
 */
export function MyWorkPhone({ c, show }: { c: PjCtx; show: boolean }) {
  const [tab, setTab] = React.useState<"today" | "overdue" | "next">("today");
  if (!show) return null;
  const open = c.tasks.filter((t) => !t.closed);
  const today = c.data.today;
  const lists = {
    today: open.filter((t) => t.dueDate === today || (!t.dueDate && t.startDate === today)),
    overdue: open.filter((t) => t.dueDate && t.dueDate < today),
    next: open.filter((t) => !t.dueDate || t.dueDate > today).sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999")),
  };
  return (
    <div className="gp-phone-mine">
      <div className="gp-phone-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "today"} className={`gp-fb ${tab === "today" ? "sel" : ""}`} onClick={() => setTab("today")}>Today</button>
        <button type="button" role="tab" aria-selected={tab === "overdue"} className={`gp-fb ${tab === "overdue" ? "sel" : ""}`} onClick={() => setTab("overdue")}>Overdue {lists.overdue.length}</button>
        <button type="button" role="tab" aria-selected={tab === "next"} className={`gp-fb ${tab === "next" ? "sel" : ""}`} onClick={() => setTab("next")}>Next</button>
      </div>
      {lists[tab].map((t) => (
        <button key={t.id} type="button" className="gp-phone-row" onClick={() => c.open(t.id)}>
          <span className="ld-between">
            <b className="gp-ell">{t.name}</b>
            <Flag p={t.priority} />
          </span>
          <span className="ld-small ld-muted gp-ell">
            {t.listName}
            {t.dueDate ? ` · ${fmtYmd(t.dueDate)}` : ""}
            {t.repeat ? ` · ↻ ${repeatText(t.repeat).replace(/^Every /, "").toLowerCase()}` : ""}
            {t.blocked ? " · waiting" : ""}
          </span>
        </button>
      ))}
      {!lists[tab].length && <div className="gp-empty">{tab === "overdue" ? "Nothing overdue." : tab === "today" ? "Nothing due today." : "Nothing coming up."}</div>}
    </div>
  );
}
