/** Display facts about each employee job, shared by every screen. */

export type Kind = "coo" | "projects" | "grants" | "speaking" | "prospecting" | "outreach" | "leads" | "social" | "blog" | "website" | "video" | "inbox" | "hiring" | "developer" | "onboarding" | "platform" | "custom";

export const KIND_META: Record<Kind, { color: string; work: string | null; group: "Leadership" | "Revenue" | "Sales" | "Marketing" | "Operations" | "Other" }> = {
  coo: { color: "#334155", work: "Meetings", group: "Leadership" },
  projects: { color: "#6b4f1d", work: "Projects", group: "Leadership" },
  grants: { color: "#1b6b4a", work: "Opportunities", group: "Revenue" },
  speaking: { color: "#9a4d14", work: "Press", group: "Revenue" },
  prospecting: { color: "#4b3f8f", work: "Prospects", group: "Sales" },
  outreach: { color: "#a1432a", work: "Outreach", group: "Sales" },
  leads: { color: "#1f6f5c", work: "Leads", group: "Sales" },
  social: { color: "#7a3b6e", work: "Posts", group: "Marketing" },
  blog: { color: "#2f5d8a", work: "Articles", group: "Marketing" },
  website: { color: "#4a5a1e", work: "Pages", group: "Marketing" },
  video: { color: "#8a2f3a", work: "Videos", group: "Marketing" },
  inbox: { color: "#3c4a8a", work: "Desk", group: "Operations" },
  hiring: { color: "#0f6e74", work: "Hiring", group: "Operations" },
  developer: { color: "#3b4a6b", work: "Changes", group: "Operations" },
  onboarding: { color: "#7a3e6b", work: null, group: "Operations" },
  platform: { color: "#2f6f8a", work: "Workflows", group: "Operations" },
  custom: { color: "#3d4c45", work: null, group: "Other" },
};

export const KIND_ORDER: Kind[] = ["coo", "projects", "grants", "speaking", "prospecting", "outreach", "leads", "social", "blog", "website", "video", "inbox", "hiring", "onboarding", "developer", "platform", "custom"];
export const GROUP_ORDER = ["Leadership", "Revenue", "Sales", "Marketing", "Operations", "Other"] as const;

/** Portraits live in client/public/avatars/<kind>.webp (256 px, cut from the LeadDash Employees team sheet). */
export const AVATAR_FILES: Partial<Record<Kind, string>> = {
  coo: "/avatars/coo.webp",
  projects: "/avatars/projects.webp",
  grants: "/avatars/grants.webp",
  speaking: "/avatars/speaking.webp",
  prospecting: "/avatars/prospecting.webp",
  outreach: "/avatars/outreach.webp",
  leads: "/avatars/leads.webp",
  social: "/avatars/social.webp",
  blog: "/avatars/blog.webp",
  website: "/avatars/website.webp",
  video: "/avatars/video.webp",
  inbox: "/avatars/inbox.webp",
  hiring: "/avatars/hiring.webp",
  developer: "/avatars/developer.webp",
  onboarding: "/avatars/onboarding.webp",
  platform: "/avatars/platform.webp",
  custom: "/avatars/custom.webp",
};

export const SUGGESTIONS: Record<Kind, string[]> = {
  coo: ["Write Monday's agenda", "What did we decide in my last meeting?", "Skip my next meeting", "How did we do this week?"],
  projects: ["Plan a launch", "What's behind this week?", "Set up a project meeting", "Send me the status report"],
  grants: ["Find grants for this quarter", "Find pitch competitions", "Apply to the best fit", "Check application status"],
  speaking: ["Find speaking events for the spring", "Find media requests I can answer", "Find podcasts to pitch me to", "Check what's waiting on me"],
  prospecting: ["Find practices in a state", "Find practices hiring", "Find referral partners", "What did you find this week?"],
  outreach: ["Start outreach for new prospects", "Who replied this week?", "Ask Malik about demos"],
  leads: ["How many meetings this week?", "Any new leads?", "Ask Jada who replied"],
  social: ["Write a post for this week", "Schedule my drafts", "Plan next month"],
  blog: ["Write an article about intake mistakes", "Suggest five article topics", "Write a how-to article"],
  website: ["Audit my website", "Mock up my website", "Build a landing page", "Change my last page"],
  video: ["Find video ideas for this week", "Find trends for practice owners", "Plan a 30-second video"],
  inbox: ["Paste an email and I'll draft the reply", "Email someone to set a meeting", "Put a meeting on my calendar"],
  hiring: ["Find LPCs for outreach", "Check hiring status", "Write a job post", "What licenses expire soon?"],
  developer: ["Something's broken", "What are you working on?", "What's ready for me to merge?"],
  onboarding: ["Onboard a new customer", "Who's being onboarded?", "What's due this week?"],
  platform: ["Audit my workflows", "Put Jordan's page in a funnel", "What needs fixing?"],
  custom: ["What can you help with?"],
};

