import { internalMutation as mutation, internalQuery as query } from "./_fn";
import { v } from "convex/values";
import { DEFAULT_SYSTEM, TOOLS } from "../core/agent";

export const getConfig = query({
  args: {},
  handler: async (ctx) => {
    const a = await ctx.db.query("agents").first();
    return a
      ? { id: a._id, name: a.name, systemPrompt: a.systemPrompt, enabledTools: a.enabledTools, maxSteps: a.maxSteps, model: a.model ?? null }
      : { id: null, name: "Support agent", systemPrompt: DEFAULT_SYSTEM, enabledTools: TOOLS.map((t) => t.name), maxSteps: 8, model: null };
  },
});

export const findContact = query({
  args: { phone: v.optional(v.string()), email: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const address = (a.phone ?? a.email)!;
    const hit = await ctx.db.query("contactAddresses").withIndex("by_address", (q) => q.eq("address", address)).first();
    const c = hit && (await ctx.db.get(hit.contactId));
    return c ? { id: c._id, name: c.name, phones: c.phones, emails: c.emails, unitId: c.unitId, role: c.role } : null;
  },
});
export const getUnit = query({
  args: { id: v.string() },
  handler: async (ctx, a) => {
    const u = (await ctx.db.get(a.id as any)) as any;
    return u ? { id: u._id, building: u.building, label: u.label } : null;
  },
});
export const openTickets = query({
  args: { unitId: v.string() },
  handler: async (ctx, a) =>
    (await ctx.db.query("tickets").withIndex("by_unit_status", (q) => q.eq("unitId", a.unitId as any).eq("status", "open")).take(20))
      .map((t) => ({ id: t._id, category: t.category, urgency: t.urgency, summary: t.summary, status: t.status })),
});
export const searchKb = query({
  args: { query: v.string(), limit: v.number() },
  handler: async (ctx, a) =>
    (await ctx.db.query("kbArticles").withSearchIndex("search_body", (q) => q.search("body", a.query)).take(a.limit))
      .map((k) => ({ id: k._id, title: k.title, body: k.body })),
});
export const createTicket = mutation({
  args: { unitId: v.optional(v.string()), contactId: v.optional(v.string()), category: v.string(), urgency: v.union(v.literal("low"), v.literal("normal"), v.literal("emergency")), summary: v.string() },
  handler: async (ctx, a) => {
    const id = await ctx.db.insert("tickets", { ...(a as any), status: "open" });
    return { id, status: "open", ...a };
  },
});

/** Persist the reply and enqueue delivery. The send itself happens in `outbound:send` (with retries). */
export const reply = mutation({
  args: { conversationId: v.id("conversations"), text: v.string(), by: v.optional(v.union(v.literal("agent"), v.literal("human"))) },
  handler: async (ctx, a) => {
    const conv = await ctx.db.get(a.conversationId);
    if (!conv) return;
    const messageId = await ctx.db.insert("messages", {
      conversationId: conv._id, direction: "out", channel: conv.channel, body: a.text, by: a.by ?? "agent", delivery: "pending", attempts: 0,
    });
    await ctx.db.patch(conv._id, { status: "agent_handled" });
    await ctx.scheduler.runAfter(0, "outbound:send" as any, { messageId });
  },
});
export const escalate = mutation({
  args: { conversationId: v.id("conversations"), reason: v.string() },
  handler: async (ctx, a) => { await ctx.db.patch(a.conversationId, { status: "needs_human", escalationReason: a.reason }); },
});
export const recordRun = mutation({
  args: {
    conversationId: v.id("conversations"), steps: v.any(), outcome: v.union(v.literal("replied"), v.literal("escalated"), v.literal("failed")),
    usage: v.optional(v.any()), llmCalls: v.optional(v.number()), model: v.optional(v.string()), ms: v.optional(v.number()),
  },
  handler: async (ctx, a) => { await ctx.db.insert("agentRuns", a); },
});
