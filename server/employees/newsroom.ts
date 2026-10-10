import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, searchJson, type JsonSchema } from "../_core/llm";
import type { AIEmployee, PressContact, PressSettings, PressStory } from "../../drizzle/schema";
import { employeeFor, systemPromptFor, working } from "./tasks";

/**
 * Taylor's newsroom. Each workspace keeps its own Taylor and Brain (a desk);
 * the workspaces the owner links share one newsroom: one record per reporter
 * with article proof, one contact history, one Do not contact list.
 *
 * The rules that make it a PR department rather than a list builder:
 * - Every reporter has articles from the last six months as proof, and an
 *   email only from a public page. Nothing is guessed or invented.
 * - Every story goes to the desk that fits it best; one desk pitches.
 * - A reporter pitched by one desk is left alone by the others for the
 *   cooling period.
 * - Nothing goes out unless the owner approves it, at the level she sets.
 * - Crisis words in a reporter's email stop everything on that desk.
 */

export const RELATIONSHIPS = ["prospect", "contacted", "engaged", "source", "warm", "advocate"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export type Article = { title: string; url: string; date: string; topics: string };
export type Profile = { storyType?: string; sources?: string; launches?: string; strongest?: string; likes?: string };

export const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
export const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: unknown): JsonSchema => ({ type: "array", items });

// ==========================================
// Settings and the shared newsroom
// ==========================================

export function settingsOf(orgId: number): PressSettings {
  return (
    db.press.getSettings(orgId) ?? {
      organizationId: orgId,
      shared: JSON.stringify([orgId]),
      coolingDays: 21,
      level: 1,
      alwaysNeedsYou: "Crisis, regulators, legal, sensitive clinical topics, statements about patients",
      stopWords: "Breach, lawsuit, complaint, investigation, harm, death",
      owns: "",
      beats: "[]",
      paused: false,
      pausedReason: null,
      lastScoutAt: null,
      lastBriefAt: null,
      listGoal: 500,
      lastBuildAt: null,
      buildCursor: 0,
      updatedAt: null,
    }
  );
}

/** The workspaces sharing this desk's newsroom, this one first. */
export function newsroomOrgs(orgId: number): number[] {
  const shared = parse<number[]>(settingsOf(orgId).shared, []).filter((n) => Number.isFinite(n) && n !== orgId);
  return [orgId, ...shared];
}

/** Words from a comma list ("Breach, lawsuit") found in a text. */
export function wordsIn(list: string, text: string) {
  return list
    .split(/[,;\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 2)
    .filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text));
}

/**
 * Saves the press settings. A shared newsroom is the same group for every
 * desk in it, so each linked workspace gets the same list; a workspace taken
 * out goes back to a newsroom of its own. The person must run each workspace.
 */
export async function saveSettings(orgId: number, userId: number, isAdmin: boolean, input: { shared: number[]; coolingDays: number; level: number; alwaysNeedsYou: string; stopWords: string; owns?: string; beats?: string[]; listGoal?: number }) {
  const want = Array.from(new Set([orgId, ...input.shared]));
  for (const id of want) {
    if (isAdmin) continue;
    const m = await db.getOrganizationMembership(id, userId);
    if (!m || (m.role !== "owner" && m.role !== "admin")) throw new TRPCError({ code: "FORBIDDEN", message: "You can only share the newsroom with workspaces you run." });
  }
  const before = newsroomOrgs(orgId);
  for (const id of before) if (!want.includes(id)) db.press.saveSettings(id, { shared: JSON.stringify([id]) });
  for (const id of want) db.press.saveSettings(id, { shared: JSON.stringify(want) });
  return db.press.saveSettings(orgId, {
    coolingDays: Math.max(0, Math.min(120, Math.round(input.coolingDays))),
    level: Math.max(1, Math.min(5, Math.round(input.level))),
    alwaysNeedsYou: input.alwaysNeedsYou.trim().slice(0, 500),
    stopWords: input.stopWords.trim().slice(0, 500),
    ...(input.owns !== undefined ? { owns: input.owns.trim().slice(0, 500) } : {}),
    ...(input.beats ? { beats: JSON.stringify(input.beats.map((b) => b.trim()).filter(Boolean).slice(0, 20)) } : {}),
    ...(input.listGoal ? { listGoal: Math.max(20, Math.min(5000, Math.round(input.listGoal))) } : {}),
  });
}

export function resume(orgId: number) {
  return db.press.saveSettings(orgId, { paused: false, pausedReason: null });
}

type Desk = { id: number; name: string; owns: string; beats: string[] };
export async function desks(orgId: number): Promise<Desk[]> {
  const out: Desk[] = [];
  for (const id of newsroomOrgs(orgId)) {
    const org = await db.getOrganizationById(id);
    if (!org) continue;
    const st = settingsOf(id);
    out.push({ id, name: org.name, owns: st.owns || org.description || org.focusAreas || "", beats: parse<string[]>(st.beats, []) });
  }
  return out;
}

/** A desk's beats and what it owns, written from its Brain the first time it's needed. */
async function ensureDeskProfile(emp: AIEmployee) {
  const st = settingsOf(emp.organizationId);
  if (st.owns && parse<string[]>(st.beats, []).length) return;
  await setDeskProfile(emp, "");
}

/**
 * Writes what this desk owns and the beats its scout watches. The desk speaks
 * for this workspace's own company: its product or service, its market, its
 * founder's story. What the owner says ("tech, women in tech, women founders")
 * leads; the Brain fills in the rest.
 */
