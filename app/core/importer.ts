/**
 * Resumable, idempotent bulk import (the "move customers off their old system" problem).
 *
 * - Work is a cursor over a source; each tick processes a bounded batch so it fits a
 *   Convex mutation/action time limit, then the caller reschedules itself.
 * - Every record has a stable sourceId; `upsert` must be idempotent so a crashed tick
 *   can simply run again.
 * - Failures retry with exponential backoff + jitter, then land in a dead-letter list
 *   instead of blocking the other 99,999 records.
 */
export interface ImportSource<T> {
  /** Return up to `limit` records after `cursor` (null = start). */
  page(cursor: string | null, limit: number): Promise<{ items: { sourceId: string; data: T }[]; next: string | null }>;
}

export interface ImportState {
  cursor: string | null;
  done: boolean;
  imported: number;
  skipped: number;
  retry: Record<string, number>; // sourceId -> attempts
  dead: { sourceId: string; error: string }[];
  /** Ids of the current page already settled, so a page re-run after a failure doesn't redo or recount them. */
  pageDone: string[];
}

export const newImportState = (): ImportState => ({ cursor: null, done: false, imported: 0, skipped: 0, retry: {}, dead: [], pageDone: [] });

export const backoffMs = (attempt: number, rand = Math.random) => Math.min(60_000, 500 * 2 ** attempt) * (0.5 + rand() / 2);

export async function importTick<T>(
  state: ImportState,
  source: ImportSource<T>,
  upsert: (sourceId: string, data: T) => Promise<"created" | "unchanged">,
  opts: { batch?: number; maxAttempts?: number } = {},
): Promise<{ state: ImportState; nextDelayMs: number | null }> {
  const { batch = 100, maxAttempts = 4 } = opts;
  if (state.done) return { state, nextDelayMs: null };
  const s: ImportState = { ...state, retry: { ...state.retry }, dead: [...state.dead], pageDone: [...state.pageDone] };
  const settled = new Set(s.pageDone);
  const { items, next } = await source.page(s.cursor, batch);
  let failed = 0;

  for (const it of items) {
    if (settled.has(it.sourceId)) continue;
    try {
      (await upsert(it.sourceId, it.data)) === "created" ? s.imported++ : s.skipped++;
      delete s.retry[it.sourceId];
      settled.add(it.sourceId);
    } catch (e) {
      const n = (s.retry[it.sourceId] ?? 0) + 1;
      if (n >= maxAttempts) { s.dead.push({ sourceId: it.sourceId, error: (e as Error).message }); delete s.retry[it.sourceId]; settled.add(it.sourceId); }
      else { s.retry[it.sourceId] = n; failed++; }
    }
  }
  s.pageDone = [...settled];
  // Move on only if the page fully settled; otherwise re-run the same page after a backoff.
  if (failed === 0) { s.cursor = next; s.done = next === null; s.pageDone = []; }
  const worst = Math.max(0, ...Object.values(s.retry));
  return { state: s, nextDelayMs: s.done ? null : failed ? backoffMs(worst) : 0 };
}
