import type { Ports, Ticket } from "./types";

export interface SandboxEffect { kind: "reply" | "escalate" | "ticket"; detail: unknown }

/**
 * Wraps real Ports so an agent can be tried against live data (contacts, units, KB) with
 * every side effect captured instead of executed. This is what makes "train your agent
 * safely" possible: reads are real, writes are recorded.
 */
export function dryRunPorts(base: Ports): { ports: Ports; effects: SandboxEffect[] } {
  const effects: SandboxEffect[] = [];
  let n = 0;
  return {
    effects,
    ports: {
      ...base,
      createTicket: async (t) => {
        const ticket: Ticket = { ...t, id: `DRY-${++n}`, status: "open" };
        effects.push({ kind: "ticket", detail: ticket });
        return ticket;
      },
      sendReply: async (text) => { effects.push({ kind: "reply", detail: text }); },
      escalate: async (reason) => { effects.push({ kind: "escalate", detail: reason }); },
    },
  };
}
