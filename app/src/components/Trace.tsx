import { Badge } from "./ui/badge";

export interface Step { kind: string; name?: string; args?: unknown; result?: unknown; ms: number }
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number }

const TONE: Record<string, "neutral" | "green" | "red" | "amber"> = { reply: "green", escalate: "red", limit: "amber" };

/** Compact, readable step list: what the agent called, with what, and what it got back. */
export function Trace({ steps, usage, model, ms, llmCalls }: { steps: Step[]; usage?: Usage; model?: string; ms?: number; llmCalls?: number }) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
        {model && <Badge tone={model === "scripted" ? "neutral" : "blue"}>{model}</Badge>}
        {llmCalls !== undefined && <span>{llmCalls} model calls</span>}
        {usage && usage.inputTokens > 0 && <span>· {usage.inputTokens} in / {usage.outputTokens} out{usage.cacheReadTokens ? ` · ${usage.cacheReadTokens} cached` : ""}</span>}
        {ms !== undefined && <span>· {ms} ms</span>}
      </div>
      <ol className="space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-[11px] leading-snug">
            <div className="flex items-center justify-between gap-2">
              <Badge tone={TONE[s.kind] ?? "neutral"}>{s.name ?? s.kind}</Badge>
              <span className="text-zinc-400">{s.ms} ms</span>
            </div>
            {s.args !== undefined && JSON.stringify(s.args) !== "{}" && <div className="mt-1 break-words text-zinc-600">{JSON.stringify(s.args)}</div>}
            {s.result !== undefined && <div className="mt-1 break-words text-emerald-700">→ {JSON.stringify(s.result)}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
