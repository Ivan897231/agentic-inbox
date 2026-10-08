import { actionGeneric } from "convex/server";
import { v } from "convex/values";
import { runAgent } from "../core/agent";
import { anthropicLlm, scriptedLlm } from "../core/llm";
import { dryRunPorts } from "../core/sandbox";
import type { Ports } from "../core/types";

const channelV = v.union(v.literal("email"), v.literal("whatsapp"), v.literal("sms"));

function bind(ctx: any, conversationId?: string): Ports {
  const q = (name: string, args: any) => ctx.runQuery(name as any, args) as Promise<any>;
  const mut = (name: string, args: any) => ctx.runMutation(name as any, args) as Promise<any>;
  return {
    findContact: (x) => q("agentTools:findContact", x),
    getUnit: (id) => q("agentTools:getUnit", { id }),
    listOpenTickets: (unitId) => q("agentTools:openTickets", { unitId }),
    createTicket: (t) => mut("agentTools:createTicket", t),
    searchKb: (query, limit) => q("agentTools:searchKb", { query, limit }),
    sendReply: (text) => mut("agentTools:reply", { conversationId, text }),
    escalate: (reason) => mut("agentTools:escalate", { conversationId, reason }),
  };
}

/** Real model when ANTHROPIC_API_KEY is set; otherwise the scripted stand-in (so demos never break). */
function pickLlm(modelOverride: string | null) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = modelOverride ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
  return key ? { llm: anthropicLlm(key, { model }), model, live: true } : { llm: scriptedLlm(), model: "scripted", live: false };
}

/** Runs once per inbound message, scheduled by `ingest:receive` so the webhook can return immediately. */
export const run = actionGeneric({
  args: { conversationId: v.id("conversations"), from: v.string(), channel: channelV, body: v.string() },
  handler: async (ctx, a) => {
    const t0 = Date.now();
    const mut = (name: string, args: any) => ctx.runMutation(name as any, args) as Promise<any>;
    const cfg = await ctx.runQuery("agentTools:getConfig" as any, {}) as any;
    const { llm, model } = pickLlm(cfg.model);
    try {
      const r = await runAgent(
        { channel: a.channel, externalId: "", from: a.from, to: "", body: a.body, receivedAt: Date.now() },
        bind(ctx, a.conversationId), llm,
        { maxSteps: cfg.maxSteps, systemPrompt: cfg.systemPrompt, enabledTools: cfg.enabledTools },
      );
      await mut("agentTools:recordRun", { conversationId: a.conversationId, steps: r.steps, outcome: r.escalated ? "escalated" : "replied", usage: r.usage, llmCalls: r.llmCalls, model, ms: Date.now() - t0 });
    } catch (e) {
      // Never leave a customer message in limbo: a failed run puts it in front of a human.
      await mut("agentTools:escalate", { conversationId: a.conversationId, reason: `Agent crashed: ${(e as Error).message}` });
      await mut("agentTools:recordRun", { conversationId: a.conversationId, steps: [{ kind: "limit", name: "crash", result: (e as Error).message, ms: 0 }], outcome: "failed", model, ms: Date.now() - t0 });
    }
  },
});

/**
 * Agent Studio sandbox: runs the *current draft config* against live read-only data
 * ("pretend I am this phone number and I wrote this") and returns the trace + captured effects.
 * Nothing is written, nothing is sent.
 */
export const sandbox = actionGeneric({
  args: {
    from: v.string(), channel: channelV, body: v.string(),
    draft: v.object({ systemPrompt: v.string(), enabledTools: v.array(v.string()), maxSteps: v.number() }),
  },
  handler: async (ctx, a) => {
    const t0 = Date.now();
    const cfg = await ctx.runQuery("agentTools:getConfig" as any, {}) as any;
    const { llm, model, live } = pickLlm(cfg.model);
    const { ports, effects } = dryRunPorts(bind(ctx));
    const r = await runAgent({ channel: a.channel, externalId: "", from: a.from, to: "", body: a.body, receivedAt: Date.now() }, ports, llm, a.draft);
    return { steps: r.steps, effects, usage: r.usage, llmCalls: r.llmCalls, model, live, ms: Date.now() - t0 };
  },
});
