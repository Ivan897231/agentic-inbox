import { actionGeneric } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_fn";
import { seedStore } from "../core/seed";

/** Idempotent: loads the same fixture the in-browser demo uses. */
export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    if (await ctx.db.query("units").first()) return "already seeded";
    const s = seedStore();
    const unitIds: Record<string, any> = {};
    for (const u of s.units) unitIds[u.id] = await ctx.db.insert("units", { building: u.building, label: u.label, sourceId: u.id });
    const contactIds: Record<string, any> = {};
    for (const c of s.contacts) {
      const id = await ctx.db.insert("contacts", { name: c.name, phones: c.phones, emails: c.emails, role: c.role, unitId: c.unitId && unitIds[c.unitId], sourceId: c.id });
      contactIds[c.id] = id;
      for (const a of [...c.phones, ...c.emails]) await ctx.db.insert("contactAddresses", { address: a, contactId: id });
    }
    for (const t of s.tickets) await ctx.db.insert("tickets", { unitId: t.unitId && unitIds[t.unitId], contactId: t.contactId && contactIds[t.contactId], category: t.category, urgency: t.urgency, summary: t.summary, status: t.status });
    for (const k of s.kb) await ctx.db.insert("kbArticles", { title: k.title, body: k.body });
    return "seeded";
  },
});

/** Lets the UI inject a message through the exact same path the webhooks use. */
export const simulate = actionGeneric({
  args: { channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("sms")), externalId: v.string(), from: v.string(), body: v.string() },
  handler: async (ctx, a) => ctx.runMutation("ingest:receive" as any, a) as Promise<{ duplicate: boolean }>,
});

export const state = query({
  args: {},
  handler: async (ctx) => {
    const conversations = await ctx.db.query("conversations").order("desc").take(50);
    const out = [];
    for (const c of conversations) {
      const contact = c.contactId ? await ctx.db.get(c.contactId) : null;
      out.push({
        ...c,
        name: contact?.name ?? null,
        role: contact?.role ?? null,
        messages: await ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).take(100),
        runs: await ctx.db.query("agentRuns").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).take(5),
      });
    }
    return { conversations: out, tickets: await ctx.db.query("tickets").order("desc").take(50) };
  },
});
