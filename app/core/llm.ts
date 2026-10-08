import type { Llm, LlmMessage, LlmTurn, ToolCall, ToolDef } from "./agent";

/** Real model over the Anthropic Messages API (plain fetch: works in Convex actions). */
export function anthropicLlm(apiKey: string, model = "claude-sonnet-5-5"): Llm {
  return {
    async next(system, history, tools): Promise<LlmTurn> {
      const messages: any[] = [];
      for (const m of history) {
        if (m.role === "user") messages.push({ role: "user", content: m.content });
        else if (m.role === "assistant")
          messages.push({
            role: "assistant",
            content: [
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
            ],
          });
        else {
          const block = { type: "tool_result", tool_use_id: m.callId, content: m.content };
          const last = messages[messages.length - 1];
          if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
          else messages.push({ role: "user", content: [block] });
        }
      }
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model, max_tokens: 1024, system, messages,
          tools: tools.map((t: ToolDef) => ({ name: t.name, description: t.description, input_schema: t.schema })),
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      const j: any = await res.json();
      return {
        text: j.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(""),
        toolCalls: j.content.filter((b: any) => b.type === "tool_use").map((b: any): ToolCall => ({ id: b.id, name: b.name, args: b.input })),
      };
    },
  };
}

const EMERGENCY = /(gas|smell of gas|fire|flood|water.*(ceiling|pouring)|burst|no heat.*(freez|baby)|carbon monoxide|gasgeruch|wasserrohrbruch|feuer)/i;
const MAINT = /(leak|broken|heating|heater|boiler|mold|mould|lock|door|window|light|elevator|lift|noise|kaputt|heizung|defekt|tropft)/i;
const BILLING = /(rent|invoice|deposit|payment|charge|miete|rechnung|kaution)/i;
const ACCESS = /(key|keys|locked out|access|schlüssel|fob)/i;

/**
 * Deterministic stand-in so the demo (and the tests) run with no API key.
 * It plays a believable policy: identify -> check tickets -> KB -> act -> reply/escalate.
 */
export function scriptedLlm(): Llm {
  return {
    async next(_s, history: LlmMessage[]): Promise<LlmTurn> {
      const text = (history[0] as { content: string }).content;
      const called = (n: string) => history.some((m) => m.role === "tool" && m.name === n);
      const result = (n: string) => {
        const m = history.find((m) => m.role === "tool" && m.name === n) as { content: string } | undefined;
        return m ? JSON.parse(m.content) : undefined;
      };
      const call = (name: string, args: Record<string, any> = {}): LlmTurn => ({ text: "", toolCalls: [{ id: `${name}-${history.length}`, name, args }] });

      if (!called("find_contact")) return call("find_contact");
      const who = result("find_contact");
      if (who?.found === false) return call("escalate", { reason: "Unknown sender: cannot verify identity" });
      if (EMERGENCY.test(text)) {
        if (!called("create_ticket")) return call("create_ticket", { category: "maintenance", urgency: "emergency", summary: text.slice(0, 140) });
        return call("escalate", { reason: "Emergency keywords detected; ticket created, on-call paged" });
      }
      if (!called("list_open_tickets")) return call("list_open_tickets");
      if (!called("search_kb")) return call("search_kb", { query: text });
      const kb = result("search_kb") as { title: string; body: string }[];
      const dup = (result("list_open_tickets") as { summary: string }[]).find((t) => MAINT.test(t.summary) && MAINT.test(text));
      if (BILLING.test(text) && !MAINT.test(text)) return call("escalate", { reason: "Billing question: needs a human" });
      if (dup) return call("reply", { text: `Hi ${who.name}, we already have an open ticket for this (“${dup.summary}”). A technician will be in touch; no need to report it again.` });
      if ((MAINT.test(text) || ACCESS.test(text)) && !called("create_ticket")) {
        return call("create_ticket", { category: ACCESS.test(text) ? "access" : "maintenance", urgency: "normal", summary: text.slice(0, 140) });
      }
      const ticket = result("create_ticket");
      const tip = kb?.[0] ? ` ${kb[0].body}` : "";
      return call("reply", { text: `Hi ${who.name}, thanks for letting us know.${ticket ? ` I opened ticket ${ticket.ticketId} for ${who.unit}.` : ""}${tip}` });
    },
  };
}
