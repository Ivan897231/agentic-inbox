import { useEffect, useRef, useState } from "react";
import { ConvexReactClient, ConvexProvider, useQuery, useMutation, useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { DEMO_MESSAGES } from "../core/seed";

const url = import.meta.env.VITE_CONVEX_URL as string;
const client = new ConvexReactClient(url);
const state = makeFunctionReference<"query">("demo:state");
const seed = makeFunctionReference<"mutation">("demo:seed");
const simulate = makeFunctionReference<"action">("demo:simulate");

export default function LiveApp() {
  return <ConvexProvider client={client}><Live /></ConvexProvider>;
}

function Live() {
  const data = useQuery(state) as any;
  const doSeed = useMutation(seed);
  const doSim = useAction(simulate);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { void doSeed(); }, [doSeed]);

  const send = async (d: (typeof DEMO_MESSAGES)[number]) => {
    await doSim({ channel: d.channel, externalId: `live-${Math.random().toString(36).slice(2)}`, from: d.from, body: d.body });
  };
  const dupId = useRef(`live-dup-${Date.now()}`);
  const sendDup = () => doSim({ channel: "sms", externalId: dupId.current, from: "+447700900123", body: "Quiet hours?" }).then((r: any) => r.duplicate && alert("Duplicate delivery ignored (idempotent)"));

  const convs = data?.conversations ?? [];
  const conv = convs.find((c: any) => c._id === sel) ?? convs[0];
  return (
    <div className="mx-auto flex h-screen max-w-7xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Unified Inbox <span className="text-emerald-600">· live on Convex</span></h1>
          <p className="text-sm text-zinc-500">Real database + real-time queries + scheduled agent action.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {DEMO_MESSAGES.map((d) => <button key={d.label} onClick={() => send(d)} className="rounded border bg-white px-2 py-1 text-xs hover:bg-zinc-100">{d.label}</button>)}
          <button onClick={sendDup} className="rounded border bg-white px-2 py-1 text-xs hover:bg-zinc-100">↻ Send same SMS twice</button>
        </div>
      </header>
      {!data ? <p className="text-sm text-zinc-500">Connecting…</p> : (
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[280px_1fr_340px]">
          <section className="overflow-auto rounded-lg border bg-white">
            {convs.length === 0 && <p className="p-4 text-sm text-zinc-500">Empty. Click a message button above.</p>}
            {convs.map((c: any) => (
              <button key={c._id} onClick={() => setSel(c._id)} className={`block w-full border-b p-3 text-left hover:bg-zinc-50 ${conv?._id === c._id ? "bg-zinc-100" : ""}`}>
                <div className="flex justify-between"><b className="truncate">{c.name ?? c.party}</b><span className="text-[10px]">{c.channel}</span></div>
                <div className={`text-[10px] ${c.status === "needs_human" ? "text-red-600" : "text-zinc-500"}`}>{c.status.replace("_", " ")}</div>
              </button>
            ))}
          </section>
          <section className="overflow-auto rounded-lg border bg-white p-4">
            {conv?.messages.map((m: any) => (
              <div key={m._id} className={`mb-2 max-w-[80%] rounded-lg px-3 py-2 text-sm ${m.direction === "in" ? "bg-zinc-100" : "ml-auto bg-zinc-900 text-white"}`}>{m.body}</div>
            ))}
            {conv && conv.messages.length > 0 && conv.messages.every((m: any) => m.direction === "in") && conv.status === "open" && <p className="text-xs text-zinc-400">Agent is working…</p>}
          </section>
          <aside className="overflow-auto rounded-lg border bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold">Agent trace</h2>
            {conv?.runs.map((r: any) => r.steps.map((s: any, i: number) => (
              <div key={i} className="mb-2 rounded border bg-zinc-50 p-2 font-mono text-[11px]"><b>{s.name ?? s.kind}</b>
                {s.result !== undefined && <div className="break-words text-emerald-700">→ {JSON.stringify(s.result)}</div>}</div>
            )))}
            <h2 className="mb-1 mt-4 text-sm font-semibold">Tickets ({data.tickets.length})</h2>
            {data.tickets.map((t: any) => <div key={t._id} className={`text-xs ${t.urgency === "emergency" ? "font-semibold text-red-600" : ""}`}>{t.summary}</div>)}
          </aside>
        </div>
      )}
    </div>
  );
}
