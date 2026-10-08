import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardTitle } from "./components/ui/card";
import { mapContacts, parseCsv, sampleCsv, type ContactRow } from "../core/csv";

const r = {
  create: makeFunctionReference<"mutation">("importer:create"),
  stage: makeFunctionReference<"mutation">("importer:stage"),
  begin: makeFunctionReference<"mutation">("importer:begin"),
  latest: makeFunctionReference<"query">("importer:latest"),
};
const CHUNK = 200;

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export function Migration() {
  const job = useQuery(r.latest) as any;
  const create = useMutation(r.create);
  const stage = useMutation(r.stage);
  const begin = useMutation(r.begin);
  const [parsed, setParsed] = useState<{ name: string; contacts: ContactRow[]; errors: { line: number; error: string }[] } | null>(null);
  const [upload, setUpload] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = (name: string, text: string) => { setErr(null); setParsed({ name, ...mapContacts(parseCsv(text)) }); };

  const start = async () => {
    if (!parsed) return;
    setErr(null);
    try {
      const jobId = await create({ kind: "contacts", total: parsed.contacts.length, parseErrors: parsed.errors });
      for (let i = 0; i < parsed.contacts.length; i += CHUNK) {
        setUpload(Math.round((i / parsed.contacts.length) * 100));
        await stage({ jobId, startSeq: i, rows: parsed.contacts.slice(i, i + CHUNK) });
      }
      await begin({ jobId });
      setParsed(null);
    } catch (e) { setErr((e as Error).message); } finally { setUpload(null); }
  };

  const settled = job ? job.imported + job.updated + job.skipped + job.deadCount : 0;
  const pct = job && job.total ? Math.min(100, Math.round((settled / job.total) * 100)) : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-3 p-4">
        <CardTitle>Import contacts from your old system</CardTitle>
        <p className="text-xs text-zinc-500">
          Upload a CSV export. Columns are matched by name (name / full_name, phone / mobile, email, property, apartment, role…).
          Cells with several values ("a@x.com; b@x.com") are split. Bad rows are reported with their line number instead of aborting the file.
        </p>
        <div className="flex flex-wrap gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) load(f.name, await f.text()); e.target.value = ""; }} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>Choose CSV…</Button>
          <Button variant="ghost" onClick={() => load("sample-2000-rows.csv", sampleCsv(2000))}>Use sample (2,000 rows)</Button>
        </div>
        {parsed && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <div><b>{parsed.name}</b>: <Badge tone="green">{parsed.contacts.length} valid</Badge> <Badge tone={parsed.errors.length ? "red" : "neutral"}>{parsed.errors.length} rejected</Badge></div>
            {parsed.errors.length > 0 && (
              <ul className="max-h-28 overflow-auto text-xs text-red-700">
                {parsed.errors.slice(0, 8).map((e) => <li key={e.line}>Line {e.line}: {e.error}</li>)}
                {parsed.errors.length > 8 && <li>…and {parsed.errors.length - 8} more</li>}
              </ul>
            )}
            <Button onClick={start} disabled={upload !== null || parsed.contacts.length === 0}>{upload !== null ? `Uploading ${upload}%…` : `Import ${parsed.contacts.length} contacts`}</Button>
          </div>
        )}
        {err && <p role="alert" className="text-xs text-red-600">{err}</p>}
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">How this works</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>The browser parses and validates the file, then uploads rows in chunks of {CHUNK} to a staging table (re-sending a chunk is safe).</li>
            <li>A server job takes 100 rows per transaction and reschedules itself until done, so 500k rows is just more ticks.</li>
            <li>Every row upserts by its source id: re-running the same file creates nothing new, and changed rows are updated.</li>
            <li>Rows that keep failing are retried with backoff, then set aside as dead letters without blocking the rest.</li>
          </ol>
        </details>
      </Card>

      <Card className="space-y-3 self-start p-4">
        <div className="flex items-center justify-between">
          <CardTitle>Latest import</CardTitle>
          {job && (job.done ? <Badge tone="green">done</Badge> : <Badge tone="amber">running</Badge>)}
        </div>
        {!job ? <p className="text-sm text-zinc-500">No imports yet.</p> : (
          <>
            <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded bg-zinc-100">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <dl className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-5">
              {[["created", job.imported], ["updated", job.updated], ["unchanged", job.skipped], ["retrying", job.retrying], ["dead-lettered", job.deadCount]].map(([k, v]) => (
                <div key={k as string} className="rounded border p-2"><dd className="text-lg font-semibold">{v}</dd><dt className="text-zinc-500">{k}</dt></div>
              ))}
            </dl>
            {job.finishedAt && job.startedAt && <p className="text-xs text-zinc-500">{job.total} rows in {((job.finishedAt - job.startedAt) / 1000).toFixed(1)} s</p>}
            {job.parseErrorCount > 0 && (
              <div>
                <div className="mb-1 flex items-center justify-between text-xs"><b>{job.parseErrorCount} rows rejected before import</b>
                  <Button size="sm" variant="outline" onClick={() => download("rejected-rows.csv", "line,error\n" + job.parseErrors.map((e: any) => `${e.line},"${e.error.replace(/"/g, '""')}"`).join("\n"))}>Download report</Button></div>
                <ul className="max-h-24 overflow-auto text-xs text-red-700">{job.parseErrors.slice(0, 6).map((e: any) => <li key={e.line}>Line {e.line}: {e.error}</li>)}</ul>
              </div>
            )}
            {job.deadCount > 0 && <ul className="text-xs text-red-700">{job.dead.map((d: any) => <li key={d.sourceId}>{d.sourceId}: {d.error}</li>)}</ul>}
          </>
        )}
      </Card>
    </div>
  );
}
