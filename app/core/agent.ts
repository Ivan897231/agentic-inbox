import type { InboundMessage, Ports, TicketCategory, Urgency } from "./types";

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string };

export interface ToolCall { id: string; name: string; args: Record<string, any> }
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
export interface LlmTurn { text: string; toolCalls: ToolCall[]; usage?: Usage }
export interface ToolDef { name: string; description: string; schema: Record<string, any> }

/** The only thing that changes between a real model and the offline demo model. */
export interface Llm {
  next(system: string, history: LlmMessage[], tools: ToolDef[]): Promise<LlmTurn>;
}

export interface TraceStep {
  kind: "tool" | "reply" | "escalate" | "limit";
  name?: string;
  args?: unknown;
  result?: unknown;
  ms: number;
}

export interface AgentResult { steps: TraceStep[]; replied: boolean; escalated: boolean; usage: Usage; llmCalls: number }

export interface AgentOptions { maxSteps?: number; systemPrompt?: string; enabledTools?: string[] }

export const DEFAULT_SYSTEM = `You are the first-line assistant for a property management company.
Identify the sender, check their unit's open tickets, search the knowledge base before answering,
create a ticket for anything that needs a technician, and escalate to a human for emergencies,
legal/billing disputes, or when unsure. Never invent policies. Reply in the sender's language, briefly.`;

export const TOOLS: ToolDef[] = [
  { name: "find_contact", description: "Look up the sender by phone/email.", schema: { type: "object", properties: {} } },
  { name: "list_open_tickets", description: "Open tickets for the sender's unit.", schema: { type: "object", properties: {} } },
  { name: "search_kb", description: "Search the knowledge base.", schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  {
    name: "create_ticket",
    description: "Open a ticket for a technician.",
    schema: {
      type: "object",
      properties: {
        category: { enum: ["maintenance", "billing", "access", "other"] },
        urgency: { enum: ["low", "normal", "emergency"] },
        summary: { type: "string" },
      },
      required: ["category", "urgency", "summary"],
    },
  },
  { name: "reply", description: "Send the reply to the sender. Ends the run.", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "escalate", description: "Hand over to a human. Ends the run.", schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
];

/**
 * Bounded tool loop. Guardrails: hard step cap, tool errors are fed back to the model
 * instead of crashing the run, and a run that hits the cap escalates to a human.
 */
export async function runAgent(msg: InboundMessage, ports: Ports, llm: Llm, opts: AgentOptions = {}): Promise<AgentResult> {
  const { maxSteps = 8, systemPrompt = DEFAULT_SYSTEM } = opts;
  // `reply` and `escalate` always stay available: a run must always be able to finish safely.
  const allowed = new Set([...(opts.enabledTools ?? TOOLS.map((t) => t.name)), "reply", "escalate"]);
  const tools = TOOLS.filter((t) => allowed.has(t.name));
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let llmCalls = 0;
  const steps: TraceStep[] = [];
  const history: LlmMessage[] = [{ role: "user", content: msg.subject ? `${msg.subject}\n\n${msg.body}` : msg.body }];
  let contactId: string | undefined, unitId: string | undefined;

  for (let i = 0; i < maxSteps; i++) {
    const turn = await llm.next(systemPrompt, history, tools);
    llmCalls++;
    if (turn.usage) {
      usage.inputTokens += turn.usage.inputTokens;
      usage.outputTokens += turn.usage.outputTokens;
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (turn.usage.cacheReadTokens ?? 0);
    }
    history.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });
    if (!turn.toolCalls.length) { // model answered without a tool: treat as the reply
      const t0 = Date.now();
      await ports.sendReply(turn.text);
      steps.push({ kind: "reply", args: { text: turn.text }, ms: Date.now() - t0 });
      return { steps, replied: true, escalated: false, usage, llmCalls };
    }
    for (const call of turn.toolCalls) {
      const t0 = Date.now();
      const done = (kind: TraceStep["kind"], result?: unknown) =>
        steps.push({ kind, name: call.name, args: call.args, result, ms: Date.now() - t0 });
      try {
        let result: unknown;
        if (!allowed.has(call.name) && TOOLS.some((t) => t.name === call.name)) throw new Error(`tool ${call.name} is disabled for this agent`);
        switch (call.name) {
          case "find_contact": {
            const c = await ports.findContact(msg.channel === "email" ? { email: msg.from } : { phone: msg.from });
            contactId = c?.id; unitId = c?.unitId;
            const unit = unitId ? await ports.getUnit(unitId) : null;
            result = c ? { name: c.name, role: c.role, unit: unit && `${unit.building} ${unit.label}` } : { found: false };
            break;
          }
          case "list_open_tickets":
            result = unitId ? (await ports.listOpenTickets(unitId)).map((t) => ({ id: t.id, summary: t.summary, urgency: t.urgency })) : [];
            break;
          case "search_kb":
            result = (await ports.searchKb(String(call.args.query), 3)).map((a) => ({ title: a.title, body: a.body }));
            break;
          case "create_ticket": {
            const t = await ports.createTicket({
              unitId, contactId,
              category: call.args.category as TicketCategory,
              urgency: call.args.urgency as Urgency,
              summary: String(call.args.summary),
            });
            result = { ticketId: t.id };
            break;
          }
          case "reply":
            await ports.sendReply(String(call.args.text));
            done("reply");
            return { steps, replied: true, escalated: false, usage, llmCalls };
          case "escalate":
            await ports.escalate(String(call.args.reason));
            done("escalate");
            return { steps, replied: false, escalated: true, usage, llmCalls };
          default:
            throw new Error(`unknown tool ${call.name}`);
        }
        done("tool", result);
        history.push({ role: "tool", callId: call.id, name: call.name, content: JSON.stringify(result) });
      } catch (e) {
        const err = { error: (e as Error).message };
        done("tool", err);
        history.push({ role: "tool", callId: call.id, name: call.name, content: JSON.stringify(err) });
      }
    }
  }
  await ports.escalate("Agent hit step limit");
  steps.push({ kind: "limit", ms: 0 });
  return { steps, replied: false, escalated: true, usage, llmCalls };
}
