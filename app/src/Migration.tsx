import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardTitle } from "./components/ui/card";
import { mapContacts, parseCsv, sampleCsv, type ContactRow } from "../core/csv";
import { cn } from "./lib/utils";

const r = {
  create: makeFunctionReference<"mutation">("importer:create"),
  stage: makeFunctionReference<"mutation">("importer:stage"),
  begin: makeFunctionReference<"mutation">("importer:begin"),
  apply: makeFunctionReference<"mutation">("importer:apply"),
  latest: makeFunctionReference<"query">("importer:latest"),
};
const CHUNK = 200;
type Mode = "import" | "sync";
type Parsed = { name: string; contacts: ContactRow[]; errors: { line: number; error: string }[] };

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

const KIND_TONE = { created: "green", updated: "blue", restored: "blue", archived: "amber" } as const;

export function Migration() {
  const job = useQuery(r.latest) as any;
  const create = useMutation(r.create);
  const stage = useMutation(r.stage);
  const begin = useMutation(r.begin);
  const apply = useMutation(r.apply);
  const [mode, setMode] = useState<Mode>("sync");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [upload, setUpload] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = (name: string, text: string) => { setErr(null); setParsed({ name, ...mapContacts(parseCsv(text)) }); };

  const start = async (dryRun: boolean) => {
    if (!parsed) return;
    setErr(null);
    try {
      const jobId = await create({ kind: "contacts", total: parsed.contacts.length, parseErrors: parsed.errors, mode, dryRun });
      for (let i = 0; i < parsed.contacts.length; i += CHUNK) {
        setUpload(Math.round((i / parsed.contacts.length) * 100));
        await stage({ jobId, startSeq: i, rows: parsed.contacts.slice(i, i + CHUNK) });
      }
      await begin({ jobId });
      setParsed(null);
    } catch (e) { setErr((e as Error).message); } finally { setUpload(null); }
  };

  const settled = job ? job.imported + job.updated + job.skipped + job.deadCount : 0;
  const pct = job?.total ? Math.min(100, Math.round((settled / job.total) * 100)) : 0;
  const preview = job?.dryRun;
  const ready = preview && job.done && !job.error;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-3 p-4">
        <CardTitle>Bring your data from the old system</CardTitle>
        <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 text-sm" role="group" aria-label="Mode">
          {([["sync", "Sync from ERP"], ["import", "One-off import"]] as const).map(([m, label]) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} className={cn("flex-1 rounded-md px-3 py-1.5", mode === m ? "bg-white font-medium shadow-sm" : "text-zinc-600")}>{label}</button>
          ))}
        </div>
        <p className="text-xs text-zinc-500">
          {mode === "sync"
            ? "Recurring sync with a system the customer still runs. The ERP stays the source of truth for names, phones and emails. Review a preview first. People missing from the export are archived, never deleted, and come back if they reappear."
            : "One-off migration. Creates new people and updates existing ones; nothing is ever removed."}
          {" "}Columns are matched by name (name / full_name, phone / mobile, email, property, apartment, role…). Bad rows are reported with their line number instead of aborting the file.
        </p>
        <div className="flex flex-wrap gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) load(f.name, await f.text()); e.target.value = ""; }} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>Choose CSV…</Button>
          <Button variant="ghost" onClick={() => load("erp-export-monday.csv", sampleCsv(2000, 1))}>Sample: Monday export</Button>
          <Button variant="ghost" onClick={() => load("erp-export-tuesday.csv", sampleCsv(2000, 2))}>Sample: Tuesday export</Button>
        </div>
        {parsed && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <div><b>{parsed.name}</b>: <Badge tone="green">{parsed.contacts.length} valid</Badge> <Badge tone={parsed.errors.length ? "red" : "neutral"}>{parsed.errors.length} rejected</Badge></div>
            {parsed.errors.length > 0 && (
              <ul className="max-h-24 overflow-auto text-xs text-red-700">
                {parsed.errors.slice(0, 5).map((e) => <li key={e.line}>Line {e.line}: {e.error}</li>)}
                {parsed.errors.length > 5 && <li>…and {parsed.errors.length - 5} more</li>}
              </ul>
            )}
            <div className="flex gap-2">
              {mode === "sync" && <Button onClick={() => start(true)} disabled={upload !== null || !parsed.contacts.length}>{upload !== null ? `Uploading ${upload}%…` : "Preview changes"}</Button>}
              {mode === "import" && <Button onClick={() => start(false)} disabled={upload !== null || !parsed.contacts.length}>{upload !== null ? `Uploading ${upload}%…` : `Import ${parsed.contacts.length} contacts`}</Button>}
            </div>
          </div>
        )}
        {err && <p role="alert" className="text-xs text-red-600">{err}</p>}
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">How this works</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>The browser parses and validates the file, then uploads rows in chunks of {CHUNK} to a staging table (re-sending a chunk is safe).</li>
            <li>A server job takes 100 rows per transaction and reschedules itself until done, so 500k rows is just more ticks.</li>
            <li>Every row upserts by its source id: re-running a file creates nothing new. Lists are compared as sets, so a re-ordered phone cell isn't a "change".</li>
            <li>A preview runs the exact same code but writes nothing. Apply then reuses the staged rows.</li>
            <li>The archive step is read-only first: if the snapshot is much smaller than what we hold (a truncated export), it stops before archiving anyone.</li>
            <li>Rows that keep failing are retried with backoff, then set aside as dead letters without blocking the rest.</li>
          </ol>
        </details>
      </Card>

      <Card className="space-y-3 self-start p-4">
        <div className="flex items-center justify-between">
          <CardTitle>{preview ? "Preview" : "Latest run"}</CardTitle>
          {job && (job.error ? <Badge tone="red">stopped</Badge> : job.done ? <Badge tone="green">{preview ? "ready to review" : "done"}</Badge> : <Badge tone="amber">{job.phase === "archive" ? "checking removals" : "running"}</Badge>)}
        </div>
        {!job ? <p className="text-sm text-zinc-500">Nothing yet.</p> : (
          <>
            {job.error && <p role="alert" className="rounded-md bg-red-50 p-3 text-xs text-red-800"><b>Safety stop.</b> {job.error}</p>}
            <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded bg-zinc-100">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${job.done ? 100 : pct}%` }} />
            </div>
            <dl className="grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-5">
              {[
                [preview ? "would create" : "created", job.imported],
                [preview ? "would update" : "updated", job.updated],
                ["unchanged", job.skipped],
                ...(job.mode === "sync" ? [[preview ? "would archive" : "archived", preview ? job.wouldArchive : job.archived]] : []),
                ...(job.restored ? [["restored", job.restored]] : []),
                ["dead-lettered", job.deadCount],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded border p-2"><dd className="text-lg font-semibold">{v}</dd><dt className="text-zinc-500">{k}</dt></div>
              ))}
            </dl>
            {job.changes.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold">Sample of changes</h3>
                <ul className="max-h-56 space-y-1 overflow-auto text-xs">
                  {job.changes.map((c: any, i: number) => (
                    <li key={i} className="flex items-start gap-2 rounded border p-1.5">
                      <Badge tone={KIND_TONE[c.kind as keyof typeof KIND_TONE]}>{c.kind}</Badge>
                      <span><b>{c.name}</b> <span className="text-zinc-400">#{c.sourceId}</span>{c.diff?.map((d: string) => <div key={d} className="font-mono text-[11px] text-zinc-600">{d}</div>)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {ready && <Button onClick={() => apply({ jobId: job.id })}>Apply these changes</Button>}
            {job.finishedAt && job.startedAt && !preview && <p className="text-xs text-zinc-500">{job.total} rows in {((job.finishedAt - job.startedAt) / 1000).toFixed(1)} s</p>}
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
