/** Master-data fields an external system (ERP) owns. Anything else on our side is never touched by a sync. */
export interface Master { name: string; phones: string[]; emails: string[]; role: string }

const set = (a: string[]) => [...new Set(a)].sort();
const same = (a: string[], b: string[]) => JSON.stringify(set(a)) === JSON.stringify(set(b));

/**
 * Human-readable field diff, empty when nothing relevant changed. Order-insensitive for lists,
 * so a re-ordered "phones" cell in the export doesn't count as a change (that would turn every
 * sync into thousands of fake updates and drown the real ones).
 */
export function diffFields(before: Master, after: Master): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`name: ${before.name} → ${after.name}`);
  if (before.role !== after.role) out.push(`role: ${before.role} → ${after.role}`);
  if (!same(before.phones, after.phones)) out.push(`phones: ${before.phones.join(", ") || "none"} → ${after.phones.join(", ") || "none"}`);
  if (!same(before.emails, after.emails)) out.push(`emails: ${before.emails.join(", ") || "none"} → ${after.emails.join(", ") || "none"}`);
  return out;
}

export interface ChangeSample { kind: "created" | "updated" | "archived" | "restored"; sourceId: string; name: string; diff?: string[] }

/** Keep a bounded, representative sample of changes for the preview screen. */
export function pushSample(list: ChangeSample[], s: ChangeSample, perKind = 8): ChangeSample[] {
  return list.filter((x) => x.kind === s.kind).length >= perKind ? list : [...list, s];
}
