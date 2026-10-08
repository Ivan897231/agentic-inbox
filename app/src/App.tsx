import { useMemo, useRef, useState } from "react";
import { scriptedLlm } from "../core/llm";
import { seedStore, DEMO_MESSAGES } from "../core/seed";
import { fromEmail, fromTwilio } from "../core/normalize";
import { importTick, newImportState, type ImportState } from "../core/importer";
import type { InboundMessage } from "../core/types";

const CHANNEL: Record<string, string> = { whatsapp: "bg-emerald-100 text-emerald-800", sms: "bg-sky-100 text-sky-800", email: "bg-amber-100 text-amber-800" };
const STATUS: Record<string, string> = { needs_human: "bg-red-100 text-red-700", agent_handled: "bg-emerald-100 text-emerald-700", open: "bg-zinc-100 text-zinc-600" };

export default function App() {
  const store = useRef(seedStore()).current;
  const [, tick] = useState(0);
  const rerender = () => tick((n) => n + 1);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const menu = useRef<HTMLDetailsElement>(null);

  async function send(d: (typeof DEMO_MESSAGES)[number], replay = false) {
    menu.current?.removeAttribute("open");
    setBusy(true);
    const id = replay && seq.current ? `demo-${seq.current}` : `demo-${++seq.current}`;
    // Go through the real normalizers, exactly like the webhooks do.
    const m: InboundMessage =
      d.channel === "email"
        ? fromEmail({ MessageID: id, From: d.from, To: "support@acme-pm.com", Subject: (d as any).subject, TextBody: d.body })
        : fromTwilio({ MessageSid: id, From: d.channel === "whatsapp" ? `whatsapp:${d.from}` : d.from, To: "+10000000000", Body: d.body });
    const r = await store.ingest(m, scriptedLlm());
    if (!r.duplicate) setSel(r.conversationId!);
    setBusy(false);
    rerender();
    if (r.duplicate) alert("Duplicate delivery ignored (idempotent on channel + provider message id)");
  }

  const conv = store.conversations.find((c) => c.id === sel);
  const msgs = store.messages.filter((m) => m.conversationId === sel);
  const runs = store.runs.filter((r) => r.conversationId === sel);
  const contact = (id?: string) => store.contacts.find((c) => c.id === id);
  const rank = (s: string) => (s === "needs_human" ? 0 : 1);
  const list = [...store.conversations].sort((a, b) => rank(a.status) - rank(b.status) || b.lastAt - a.lastAt);

  return (
    <div className="mx-auto flex h-screen max-w-7xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Unified Inbox <span className="text-zinc-400">· agent demo</span></h1>
          <p className="text-sm text-zinc-500">WhatsApp / SMS / email → one pipeline → tool-using agent. Runs fully in-browser (scripted model); same code runs in Convex.</p>
        </div>
        <details ref={menu} className="relative">
          <summary className="cursor-pointer rounded-md bg-zinc-900 px-3 py-2 text-sm text-white">Simulate inbound ▾</summary>
          <div className="absolute right-0 z-10 mt-1 w-80 rounded-md border bg-white p-1 shadow-lg">
            {DEMO_MESSAGES.map((d) => (
              <button key={d.label} disabled={busy} onClick={() => send(d)} className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-zinc-100">{d.label}</button>
            ))}
            <button onClick={() => send(DEMO_MESSAGES[0], true)} className="block w-full rounded border-t px-3 py-2 text-left text-sm text-zinc-500 hover:bg-zinc-100">↻ Re-deliver last message (provider retry)</button>
          </div>
        </details>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[280px_1fr_340px]">
        <section className="overflow-auto rounded-lg border bg-white">
          {list.length === 0 && <p className="p-4 text-sm text-zinc-500">No conversations yet. Use “Simulate inbound”.</p>}
          {list.map((c) => (
            <button key={c.id} onClick={() => setSel(c.id)} className={`block w-full border-b p-3 text-left hover:bg-zinc-50 ${sel === c.id ? "bg-zinc-100" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{contact(c.contactId)?.name ?? c.party}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${CHANNEL[c.channel]}`}>{c.channel}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="truncate text-xs text-zinc-500">{[...store.messages].reverse().find((m) => m.conversationId === c.id)?.body}</span>
                <span className={`ml-2 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${STATUS[c.status]}`}>{c.status.replace("_", " ")}</span>
              </div>
            </button>
          ))}
        </section>

        <section className="flex min-h-0 flex-col overflow-auto rounded-lg border bg-white p-4">
          {!conv ? <p className="text-sm text-zinc-500">Select a conversation.</p> : (
            <>
              <div className="mb-3 text-sm text-zinc-500">{contact(conv.contactId)?.name ?? "Unknown sender"} · {conv.party}</div>
              <div className="flex flex-col gap-2">
                {msgs.map((m) => (
                  <div key={m.id} className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${m.direction === "in" ? "self-start bg-zinc-100" : "self-end bg-zinc-900 text-white"}`}>
                    {m.body}
                    {m.by === "agent" && <div className="mt-1 text-[10px] opacity-60">sent by agent</div>}
                  </div>
                ))}
                {conv.status === "needs_human" && <div className="self-center rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">Escalated to a human. Agent did not reply.</div>}
              </div>
            </>
          )}
        </section>

        <aside className="flex min-h-0 flex-col gap-4 overflow-auto">
          <div className="rounded-lg border bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold">Agent trace</h2>
            {!runs.length && <p className="text-sm text-zinc-500">Nothing yet.</p>}
            {runs.map((r, i) => (
              <ol key={i} className="space-y-2">
                {r.result.steps.map((s, j) => (
                  <li key={j} className="rounded border bg-zinc-50 p-2 font-mono text-[11px]">
                    <div className="flex justify-between"><b>{s.name ?? s.kind}</b><span className="text-zinc-400">{s.ms}ms</span></div>
                    {s.args !== undefined && <div className="truncate text-zinc-600">{JSON.stringify(s.args)}</div>}
                    {s.result !== undefined && <div className="text-emerald-700 break-words">→ {JSON.stringify(s.result)}</div>}
                  </li>
                ))}
              </ol>
            ))}
          </div>
          <TicketsPanel tickets={store.tickets} />
          <ImportPanel />
        </aside>
      </div>
    </div>
  );
}

function TicketsPanel({ tickets }: { tickets: { id: string; urgency: string; summary: string }[] }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <h2 className="mb-2 text-sm font-semibold">Tickets ({tickets.length})</h2>
      <ul className="space-y-1 text-xs">
        {tickets.map((t) => (
          <li key={t.id} className="flex gap-2"><span className="font-mono text-zinc-500">{t.id}</span>
            <span className={t.urgency === "emergency" ? "font-semibold text-red-600" : ""}>{t.summary}</span></li>
        ))}
      </ul>
    </div>
  );
}

/** Live demo of the resumable importer: 5k records, flaky + poison rows, batch ticks. */
function ImportPanel() {
  const [st, setSt] = useState<ImportState>(newImportState());
  const [running, setRunning] = useState(false);
  const total = 5000;
  const db = useMemo(() => new Set<string>(), []);
  const flaky = useRef(new Map<string, number>());

  async function run() {
    setRunning(true);
    let s = newImportState(); db.clear(); flaky.current.clear();
    const source = {
      async page(cursor: string | null, limit: number) {
        const a = cursor ? Number(cursor) : 0, b = Math.min(total, a + limit);
        return { items: Array.from({ length: b - a }, (_, i) => ({ sourceId: `rec${a + i}`, data: a + i })), next: b >= total ? null : String(b) };
      },
    };
    const upsert = async (id: string, n: number) => {
      if (n % 997 === 0 && n > 0) { const k = flaky.current.get(id) ?? 0; flaky.current.set(id, k + 1); if (k < 2) throw new Error("upstream timeout"); }
      if (n % 1999 === 0 && n > 0) throw new Error("malformed record");
      if (db.has(id)) return "unchanged" as const;
      db.add(id); return "created" as const;
    };
    while (!s.done) {
      const r = await importTick(s, source, upsert, { batch: 250, maxAttempts: 3 });
      s = r.state; setSt(s);
      await new Promise((res) => setTimeout(res, 60)); // (real backoff is skipped in the demo)
    }
    setRunning(false);
  }
  const pct = Math.round(((st.imported + st.skipped + st.dead.length) / total) * 100);
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Migration importer</h2>
        <button disabled={running} onClick={run} className="rounded bg-zinc-900 px-2 py-1 text-xs text-white disabled:opacity-40">{running ? "Running…" : "Import 5,000 records"}</button>
      </div>
      <div className="h-2 overflow-hidden rounded bg-zinc-100"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} /></div>
      <p className="mt-2 text-xs text-zinc-600">{st.imported} imported · {st.skipped} skipped · {st.dead.length} dead-lettered · {Object.keys(st.retry).length} retrying</p>
      {st.dead.map((d) => <p key={d.sourceId} className="text-[11px] text-red-600">{d.sourceId}: {d.error}</p>)}
    </div>
  );
}