export async function setDeskProfile(emp: AIEmployee, said: string) {
  const org = await db.getOrganizationById(emp.organizationId);
  const name = org?.name ?? "this workspace";
  const { system } = await systemPromptFor(
    emp,
    `Your job now: you are the publicist for ${name}. Decide which stories this desk owns and which beats (subjects reporters cover) its scout watches.
- This desk speaks for ${name} itself: what it sells or does, the market it serves, the problem it solves, its news (launches, customers, results, funding, awards), and its founder's story as the founder of ${name}.
- The owner's talks and speaking topics belong to the speaking desk, not here, unless ${name} is the owner's personal brand. Never let a talk you wrote decide this desk's beats.
- Beats are what reporters actually cover, in their words (for example "health tech", "women founders", "small business software"), so the scout finds the reporters who would write about ${name}.${said.trim() ? `
- The owner told you what this desk's media list and pitches should be about. Her words lead; build every beat around them and drop anything that doesn't serve them: ${said.trim().slice(0, 800)}` : ""}`
  );
  const r = await generateJson<{ owns: string; beats: string[] }>({
    system,
    prompt: "Write what this desk owns in one line (the kinds of stories), and 8 to 14 beats, each two to four words, most specific first.",
    schemaName: "desk_profile",
    schema: obj({ owns: str, beats: arr(str) }),
    maxTokens: 1500,
    reason: true,
  });
  const owns = said.trim() ? (r.owns ?? "").slice(0, 500) : settingsOf(emp.organizationId).owns || (r.owns ?? "").slice(0, 500);
  const beats = (r.beats ?? []).map((b) => b.trim()).filter(Boolean).slice(0, 14);
  db.press.saveSettings(emp.organizationId, { owns, beats: JSON.stringify(beats) });
  return { owns, beats };
}

// ==========================================
// Reporters
// ==========================================

export function contactsFor(orgId: number) {
  return db.press.contacts.listIn(newsroomOrgs(orgId));
}

/** A reporter this desk can see (its own, or a linked desk's). */
export function contactFor(orgId: number, id: number) {
  for (const o of newsroomOrgs(orgId)) {
    const c = db.press.contacts.get(id, o);
    if (c) return c;
  }
  return null;
}

export function updateContact(orgId: number, id: number, data: Partial<PressContact>) {
  const c = contactFor(orgId, id);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That reporter isn't in this newsroom." });
  return db.press.contacts.update(id, c.organizationId, data as never)!;
}

export function fitOf(c: Pick<PressContact, "fit">, orgId: number) {
  return Number(parse<Record<string, number>>(c.fit, {})[orgId] ?? 0);
}

const recent = (date: string, days = 183) => {
  const t = Date.parse(date);
  return Number.isFinite(t) && t > Date.now() - days * DAY && t < Date.now() + 2 * DAY;
};

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

type FoundReporter = { name: string; outlet: string; title: string; beats: string[]; location: string; email: string; emailSource: string; authorPage: string; articles: Article[]; why: string; profile: Profile; fit: { deskId: number; score: number }[] };

/** Keeps a reporter only with a real, recent article that came up in the search, and an email only from a public page that did. */
export function provenReporter(r: FoundReporter, sources: { url: string }[]) {
  const hosts = new Set(sources.map((s) => hostOf(s.url)).filter(Boolean));
  const ok = (u: string) => /^https?:\/\//i.test(u) && (hosts.size === 0 || hosts.has(hostOf(u)));
  const articles = (r.articles ?? []).filter((a) => a.title && ok(a.url) && recent(a.date)).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  if (!r.name?.trim() || !articles.length) return null;
  const email = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(r.email ?? "") && ok(r.emailSource ?? "") ? r.email.trim().toLowerCase() : null;
  return { ...r, articles: articles.slice(0, 8), email, emailSource: email ? r.emailSource : null };
}

/** Adds a found reporter or updates the one already on file (a new outlet means they moved). */
export function mergeReporter(orgId: number, r: NonNullable<ReturnType<typeof provenReporter>>, deskIds: number[]) {
  const all = contactsFor(orgId);
  const same = all.find((c) => norm(c.name) === norm(r.name) && (norm(c.outlet) === norm(r.outlet) || !r.outlet));
  // Same name at a new outlet: they moved.
  const moved = !same ? all.find((c) => norm(c.name) === norm(r.name) && r.outlet && norm(c.outlet) !== norm(r.outlet)) : null;
  const fit: Record<string, number> = {};
  for (const f of r.fit ?? []) if (deskIds.includes(f.deskId)) fit[f.deskId] = Math.max(0, Math.min(100, Math.round(f.score)));
  const target = same ?? moved;
  if (target) {
    const old = parse<Article[]>(target.articles, []);
    const articles = [...r.articles, ...old.filter((a) => !r.articles.some((b) => b.url === a.url))].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 10);
    return {
      contact: db.press.contacts.update(target.id, target.organizationId, {
        articles: JSON.stringify(articles),
        fit: JSON.stringify({ ...parse<Record<string, number>>(target.fit, {}), ...fit }),
        why: r.why || target.why,
        profile: JSON.stringify({ ...parse<Profile>(target.profile, {}), ...r.profile }),
        beats: JSON.stringify(Array.from(new Set([...(r.beats ?? []), ...parse<string[]>(target.beats, [])])).slice(0, 10)),
        verifiedAt: new Date(),
        ...(r.email && !target.email ? { email: r.email, emailSource: r.emailSource } : {}),
        ...(moved ? { movedFrom: target.outlet, outlet: r.outlet, title: r.title || target.title, ...(r.email ? { email: r.email, emailSource: r.emailSource } : {}) } : {}),
      })!,
      isNew: false,
      moved: Boolean(moved),
    };
  }
  return {
    contact: db.press.contacts.create({
      organizationId: orgId,
      name: r.name.trim().slice(0, 120),
      outlet: (r.outlet ?? "").slice(0, 160),
      title: (r.title ?? "").slice(0, 160),
      beats: JSON.stringify((r.beats ?? []).slice(0, 10)),
      location: (r.location ?? "").slice(0, 120),
      email: r.email,
      emailSource: r.emailSource,
      authorPage: /^https?:\/\//.test(r.authorPage ?? "") ? r.authorPage : null,
      articles: JSON.stringify(r.articles),
      why: (r.why ?? "").slice(0, 600),
      profile: JSON.stringify(r.profile ?? {}),
      fit: JSON.stringify(fit),
      verifiedAt: new Date(),
    }),
    isNew: true,
    moved: false,
  };
}

