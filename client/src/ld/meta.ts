/** Display facts about each employee job, shared by every screen. */

export type Kind = "grants" | "speaking" | "social" | "blog" | "website" | "video" | "inbox" | "custom";

export const KIND_META: Record<Kind, { color: string; work: string | null; group: "Revenue" | "Marketing" | "Operations" | "Other" }> = {
  grants: { color: "#1b6b4a", work: "Opportunities", group: "Revenue" },
  speaking: { color: "#9a4d14", work: "Pitches", group: "Revenue" },
  social: { color: "#7a3b6e", work: "Posts", group: "Marketing" },
  blog: { color: "#2f5d8a", work: "Articles", group: "Marketing" },
  website: { color: "#4a5a1e", work: "Pages", group: "Marketing" },
  video: { color: "#8a2f3a", work: "Videos", group: "Marketing" },
  inbox: { color: "#3c4a8a", work: "Drafts", group: "Operations" },
  custom: { color: "#3d4c45", work: null, group: "Other" },
};

export const KIND_ORDER: Kind[] = ["grants", "speaking", "social", "blog", "website", "video", "inbox", "custom"];
export const GROUP_ORDER = ["Revenue", "Marketing", "Operations", "Other"] as const;

/** Portrait files, once provided, live in client/public/avatars/<kind>.png. */
export const AVATAR_FILES: Partial<Record<Kind, string>> = {};

export const SUGGESTIONS: Record<Kind, string[]> = {
  grants: ["Find grants for this quarter", "What deadlines are coming up?", "Find grants for clinician hiring"],
  speaking: ["Find speaking events for the spring", "Find paid speaking events", "Which pitches are still open?"],
  social: ["Write a LinkedIn post about our first year", "Write a post for this week", "Ideas for next week's posts"],
  blog: ["Write an article about intake mistakes", "Suggest five article topics", "Write a how-to article"],
  website: ["Plan a couples counseling page", "Plan a new home page", "Plan a careers page"],
  video: ["Find video ideas for this week", "Find trends for practice owners", "Plan a 30-second video"],
  inbox: ["Paste an email and I'll draft the reply", "How should I answer a fee question?", "Draft a follow-up"],
  custom: ["What can you help with?"],
};

export const GUIDELINE_LABELS: Record<Kind, { focus: string; avoid: string; signAs: string }> = {
  grants: { focus: "Look for", avoid: "Skip", signAs: "Sign proposals as" },
  speaking: { focus: "Talks to pitch", avoid: "Skip", signAs: "Sign pitches as" },
  social: { focus: "Topics", avoid: "Avoid", signAs: "Sign posts as" },
  blog: { focus: "Topics", avoid: "Avoid", signAs: "Author name" },
  website: { focus: "Pages to focus on", avoid: "Avoid", signAs: "Main call to action" },
  video: { focus: "Formats", avoid: "Avoid", signAs: "On-camera name" },
  inbox: { focus: "How to reply", avoid: "Never", signAs: "Sign replies as" },
  custom: { focus: "Focus on", avoid: "Avoid", signAs: "Sign as" },
};

export const ALWAYS_FOLLOWED: Record<Kind, string[]> = {
  grants: [
    "Every grant comes with the funder's page.",
    "Nothing is submitted or sent without your approval.",
    "No invented numbers, awards or credentials. Missing facts become placeholders.",
    "No client names or health information.",
  ],
  speaking: [
    "Every event comes with its call-for-proposals page.",
    "Pitches wait for your approval before anyone sends them.",
    "No invented credentials or talk history.",
  ],
  social: [
    "Posts wait for your approval before anything is posted.",
    "No em dashes, no hype, no invented statistics.",
    "No client names or health information.",
  ],
  blog: [
    "Articles wait for your approval before going to WordPress.",
    "No made-up studies or numbers.",
    "No client names or health information.",
  ],
  website: ["Copy uses the facts in your Brain. Missing facts become placeholders.", "No invented reviews or credentials."],
  video: ["Every trend comes with the page it was found on.", "Plans only. Nothing is posted for you."],
  inbox: [
    "Replies wait for your approval before anything is sent.",
    "Clients are referred to by initials only.",
    "Decisions that belong to you become placeholders.",
  ],
  custom: ["Nothing is sent without your approval."],
};

const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** "Oct 1, 2026". Dates always include the year. */
export function fmtDate(d: Date | string | number | null | undefined) {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? "" : DATE_FMT.format(date);
}

export function fmtTime(d: Date | string | number) {
  return TIME_FMT.format(d instanceof Date ? d : new Date(d));
}

export function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "7:39 PM" for today, "Sep 30, 2026" otherwise. */
export function fmtWhen(d: Date | string | number | null | undefined) {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  return isSameDay(date, new Date()) ? fmtTime(date) : fmtDate(date);
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
