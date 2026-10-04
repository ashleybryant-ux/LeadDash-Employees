/**
 * Public sales pages for each workspace, reached by its private token:
 * - /f/:token          the lead form (new leads go to Malik)
 * - /hooks/leads/:token where a LeadDash platform workflow sends new contacts
 * - /book/:token       the booking page linked from Jada's and Malik's emails
 */
import type { Express, Request, Response } from "express";
import * as db from "./db";
import { book, newLead, openTimes, readSales, whenText } from "./employees/sales";
import { partsIn } from "./employees/schedule";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// A few submissions per visitor per hour keeps bots from filling Malik's list.
const hits = new Map<string, number[]>();
function limited(req: Request, max = 12) {
  const key = `${req.ip}|${req.path}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

const CSS = `*{box-sizing:border-box}body{margin:0;background:#F8FAFB;font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;color:#14221c}
.wrap{max-width:640px;margin:0 auto;padding:40px 20px 56px}.card{background:#fff;border:1px solid #e3e9e6;border-radius:14px;padding:24px}
h1{font-size:26px;margin:0 0 6px;font-weight:800}p{font-size:15px;line-height:1.6;color:#3d4c45;margin:0 0 14px}
label{display:block;font-size:12px;font-weight:700;color:#5b6b64;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px}
input,textarea{width:100%;border:1px solid #cfd9d4;border-radius:8px;padding:10px 12px;font:inherit;font-size:16px;background:#fff;color:#14221c}
textarea{min-height:110px;resize:vertical}button{height:44px;padding:0 22px;border-radius:10px;border:0;background:#1b6b4a;color:#fff;font:inherit;font-weight:700;font-size:15px;cursor:pointer;margin-top:18px}
.day{font-weight:800;font-size:14px;margin:18px 0 8px}.slots{display:flex;flex-wrap:wrap;gap:8px}
.slot{position:relative}.slot input{position:absolute;opacity:0;width:1px;height:1px}.slot span{display:inline-flex;height:38px;padding:0 14px;align-items:center;border:1px solid #cfd9d4;border-radius:9px;font-weight:700;font-size:14px;cursor:pointer;background:#fff}
.slot input:checked+span{background:#e6f2ec;border-color:#1b6b4a;color:#155c3e}.slot input:focus-visible+span{outline:2px solid #1b6b4a;outline-offset:2px}
.err{color:#b42318;font-weight:600;font-size:14px}.muted{color:#5b6b64;font-size:13px}.hp{position:absolute;left:-9999px}`;

function shell(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap"><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

async function orgFor(token: string) {
  const org = await db.findOrgBySalesToken(String(token || ""));
  return org;
}

function formPage(orgName: string, sells: "software" | "therapy", error = "", v: Record<string, string> = {}) {
  const therapy = sells === "therapy";
  return shell(`Contact ${orgName}`, `<div class="card"><h1>Contact ${esc(orgName)}</h1>
<p>${therapy ? "Leave your name and the best way to reach you. Please don't include health details here; we'll talk about what you're looking for when we connect." : "Tell us a little about you and we'll reply with times to talk."}</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post"><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<label for="n">Name</label><input id="n" name="name" required value="${esc(v.name ?? "")}">
<label for="e">Email</label><input id="e" name="email" type="email" required value="${esc(v.email ?? "")}">
<label for="p">Phone</label><input id="p" name="phone" value="${esc(v.phone ?? "")}">
${therapy ? "" : `<label for="c">Practice or company</label><input id="c" name="company" value="${esc(v.company ?? "")}">`}
${therapy ? "" : `<label for="m">How can we help?</label><textarea id="m" name="message">${esc(v.message ?? "")}</textarea>`}
<button type="submit">Send</button></form></div>`);
}

function done(title: string, text: string) {
  return shell(title, `<div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`);
}

export function registerSalesPages(app: Express) {
  // Lead form
  app.get("/f/:token", async (req, res) => {
    const org = await orgFor(req.params.token);
    if (!org) return res.status(404).send(done("Not found", "This link is not active."));
    res.send(formPage(org.name, readSales(org.sales).sells));
  });
  app.post("/f/:token", async (req: Request, res: Response) => {
    const org = await orgFor(req.params.token);
    if (!org) return res.status(404).send(done("Not found", "This link is not active."));
    const b = req.body ?? {};
    if (b.website) return res.send(done("Thank you", "We got your message."));
    if (limited(req)) return res.status(429).send(done("Please try again later", "Too many messages from this connection. Try again in an hour."));
    const v = { name: String(b.name ?? "").trim(), email: String(b.email ?? "").trim(), phone: String(b.phone ?? "").trim(), company: String(b.company ?? "").trim(), message: String(b.message ?? "").trim() };
    const sells = readSales(org.sales).sells;
    if (!v.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return res.status(400).send(formPage(org.name, sells, "Enter your name and a valid email.", v));
    await newLead(org.id, { ...v, message: sells === "therapy" ? null : v.message, source: "Website form" });
    res.send(done("Thank you", "We got your message and will reply by email shortly."));
  });

  // LeadDash platform workflows (webhook with the contact's fields)
  app.post("/hooks/leads/:token", async (req, res) => {
    const org = await orgFor(req.params.token);
    if (!org) return res.status(404).json({ error: "Not found" });
    if (limited(req, 300)) return res.status(429).json({ error: "Too many requests" });
    const b = (req.body ?? {}) as Record<string, any>;
    const c = typeof b.contact === "object" && b.contact ? b.contact : {};
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = b[k] ?? c[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    };
    const name = pick("full_name", "name", "contact_name") || [pick("first_name", "firstName"), pick("last_name", "lastName")].filter(Boolean).join(" ");
    const email = pick("email", "email_address");
    if (!name && !email) return res.status(400).json({ error: "Send at least a name or an email." });
    const sells = readSales(org.sales).sells;
    const lead = await newLead(org.id, {
      name: name || email,
      email,
      phone: pick("phone", "phone_number"),
      company: pick("company_name", "company", "business_name"),
      message: sells === "therapy" ? null : pick("message", "notes", "comments"),
      source: "LeadDash platform form",
    });
    res.json({ ok: true, id: lead?.id ?? null });
  });

  // Instantly webhook (Hypergrowth and up): a reply, booking or inbox error is handled right away.
  app.post("/hooks/instantly/:token", async (req, res) => {
    const db = await import("./db");
    const s = db.cold.settingsByHook(String(req.params.token));
    if (!s) return res.status(404).json({ error: "Not found" });
    if (limited(req, 600)) return res.status(429).json({ error: "Too many requests" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const event = String(b.event_type ?? b.event ?? "");
    const email = String(b.lead_email ?? b.email ?? "").toLowerCase();
    const cold = await import("./employees/cold");
    const orgId = s.organizationId;
    if (/meeting_booked/i.test(event) && email) cold.job(`booked-${orgId}-${email}`, async () => (await import("./employees/coldreply")).onBooked(orgId, email, null));
    if (/account_error|bounce/i.test(event)) cold.job(`inboxes-${orgId}`, () => cold.syncInboxes(orgId));
    cold.job(`replies-${orgId}`, async () => (await import("./employees/coldreply")).checkReplies(orgId));
    res.json({ ok: true });
  });

  // Booking page
  app.get("/book/:token", async (req, res) => {
    const org = await orgFor(req.params.token);
    if (!org) return res.status(404).send(done("Not found", "This link is not active."));
    res.send(await bookingPage(org.id, org.name, String(req.query.e ?? "")));
  });
  app.post("/book/:token", async (req: Request, res: Response) => {
    const org = await orgFor(req.params.token);
    if (!org) return res.status(404).send(done("Not found", "This link is not active."));
    const b = req.body ?? {};
    if (b.website) return res.send(done("Thank you", "You're booked."));
    if (limited(req)) return res.status(429).send(done("Please try again later", "Too many tries from this connection. Try again in an hour."));
    try {
      const r = await book(org.id, { at: String(b.at ?? ""), name: String(b.name ?? ""), email: String(b.email ?? ""), company: String(b.company ?? ""), note: String(b.note ?? "") });
      res.send(done("You're booked", `${r.when}. A calendar invite is on its way to ${String(b.email).trim()}.`));
    } catch (err) {
      res.status(400).send(await bookingPage(org.id, org.name, err instanceof Error ? err.message : "That did not work. Try again.", { name: String(b.name ?? ""), email: String(b.email ?? ""), company: String(b.company ?? "") }));
    }
  });
}

async function bookingPage(orgId: number, orgName: string, error = "", v: Record<string, string> = {}) {
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const s = readSales(org?.sales);
  const open = await openTimes(orgId, 60);
  if (!open.ready || open.times.length === 0) return shell(`Book a time with ${orgName}`, `<div class="card"><h1>Book a time with ${esc(orgName)}</h1><p>${open.ready ? "There are no open times in the next two weeks. Reply to the email you received and we'll find a time." : "Booking is not open right now. Reply to the email you received and we'll find a time."}</p></div>`);
  const byDay = new Map<string, Date[]>();
  for (const t of open.times) {
    const p = partsIn(t, tz);
    const k = `${p.y}-${p.m}-${p.d}`;
    byDay.set(k, [...(byDay.get(k) ?? []), t]);
  }
  const days = Array.from(byDay.values()).slice(0, 6);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((x) => x.type === "timeZoneName")?.value ?? "";
  const daysHtml = days
    .map((list) => {
      const label = whenText(list[0], tz).replace(/ at .*/, "");
      const slots = list.map((t) => `<label class="slot"><input type="radio" name="at" value="${t.toISOString()}" required><span>${whenText(t, tz).replace(/^.* at /, "")}</span></label>`).join("");
      return `<div class="day">${esc(label)}</div><div class="slots">${slots}</div>`;
    })
    .join("");
  return shell(
    `Book a time with ${orgName}`,
    `<div class="card"><h1>Book a time with ${esc(orgName)}</h1><p>${s.meetingMinutes} minutes. Times are ${esc(zone)}.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post"><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">${daysHtml}
<label for="n">Name</label><input id="n" name="name" required value="${esc(v.name ?? "")}">
<label for="e">Email</label><input id="e" name="email" type="email" required value="${esc(v.email ?? "")}">
${s.sells === "therapy" ? "" : `<label for="c">Practice or company</label><input id="c" name="company" value="${esc(v.company ?? "")}">`}
<button type="submit">Book this time</button></form></div>`
  );
}
