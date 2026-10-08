import { actionGeneric } from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_fn";
import { nextDelivery, sendOutbound, type Providers } from "../core/outbound";

function providers(): Providers {
  const e = process.env;
  return {
    twilio: e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_SMS_FROM
      ? { accountSid: e.TWILIO_ACCOUNT_SID, authToken: e.TWILIO_AUTH_TOKEN, smsFrom: e.TWILIO_SMS_FROM, whatsappFrom: e.TWILIO_WHATSAPP_FROM ?? `whatsapp:${e.TWILIO_SMS_FROM}` }
      : undefined,
    resend: e.RESEND_API_KEY ? { apiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM ?? "support@example.com" } : undefined,
  };
}

export const load = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const m = await ctx.db.get(messageId);
    const conv = m && (await ctx.db.get(m.conversationId));
    return m && conv ? { channel: m.channel, body: m.body, to: conv.party, delivery: m.delivery ?? null, attempts: m.attempts ?? 0 } : null;
  },
});

export const mark = internalMutation({
  args: { messageId: v.id("messages"), delivery: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed"), v.literal("skipped")), note: v.optional(v.string()), attempts: v.number() },
  handler: async (ctx, a) => { await ctx.db.patch(a.messageId, { delivery: a.delivery, deliveryNote: a.note, attempts: a.attempts }); },
});

/**
 * One delivery attempt. On a retryable failure it reschedules itself with exponential backoff
 * (a durable queue built from nothing but the scheduler); permanent failures and exhausted
 * retries end in `failed`, visible to a human in the inbox.
 */
export const send = actionGeneric({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const m = (await ctx.runQuery("outbound:load" as any, { messageId })) as any;
    if (!m || m.delivery === "sent" || m.delivery === "skipped") return; // idempotent: a duplicate run is a no-op
    const attempts = m.attempts + 1;
    const r = await sendOutbound(providers(), { channel: m.channel, to: m.to, body: m.body });
    const mark = (delivery: string, note?: string) => ctx.runMutation("outbound:mark" as any, { messageId, delivery, note, attempts });
    if (r.ok === true) return void (await mark("sent", r.providerId));
    if (r.ok === "skipped") return void (await mark("skipped", r.reason));
    const next = nextDelivery(attempts, r);
    if ("giveUp" in next) return void (await mark("failed", r.error));
    await mark("pending", `Attempt ${attempts} failed: ${r.error}. Retrying.`);
    await ctx.scheduler.runAfter(next.retryInMs, "outbound:send" as any, { messageId });
  },
});
