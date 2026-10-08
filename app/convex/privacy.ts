import { mutation } from "./_fn";
import { v } from "convex/values";

/**
 * GDPR "right to erasure" for one person. Deletes the contact and everything that identifies them,
 * and anonymises (not deletes) records the business must keep: conversations/tickets stay for
 * accounting and audit, but with the personal content removed. Agent traces are deleted.
 */
export const erasePerson = mutation({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => {
    const contact = await ctx.db.get(contactId);
    if (!contact) throw new Error("Contact not found");
    const counts = { addresses: 0, conversations: 0, messages: 0, runs: 0, tickets: 0 };

    for (const a of await ctx.db.query("contactAddresses").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect()) {
      await ctx.db.delete(a._id); counts.addresses++;
    }
    for (const c of await ctx.db.query("conversations").withIndex("by_contact", (q) => q.eq("contactId", contactId)).take(500)) {
      for (const m of await ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).take(1000)) {
        await ctx.db.patch(m._id, { body: "[erased]" }); counts.messages++;
      }
      for (const r of await ctx.db.query("agentRuns").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).take(100)) {
        await ctx.db.delete(r._id); counts.runs++;
      }
      await ctx.db.patch(c._id, { party: "erased", contactId: undefined, escalationReason: undefined }); counts.conversations++;
    }
    for (const t of await ctx.db.query("tickets").withIndex("by_contact", (q) => q.eq("contactId", contactId)).take(500)) {
      await ctx.db.patch(t._id, { contactId: undefined, summary: "[erased]" }); counts.tickets++;
    }
    await ctx.db.delete(contactId);
    return counts;
  },
});
