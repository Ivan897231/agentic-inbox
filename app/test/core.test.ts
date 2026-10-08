import { describe, expect, it } from "vitest";
import { fromEmail, fromTwilio, fromVonage, stripQuoted, twilioSignature, verifyTwilio } from "../core/normalize";
import { seedStore, DEMO_MESSAGES } from "../core/seed";
import { scriptedLlm } from "../core/llm";
import { importTick, newImportState, type ImportSource } from "../core/importer";
import { searchKb } from "../core/kb";

const msg = (o: any) => ({ externalId: Math.random().toString(), receivedAt: 1, to: "x", subject: undefined, ...o });

describe("normalizers", () => {
  it("twilio whatsapp", () => {
    const m = fromTwilio({ MessageSid: "SM1", From: "whatsapp:+49 151 1234 5678", To: "whatsapp:+14155238886", Body: "hi" });
    expect(m).toMatchObject({ channel: "whatsapp", externalId: "SM1", from: "+4915112345678" });
  });
  it("vonage sms", () => {
    expect(fromVonage({ messageId: "v1", msisdn: "447700900123", to: "4400", text: "yo" })).toMatchObject({ channel: "sms", from: "+447700900123" });
  });
  it("email strips quoted reply and display name", () => {
    const m = fromEmail({ MessageID: "e1", From: "Maria <Maria.Keller@Example.com>", To: "a@b.c", TextBody: "Thanks!\n\nOn Mon, X wrote:\n> old" });
    expect(m.from).toBe("maria.keller@example.com");
    expect(m.body).toBe("Thanks!");
    expect(stripQuoted("a\n> q")).toBe("a");
  });
  it("twilio signature matches the documented algorithm and rejects tampering", async () => {
    const params = { From: "+1", Body: "x" };
    const sig = await twilioSignature("tok", "https://h/twilio", params);
    expect(await verifyTwilio("tok", "https://h/twilio", params, sig)).toBe(true);
    expect(await verifyTwilio("tok", "https://h/twilio", { ...params, Body: "y" }, sig)).toBe(false);
    expect(await verifyTwilio("tok", "https://h/twilio", params, null)).toBe(false);
  });
});

describe("kb", () => {
  it("ranks the relevant article first", () => {
    const s = seedStore();
    expect(searchKb(s.kb, "my radiator is cold", 1)[0].id).toBe("k3");
  });
});

describe("kb relevance", () => {
  it("returns nothing for an unrelated query instead of noise", () => {
    expect(searchKb(seedStore().kb, "the bathroom tap has a slow leak", 3)).toEqual([]);
  });
});

describe("ingest + agent", () => {
  it("is idempotent on provider retries", async () => {
    const s = seedStore();
    const m = msg({ channel: "sms", externalId: "dup", from: "+447700900123", body: "Quiet hours?" });
    expect((await s.ingest(m, scriptedLlm())).duplicate).toBe(false);
    expect((await s.ingest(m, scriptedLlm())).duplicate).toBe(true);
    expect(s.messages.filter((x) => x.direction === "in")).toHaveLength(1);
  });
  it("dedupes against an open ticket instead of opening a new one", async () => {
    const s = seedStore();
    await s.ingest(msg({ ...DEMO_MESSAGES[0] }), scriptedLlm());
    expect(s.tickets).toHaveLength(1);
    expect(s.messages.at(-1)!.body).toContain("already have an open ticket");
  });
  it("gas smell -> emergency ticket + escalation, no reply", async () => {
    const s = seedStore();
    await s.ingest(msg({ ...DEMO_MESSAGES[1] }), scriptedLlm());
    expect(s.tickets.at(-1)).toMatchObject({ urgency: "emergency" });
    expect(s.conversations[0].status).toBe("needs_human");
    expect(s.messages.some((m) => m.direction === "out")).toBe(false);
  });
  it("unknown sender escalates without touching data", async () => {
    const s = seedStore();
    await s.ingest(msg({ ...DEMO_MESSAGES[4] }), scriptedLlm());
    expect(s.conversations[0].status).toBe("needs_human");
    expect(s.tickets).toHaveLength(1);
  });
  it("runaway model hits the step cap and escalates", async () => {
    const s = seedStore();
    const loop = { next: async () => ({ text: "", toolCalls: [{ id: "x", name: "list_open_tickets", args: {} }] }) };
    await s.ingest(msg({ ...DEMO_MESSAGES[2] }), loop);
    expect(s.conversations[0].status).toBe("needs_human");
    expect(s.runs[0].result.steps.at(-1)!.kind).toBe("limit");
  });
  it("tool errors are fed back, not thrown", async () => {
    const s = seedStore();
    let n = 0;
    const llm = { next: async () => (n++ === 0 ? { text: "", toolCalls: [{ id: "1", name: "nope", args: {} }] } : { text: "sorry", toolCalls: [] }) };
    await s.ingest(msg({ ...DEMO_MESSAGES[2] }), llm);
    expect(s.runs[0].result.steps[0].result).toEqual({ error: "unknown tool nope" });
    expect(s.runs[0].result.replied).toBe(true);
  });
});

describe("importer", () => {
  const source = (n: number): ImportSource<number> => ({
    async page(cursor, limit) {
      const start = cursor ? Number(cursor) : 0, end = Math.min(n, start + limit);
      return { items: Array.from({ length: end - start }, (_, i) => ({ sourceId: `r${start + i}`, data: start + i })), next: end >= n ? null : String(end) };
    },
  });
  const drain = async (src: ImportSource<number>, upsert: any, state = newImportState()) => {
    for (let i = 0; i < 1000 && !state.done; i++) state = (await importTick(state, src, upsert, { batch: 50, maxAttempts: 3 })).state;
    return state;
  };
  it("imports everything exactly once and is re-runnable", async () => {
    const db = new Set<string>();
    const upsert = async (id: string) => (db.has(id) ? "unchanged" : (db.add(id), "created"));
    const a = await drain(source(1234), upsert);
    expect(a).toMatchObject({ imported: 1234, skipped: 0, done: true });
    const b = await drain(source(1234), upsert);
    expect(b).toMatchObject({ imported: 0, skipped: 1234 });
  });
  it("retries transient failures and dead-letters poison records without blocking", async () => {
    const db = new Set<string>(); let flaky = 0;
    const upsert = async (id: string) => {
      if (id === "r7" && flaky++ < 2) throw new Error("timeout");
      if (id === "r9") throw new Error("bad record");
      return db.has(id) ? "unchanged" : (db.add(id), "created");
    };
    const s = await drain(source(20), upsert as any);
    expect(s.dead).toEqual([{ sourceId: "r9", error: "bad record" }]);
    expect(db.has("r7")).toBe(true);
    expect(s.imported).toBe(19);
    expect(s.imported + s.updated + s.skipped + s.dead.length).toBe(20);
    expect(s.retry).toEqual({});
  });
});
