import { internalMutation, mutation, query } from "./_fn";
import { v } from "convex/values";
import { importTick, newImportState, type ImportSource, type ImportState } from "../core/importer";
import { diffFields, pushSample, type ChangeSample } from "../core/sync";
import type { ContactRow } from "../core/csv";

const BATCH = 100;

/**
 * Two modes over the same engine:
 *  - "import": one-off migration (create + update).
 *  - "sync":   recurring ERP snapshot. Same upserts, plus an archive pass for people who vanished
 *              from the export. Archived, never deleted: a missing row in a nightly export is far
 *              more often an export glitch than a real removal, and history must survive it.
 * `dryRun` runs the identical logic but writes nothing, so a customer can preview a sync before applying it.
 *
 * Flow: create -> stage (chunks) -> begin -> [preview done -> apply]
 */
export const create = mutation({
  args: { kind: v.string(), total: v.number(), parseErrors: v.any(), mode: v.optional(v.union(v.literal("import"), v.literal("sync"))), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, a) =>
    ctx.db.insert("importJobs", {
      kind: a.kind, total: a.total, parseErrors: a.parseErrors, mode: a.mode ?? "import", dryRun: a.dryRun ?? false,
      phase: "upsert", restored: 0, archived: 0, changes: [], ...newImportState(), startedAt: Date.now(),
    }),
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

/** Turn a finished preview into the real run. The staged rows are still there (previews never drop them). */
export const apply = mutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || !job.dryRun || !job.done) throw new Error("Only a finished preview can be applied");
    await ctx.db.patch(jobId, {
      dryRun: false, phase: "upsert", archiveCursor: null, archiveStep: "count", wouldArchive: 0, error: undefined, restored: 0, archived: 0, changes: [],
      ...newImportState(), startedAt: Date.now(), finishedAt: undefined,
    });
    await ctx.scheduler.runAfter(0, "importer:tick" as any, { jobId });
  },
});

/**
 * One tick = one bounded batch inside one transaction, then it reschedules itself. A 500k-row sync is
 * a chain of short transactions: it survives deploys and never blocks the rest of the app.
 */
export const tick = internalMutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.done) return;
    if ((job.phase ?? "upsert") === "archive") return archivePass(ctx, job);

    const state: ImportState = {
      cursor: job.cursor, done: job.done, imported: job.imported, updated: job.updated ?? 0, skipped: job.skipped,
      retry: job.retry ?? {}, dead: job.dead ?? [], pageDone: job.pageDone ?? [],
    };
    const dryRun = job.dryRun ?? false;
    let changes: ChangeSample[] = job.changes ?? [];
    let restored = job.restored ?? 0;

    const source: ImportSource<ContactRow> = {
      async page(cursor, limit) {
        const after = cursor === null ? -1 : Number(cursor);
        const rows = await ctx.db.query("importRows").withIndex("by_job_seq", (q) => q.eq("jobId", jobId).gt("seq", after)).take(limit + 1);
        const items = rows.slice(0, limit).map((r) => ({ sourceId: (r.data as ContactRow).sourceId, data: r.data as ContactRow, seq: r.seq }));
        return { items, next: rows.length > limit ? String(items[items.length - 1].seq) : null };
      },
    };

    const { state: next, nextDelayMs } = await importTick(
      state, source,
      async (sourceId, row) => {
        const r = await upsertContact(ctx, String(jobId), sourceId, row, dryRun);
        if (r.restored) restored++;
        if (r.sample) changes = pushSample(changes, r.sample);
        return r.outcome;
      },
      { batch: BATCH },
    );

    const finishedUpsert = next.done;
    const goArchive = finishedUpsert && job.mode === "sync";
    await ctx.db.patch(jobId, {
      ...next, restored, changes,
      // In sync mode the job isn't done until the archive pass has also run.
      ...(goArchive ? { done: false, phase: "archive" as const, archiveCursor: null, archiveStep: "count" as const, wouldArchive: 0 } : {}),
      ...(finishedUpsert && !goArchive ? { finishedAt: Date.now() } : {}),
    });
    // The page settled: its staged rows are only transport, so drop them (not on a preview: Apply needs them).
    if (!dryRun && (next.cursor !== state.cursor || next.done)) await dropStaged(ctx, jobId, state.cursor === null ? -1 : Number(state.cursor));
    if (nextDelayMs !== null || goArchive) await ctx.scheduler.runAfter(goArchive ? 0 : nextDelayMs!, "importer:tick" as any, { jobId });
  },
});

/**
 * Archive pass for sync mode, in two steps over ERP-managed contacts:
 *  1. count: read-only. Finds who isn't in the snapshot and checks a safety valve. If the snapshot is
 *     suspiciously small compared to what we hold (a truncated export), the job FAILS before archiving
 *     anyone, because "30% of customers vanished overnight" is a broken export, not a business event.
 *  2. apply: archives them (skipped entirely for previews).
 */
