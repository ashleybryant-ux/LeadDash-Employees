/**
 * Instantly API v2: the sending engine for Jada's cold email.
 *
 * Instantly holds the warmed inboxes and sends on its schedule. Everything
 * else (the list, scoring, which leads go next, reading and answering
 * replies, the weekly review) happens here. The key is stored encrypted and
 * only ever used on the server.
 *
 * Endpoints used (developer.instantly.ai, API v2):
 * GET  /api/v2/accounts                       inboxes and their status
 * GET  /api/v2/accounts/analytics/daily       sent, bounced and replies per inbox per day
 * POST /api/v2/campaigns                      create a campaign (schedule, 4 steps, inboxes, no tracking)
 * PATCH /api/v2/campaigns/{id}                change inboxes, steps or limits
 * POST /api/v2/campaigns/{id}/activate        start or resume
 * POST /api/v2/campaigns/{id}/pause           pause
 * GET  /api/v2/campaigns/analytics            sent, replies, bounces per campaign
 * POST /api/v2/leads/add                      add up to 1,000 leads to a campaign
 * DELETE /api/v2/leads/{id}                   take a finished lead out (frees the contact slot)
 * POST /api/v2/leads/list                     leads already in the workspace
 * GET  /api/v2/emails?email_type=received     replies
 * POST /api/v2/emails/reply                   answer on the same thread from the same inbox
 * POST /api/v2/block-lists-entries            do not contact, in Instantly too
 */

const BASE = "https://api.instantly.ai/api/v2";

export class InstantlyError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export type IAccount = { email: string; status: number; warmup_status?: number; daily_limit?: number; stat_warmup_score?: number };
export type IDaily = { date: string; email_account: string; sent: number; bounced: number; replies: number; unique_replies?: number };
export type IEmail = {
  id: string;
  thread_id?: string;
  message_id?: string;
  from_address_email: string;
  to_address_email_list?: string;
  eaccount: string;
  subject: string;
  body?: { text?: string; html?: string };
  timestamp_created: string;
  lead?: string;
  campaign_id?: string;
  is_auto_reply?: boolean | number;
  ue_type?: number;
};
export type ICampaignAnalytics = { campaign_id: string; campaign_name?: string; leads_count?: number; contacted_count?: number; emails_sent_count?: number; reply_count?: number; bounced_count?: number; unsubscribed_count?: number; completed_count?: number };
/** delayDays: days to wait after this email before the next one (Instantly's step delay). */
export type IStep = { subject: string; subjectB?: string; body: string; delayDays: number };
export type ILead = { email: string; first_name?: string; last_name?: string; company_name?: string; website?: string; phone?: string; custom_variables?: Record<string, string | number | boolean | null> };

/** Plain text to the simple HTML Instantly sends (line breaks kept). */
export function toHtml(text: string) {
  return text.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");
}

/** Our [first name] and [practice name] placeholders to Instantly's variables. */
export function toVars(text: string) {
  return text.replace(/\[first name\]/gi, "{{firstName}}").replace(/\[last name\]/gi, "{{lastName}}").replace(/\[practice name\]/gi, "{{companyName}}").replace(/\[city\]/gi, "{{city}}");
}