/** When this reporter is free to pitch again from this desk, or null now. Do not contact is never free. */
export function coolingFor(orgId: number, c: PressContact, followUp = false): { until: Date | null; reason: string } {
  if (c.doNotContact) return { until: new Date(8.64e15), reason: "Asked not to be contacted" };
  const st = settingsOf(orgId);
  const others = newsroomOrgs(orgId).filter((o) => o !== orgId);
  const since = new Date(Date.now() - st.coolingDays * DAY);
  const sent = db.press.sentTo(c.id, others, since);
  if (sent.length) {
    const last = Math.max(...sent.map((p) => new Date(p.sentAt!).getTime()));
    return { until: new Date(last + st.coolingDays * DAY), reason: `Pitched by another desk ${Math.max(1, Math.round((Date.now() - last) / DAY))} days ago` };
  }
  if (!followUp) {
    const mine = db.press.sentTo(c.id, [orgId], new Date(Date.now() - 7 * DAY));
    if (mine.length) {
      const last = Math.max(...mine.map((p) => new Date(p.sentAt!).getTime()));
      return { until: new Date(last + 7 * DAY), reason: "Pitched by this desk this week" };
    }
  }
  return { until: null, reason: "" };
}

// ==========================================
// The weekly scout
// ==========================================

const SCOUT_JOB = `Your job now: you are the publicist, scouting the news for this newsroom. You think like a journalist before a marketer.
- Find what reporters published in the last 7 to 14 days on these desks' beats, the stories breaking now where the expert in the Brain can add something (new reports and studies, government data, industry news, controversies, source requests, podcasts booking guests, editorial calendars, awards and nomination windows), and articles from the last 30 days that quote or mention the owner or her companies.
- Reporters: only people with a real byline you found, each with 1 to 4 recent articles (title, URL, date as Mon D, YYYY). Never invent a reporter, an article or an email. An email only when it is printed on a public page you found (their author page, the outlet's contact page); give that page as emailSource; otherwise "".
- For each reporter, say in two or three sentences why they matter (what they've written lately and how it connects), how they work (story type, who they quote, whether they cover launches, their strongest angle for us, what they like), and score their fit 0 to 100 for each desk.
- Stories: say which desk it fits best (one desk pitches), which other desks it also fits and why, the window (the last good day to pitch, as Mon D, YYYY, or "Rolling"), a 0 to 100 score, the angle (a story bigger than the company), what we can offer, and the reporters on it by name.
- A story about a crisis, a tragedy or a patient is never an opportunity.
- The Brain may hold the owner's talks, keynote titles and frameworks. Those are speaking material for stages, not this desk's story. This desk's story is what the desk owns (below). Never make a talk or a framework the angle unless the owner said so.`;

const SCOUT_SCHEMA = obj({
  reporters: arr(
    obj({
      name: str,
      outlet: str,
      title: str,
      beats: arr(str),
      location: str,
      email: str,
      emailSource: str,
      authorPage: str,
      articles: arr(obj({ title: str, url: str, date: str, topics: str })),
      why: str,
      profile: obj({ storyType: str, sources: str, launches: str, strongest: str, likes: str }),
      fit: arr(obj({ deskId: int, score: int })),
    })
  ),
  stories: arr(
    obj({
      title: str,
      source: str,
      sourceUrl: str,
      windowEnds: str,
      score: int,
      bestDeskId: int,
      alsoFits: arr(obj({ deskId: int, why: str })),
      angle: str,
      offer: str,
      reporters: arr(str),
    })
  ),
  coverage: arr(obj({ headline: str, outlet: str, url: str, ranOn: str, author: str })),
});

type ScoutResult = { reporters: FoundReporter[]; stories: { title: string; source: string; sourceUrl: string; windowEnds: string; score: number; bestDeskId: number; alsoFits: { deskId: number; why: string }[]; angle: string; offer: string; reporters: string[] }[]; coverage: { headline: string; outlet: string; url: string; ranOn: string; author: string }[] };

const scouting = new Set<number>();
export const isScouting = (orgId: number) => scouting.has(orgId);