async function archivePass(ctx: any, job: any) {
  const jobId = job._id;
  const dryRun = job.dryRun ?? false;
  const step: "count" | "apply" = job.archiveStep ?? "count";
  const res = await ctx.db.query("contacts").withIndex("by_erpManaged", (q: any) => q.eq("erpManaged", true)).paginate({ numItems: BATCH, cursor: job.archiveCursor ?? null });
  let changes: ChangeSample[] = job.changes ?? [];
  let would = job.wouldArchive ?? 0;
  let archived = job.archived ?? 0;
  const gone = res.page.filter((c: any) => c.seenJobId !== String(jobId) && !c.archivedAt);

  if (step === "count") {
    would += gone.length;
    for (const c of gone) changes = pushSample(changes, { kind: "archived", sourceId: String(c.sourceId).replace(/^import:/, ""), name: c.name });
    if (!res.isDone) {
      await ctx.db.patch(jobId, { wouldArchive: would, changes, archiveCursor: res.continueCursor });
    } else {
      const seen = (job.imported ?? 0) + (job.updated ?? 0) + (job.skipped ?? 0);
      if (seen > 0 && would > Math.max(25, seen * 0.3)) {
        await ctx.db.patch(jobId, {
          wouldArchive: would, changes, done: true, finishedAt: Date.now(),
          error: `Sync stopped before archiving anyone: ${would} contacts are missing from a snapshot of only ${seen} rows. The export looks truncated. Nothing was archived.`,
        });
        return;
      }
      await ctx.db.patch(jobId, dryRun
        ? { wouldArchive: would, archived: would, changes, done: true, finishedAt: Date.now() }
        : { wouldArchive: would, changes, archiveStep: "apply" as const, archiveCursor: null });
      if (dryRun) return;
    }
    return void (await ctx.scheduler.runAfter(0, "importer:tick" as any, { jobId }));
  }

  for (const c of gone) {
    archived++;
    await ctx.db.patch(c._id, { archivedAt: Date.now() });
    const addrs = await ctx.db.query("contactAddresses").withIndex("by_contact", (q: any) => q.eq("contactId", c._id)).collect();
    for (const a of addrs) await ctx.db.delete(a._id); // archived people are no longer recognised by the agent
  }
  await ctx.db.patch(jobId, { archived, archiveCursor: res.continueCursor, ...(res.isDone ? { done: true, finishedAt: Date.now() } : {}) });
  if (!res.isDone) await ctx.scheduler.runAfter(0, "importer:tick" as any, { jobId });
}

type Upsert = { outcome: "created" | "updated" | "unchanged"; restored?: boolean; sample?: ChangeSample };

/** Idempotent by `sourceId`: a re-run (or a crashed tick) converges instead of duplicating. */
async function upsertContact(ctx: any, jobKey: string, sourceId: string, row: ContactRow, dryRun: boolean): Promise<Upsert> {
  const unitKey = `${row.building}|${row.unit}`;
  const unit = await ctx.db.query("units").withIndex("by_sourceId", (q: any) => q.eq("sourceId", unitKey)).first();
  const existing = await ctx.db.query("contacts").withIndex("by_sourceId", (q: any) => q.eq("sourceId", `import:${sourceId}`)).first();
  const mk = (id?: any) => ({ name: row.name, phones: row.phones, emails: row.emails, role: row.role, unitId: id, sourceId: `import:${sourceId}`, erpManaged: true, seenJobId: jobKey });
  const getUnitId = async () => unit?._id ?? (dryRun ? undefined : await ctx.db.insert("units", { building: row.building, label: row.unit || "-", sourceId: unitKey }));

  if (!existing) {
    if (!dryRun) {
      const id = await ctx.db.insert("contacts", mk(await getUnitId()));
      for (const a of [...row.phones, ...row.emails]) await ctx.db.insert("contactAddresses", { address: a, contactId: id });
    }
    return { outcome: "created", sample: { kind: "created", sourceId, name: row.name } };
  }

  const wasArchived = !!existing.archivedAt;
  const diff = diffFields(existing, row);
  const unitChanged = !!unit && existing.unitId !== unit._id;
  if (unitChanged) diff.push(`unit: moved to ${row.building} ${row.unit}`);

  if (!diff.length && !wasArchived) {
    if (existing.seenJobId !== jobKey) await ctx.db.patch(existing._id, { seenJobId: jobKey }); // marker only, even on preview
    return { outcome: "unchanged" };
  }
  if (!dryRun) {
    await ctx.db.patch(existing._id, { ...mk(await getUnitId()), archivedAt: undefined });
    const old = await ctx.db.query("contactAddresses").withIndex("by_contact", (q: any) => q.eq("contactId", existing._id)).collect();
    for (const o of old) await ctx.db.delete(o._id);
    for (const a of [...row.phones, ...row.emails]) await ctx.db.insert("contactAddresses", { address: a, contactId: existing._id });
  } else if (existing.seenJobId !== jobKey) await ctx.db.patch(existing._id, { seenJobId: jobKey });
  return { outcome: "updated", restored: wasArchived, sample: { kind: wasArchived ? "restored" : "updated", sourceId, name: row.name, diff } };
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
      id: j._id, kind: j.kind, mode: j.mode ?? "import", dryRun: j.dryRun ?? false, phase: j.phase ?? "upsert",
      total: j.total ?? 0, done: j.done, imported: j.imported, updated: j.updated ?? 0, skipped: j.skipped,
      restored: j.restored ?? 0, archived: j.archived ?? 0, wouldArchive: j.wouldArchive ?? 0, error: j.error ?? null, changes: j.changes ?? [],
      retrying: Object.keys(j.retry ?? {}).length, dead: (j.dead ?? []).slice(0, 20), deadCount: (j.dead ?? []).length,
      parseErrors: (j.parseErrors ?? []).slice(0, 20), parseErrorCount: (j.parseErrors ?? []).length,
      startedAt: j.startedAt ?? null, finishedAt: j.finishedAt ?? null,
    };
  },
});
