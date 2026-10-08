import { runAgent, type Llm } from "./agent";
import { searchKb } from "./kb";
import type { Contact, InboundMessage, KbArticle, Ports, Ticket, Unit } from "./types";
import type { AgentResult } from "./agent";

export interface Message { id: string; conversationId: string; direction: "in" | "out"; channel: InboundMessage["channel"]; body: string; at: number; by?: "agent" | "human" }
export interface Conversation { id: string; contactId?: string; party: string; channel: InboundMessage["channel"]; status: "open" | "agent_handled" | "needs_human"; lastAt: number }

/** In-memory twin of the Convex tables. Drives the demo UI and the unit tests. */
export class MemoryStore {
  contacts: Contact[] = [];
  units: Unit[] = [];
  tickets: Ticket[] = [];
  kb: KbArticle[] = [];
  conversations: Conversation[] = [];
  messages: Message[] = [];
  runs: { conversationId: string; result: AgentResult }[] = [];
  private seen = new Set<string>();
  private n = 0;
  private id = (p: string) => `${p}_${++this.n}`;

  /** Idempotent ingest: provider retries (same channel+externalId) are no-ops. */
  async ingest(msg: InboundMessage, llm: Llm): Promise<{ duplicate: boolean; conversationId?: string }> {
    const key = `${msg.channel}:${msg.externalId}`;
    if (this.seen.has(key)) return { duplicate: true };
    this.seen.add(key);

    const contact = this.contacts.find((c) => c.phones.includes(msg.from) || c.emails.includes(msg.from));
    // Thread by (contact or raw address) + channel, reopening if previously handled.
    let conv = this.conversations.find((c) => c.party === msg.from && c.channel === msg.channel);
    if (!conv) {
      conv = { id: this.id("conv"), contactId: contact?.id, party: msg.from, channel: msg.channel, status: "open", lastAt: msg.receivedAt };
      this.conversations.unshift(conv);
    }
    conv.lastAt = msg.receivedAt;
    this.messages.push({ id: this.id("msg"), conversationId: conv.id, direction: "in", channel: msg.channel, body: msg.body, at: msg.receivedAt });

    const c = conv;
    const ports = this.ports(c);
    const result = await runAgent(msg, ports, llm);
    this.runs.push({ conversationId: c.id, result });
    c.status = result.escalated ? "needs_human" : "agent_handled";
    return { duplicate: false, conversationId: c.id };
  }

  ports(conv: Conversation): Ports {
    return {
      findContact: async (q) => this.contacts.find((c) => (q.phone && c.phones.includes(q.phone)) || (q.email && c.emails.includes(q.email))) ?? null,
      getUnit: async (id) => this.units.find((u) => u.id === id) ?? null,
      listOpenTickets: async (unitId) => this.tickets.filter((t) => t.unitId === unitId && t.status === "open"),
      createTicket: async (t) => { const x: Ticket = { ...t, id: `T-${1000 + this.tickets.length + 1}`, status: "open" }; this.tickets.push(x); return x; },
      searchKb: async (q, n) => searchKb(this.kb, q, n),
      sendReply: async (text) => { this.messages.push({ id: this.id("msg"), conversationId: conv.id, direction: "out", channel: conv.channel, body: text, at: Date.now(), by: "agent" }); },
      escalate: async () => { conv.status = "needs_human"; },
    };
  }
}