/** Finds reporters and stories for every desk in this newsroom; routes each story to its best desk. */
export async function scout(orgId: number, opts: { focus?: string; quiet?: boolean } = {}) {
  if (scouting.has(orgId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Taylor is already scouting." });
  const st = settingsOf(orgId);
  if (st.paused) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This desk is paused: ${st.pausedReason ?? "a crisis question came in"}. Resume it in Press settings first.` });
  const emp = await employeeFor(orgId, "speaking");
  scouting.add(orgId);
  try {
    return await working(emp, async () => {
      await ensureDeskProfile(emp);
      const ds = await desks(orgId);
      const { system, brain } = await systemPromptFor(emp, SCOUT_JOB);
      const known = contactsFor(orgId).slice(0, 150).map((c) => `${c.name} (${c.outlet})`);
      const here = ds.find((d) => d.id === orgId);
      const prompt = `Desks in this newsroom (use these ids):\n${ds.map((d) => `- id ${d.id}: ${d.name}. Owns: ${d.owns || "see the Brain"}. Beats: ${d.beats.join(", ") || "from the Brain"}`).join("\n")}
${here ? `\nThis scout is for the ${here.name} desk (id ${here.id}). Search its beats first: at least two thirds of the reporters and stories must fit it, about ${here.name} itself, not the owner's speaking topics. Other desks only get what you happen across.` : ""}${opts.focus ? `\nFocus this search on: ${opts.focus}` : ""}
Reporters already on file (find new ones; update these only with newer articles): ${known.join("; ") || "none"}
The owner: ${brain.org?.signerName ?? ""}${brain.org?.signerTitle ? `, ${brain.org.signerTitle}` : ""}, ${brain.org?.name ?? ""}.
Return up to 15 reporters, up to 8 stories and any coverage found.`;
      const res = await searchJson<ScoutResult>({ system, prompt, schemaName: "press_scout", schema: SCOUT_SCHEMA, maxUses: 15, maxTokens: 16000 });
      return applyScout(orgId, res.data, res.sources, opts);
    });
  } finally {
    scouting.delete(orgId);
    db.press.saveSettings(orgId, { lastScoutAt: new Date() });
  }
}

/** Saves what the scout found: reporters with proof, stories on their best desk, coverage. */
export async function applyScout(orgId: number, data: ScoutResult, sources: { url: string }[], opts: { quiet?: boolean } = {}) {
  const deskIds = newsroomOrgs(orgId);
  let added = 0;
  let moved = 0;
  const byName = new Map<string, PressContact>();
  for (const raw of data.reporters ?? []) {
    const r = provenReporter(raw, sources);
    if (!r) continue;
    const m = mergeReporter(orgId, r, deskIds);
    if (m.isNew) added++;
    if (m.moved) moved++;
    byName.set(norm(r.name), m.contact);
  }
  const all = contactsFor(orgId);
  const stories: PressStory[] = [];
  for (const s of data.stories ?? []) {
    if (!s.title?.trim()) continue;
    const owner = deskIds.includes(s.bestDeskId) ? s.bestDeskId : orgId;
    if (db.press.stories.list(owner).some((x) => norm(x.title) === norm(s.title))) continue;
    const contacts = (s.reporters ?? []).map((n) => byName.get(norm(n)) ?? all.find((c) => norm(c.name) === norm(n))).filter((c): c is PressContact => Boolean(c));
    const skipped = contacts.map((c) => ({ c, cool: coolingFor(owner, c) })).filter((x) => x.cool.until).map((x) => ({ contactId: x.c.id, reason: x.cool.reason, until: x.cool.until!.toISOString() }));
    stories.push(
      db.press.stories.create({
        organizationId: owner,
        title: s.title.slice(0, 255),
        source: (s.source ?? "").slice(0, 160),
        sourceUrl: /^https?:\/\//.test(s.sourceUrl ?? "") ? s.sourceUrl : null,
        windowEnds: (s.windowEnds ?? "").slice(0, 40),
        score: Math.max(0, Math.min(100, Math.round(s.score || 0))),
        alsoFits: JSON.stringify((s.alsoFits ?? []).filter((a) => deskIds.includes(a.deskId) && a.deskId !== owner)),
        angle: (s.angle ?? "").slice(0, 600),
        offer: (s.offer ?? "").slice(0, 300),
        spokesperson: (await db.getOrganizationById(owner))?.signerName ?? "",
        contactIds: JSON.stringify(contacts.map((c) => c.id)),
        skipped: JSON.stringify(skipped),
      })
    );
  }
  let covered = 0;
  for (const cv of data.coverage ?? []) {
    if (!/^https?:\/\//.test(cv.url ?? "") || !cv.headline) continue;
    if (deskIds.some((o) => db.press.coverage.list(o).some((x) => x.url === cv.url))) continue;
    const author = all.find((c) => norm(c.name) === norm(cv.author));
    db.press.coverage.create({ organizationId: orgId, contactId: author?.id ?? null, headline: cv.headline.slice(0, 255), outlet: (cv.outlet ?? "").slice(0, 160), url: cv.url, ranOn: (cv.ranOn ?? "").slice(0, 40), details: JSON.stringify({ author: cv.author ?? "" }) });
    covered++;
  }
  // A strong story with a short window gets pitches drafted now (rapid response).
  const urgent = stories.filter((s) => s.score >= 85 && windowDays(s.windowEnds) <= 3);
  for (const s of urgent) await (await import("./pitching")).rapidResponse(s).catch((err) => console.warn("[newsroom] rapid response skipped:", err instanceof Error ? err.message : err));
  if (!opts.quiet) {
    const emp = await employeeFor(orgId, "speaking");
    const mine = stories.filter((s) => s.organizationId === orgId);
    await db.createChatMessage({
      organizationId: orgId,
      employeeId: emp.id,
      role: "employee",
      authorName: emp.name,
      content: `Scouting done: ${added} new ${added === 1 ? "reporter" : "reporters"} with proof${moved ? `, ${moved} changed outlets` : ""}, ${stories.length} ${stories.length === 1 ? "story" : "stories"} (${mine.length} for this desk)${covered ? `, and ${covered} new coverage ${covered === 1 ? "mention" : "mentions"}` : ""}. They're on my Newsroom tab.`,
    });
  }
  return { added, moved, stories: stories.length, coverage: covered };
}


// ==========================================
// The media list builder (every day until the goal)
// ==========================================

