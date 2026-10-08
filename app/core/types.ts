export type Channel = "email" | "whatsapp" | "sms";

/** Provider-agnostic inbound message. Every integration normalizes to this. */
export interface InboundMessage {
  channel: Channel;
  /** Provider message id, the idempotency key together with `channel`. */
  externalId: string;
  from: string; // E.164 phone or lowercased email
  to: string;
  subject?: string;
  body: string;
  receivedAt: number;
}

export interface Contact {
  id: string;
  name: string;
  phones: string[];
  emails: string[];
  unitId?: string;
  role: "tenant" | "owner" | "vendor";
}

export interface Unit {
  id: string;
  building: string;
  label: string;
}

export type TicketCategory = "maintenance" | "billing" | "access" | "other";
export type Urgency = "low" | "normal" | "emergency";

export interface Ticket {
  id: string;
  unitId?: string;
  contactId?: string;
  category: TicketCategory;
  urgency: Urgency;
  summary: string;
  status: "open" | "closed";
}

export interface KbArticle {
  id: string;
  title: string;
  body: string;
}

/** What the agent is allowed to touch. Implemented by Convex ctx or by the in-memory store. */
export interface Ports {
  findContact(q: { phone?: string; email?: string }): Promise<Contact | null>;
  getUnit(id: string): Promise<Unit | null>;
  listOpenTickets(unitId: string): Promise<Ticket[]>;
  createTicket(t: Omit<Ticket, "id" | "status">): Promise<Ticket>;
  searchKb(query: string, limit: number): Promise<KbArticle[]>;
  sendReply(text: string): Promise<void>;
  escalate(reason: string): Promise<void>;
}
