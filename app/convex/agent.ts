import { actionGeneric, internalMutationGeneric, internalQueryGeneric } from "convex/server";
import { v } from "convex/values";
import { runAgent } from "../core/agent";
import { anthropicLlm, scriptedLlm } from "../core/llm";
import type { Ports } from "../core/types";

/** Runs the same `runAgent` loop as the tests; only the Ports + Llm are Convex-backed. */
export const run = actionGeneric({
  args: { conversationId: v.id("conversations"), from: v.string(), channel: v.string(), body: v.string() },
  handler: async (ctx, a) => {
    const q = (name: string, args: any) => ctx.runQuery(name as any, args) as Promise<any>;
    const mut = (name: string, args: any) => ctx.runMutation(name as any, args) as Promise<any>;
    const ports: Ports = {
      findContact: (x) => q("agentTools:findContact", x),
      getUnit: (id) => q("agentTools:getUnit", { id }),
      listOpenTickets: (unitId) => q("agentTools:openTickets", { unitId }),
      createTicket: (t) => mut("agentTools:createTicket", t),
      searchKb: (query, limit) => q("agentTools:searchKb", { query, limit }),
      sendReply: (text) => mut("agentTools:reply", { conversationId: a.conversationId, text }),
      escalate: (reason) => mut("agentTools:escalate", { conversationId: a.conversationId, reason }),
    };
    const key = process.env.ANTHROPIC_API_KEY;
    const llm = key ? anthropicLlm(key) : scriptedLlm();
    try {
      const r = await runAgent({ channel: a.channel as any, externalId: "", from: a.from, to: "", body: a.body, receivedAt: Date.now() }, ports, llm);
      await mut("agentTools:recordRun", { conversationId: a.conversationId, steps: r.steps, outcome: r.escalated ? "escalated" : "replied" });
    } catch (e) {
      // Never leave a customer message in limbo: failed run => a human sees it.
      await mut("agentTools:escalate", { conversationId: a.conversationId, reason: `Agent crashed: ${(e as Error).message}` });
      await mut("agentTools:recordRun", { conversationId: a.conversationId, steps: [], outcome: "failed" });
    }
  },
});
