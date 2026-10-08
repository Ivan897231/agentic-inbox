import { describe, expect, it, vi } from "vitest";
import { anthropicLlm, scriptedLlm } from "../core/llm";
import { runAgent, TOOLS } from "../core/agent";
import { dryRunPorts } from "../core/sandbox";
import { nextDelivery, sendOutbound } from "../core/outbound";
import { mapContacts, parseCsv, sampleCsv } from "../core/csv";
import { seedStore } from "../core/seed";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const inbound = { channel: "sms" as const, externalId: "1", from: "+447700900123", to: "x", body: "The heating is broken", receivedAt: 1 };

describe("anthropicLlm", () => {
  const okBody = { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "find_contact", input: {} }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8 } };

  it("builds a cacheable request and parses text, tool calls and usage", async () => {
    const f = vi.fn(async () => json(okBody));
    const llm = anthropicLlm("k", { fetchImpl: f as any, model: "m1" });
    const turn = await llm.next("SYS", [{ role: "user", content: "yo" }], TOOLS);
    const [url, init] = f.mock.calls[0] as any;
    const sent = JSON.parse(init.body);
    expect(url).toContain("/v1/messages");
    expect(init.headers["x-api-key"]).toBe("k");
    expect(sent.model).toBe("m1");
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sent.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(sent.tools.slice(0, -1).every((t: any) => !t.cache_control)).toBe(true);
    expect(turn.toolCalls).toEqual([{ id: "t1", name: "find_contact", args: {} }]);
    expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 8 });
  });

  it("merges consecutive tool results into one user message", async () => {
    const f = vi.fn(async () => json(okBody));
    await anthropicLlm("k", { fetchImpl: f as any }).next("s", [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "x", args: {} }, { id: "b", name: "y", args: {} }] },
      { role: "tool", callId: "a", name: "x", content: "1" },
      { role: "tool", callId: "b", name: "y", content: "2" },
    ], TOOLS);
    const msgs = JSON.parse((f.mock.calls[0] as any)[1].body).messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[2].content.map((c: any) => c.tool_use_id)).toEqual(["a", "b"]);
  });

  it("retries 429 with retry-after, then succeeds; gives up on 400", async () => {
    const sleep = vi.fn(async () => {});
    const f = vi.fn().mockResolvedValueOnce(json({}, 429, { "retry-after": "2" })).mockResolvedValueOnce(json({}, 529)).mockResolvedValueOnce(json(okBody));
    await anthropicLlm("k", { fetchImpl: f as any, sleep }).next("s", [{ role: "user", content: "q" }], TOOLS);
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[0][0]).toBe(2000);
    const bad = vi.fn(async () => json({ error: "nope" }, 400));
    await expect(anthropicLlm("k", { fetchImpl: bad as any, sleep }).next("s", [{ role: "user", content: "q" }], TOOLS)).rejects.toThrow(/400/);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe("agent options", () => {
  it("disabled tools are hidden from the model and rejected if called anyway", async () => {
    const s = seedStore();
    let seenTools: string[] = [];
    let n = 0;
    const llm = { next: async (_s: string, _h: any, tools: any[]) => { seenTools = tools.map((t) => t.name); return n++ === 0 ? { text: "", toolCalls: [{ id: "1", name: "create_ticket", args: { category: "other", urgency: "low", summary: "x" } }] } : { text: "done", toolCalls: [] }; } };
    const r = await runAgent(inbound, s.ports(s.conversations[0] ?? { id: "c", party: "p", channel: "sms", status: "open", lastAt: 0 }), llm, { enabledTools: ["find_contact"] });
    expect(seenTools).not.toContain("create_ticket");
    expect(seenTools).toContain("reply"); // can always finish
    expect(r.steps[0].result).toEqual({ error: "tool create_ticket is disabled for this agent" });
    expect(s.tickets).toHaveLength(1); // only the seeded one
  });

  it("uses the custom system prompt and accumulates usage", async () => {
    const s = seedStore();
    const seen: string[] = [];
    let n = 0;
    const llm = { next: async (sys: string) => { seen.push(sys); return n++ === 0 ? { text: "", toolCalls: [{ id: "1", name: "find_contact", args: {} }], usage: { inputTokens: 100, outputTokens: 10 } } : { text: "hello", toolCalls: [], usage: { inputTokens: 150, outputTokens: 20, cacheReadTokens: 90 } }; } };
    const r = await runAgent(inbound, s.ports({ id: "c", party: "p", channel: "sms", status: "open", lastAt: 0 }), llm, { systemPrompt: "BE BRIEF" });
    expect(seen).toEqual(["BE BRIEF", "BE BRIEF"]);
    expect(r.usage).toEqual({ inputTokens: 250, outputTokens: 30, cacheReadTokens: 90 });
    expect(r.llmCalls).toBe(2);
  });
});

describe("sandbox", () => {
  it("reads real data but captures writes", async () => {
    const s = seedStore();
    const { ports, effects } = dryRunPorts(s.ports({ id: "c", party: "p", channel: "sms", status: "open", lastAt: 0 }));
    const r = await runAgent({ ...inbound, body: "I smell gas" }, ports, scriptedLlm());
    expect(r.escalated).toBe(true);
    expect(effects.map((e) => e.kind)).toEqual(["ticket", "escalate"]);
    expect(s.tickets).toHaveLength(1);
    expect(s.messages).toHaveLength(0);
    expect(s.conversations).toHaveLength(0);
  });
});

describe("outbound", () => {
  const tw = { accountSid: "AC1", authToken: "tok", smsFrom: "+1555", whatsappFrom: "whatsapp:+1555" };
  it("sends whatsapp through Twilio with basic auth and prefixed numbers", async () => {
    const f = vi.fn(async () => json({ sid: "SM9" }, 201));
    const r = await sendOutbound({ twilio: tw }, { channel: "whatsapp", to: "+4915112345678", body: "hi" }, f as any);
    const [url, init] = f.mock.calls[0] as any;
    expect(r).toEqual({ ok: true, providerId: "SM9" });
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect(init.headers.authorization).toBe(`Basic ${btoa("AC1:tok")}`);
    expect(new URLSearchParams(init.body).get("To")).toBe("whatsapp:+4915112345678");
  });
  it("skips (not fails) when no provider is configured", async () => {
    expect(await sendOutbound({}, { channel: "sms", to: "+1", body: "x" })).toMatchObject({ ok: "skipped" });
    expect(await sendOutbound({}, { channel: "email", to: "a@b.c", body: "x" })).toMatchObject({ ok: "skipped" });
  });
  it("classifies failures as retryable or permanent", async () => {
    const mk = (status: number) => sendOutbound({ twilio: tw }, { channel: "sms", to: "+1", body: "x" }, (async () => new Response("e", { status })) as any);
    expect(await mk(503)).toMatchObject({ ok: false, retryable: true });
    expect(await mk(429)).toMatchObject({ ok: false, retryable: true });
    expect(await mk(400)).toMatchObject({ ok: false, retryable: false });
    const net = await sendOutbound({ twilio: tw }, { channel: "sms", to: "+1", body: "x" }, (async () => { throw new Error("ECONNRESET"); }) as any);
    expect(net).toMatchObject({ ok: false, retryable: true });
  });
  it("gives up after max attempts or on permanent errors", () => {
    expect(nextDelivery(1, { ok: false, error: "e", retryable: true })).toHaveProperty("retryInMs");
    expect(nextDelivery(5, { ok: false, error: "e", retryable: true })).toEqual({ giveUp: true });
    expect(nextDelivery(1, { ok: false, error: "e", retryable: false })).toEqual({ giveUp: true });
  });
});

describe("csv", () => {
  it("parses quotes, escaped quotes, embedded commas/newlines and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"line1\nline2",z\n\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"'], ["line1\nline2", "z"]]);
  });
  it("maps varied headers, splits multi-value cells, reports bad rows with line numbers", () => {
    const rows = parseCsv("Customer_ID,Full Name,Mobile,E-Mail,Property,Apt,Type\n1,Ana,+49 151 111 2222,a@x.com; b@x.com,Hill 1,3,Owner\n2,,+1,,H,1,\n3,Bob,12,bad,H,2,");
    const { contacts, errors } = mapContacts(rows);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ sourceId: "1", name: "Ana", emails: ["a@x.com", "b@x.com"], phones: ["+491511112222"], building: "Hill 1", unit: "3", role: "owner" });
    expect(errors).toEqual([{ line: 3, error: "Missing name" }, { line: 4, error: 'Invalid email "bad"' }]);
  });
  it("rejects files without a name column", () => {
    expect(mapContacts(parseCsv("foo,bar\n1,2")).errors[0].error).toMatch(/No name column/);
  });
  it("sample export round-trips with the expected bad rows", () => {
    const { contacts, errors } = mapContacts(parseCsv(sampleCsv(2000)));
    expect(contacts.length + errors.length).toBe(2000);
    expect(errors.length).toBeGreaterThan(5);
  });
});

import { runEval, SCENARIOS } from "../core/eval";
describe("agent eval harness", () => {
  it("scripted model passes every scenario", async () => {
    const rows = await runEval(scriptedLlm());
    expect(rows.filter((r) => !r.pass).map((r) => `${r.id}: ${r.failures.join("; ")}`)).toEqual([]);
    expect(rows).toHaveLength(SCENARIOS.length);
  });
  it("detects a bad agent (always replies, never escalates)", async () => {
    const reckless = { next: async () => ({ text: "Sure, happy to help with anything!", toolCalls: [] }) };
    const rows = await runEval(reckless);
    const failed = rows.filter((r) => !r.pass).map((r) => r.id);
    expect(failed).toEqual(expect.arrayContaining(["emergency-en", "billing", "unknown-sender"]));
  });
});