const LIST_JOB = `Your job now: you are building this desk's media list, one beat at a time. The owner wants a real list: hundreds of reporters who cover the beats this desk pitches, each with proof they cover it and a way to reach them.
- Search the beat you are given: the outlets that cover it (trade press, business press, local press, podcasts and newsletters with named hosts or editors), their author pages, mastheads and recent articles. Vary the searches: outlet names, "<beat> reporter", "<beat> editor", recent headlines on the beat, "<outlet> contact".
- Reporters: only people with a real byline you found, each with 1 to 4 articles from the last six months (title, URL, date as Mon D, YYYY). Never invent a reporter, an article or an email.
- An email only when it is printed on a public page you found (their author page, the outlet's contact or masthead page); give that page as emailSource; otherwise "". Give the author page URL whenever you find one.
- Skip anyone already on file (the list below). Spend the searches on new names.
- For each reporter: beats in their words, location, two or three sentences on why they matter to this desk, how they work (story type, who they quote, whether they cover launches, strongest angle, what they like), and a 0 to 100 fit score for each desk.
- The Brain may hold the owner's talks and frameworks; those are speaking material, not this desk's story. Fit is about what the desk owns.`;

const LIST_SCHEMA = obj({
  reporters: arr(
    obj({
      name: str,
      outlet: str,
      title: str,
      beats: arr(str),
      location: str,
      email: str,
      emailSource: str,
      authorPage: str,
      articles: arr(obj({ title: str, url: str, date: str, topics: str })),
      why: str,
      profile: obj({ storyType: str, sources: str, launches: str, strongest: str, likes: str }),
      fit: arr(obj({ deskId: int, score: int })),
    })
  ),
});

const CONTACT_JOB = `Your job now: find how to reach the reporters below. For each one, look for their author page on the outlet, the outlet's contact, masthead or "tips" page, and their own site. Report an email only when it is printed on a public page you found, with that page as the source; never guess an email or build one from a pattern. Also give the author page URL and the best public way to reach them in one line (the outlet's tips address, a contact form, a newsletter reply address, a public social profile) with the page it came from.`;

const CONTACT_SCHEMA = obj({
  found: arr(obj({ contactId: int, email: str, emailSource: str, authorPage: str, reach: str, reachSource: str })),
});

const building = new Set<number>();
export const isBuilding = (orgId: number) => building.has(orgId);

/** Where the list stands against its goal, for chat, the brief and the Media list tab. */
export function listProgress(orgId: number) {
  const st = settingsOf(orgId);
  const all = contactsFor(orgId);
  const today = new Date().toISOString().slice(0, 10);
  return {
    goal: st.listGoal,
    count: all.length,
    withEmail: all.filter((c) => c.email).length,
    withReach: all.filter((c) => c.email || c.authorPage).length,
    addedToday: all.filter((c) => new Date(c.createdAt).toISOString().slice(0, 10) === today).length,
    lastBuildAt: st.lastBuildAt,
    building: building.has(orgId),
  };
}

/**
 * One pass per beat: the scout searches that beat alone and brings back up to
 * 15 reporters it can prove, skipping the names already on file. Then a contact
 * pass looks up emails and author pages for reporters that have none. Runs
 * every day until the list reaches its goal; the owner can also run it from
 * chat or the Newsroom tab.
 */