export const GUIDELINE_LABELS: Record<Kind, { focus: string; avoid: string; signAs: string }> = {
  coo: { focus: "What every agenda covers", avoid: "Never put on an agenda", signAs: "Sign invites as" },
  projects: { focus: "How you like plans", avoid: "Never schedule", signAs: "Sign reports as" },
  grants: { focus: "Look for", avoid: "Skip", signAs: "Sign proposals as" },
  speaking: { focus: "Talks to pitch", avoid: "Skip", signAs: "Sign pitches as" },
  social: { focus: "Topics", avoid: "Avoid", signAs: "Sign posts as" },
  blog: { focus: "Topics", avoid: "Avoid", signAs: "Author name" },
  website: { focus: "Pages to focus on", avoid: "Avoid", signAs: "Main call to action" },
  video: { focus: "Formats", avoid: "Avoid", signAs: "On-camera name" },
  inbox: { focus: "How to reply", avoid: "Never", signAs: "Sign replies as" },
  hiring: { focus: "Roles to fill", avoid: "Never", signAs: "Sign messages as" },
  developer: { focus: "What to work on", avoid: "Never change", signAs: "Sign changes as" },
  onboarding: { focus: "Every onboarding includes", avoid: "Never promise", signAs: "Sign emails as" },
  platform: { focus: "What to check first", avoid: "Never change", signAs: "Name pages as" },
  prospecting: { focus: "Look for", avoid: "Skip", signAs: "Ideal fit" },
  outreach: { focus: "What to lead with", avoid: "Never say", signAs: "Sign emails as" },
  leads: { focus: "How to reply", avoid: "Never promise", signAs: "Sign replies as" },
  custom: { focus: "Focus on", avoid: "Avoid", signAs: "Sign as" },
};

export const ALWAYS_FOLLOWED: Record<Kind, string[]> = {
  coo: [
    "Invites and recaps wait for your approval unless you set them to go on their own.",
    "Agendas come from what happened this week: Activity, launch reports and the scorecard.",
    "Employees give updates; only people get invites.",
    "No client names or health information in agendas, invites or recaps.",
  ],
  projects: [
    "A new launch plan waits for your approval before anything goes to ClickUp.",
    "Every task has one owner and a due date before its milestone.",
    "KPIs count from what the app already tracks; anything else you enter yourself.",
    "No client names or health information in tasks or reports.",
  ],
  grants: [
    "Every opportunity comes with the host's page.",
    "Nothing is submitted without your Submit tap, which certifies the application.",
    "No invented numbers, awards or credentials. Missing facts become placeholders or a question to you.",
    "When a host restricts AI-written applications, you get an outline and sources to write from.",
    "No client names or health information.",
  ],
  speaking: [
    "Every event and media opportunity comes with its source page.",
    "Nothing is submitted or pitched without your approval.",
    "No invented credentials, talk history or past press.",
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
  developer: [
    "Claude only proposes changes. Nothing joins your code until you press Merge, and nothing goes live until you deploy.",
    "Every change says what was fixed and how to check it.",
    "No client data ever goes into a write-up.",
  ],
  platform: [
    "Audits only read. Nothing in the platform changes until you press Fix or Publish.",
    "The login is locked to one sub-account. Every other sub-account is out of reach.",
    "Pages go in as drafts. Nothing goes live until you press Publish.",
    "Passwords are typed into the page directly and never shown to the AI.",
  ],
  onboarding: [
    "Every email to a customer waits for your approval.",
    "Plans are worked back from the go-live date, and Nora tracks every step.",
    "No client data from a customer's practice goes into a plan or an email.",
  ],
  hiring: [
    "Scores count only your must-haves and nice-to-haves. Protected traits and gaps in work history are never considered.",
    "Outreach uses work facts people published themselves. No home addresses, personal phones or personal accounts.",
    "Quinn never logs into LinkedIn. You send LinkedIn messages from your own account.",
    "Every message to a candidate waits for your approval.",
    "Prospects nobody acted on are deleted after 90 days.",
  ],
  prospecting: [
    "Every prospect comes with the page it was found on.",
    "Contact details only when the business printed them on its own site.",
    "No home addresses, personal phones or personal accounts.",
  ],
  outreach: [
    "Emails send from your Gmail, never from a shared address.",
    "A sequence stops the moment they book or reply.",
    "Three emails at most, then it stops for good.",
  ],
  leads: [
    "Replies only offer times that are open on your calendar.",
    "For a practice, client inquiries always wait for your approval and never ask about symptoms.",
    "No prices or promises the Brain does not state.",
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
export const OPP_TABS: Record<"grants" | "speaking", { key: "grant" | "pitch" | "accelerator" | "speaking" | "bid" | "media"; label: string }[]> = {
  grants: [
    { key: "grant", label: "Grants" },
    { key: "pitch", label: "Pitch competitions" },
    { key: "accelerator", label: "Accelerators" },
    { key: "bid", label: "Bids" },
  ],
  speaking: [
    { key: "speaking", label: "Speaking" },
    { key: "media", label: "Media" },
  ],
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

/** A Claude or ChatGPT export, sent in 40 MB parts so any size gets past the web server's limit. */
export async function uploadHistory(file: File, organizationId: number, onProgress?: (sent: number, total: number) => void) {
  const PART = 40_000_000;
  const total = Math.max(1, Math.ceil(file.size / PART));
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const uploadId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  let data: any = null;
  for (let index = 0; index < total; index++) {
    const offset = index * PART;
    const q = new URLSearchParams({ organizationId: String(organizationId), name: file.name, uploadId, index: String(index), total: String(total), offset: String(offset) });
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`/api/upload/history-part?${q.toString()}`, { method: "POST", body: file.slice(offset, offset + PART), credentials: "include", headers: { "content-type": "application/octet-stream" } }).catch(() => null);
      if (res && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    if (!res) throw new Error("The connection dropped while uploading. Check your internet and try again.");
    data = await res.json().catch(() => ({ error: res!.status === 413 ? "That part is too large for the server." : "Upload failed." }));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    onProgress?.(Math.min(file.size, offset + PART), file.size);
  }
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
