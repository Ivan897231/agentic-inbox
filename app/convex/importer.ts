import { internalMutation as internalMutationGeneric, query as queryGeneric } from "./_fn";
import { v } from "convex/values";
import { importTick, type ImportState } from "../core/importer";

/**
 * One tick = one bounded batch. The mutation reschedules itself until `done`,
 * so a 500k-record import is a chain of short transactions, survives deploys,
 * and can be paused by flipping nothing but a row.
 *
 * `fetchPage` is the customer-specific adapter (CSV in storage, legacy REST API, ...).
 */
export const tick = internalMutationGeneric({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.done) return;
    const state: ImportState = { cursor: job.cursor, done: job.done, imported: job.imported, skipped: job.skipped, retry: job.retry, dead: job.dead, pageDone: job.pageDone };

    const source = { page: async (_cursor: string | null, _limit: number) => ({ items: [] as any[], next: null as string | null }) }; // TODO: wire adapter per job.kind
    const { state: next, nextDelayMs } = await importTick(state, source, async (sourceId, data: any) => {
      const existing = await ctx.db.query("contacts").withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId)).first();
      if (existing) return "unchanged";
      const id = await ctx.db.insert("contacts", { ...data, sourceId });
      for (const a of [...data.phones, ...data.emails]) await ctx.db.insert("contactAddresses", { address: a, contactId: id });
      return "created";
    });
    await ctx.db.patch(jobId, next);
    if (nextDelayMs !== null) await ctx.scheduler.runAfter(nextDelayMs, "importer:tick" as any, { jobId });
  },
});

export const progress = queryGeneric({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    const j = await ctx.db.get(jobId);
    return j && { imported: j.imported, skipped: j.skipped, dead: j.dead.length, done: j.done };
  },
});