export async function buildList(orgId: number, opts: { passes?: number; quiet?: boolean; focus?: string } = {}) {
  if (building.has(orgId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Taylor is already building the media list." });
  const st = settingsOf(orgId);
  if (st.paused) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This desk is paused: ${st.pausedReason ?? "a crisis question came in"}. Resume it in Press settings first.` });
  const emp = await employeeFor(orgId, "speaking");
  building.add(orgId);
  // Marked now, so a pass that fails waits its turn like one that worked instead of retrying every half hour.
  db.press.saveSettings(orgId, { lastBuildAt: new Date() });
  try {
    return await working(emp, async () => {
      await ensureDeskProfile(emp);
      const ds = await desks(orgId);
      const here = ds.find((d) => d.id === orgId) ?? ds[0];
      const beats = opts.focus ? [opts.focus] : parse<string[]>(settingsOf(orgId).beats, []);
      if (!beats.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Tell me what this desk's media list should be about first." });
      const { system, brain } = await systemPromptFor(emp, LIST_JOB);
      const deskIds = newsroomOrgs(orgId);
      const passes = Math.max(1, Math.min(opts.passes ?? 4, beats.length));
      const cursor = opts.focus ? 0 : settingsOf(orgId).buildCursor % beats.length;
      let added = 0;
      let updated = 0;
      const ran: string[] = [];
      for (let i = 0; i < passes; i++) {
        if (contactsFor(orgId).length >= settingsOf(orgId).listGoal && !opts.focus) break;
        const beat = beats[(cursor + i) % beats.length];
        ran.push(beat);
        // Names already on file, the ones on this beat first, so the searches go to new people.
        const onBeat = (c: PressContact) => parse<string[]>(c.beats, []).some((b) => norm(b).includes(norm(beat)) || norm(beat).includes(norm(b)));
        const known = [...contactsFor(orgId)].sort((a, b) => Number(onBeat(b)) - Number(onBeat(a))).slice(0, 400).map((c) => `${c.name} (${c.outlet})`);
        const prompt = `Desks in this newsroom (use these ids for fit):\n${ds.map((d) => `- id ${d.id}: ${d.name}. Owns: ${d.owns || "see the Brain"}.`).join("\n")}
This pass is for the ${here?.name ?? "this"} desk (id ${here?.id ?? orgId}). The beat to search now: ${beat}.
The owner: ${brain.org?.signerName ?? ""}${brain.org?.signerTitle ? `, ${brain.org.signerTitle}` : ""}, ${brain.org?.name ?? ""}.
Already on file, skip these: ${known.join("; ") || "none yet"}
Return up to 15 new reporters you can prove.`;
        try {
          const res = await searchJson<{ reporters: FoundReporter[] }>({ system, prompt, schemaName: "press_list", schema: LIST_SCHEMA, maxUses: 12, maxTokens: 14000 });
          for (const raw of res.data.reporters ?? []) {
            const r = provenReporter(raw, res.sources);
            if (!r) continue;
            const m = mergeReporter(orgId, r, deskIds);
            if (m.isNew) added++;
            else updated++;
          }
        } catch (err) {
          console.warn(`[newsroom] list pass on "${beat}" for ${orgId}:`, err instanceof Error ? err.message : err);
        }
        if (!opts.focus) db.press.saveSettings(orgId, { buildCursor: (cursor + i + 1) % beats.length });
      }
      const contacts = await findContacts(orgId, 12);
      db.press.saveSettings(orgId, { lastBuildAt: new Date() });
      const p = listProgress(orgId);
      if (!opts.quiet) {
        const left = Math.max(0, p.goal - p.count);
        await db.createChatMessage({
          organizationId: orgId,
          employeeId: emp.id,
          role: "employee",
          authorName: emp.name,
          content: `Media list: ${p.count} of ${p.goal} reporters, ${p.withEmail} with an email on file. This pass added ${added} new ${added === 1 ? "reporter" : "reporters"}${updated ? ` and refreshed ${updated}` : ""} on ${ran.join(", ")}${contacts.emails ? `, and found ${contacts.emails === 1 ? "an email" : `${contacts.emails} emails`} for reporters already on file` : ""}. Every one has an article from the last six months as proof.${left ? ` ${left} to go; I keep building every day until the list is full.` : " The list is at its goal; I keep it fresh from here."}`,
          cards: JSON.stringify([{ type: "press_brief", id: Date.now(), title: "Newsroom" }]),
        });
      }
      return { added, updated, emails: contacts.emails, beats: ran, ...p };
    });
  } finally {
    building.delete(orgId);
  }
}

/** Looks up public emails and author pages for reporters that have none, a dozen at a time. */
export async function findContacts(orgId: number, limit = 12) {
  const emp = await employeeFor(orgId, "speaking");
  const missing = contactsFor(orgId)
    .filter((c) => !c.email && !c.doNotContact && !parse<{ reach?: string; reachAt?: string }>(c.profile, {}).reachAt)
    .sort((a, b) => fitOf(b, orgId) - fitOf(a, orgId))
    .slice(0, limit);
  if (!missing.length) return { emails: 0, pages: 0 };
  const { system } = await systemPromptFor(emp, CONTACT_JOB);
  const prompt = `Reporters (use contactId as given):\n${missing.map((c) => `- contactId ${c.id}: ${c.name}, ${c.title || "reporter"} at ${c.outlet}${c.authorPage ? ` (author page: ${c.authorPage})` : ""}`).join("\n")}`;
  let emails = 0;
  let pages = 0;
  try {
    const res = await searchJson<{ found: { contactId: number; email: string; emailSource: string; authorPage: string; reach: string; reachSource: string }[] }>({ system, prompt, schemaName: "press_contacts", schema: CONTACT_SCHEMA, maxUses: Math.min(15, missing.length + 3), maxTokens: 6000 });
    const hosts = new Set(res.sources.map((s) => hostOf(s.url)).filter(Boolean));
    const ok = (u: string) => /^https?:\/\//i.test(u ?? "") && (hosts.size === 0 || hosts.has(hostOf(u)));
    for (const f of res.data.found ?? []) {
      const c = missing.find((m) => m.id === f.contactId);
      if (!c) continue;
      const email = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(f.email ?? "") && ok(f.emailSource) ? f.email.trim().toLowerCase() : null;
      const authorPage = !c.authorPage && ok(f.authorPage) ? f.authorPage : undefined;
      const reach = f.reach && ok(f.reachSource) ? `${f.reach.slice(0, 200)} (${f.reachSource})` : "";
      if (email) emails++;
      if (authorPage) pages++;
      db.press.contacts.update(c.id, c.organizationId, {
        ...(email ? { email, emailSource: f.emailSource } : {}),
        ...(authorPage ? { authorPage } : {}),
        profile: JSON.stringify({ ...parse<Record<string, string>>(c.profile, {}), ...(reach ? { reach } : {}), reachAt: new Date().toISOString() }),
      });
    }
  } catch (err) {
    console.warn(`[newsroom] contact pass for ${orgId}:`, err instanceof Error ? err.message : err);
  }
  return { emails, pages };
}

/** Days until a story's window closes (Rolling counts as far off). */
export function windowDays(windowEnds: string) {
  const t = Date.parse(windowEnds);
  return Number.isFinite(t) ? Math.ceil((t - Date.now()) / DAY) : 999;
}

/** Re-reads a reporter's recent work: new articles, a new outlet, a verified date. */
export async function recheck(orgId: number, contactId: number) {
  const c = contactFor(orgId, contactId);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That reporter isn't in this newsroom." });
  const emp = await employeeFor(orgId, "speaking");
  return working(emp, async () => {
    const { system } = await systemPromptFor(emp, SCOUT_JOB);
    const res = await searchJson<ScoutResult>({
      system,
      prompt: `Check ${c.name}${c.outlet ? ` (last known at ${c.outlet})` : ""}: where they work now, their latest articles (up to 4, with dates), their public email if it's printed on an author or contact page, and their fit for each desk (ids ${newsroomOrgs(orgId).join(", ")}). Return just this one reporter, no stories.`,
      schemaName: "press_scout",
      schema: SCOUT_SCHEMA,
      maxUses: 6,
      maxTokens: 6000,
    });
    const r = (res.data.reporters ?? []).map((x) => provenReporter(x, res.sources)).find((x) => x && norm(x.name) === norm(c.name));
    if (!r) {
      db.press.contacts.update(c.id, c.organizationId, { verifiedAt: new Date(), notes: [c.notes, `No recent byline found on ${fmtDay(new Date())}.`].filter(Boolean).join(" ") });
      return contactFor(orgId, contactId)!;
    }
    return mergeReporter(orgId, r, newsroomOrgs(orgId)).contact;
  });
}