export function client(key: string) {
  async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url.toString(), {
        method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status !== 429) break;
      const wait = Math.min(20, Number(res.headers.get("retry-after") || 5));
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    const text = await res!.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res!.ok) {
      const msg = typeof data === "object" && data && "message" in data ? String((data as { message: unknown }).message) : typeof data === "string" ? data.slice(0, 200) : "";
      if (res!.status === 401) throw new InstantlyError("Instantly didn't accept that API key. Make a new key in Instantly under Settings, Integrations, API keys, with all scopes, and paste it again.", 401);
      if (res!.status === 402) throw new InstantlyError("Instantly says there's no active paid plan on this workspace.", 402);
      throw new InstantlyError(`Instantly answered ${res!.status}${msg ? `: ${msg}` : ""}`, res!.status);
    }
    return data as T;
  }

  return {
    /** Checks the key by listing one inbox. */
    async test() {
      await call("GET", "/accounts", undefined, { limit: 1 });
    },

    async accounts(): Promise<IAccount[]> {
      const out: IAccount[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await call<{ items?: IAccount[]; next_starting_after?: string }>("GET", "/accounts", undefined, { limit: 100, starting_after: after });
        out.push(...(r.items ?? []));
        if (!r.next_starting_after || !(r.items ?? []).length) break;
        after = r.next_starting_after;
      }
      return out;
    },

    async daily(start: string, end: string): Promise<IDaily[]> {
      const r = await call<IDaily[] | { items?: IDaily[] }>("GET", "/accounts/analytics/daily", undefined, { start_date: start, end_date: end });
      return Array.isArray(r) ? r : (r.items ?? []);
    },

    async createCampaign(c: { name: string; tz: string; from: string; to: string; days: number[]; steps: IStep[]; inboxes: string[]; dailyLimit: number }) {
      const days: Record<string, boolean> = {};
      for (let d = 0; d < 7; d++) days[String(d)] = c.days.includes(d);
      const body = {
        name: c.name,
        campaign_schedule: { schedules: [{ name: "Weekdays", timing: { from: c.from, to: c.to }, days, timezone: c.tz }] },
        sequences: [{ steps: stepsBody(c.steps) }],
        email_list: c.inboxes,
        daily_limit: c.dailyLimit,
        stop_on_reply: true,
        stop_on_auto_reply: false,
        open_tracking: false,
        link_tracking: false,
        text_only: true,
        prioritize_new_leads: false,
      };
      return call<{ id: string }>("POST", "/campaigns", body);
    },

    async patchCampaign(id: string, patch: { inboxes?: string[]; steps?: IStep[]; dailyLimit?: number; disableB?: boolean; disableA?: boolean }) {
      const body: Record<string, unknown> = {};
      if (patch.inboxes) body.email_list = patch.inboxes;
      if (patch.dailyLimit) body.daily_limit = patch.dailyLimit;
      if (patch.steps) body.sequences = [{ steps: stepsBody(patch.steps, { disableA: patch.disableA, disableB: patch.disableB }) }];
      return call("PATCH", `/campaigns/${id}`, body);
    },

    activate: (id: string) => call("POST", `/campaigns/${id}/activate`),
    pause: (id: string) => call("POST", `/campaigns/${id}/pause`),

    async campaignAnalytics(): Promise<ICampaignAnalytics[]> {
      const r = await call<ICampaignAnalytics[] | { items?: ICampaignAnalytics[] }>("GET", "/campaigns/analytics", undefined, { exclude_total_leads_count: true });
      return Array.isArray(r) ? r : (r.items ?? []);
    },

    /** Adds leads to a campaign. Instantly skips anyone already in the workspace or on the block list. */
    async addLeads(campaignId: string, leads: ILead[]) {
      return call<{ leads_uploaded?: number; in_blocklist?: number; skipped_count?: number; remaining_in_plan?: number | null; created_leads?: { index: number; id: string; email: string | null }[] }>("POST", "/leads/add", {
        campaign_id: campaignId,
        leads,
        skip_if_in_workspace: true,
      });
    },

    deleteLead: (id: string) => call("DELETE", `/leads/${id}`),

    /** Leads already in the workspace (POST /api/v2/leads/list), up to max. */
    async listLeads(max = 5000) {
      const out: { email: string; first_name?: string; last_name?: string; company_name?: string; website?: string; phone?: string }[] = [];
      let after: string | undefined;
      for (let page = 0; page < Math.ceil(max / 100); page++) {
        const r = await call<{ items?: typeof out; next_starting_after?: string }>("POST", "/leads/list", { limit: 100, ...(after ? { starting_after: after } : {}) });
        out.push(...(r.items ?? []));
        if (!r.next_starting_after || !(r.items ?? []).length) break;
        after = r.next_starting_after;
      }
      return out.slice(0, max);
    },

    /** Replies received since a time, oldest first. */
    async received(since: Date, max = 300): Promise<IEmail[]> {
      const out: IEmail[] = [];
      let after: string | undefined;
      for (let page = 0; page < 6 && out.length < max; page++) {
        const r = await call<{ items?: IEmail[]; next_starting_after?: string }>("GET", "/emails", undefined, { email_type: "received", sort_order: "asc", limit: 100, min_timestamp_created: since.toISOString(), starting_after: after });
        out.push(...(r.items ?? []));
        if (!r.next_starting_after || !(r.items ?? []).length) break;
        after = r.next_starting_after;
      }
      return out;
    },

    async reply(r: { emailId: string; inbox: string; subject: string; text: string }) {
      return call<{ id: string }>("POST", "/emails/reply", { reply_to_uuid: r.emailId, eaccount: r.inbox, subject: r.subject, body: { text: r.text, html: toHtml(r.text) } });
    },

    block: (value: string) => call("POST", "/block-lists-entries", { bl_value: value }),
  };
}

function stepsBody(steps: IStep[], o: { disableA?: boolean; disableB?: boolean } = {}) {
  return steps.map((s, i) => {
    const body = toHtml(toVars(s.body));
    const variants = [{ subject: toVars(s.subject), body, ...(o.disableA && s.subjectB ? { v_disabled: true } : {}) }];
    if (s.subjectB) variants.push({ subject: toVars(s.subjectB), body, ...(o.disableB ? { v_disabled: true } : {}) });
    return { type: "email", delay: i === steps.length - 1 ? 0 : s.delayDays, delay_unit: "days", variants };
  });
}

export type Instantly = ReturnType<typeof client>;
