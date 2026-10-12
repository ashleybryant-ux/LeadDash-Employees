import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import express from "express";
import { TRPCError } from "@trpc/server";
import { ENV } from "./_core/env";
import * as db from "./db";
import * as hours from "./workHours";

/**
 * Buying extra work hours by card, without leaving the app: the owner picks a
 * pack, pays on Stripe's checkout page, and comes straight back. Stripe tells
 * the webhook it's paid, and the hours are added then (once per payment).
 */

export function stripeReady() {
  return !!ENV.stripeSecretKey && !!ENV.stripeWebhookSecret;
}

/** Starts a checkout for one top-up pack and returns Stripe's page to send the owner to. */
export async function checkout(orgId: number, packHours: number, email: string | null) {
  if (!stripeReady()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Card payments aren't set up yet. Use the pricing page to add hours." });
  const b = await hours.balance(orgId);
  const pack = b.topUps.find((t) => t.hours === packHours);
  if (!pack) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick one of the hour packs." });
  const org = await db.getOrganizationById(orgId);
  const back = `${ENV.appUrl}/workspace`;
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(pack.price * 100),
    "line_items[0][price_data][product_data][name]": `${pack.hours} work hours`,
    "line_items[0][price_data][product_data][description]": `LeadDash Employees, for ${org?.name ?? "your workspace"}. Good for 12 months.`,
    success_url: `${back}?hours=added`,
    cancel_url: back,
    client_reference_id: String(orgId),
    "metadata[kind]": "work_hours",
    "metadata[orgId]": String(orgId),
    "metadata[hours]": String(pack.hours),
    "payment_intent_data[metadata][kind]": "work_hours",
    "payment_intent_data[metadata][orgId]": String(orgId),
  });
  if (email) form.set("customer_email", email);
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${ENV.stripeSecretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Stripe couldn't start the checkout${data?.error?.message ? `: ${data.error.message}` : "."}` });
  return { url: String(data.url) };
}

/** Stripe's signature check: HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret, within 5 minutes. */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw.toString("utf8")}`).digest("hex");
  return header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .some((p) => {
      const sig = p.slice(3);
      return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    });
}

/** A paid checkout adds its hours once, however many times Stripe sends it. */
export async function handleEvent(event: any) {
  if (event?.type !== "checkout.session.completed") return { added: false };
  const s = event.data?.object ?? {};
  if (s.metadata?.kind !== "work_hours" || s.payment_status !== "paid") return { added: false };
  const orgId = Number(s.metadata.orgId);
  const packHours = Number(s.metadata.hours);
  if (!orgId || !packHours || !(await db.getOrganizationById(orgId))) return { added: false };
  const ref = `Stripe ${s.id}`;
  if (hours.packsFor(orgId).some((p) => p.note?.includes(ref))) return { added: false };
  const paid = typeof s.amount_total === "number" ? ` $${(s.amount_total / 100).toFixed(2)}` : "";
  await hours.addPack(orgId, packHours, `Paid by card${paid}. ${ref}`, "Card payment");
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: s.customer_details?.email || "Card payment", action: "Work hours added", details: `${packHours} work hours bought by card, good for 12 months.` });
  return { added: true };
}

export function registerStripe(app: Express) {
  app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!verifySignature(raw, req.header("stripe-signature"), ENV.stripeWebhookSecret)) return res.status(400).json({ error: "Bad signature" });
    try {
      await handleEvent(JSON.parse(raw.toString("utf8")));
      res.json({ received: true });
    } catch (err) {
      console.warn("[stripe] webhook failed:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "Could not record the payment" });
    }
  });
}