// ==========================================
// Stories
// ==========================================

export function storiesFor(orgId: number) {
  return db.press.stories.list(orgId);
}

export function moveStory(orgId: number, storyId: number, toOrg: number) {
  const s = db.press.stories.get(storyId, orgId);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "That story isn't on this desk." });
  if (!newsroomOrgs(orgId).includes(toOrg) || toOrg === orgId) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick another desk in this newsroom." });
  db.press.stories.update(storyId, orgId, { organizationId: toOrg, alsoFits: JSON.stringify([...parse<{ deskId: number; why: string }[]>(s.alsoFits, []).filter((a) => a.deskId !== toOrg), { deskId: orgId, why: "Moved from this desk" }]) } as never);
  return db.press.stories.get(storyId, toOrg);
}

export function dismissStory(orgId: number, storyId: number) {
  if (!db.press.stories.get(storyId, orgId)) throw new TRPCError({ code: "NOT_FOUND", message: "That story isn't on this desk." });
  return db.press.stories.update(storyId, orgId, { status: "dismissed" });
}

// ==========================================
// Crisis stop
// ==========================================

/** Crisis words in a reporter's email stop all outreach on the desk until the owner resumes it. */
export async function crisisCheck(orgId: number, text: string, who: string) {
  const st = settingsOf(orgId);
  const hit = wordsIn(st.stopWords, text);
  if (!hit.length) return false;
  db.press.saveSettings(orgId, { paused: true, pausedReason: `${who} asked about ${hit.join(", ")}` });
  const emp = await employeeFor(orgId, "speaking");
  await db.createChatMessage({
    organizationId: orgId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content: `I stopped all outreach on this desk. ${who} asked about ${hit.join(", ")}, which is a crisis question, so nothing goes out and I won't reply until you decide. Their email is in Replies. Resume the desk in Press settings when you're ready.`,
  });
  return true;
}

// ==========================================
// The weekly briefing and the scheduler
// ==========================================

export async function briefCounts(orgId: number) {
  const weekAgo = Date.now() - 7 * DAY;
  const out: { orgId: number; name: string; stories: number; newReporters: number; moved: number; ready: number; followUps: number; interviews: number; replies: number }[] = [];
  const contacts = contactsFor(orgId);
  for (const d of await desks(orgId)) {
    const pitches = db.press.pitches.list(d.id);
    out.push({
      orgId: d.id,
      name: d.name,
      stories: db.press.stories.list(d.id).filter((s) => s.status === "open").length,
      newReporters: contacts.filter((c) => new Date(c.createdAt).getTime() > weekAgo && fitOf(c, d.id) >= 60).length,
      moved: contacts.filter((c) => c.movedFrom && c.updatedAt && new Date(c.updatedAt).getTime() > weekAgo).length,
      ready: pitches.filter((p) => p.status === "ready" || p.status === "weak").length,
      followUps: pitches.filter((p) => p.status === "sent" && !p.followUp && p.sentAt && new Date(p.sentAt).getTime() < Date.now() - 5 * DAY).length,
      interviews: db.press.interviews.list(d.id).filter((i) => i.status === "upcoming").length,
      replies: db.press.replies.list(d.id).filter((r) => r.status === "open").length,
    });
  }
  return out;
}

export async function postBrief(orgId: number) {
  const emp = await employeeFor(orgId, "speaking");
  const counts = await briefCounts(orgId);
  const me = counts.find((c) => c.orgId === orgId)!;
  const urgent = db.press.stories.list(orgId).filter((s) => s.status === "open" && windowDays(s.windowEnds) <= 2).length;
  db.press.saveSettings(orgId, { lastBriefAt: new Date() });
  return db.createChatMessage({
    organizationId: orgId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content: `Here's your week from this desk. ${me.ready ? `${me.ready} ${me.ready === 1 ? "pitch is" : "pitches are"} ready for you` : "No pitches are waiting on you"}${urgent ? `, and ${urgent === 1 ? "one story needs" : `${urgent} stories need`} an answer in the next two days` : ""}.`,
    cards: JSON.stringify([{ type: "press_brief", id: Date.now(), title: `Week of ${fmtDay(new Date())}` }]),
  });
}

const localNow = (tz: string, now: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour) % 24, day: `${p.year}-${p.month}-${p.day}` };
};

let lastTick = 0;
/**
 * Every 30 minutes: on Monday mornings each desk scouts (7:00) and posts its
 * briefing (8:00); every day between 7:00 and 7:00 PM the media list builder
 * runs (up to three passes a day, five hours apart) until the list reaches its
 * goal; every day, follow-ups come due and seasonal moments six weeks out are
 * flagged.
 */
