import { internalMutation as internalMutationGeneric, query as queryGeneric } from "./_fn";
import { v } from "convex/values";
import type { GenericId } from "convex/values";

/**
 * Single write path for every channel. One mutation = one transaction, so the
 * dedupe check and the insert can't race (Convex serializes conflicting writes).
 */
export const receive = internalMutationGeneric({
  args: {
    channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("sms")),
    externalId: v.string(),
    from: v.string(),
    body: v.string(),
  },
  handler: async (ctx, m) => {
    const dup = await ctx.db
      .query("messages")
      .withIndex("by_channel_externalId", (q) => q.eq("channel", m.channel).eq("externalId", m.externalId))
      .first();
    if (dup) return { duplicate: true as const, conversationId: dup.conversationId };

    const addr = await ctx.db.query("contactAddresses").withIndex("by_address", (q) => q.eq("address", m.from)).first();
    let conv = await ctx.db
      .query("conversations")
      .withIndex("by_party_channel", (q) => q.eq("party", m.from).eq("channel", m.channel))
      .first();
    const now = Date.now();
    if (!conv) {
      const id = await ctx.db.insert("conversations", { party: m.from, channel: m.channel, contactId: addr?.contactId, status: "open", lastAt: now });
      conv = (await ctx.db.get(id))!;
    } else await ctx.db.patch(conv._id, { lastAt: now, status: "open" });

    await ctx.db.insert("messages", { conversationId: conv._id, direction: "in", channel: m.channel, externalId: m.externalId, body: m.body });
    // Run the agent out-of-band: the webhook must return 200 fast or providers retry.
    await ctx.scheduler.runAfter(0, "agent:run" as any, { conversationId: conv._id, from: m.from, channel: m.channel, body: m.body });
    return { duplicate: false as const, conversationId: conv._id as GenericId<"conversations"> };
  },
});

export const inbox = queryGeneric({
  args: {},
  handler: async (ctx) => {
    // Needs-human first (index on status+lastAt), then everything else; bounded reads only.
    const urgent = await ctx.db.query("conversations").withIndex("by_status_lastAt", (q) => q.eq("status", "needs_human")).order("desc").take(50);
    const rest = await ctx.db.query("conversations").withIndex("by_status_lastAt", (q) => q.eq("status", "agent_handled")).order("desc").take(50);
    return [...urgent, ...rest];
  },
});
