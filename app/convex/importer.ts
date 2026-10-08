import { internalMutation, mutation, query } from "./_fn";
import { v } from "convex/values";
import { importTick, newImportState, type ImportSource, type ImportState } from "../core/importer";
import type { ContactRow } from "../core/csv";

const BATCH = 100;

/** 1) create the job. 2) client uploads parsed rows in chunks via `stage`. 3) `begin` starts the tick chain. */
export const create = mutation({
  args: { kind: v.string(), total: v.number(), parseErrors: v.any() },
  handler: async (ctx, a) =>
    ctx.db.insert("importJobs", { kind: a.kind, total: a.total, parseErrors: a.parseErrors, ...newImportState(), startedAt: Date.now() }),
});

export const stage = mutation({
  args: { jobId: v.id("importJobs"), startSeq: v.number(), rows: v.array(v.any()) },
  handler: async (ctx, a) => {
    for (let i = 0; i < a.rows.length; i++) {
      // seq is the cursor; re-uploading a chunk after a network blip must not duplicate rows.
      const seq = a.startSeq + i;
      const exists = await ctx.db.query("importRows").withIndex("by_job_seq", (q) => q.eq("jobId", a.jobId).eq("seq", seq)).first();
      if (!exists) await ctx.db.insert("importRows", { jobId: a.jobId, seq, data: a.rows[i] });
    }
  },
});

export const begin = mutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => { await ctx.scheduler.runAfter(0, "importer:tick" as any, { jobId }); },
});

/**
 * One tick = one bounded batch inside one transaction. It reschedules itself until the job is done,
 * so a 500k-row import is a chain of short transactions: it survives deploys and never blocks the
 * rest of the app. Retries/dead-lettering come from core/importer.
 */
export const tick = internalMutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.done) return;
    const state: ImportState = {
      cursor: job.cursor, done: job.done, imported: job.imported, updated: job.updated ?? 0, skipped: job.skipped,
      retry: job.retry ?? {}, dead: job.dead ?? [], pageDone: job.pageDone ?? [],
    };

    const source: ImportSource<ContactRow> = {
      async page(cursor, limit) {
        const after = cursor === null ? -1 : Number(cursor);
        const rows = await ctx.db.query("importRows").withIndex("by_job_seq", (q) => q.eq("jobId", jobId).gt("seq", after)).take(limit + 1);
        const items = rows.slice(0, limit).map((r) => ({ sourceId: (r.data as ContactRow).sourceId, data: r.data as ContactRow, seq: r.seq }));
        return { items, next: rows.length > limit ? String(items[items.length - 1].seq) : null };
      },
    };

    const { state: next, nextDelayMs } = await importTick(state, source, (sourceId, row) => upsertContact(ctx, sourceId, row), { batch: BATCH });
    await ctx.db.patch(jobId, { ...next, ...(next.done ? { finishedAt: Date.now() } : {}) });
    // The page settled: its staged rows are only transport, so drop them (bounded by BATCH).
    if (next.cursor !== state.cursor || next.done) await dropStaged(ctx, jobId, state.cursor === null ? -1 : Number(state.cursor));
    if (nextDelayMs !== null) await ctx.scheduler.runAfter(nextDelayMs, "importer:tick" as any, { jobId });
  },
});

/** Idempotent by `sourceId`: a re-run (or a crashed tick) converges instead of duplicating. */
async function upsertContact(ctx: any, sourceId: string, row: ContactRow): Promise<"created" | "updated" | "unchanged"> {
  const unitKey = `${row.building}|${row.unit}`;
  let unit = await ctx.db.query("units").withIndex("by_sourceId", (q: any) => q.eq("sourceId", unitKey)).first();
  const unitId = unit?._id ?? (await ctx.db.insert("units", { building: row.building, label: row.unit || "-", sourceId: unitKey }));
  const existing = await ctx.db.query("contacts").withIndex("by_sourceId", (q: any) => q.eq("sourceId", `import:${sourceId}`)).first();
  const doc = { name: row.name, phones: row.phones, emails: row.emails, role: row.role, unitId, sourceId: `import:${sourceId}` };

  if (!existing) {
    const id = await ctx.db.insert("contacts", doc);
    for (const a of [...row.phones, ...row.emails]) await ctx.db.insert("contactAddresses", { address: a, contactId: id });
    return "created";
  }
  const same = existing.name === doc.name && existing.role === doc.role && existing.unitId === unitId
    && JSON.stringify(existing.phones) === JSON.stringify(doc.phones) && JSON.stringify(existing.emails) === JSON.stringify(doc.emails);
  if (same) return "unchanged";
  await ctx.db.patch(existing._id, doc);
  const old = await ctx.db.query("contactAddresses").withIndex("by_contact", (q: any) => q.eq("contactId", existing._id)).collect();
  for (const o of old) await ctx.db.delete(o._id);
  for (const a of [...row.phones, ...row.emails]) await ctx.db.insert("contactAddresses", { address: a, contactId: existing._id });
  return "updated";
}

async function dropStaged(ctx: any, jobId: any, afterSeq: number) {
  const rows = await ctx.db.query("importRows").withIndex("by_job_seq", (q: any) => q.eq("jobId", jobId).gt("seq", afterSeq)).take(BATCH);
  for (const r of rows) await ctx.db.delete(r._id);
}

export const latest = query({
  args: {},
  handler: async (ctx) => {
    const j = await ctx.db.query("importJobs").order("desc").first();
    return j && {
      id: j._id, kind: j.kind, total: j.total ?? 0, done: j.done, imported: j.imported, updated: j.updated ?? 0, skipped: j.skipped,
      retrying: Object.keys(j.retry ?? {}).length, dead: (j.dead ?? []).slice(0, 20), deadCount: (j.dead ?? []).length,
      parseErrors: (j.parseErrors ?? []).slice(0, 20), parseErrorCount: (j.parseErrors ?? []).length,
      startedAt: j.startedAt ?? null, finishedAt: j.finishedAt ?? null,
    };
  },
});