export async function newsroomTicks(now = new Date()) {
  if (now.getTime() - lastTick < 30 * 60_000) return;
  lastTick = now.getTime();
  for (const orgId of await db.listAllOrganizationIds()) {
    const st = db.press.getSettings(orgId);
    if (!st) continue; // a desk starts once its press settings exist (Taylor's Press tab or chat)
    const org = await db.getOrganizationById(orgId);
    const tz = org?.timezone || "America/Chicago";
    const t = localNow(tz, now);
    const sameWeek = (d: Date | null) => Boolean(d && now.getTime() - new Date(d).getTime() < 6 * DAY);
    try {
      if (t.weekday === "Mon" && t.hour >= 7 && !st.paused && !sameWeek(st.lastScoutAt) && !scouting.has(orgId)) await scout(orgId, { quiet: true });
      if (t.weekday === "Mon" && t.hour >= 8 && !sameWeek(st.lastBriefAt)) await postBrief(orgId);
      const sinceBuild = st.lastBuildAt ? now.getTime() - new Date(st.lastBuildAt).getTime() : Infinity;
      if (!st.paused && t.hour >= 7 && t.hour < 19 && sinceBuild > 5 * 3_600_000 && !building.has(orgId) && !scouting.has(orgId) && contactsFor(orgId).length < st.listGoal && parse<string[]>(st.beats, []).length) {
        await buildList(orgId, { passes: 4 });
      }
      const pitching = await import("./pitching");
      await pitching.followUpsDue(orgId);
      await (await import("./presslib")).seasonalAlerts(orgId);
    } catch (err) {
      console.warn(`[newsroom] tick for ${orgId}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ==========================================
// Views for the screens and chat
// ==========================================

export function contactView(orgId: number, c: PressContact) {
  const fit = parse<Record<string, number>>(c.fit, {});
  return {
    id: c.id,
    name: c.name,
    outlet: c.outlet,
    title: c.title,
    beats: parse<string[]>(c.beats, []),
    location: c.location,
    email: c.email,
    emailSource: c.emailSource,
    verifiedAt: c.verifiedAt,
    authorPage: c.authorPage,
    articles: parse<Article[]>(c.articles, []),
    why: c.why,
    profile: parse<Profile>(c.profile, {}),
    fit,
    myFit: Number(fit[orgId] ?? 0),
    relationship: c.relationship,
    lastContactAt: c.lastContactAt,
    lastContactOrgId: c.lastContactOrgId,
    lastPitch: c.lastPitch,
    asks: c.asks,
    notes: c.notes,
    doNotContact: c.doNotContact,
    movedFrom: c.movedFrom,
    cooling: (() => {
      const x = coolingFor(orgId, c);
      return x.until && !c.doNotContact ? { until: x.until, reason: x.reason } : null;
    })(),
    interviews: newsroomOrgs(orgId).flatMap((o) => db.press.interviews.list(o)).filter((i) => i.contactId === c.id).length,
    coverage: newsroomOrgs(orgId).flatMap((o) => db.press.coverage.list(o)).filter((x) => x.contactId === c.id).length,
  };
}

export function storyView(orgId: number, s: PressStory) {
  const contacts = parse<number[]>(s.contactIds, []).map((id) => contactFor(orgId, id)).filter((c): c is PressContact => Boolean(c));
  const pitches = db.press.pitches.list(s.organizationId).filter((p) => p.storyId === s.id);
  return {
    id: s.id,
    title: s.title,
    source: s.source,
    sourceUrl: s.sourceUrl,
    windowEnds: s.windowEnds,
    score: s.score,
    alsoFits: parse<{ deskId: number; why: string }[]>(s.alsoFits, []),
    angle: s.angle,
    offer: s.offer,
    spokesperson: s.spokesperson,
    quote: s.quote,
    status: s.status,
    oppId: s.oppId,
    foundAt: s.createdAt,
    reporters: contacts.map((c) => ({ id: c.id, name: c.name, outlet: c.outlet, fit: fitOf(c, orgId) })),
    skipped: parse<{ contactId: number; reason: string; until: string }[]>(s.skipped, []).map((x) => ({ ...x, name: contactFor(orgId, x.contactId)?.name ?? "A reporter" })),
    pitches: pitches.map((p) => ({ id: p.id, contactId: p.contactId, status: p.status, score: p.score })),
  };
}

export async function newsroomView(orgId: number) {
  const ds = await desks(orgId);
  const st = settingsOf(orgId);
  return {
    desk: ds[0] ?? { id: orgId, name: "", owns: "", beats: [] },
    desks: ds.map((d) => ({ id: d.id, name: d.name, owns: d.owns })),
    counts: await briefCounts(orgId),
    stories: storiesFor(orgId)
      .filter((s) => s.status !== "dismissed")
      .sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open") || b.score - a.score)
      .map((s) => storyView(orgId, s)),
    settings: { shared: newsroomOrgs(orgId), coolingDays: st.coolingDays, level: st.level, alwaysNeedsYou: st.alwaysNeedsYou, stopWords: st.stopWords, owns: st.owns, beats: parse<string[]>(st.beats, []), listGoal: st.listGoal, paused: st.paused, pausedReason: st.pausedReason, lastScoutAt: st.lastScoutAt },
    scouting: scouting.has(orgId),
    list: listProgress(orgId),
  };
}

export async function newsroomFacts(orgId: number) {
  const st = settingsOf(orgId);
  const ds = await desks(orgId);
  const counts = await briefCounts(orgId);
  const me = counts.find((c) => c.orgId === orgId);
  const p = listProgress(orgId);
  return `\nNewsroom: this desk is ${ds[0]?.name ?? "this workspace"}${ds.length > 1 ? `, sharing reporters with ${ds.slice(1).map((d) => d.name).join(" and ")}` : ""}. This desk owns: ${st.owns || "(not set yet; ask the owner what the media list should be about)"}. Beats: ${parse<string[]>(st.beats, []).join(", ") || "(none yet)"}. Media list: ${p.count} of ${p.goal} reporters on file, ${p.withEmail} with an email, ${p.addedToday} added today; the list builder runs every day until the goal${p.lastBuildAt ? `, last pass ${fmtDay(new Date(p.lastBuildAt))}` : ""}. The owner's talks, keynote titles and frameworks in the Brain are speaking material for stages; this desk's story, pitches and media list are about what the desk owns, so leave the frameworks out of press work unless the owner asks for them. Open stories: ${me?.stories ?? 0}; pitches waiting for the owner: ${me?.ready ?? 0}; open replies: ${me?.replies ?? 0}; upcoming interviews: ${me?.interviews ?? 0}. Sending level ${st.level} (1 means the owner approves every pitch). Cooling period ${st.coolingDays} days.${st.paused ? ` This desk is PAUSED: ${st.pausedReason}. Send nothing until the owner resumes it.` : ""}`;
}
