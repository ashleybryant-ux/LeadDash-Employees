/** Display facts about each employee job, shared by every screen. */

export type Kind = "grants" | "speaking" | "social" | "blog" | "website" | "video" | "inbox" | "hiring" | "custom";

export const KIND_META: Record<Kind, { color: string; work: string | null; group: "Revenue" | "Marketing" | "Operations" | "Other" }> = {
  grants: { color: "#1b6b4a", work: "Opportunities", group: "Revenue" },
  speaking: { color: "#9a4d14", work: "Opportunities", group: "Revenue" },
  social: { color: "#7a3b6e", work: "Posts", group: "Marketing" },
  blog: { color: "#2f5d8a", work: "Articles", group: "Marketing" },
  website: { color: "#4a5a1e", work: "Pages", group: "Marketing" },
  video: { color: "#8a2f3a", work: "Videos", group: "Marketing" },
  inbox: { color: "#3c4a8a", work: "Drafts", group: "Operations" },
  hiring: { color: "#0f6e74", work: "Hiring", group: "Operations" },
  custom: { color: "#3d4c45", work: null, group: "Other" },
};

export const KIND_ORDER: Kind[] = ["grants", "speaking", "social", "blog", "website", "video", "inbox", "hiring", "custom"];
export const GROUP_ORDER = ["Revenue", "Marketing", "Operations", "Other"] as const;

/** Portraits live in client/public/avatars/<kind>.webp (256 px, from the Manus originals). */
export const AVATAR_FILES: Partial<Record<Kind, string>> = {
  grants: "/avatars/grants.webp",
  speaking: "/avatars/speaking.webp",
  social: "/avatars/social.webp",
  blog: "/avatars/blog.webp",
  website: "/avatars/website.webp",
  video: "/avatars/video.webp",
  inbox: "/avatars/inbox.webp",
  // Quinn uses the default portrait until one is made to match the set.
  hiring: "/avatars/custom.webp",
  custom: "/avatars/custom.webp",
};

export const SUGGESTIONS: Record<Kind, string[]> = {
  grants: ["Find grants for this quarter", "Find pitch competitions", "Apply to the best fit", "Check application status"],
  speaking: ["Find speaking events for the spring", "Find paid speaking events", "Apply to the best fit", "Check application status"],
  social: ["Write a LinkedIn post about our first year", "Write a post for this week", "Ideas for next week's posts"],
  blog: ["Write an article about intake mistakes", "Suggest five article topics", "Write a how-to article"],
  website: ["Plan a couples counseling page", "Plan a new home page", "Plan a careers page"],
  video: ["Find video ideas for this week", "Find trends for practice owners", "Plan a 30-second video"],
  inbox: ["Paste an email and I'll draft the reply", "Email someone to set a meeting", "Put a meeting on my calendar"],
  hiring: ["Find LPCs for outreach", "Check hiring status", "Write a job post", "What licenses expire soon?"],
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
  hiring: { focus: "Roles to fill", avoid: "Never", signAs: "Sign messages as" },
  custom: { focus: "Focus on", avoid: "Avoid", signAs: "Sign as" },
};

export const ALWAYS_FOLLOWED: Record<Kind, string[]> = {
  grants: [
    "Every opportunity comes with the host's page.",
    "Nothing is submitted without your Submit tap, which certifies the application.",
    "No invented numbers, awards or credentials. Missing facts become placeholders or a question to you.",
    "When a host restricts AI-written applications, you get an outline and sources to write from.",
    "No client names or health information.",
  ],
  speaking: [
    "Every event comes with its call-for-proposals page.",
    "Nothing is submitted without your Submit tap.",
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
  hiring: [
    "Scores count only your must-haves and nice-to-haves. Protected traits and gaps in work history are never considered.",
    "Outreach uses work facts people published themselves. No home addresses, personal phones or personal accounts.",
    "Quinn never logs into LinkedIn. You send LinkedIn messages from your own account.",
    "Every message to a candidate waits for your approval.",
    "Prospects nobody acted on are deleted after 90 days.",
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

/** What each employee's opportunity tabs are called. */
export const OPP_TABS: Record<"grants" | "speaking", { key: "grant" | "pitch" | "accelerator" | "speaking"; label: string }[]> = {
  grants: [
    { key: "grant", label: "Grants" },
    { key: "pitch", label: "Pitch competitions" },
    { key: "accelerator", label: "Accelerators" },
  ],
  speaking: [{ key: "speaking", label: "Speaking" }],
};

export const APP_STATUS: Record<string, { label: string; cls: "green" | "amber" | "gray" | "red" }> = {
  writing: { label: "Writing", cls: "gray" },
  needs_answer: { label: "Needs an answer", cls: "amber" },
  ready: { label: "Waiting for you", cls: "amber" },
  approved: { label: "Approved to send", cls: "green" },
  submitted: { label: "Submitted", cls: "green" },
  awarded: { label: "Awarded", cls: "green" },
  declined: { label: "Declined", cls: "gray" },
  needs_setup: { label: "Needs Grants.gov", cls: "amber" },
  error: { label: "Needs attention", cls: "red" },
};

export const CHANNEL_LABEL: Record<string, string> = {
  form: "Host's online form",
  email: "Email",
  grants_gov: "Grants.gov",
  submittable: "Submittable",
  sessionize: "Sessionize",
  portal: "Host's portal",
};

/** Upload a file as the raw request body. Returns the JSON reply or throws its error. */
export async function uploadFile(slot: string, file: File, params: Record<string, string | number>) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  q.set("name", file.name);
  const res = await fetch(`/api/upload/${slot}?${q.toString()}`, {
    method: "POST",
    body: file,
    credentials: "include",
    headers: { "content-type": file.type || "application/octet-stream" },
  });
  const data = await res.json().catch(() => ({ error: res.status === 413 ? "That file is too large for the server." : "Upload failed." }));
  if (!res.ok) throw new Error(data.error || "Upload failed.");
  return data;
}

/** Opens a generated download in a new tab. */
export function openDownload(r: { url: string; name: string }) {
  const a = document.createElement("a");
  a.href = r.url;
  a.download = r.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
