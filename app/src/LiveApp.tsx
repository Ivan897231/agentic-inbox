import { useEffect, useState } from "react";
import { ConvexProvider, ConvexReactClient, useAction, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Inbox as InboxIcon, Database, Bot } from "lucide-react";
import { DEMO_MESSAGES } from "../core/seed";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardTitle } from "./components/ui/card";
import { Textarea } from "./components/ui/field";
import { Trace } from "./components/Trace";
import { Studio } from "./Studio";
import { Migration } from "./Migration";
import { cn } from "./lib/utils";

const client = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
export const ref = {
  state: makeFunctionReference<"query">("demo:state"),
  seed: makeFunctionReference<"mutation">("demo:seed"),
  simulate: makeFunctionReference<"action">("demo:simulate"),
  humanReply: makeFunctionReference<"mutation">("inbox:humanReply"),
  resolve: makeFunctionReference<"mutation">("inbox:resolve"),
  retry: makeFunctionReference<"mutation">("inbox:retryDelivery"),
  erase: makeFunctionReference<"mutation">("privacy:erasePerson"),
};

type Tab = "inbox" | "studio" | "migration";

export default function LiveApp() {
  return <ConvexProvider client={client}><Shell /></ConvexProvider>;
}

function Shell() {
  const [tab, setTab] = useState<Tab>("inbox");
  const seed = useMutation(ref.seed);
  useEffect(() => { void seed(); }, [seed]);
  const tabs: [Tab, string, typeof InboxIcon][] = [["inbox", "Inbox", InboxIcon], ["studio", "Agent Studio", Bot], ["migration", "Migration", Database]];
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Unified Inbox</h1>
          <Badge tone="green">live · Convex</Badge>
        </div>
        <nav className="flex gap-1 rounded-lg bg-zinc-100 p-1" aria-label="Sections">
          {tabs.map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)} aria-current={tab === id}
              className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm", tab === id ? "bg-white font-medium shadow-sm" : "text-zinc-600 hover:text-zinc-900")}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>
      </header>
      {tab === "inbox" && <InboxView />}
      {tab === "studio" && <Studio />}
      {tab === "migration" && <Migration />}
    </div>
  );
}

const CH_TONE = { whatsapp: "green", sms: "blue", email: "amber" } as const;
const DELIVERY: Record<string, { tone: "green" | "red" | "amber" | "neutral"; label: string }> = {
  sent: { tone: "green", label: "sent" }, pending: { tone: "amber", label: "sending…" }, failed: { tone: "red", label: "failed" }, skipped: { tone: "neutral", label: "not sent: no provider" },
};

