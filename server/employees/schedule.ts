import type { Repeat } from "../../drizzle/schema";

/**
 * Time-zone math for scheduled tasks, with no extra libraries. A task stores a
 * local time ("08:00") in the workspace's time zone; these helpers turn that
 * into the next real moment it should run, handling daylight saving changes.
 */

type Parts = { y: number; m: number; d: number; h: number; mi: number; wd: number };

function partsIn(date: Date, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd };
}

/** Offset of tz from UTC at the given instant, in milliseconds. */
function offsetMs(date: Date, tz: string) {
  const p = partsIn(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  return asUtc - Math.floor(date.getTime() / 60000) * 60000;
}

/** The UTC instant for a wall-clock time in tz. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let result = guess - offsetMs(new Date(guess), tz);
  // Re-check once in case the guess and the result fall on different sides of a DST change.
  result = guess - offsetMs(new Date(result), tz);
  return new Date(result);
}

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type ScheduleRule = {
  repeat: Repeat;
  time: string; // "HH:MM"
  weekday?: number | null; // 0-6
  monthDay?: number | null; // 1-28
  onDate?: string | null; // "YYYY-MM-DD" for once
};

/** The next time the rule fires strictly after `after`, or null if it never will again. */
export function nextRun(rule: ScheduleRule, tz: string, after: Date = new Date()): Date | null {
  const [hh, mm] = rule.time.split(":").map((n) => parseInt(n, 10));
  if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) return null;

  if (rule.repeat === "once") {
    if (!rule.onDate || !/^\d{4}-\d{2}-\d{2}$/.test(rule.onDate)) return null;
    const [y, m, d] = rule.onDate.split("-").map(Number);
    const at = zonedToUtc(y, m, d, hh, mm, tz);
    return at > after ? at : null;
  }

  const start = partsIn(after, tz);
  // Walk forward day by day (local calendar) until a day matches and its time is in the future.
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i, 12));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const wd = day.getUTCDay();
    const matches =
      rule.repeat === "daily" ||
      (rule.repeat === "weekdays" && wd >= 1 && wd <= 5) ||
      (rule.repeat === "weekly" && wd === (rule.weekday ?? 1)) ||
      (rule.repeat === "monthly" && d === (rule.monthDay ?? 1));
    if (!matches) continue;
    const at = zonedToUtc(y, m, d, hh, mm, tz);
    if (at > after) return at;
  }
  return null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatTime12(time: string) {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Every Monday, 8:00 AM", for the Tasks list. */
export function describeRule(rule: ScheduleRule) {
  const t = formatTime12(rule.time);
  switch (rule.repeat) {
    case "daily":
      return `Every day, ${t}`;
    case "weekdays":
      return `Every weekday, ${t}`;
    case "weekly":
      return `Every ${WEEKDAYS[rule.weekday ?? 1]}, ${t}`;
    case "monthly": {
      const n = rule.monthDay ?? 1;
      const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
      return `${n}${suffix} of the month, ${t}`;
    }
    case "once":
      return `Once, ${t}`;
  }
}
