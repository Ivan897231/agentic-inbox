import { mutation } from "./_fn";
import { v } from "convex/values";

/** A human answers from the inbox. Same delivery queue as agent replies. */
export const humanReply = mutation({
  args: { conversationId: v.id("conversations"), text: v.string() },
  handler: async (ctx, a) => {
    const text = a.text.trim();
    if (!text) throw new Error("Empty reply");
    const conv = await ctx.db.get(a.conversationId);
    if (!conv) throw new Error("Conversation not found");
    const messageId = await ctx.db.insert("messages", { conversationId: conv._id, direction: "out", channel: conv.channel, body: text, by: "human", delivery: "pending", attempts: 0 });
    await ctx.db.patch(conv._id, { status: "resolved", escalationReason: undefined });
    await ctx.scheduler.runAfter(0, "outbound:send" as any, { messageId });
  },
});

export const resolve = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, a) => { await ctx.db.patch(a.conversationId, { status: "resolved", escalationReason: undefined }); },
});

/** Manual retry for a message whose delivery gave up. */
export const retryDelivery = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.messageId, { delivery: "pending", attempts: 0, deliveryNote: undefined });
    await ctx.scheduler.runAfter(0, "outbound:send" as any, { messageId: a.messageId });
  },
});