function InboxView() {
  const data = useQuery(ref.state) as any;
  const simulate = useAction(ref.simulate);
  const humanReply = useMutation(ref.humanReply);
  const resolve = useMutation(ref.resolve);
  const retry = useMutation(ref.retry);
  const erase = useMutation(ref.erase);
  const [sel, setSel] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const convs: any[] = [...(data?.conversations ?? [])].sort(
    (a, b) => Number(b.status === "needs_human") - Number(a.status === "needs_human") || b.lastAt - a.lastAt,
  );
  const conv = convs.find((c) => c._id === sel) ?? convs[0];
  const urgent = convs.filter((c) => c.status === "needs_human").length;
  const run = conv?.runs?.at(-1);

  const send = async (d: (typeof DEMO_MESSAGES)[number]) => {
    const r: any = await simulate({ channel: d.channel, externalId: `live-${Math.random().toString(36).slice(2)}`, from: d.from, body: d.body });
    setNote(r.duplicate ? "Duplicate ignored" : null);
  };
  const sendDup = async () => {
    const r: any = await simulate({ channel: "sms", externalId: "fixed-dup-id", from: "+447700900123", body: "What are the quiet hours?" });
    setNote(r.duplicate ? "Duplicate delivery ignored: same provider message id, no second reply." : "First delivery processed. Click again to re-deliver the same message.");
  };

  if (!data) return <p className="text-sm text-zinc-500">Connecting…</p>;
  return (
    <>
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <span className="mr-1 text-xs font-medium text-zinc-500">Simulate inbound:</span>
        {DEMO_MESSAGES.map((d) => <Button key={d.label} size="sm" variant="outline" onClick={() => send(d)}>{d.label}</Button>)}
        <Button size="sm" variant="ghost" onClick={sendDup}>↻ Re-deliver same SMS</Button>
        {note && <span role="status" className="text-xs text-zinc-600">{note}</span>}
      </Card>

      <div className="grid min-h-[60vh] gap-4 lg:grid-cols-[280px_1fr_340px]">
        <Card className="max-h-[70vh] overflow-auto">
          <div className="flex items-center justify-between border-b p-3">
            <CardTitle>Conversations</CardTitle>
            {urgent > 0 && <Badge tone="red">{urgent} need you</Badge>}
          </div>
          {convs.length === 0 && <p className="p-4 text-sm text-zinc-500">Nothing yet. Use “Simulate inbound”.</p>}
          {convs.map((c) => (
            <button key={c._id} onClick={() => setSel(c._id)} className={cn("block w-full border-b p-3 text-left hover:bg-zinc-50", conv?._id === c._id && "bg-zinc-100")}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{c.name ?? c.party}</span>
                <Badge tone={CH_TONE[c.channel as keyof typeof CH_TONE]}>{c.channel}</Badge>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="truncate text-xs text-zinc-500">{c.messages.at(-1)?.body}</span>
                <Badge tone={c.status === "needs_human" ? "red" : c.status === "resolved" ? "neutral" : "green"}>{c.status.replace("_", " ")}</Badge>
              </div>
            </button>
          ))}
        </Card>

        <Card className="flex max-h-[70vh] flex-col">
          {!conv ? <p className="p-4 text-sm text-zinc-500">Select a conversation.</p> : (
            <>
              <div className="flex items-center justify-between border-b p-3">
                <div className="flex items-center gap-2 text-sm"><b>{conv.name ?? "Unknown sender"}</b>
                  {conv.role && <Badge tone={conv.role === "owner" ? "blue" : "neutral"}>{conv.role}</Badge>}
                  <span className="text-zinc-500">· {conv.party}</span></div>
                <div className="flex gap-2">
                  {conv.contactId && (
                    <Button size="sm" variant="ghost" title="GDPR right to erasure: removes this person's contact data and anonymises their messages"
                      onClick={async () => { if (window.confirm(`Erase all personal data for ${conv.name}? Their messages are anonymised and cannot be recovered.`)) { const r: any = await erase({ contactId: conv.contactId }); setNote(`Erased: ${r.messages} messages anonymised, ${r.runs} traces deleted.`); } }}>Erase data</Button>
                  )}
                  {conv.status !== "resolved" && <Button size="sm" variant="outline" onClick={() => resolve({ conversationId: conv._id })}>Mark resolved</Button>}
                </div>
              </div>
              <div className="flex-1 space-y-2 overflow-auto p-4">
                {conv.messages.map((m: any) => (
                  <div key={m._id} className={cn("max-w-[80%] rounded-lg px-3 py-2 text-sm", m.direction === "in" ? "bg-zinc-100" : "ml-auto bg-zinc-900 text-white")}>
                    {m.body}
                    {m.direction === "out" && (
                      <div className="mt-1 flex items-center gap-2 text-[10px] opacity-80">
                        <span>{m.by}</span>
                        {m.delivery && <Badge tone={DELIVERY[m.delivery].tone}>{DELIVERY[m.delivery].label}</Badge>}
                        {m.delivery === "failed" && <button className="underline" onClick={() => retry({ messageId: m._id })}>retry</button>}
                      </div>
                    )}
                    {m.deliveryNote && m.delivery !== "sent" && <div className="mt-1 text-[10px] opacity-60">{m.deliveryNote}</div>}
                  </div>
                ))}
                {conv.status === "open" && <p className="text-xs text-zinc-400">Agent is working…</p>}
                {conv.status === "needs_human" && (
                  <div role="alert" className="rounded-md bg-red-50 p-3 text-xs text-red-800">
                    <b>Needs a human.</b> {conv.escalationReason ?? "The agent escalated this conversation."}
                  </div>
                )}
              </div>
              <form className="flex gap-2 border-t p-3" onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; await humanReply({ conversationId: conv._id, text }); setText(""); }}>
                <Textarea aria-label="Reply" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply as a human…" />
                <Button type="submit" disabled={!text.trim()}>Send</Button>
              </form>
            </>
          )}
        </Card>

        <div className="flex max-h-[70vh] flex-col gap-4 overflow-auto">
          <Card className="p-4">
            <CardTitle className="mb-2">Agent trace</CardTitle>
            {run ? <Trace steps={run.steps} usage={run.usage} model={run.model} ms={run.ms} llmCalls={run.llmCalls} /> : <p className="text-sm text-zinc-500">No agent run for this conversation.</p>}
          </Card>
          <Card className="p-4">
            <CardTitle className="mb-2">Tickets ({data.tickets.length})</CardTitle>
            <ul className="space-y-1 text-xs">
              {data.tickets.map((t: any) => (
                <li key={t._id} className={cn(t.urgency === "emergency" && "font-semibold text-red-600")}>
                  {t.urgency === "emergency" && "🚨 "}{t.summary}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
