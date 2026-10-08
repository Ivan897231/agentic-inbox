import { mutation, query } from "./_fn";
import { v } from "convex/values";
import { DEFAULT_SYSTEM, TOOLS } from "../core/agent";

export const getAgent = query({
  args: {},
  handler: async (ctx) => {
    const a = await ctx.db.query("agents").first();
    return {
      name: a?.name ?? "Support agent",
      systemPrompt: a?.systemPrompt ?? DEFAULT_SYSTEM,
      enabledTools: a?.enabledTools ?? TOOLS.map((t) => t.name),
      maxSteps: a?.maxSteps ?? 8,
      saved: !!a,
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, required: t.name === "reply" || t.name === "escalate" })),
    };
  },
});

export const saveAgent = mutation({
  args: { systemPrompt: v.string(), enabledTools: v.array(v.string()), maxSteps: v.number() },
  handler: async (ctx, a) => {
    if (a.maxSteps < 1 || a.maxSteps > 20) throw new Error("maxSteps must be between 1 and 20");
    if (a.systemPrompt.trim().length < 20) throw new Error("System prompt is too short");
    const known = new Set(TOOLS.map((t) => t.name));
    const enabledTools = a.enabledTools.filter((t) => known.has(t));
    const existing = await ctx.db.query("agents").first();
    const doc = { name: "Support agent", systemPrompt: a.systemPrompt, enabledTools, maxSteps: a.maxSteps };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("agents", doc);
  },
});

export const listKb = query({ args: {}, handler: async (ctx) => ctx.db.query("kbArticles").order("desc").take(100) });

export const addKb = mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, a) => {
    if (!a.title.trim() || !a.body.trim()) throw new Error("Title and body are required");
    return ctx.db.insert("kbArticles", { title: a.title.trim(), body: a.body.trim() });
  },
});

export const removeKb = mutation({ args: { id: v.id("kbArticles") }, handler: async (ctx, a) => { await ctx.db.delete(a.id); } });

/** Who can the sandbox pretend to be? Bounded read. */
export const sandboxContacts = query({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("contacts").take(15)).map((c) => ({ id: c._id, name: c.name, phone: c.phones[0] ?? null, email: c.emails[0] ?? null })),
});
