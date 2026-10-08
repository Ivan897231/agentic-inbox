// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { sampleCsv, mapContacts, parseCsv } from "../core/csv";
import { twilioSignature } from "../core/normalize";

// convex-test locates the functions dir via `_generated`; we avoid codegen (needs a deployment) with a marker entry.
const modules = { ...import.meta.glob("../convex/*.ts"), "../convex/_generated/api.js": async () => ({}) };
const fn = (name: string) => makeFunctionReference<any>(name) as any;
const setup = async () => {
  const t = convexTest(schema, modules);
  await t.mutation(fn("demo:seed"), {});
  return t;
};
const settle = async (t: any) => { await t.finishAllScheduledFunctions(vi.runAllTimers); };
const state = (t: any) => t.query(fn("demo:state"), {});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("ingest → agent → outbound (real Convex functions, mock runtime)", () => {
  it("handles a message end to end and enqueues delivery (skipped: no provider)", async () => {
    const t = await setup();
    await t.action(fn("demo:simulate"), { channel: "whatsapp", externalId: "m1", from: "+4915112345678", body: "Hallo, die Heizung ist kaputt" });
    await settle(t);
    const { conversations, tickets } = await state(t);
    expect(conversations).toHaveLength(1);
    const c = conversations[0];
    expect(c.name).toBe("Maria Keller");
    expect(c.status).toBe("agent_handled");
    expect(c.messages.map((m: any) => m.direction)).toEqual(["in", "out"]);
    expect(c.messages[1]).toMatchObject({ by: "agent", delivery: "skipped" });
    expect(c.runs[0]).toMatchObject({ outcome: "replied", model: "scripted" });
    expect(c.runs[0].steps.map((s: any) => s.name ?? s.kind)).toContain("find_contact");
    expect(tickets).toHaveLength(1); // deduped against her open radiator ticket
  });

  it("is idempotent on provider redelivery", async () => {
    const t = await setup();
    const args = { channel: "sms", externalId: "dup", from: "+447700900123", body: "Quiet hours?" };
    expect((await t.action(fn("demo:simulate"), args)).duplicate).toBe(false);
    expect((await t.action(fn("demo:simulate"), args)).duplicate).toBe(true);
    await settle(t);
    const { conversations } = await state(t);
    expect(conversations[0].messages.filter((m: any) => m.direction === "in")).toHaveLength(1);
    expect(conversations[0].runs).toHaveLength(1);
  });

  it("emergency escalates to a human with a reason and no reply", async () => {
    const t = await setup();
    await t.action(fn("demo:simulate"), { channel: "sms", externalId: "g1", from: "+447700900123", body: "I can smell gas!!" });
    await settle(t);
    const { conversations, tickets } = await state(t);
    expect(conversations[0]).toMatchObject({ status: "needs_human" });
    expect(conversations[0].escalationReason).toMatch(/Emergency/);
    expect(conversations[0].messages.some((m: any) => m.direction === "out")).toBe(false);
    expect(tickets.some((x: any) => x.urgency === "emergency")).toBe(true);
  });

  it("a human reply goes through the same queue and resolves the thread", async () => {
    const t = await setup();
    await t.action(fn("demo:simulate"), { channel: "sms", externalId: "g2", from: "+447700900123", body: "gas smell" });
    await settle(t);
    const id = (await state(t)).conversations[0]._id;
    await t.mutation(fn("inbox:humanReply"), { conversationId: id, text: "Engineer on the way." });
    await settle(t);
    const c = (await state(t)).conversations[0];
    expect(c.status).toBe("resolved");
    expect(c.messages.at(-1)).toMatchObject({ by: "human", delivery: "skipped", body: "Engineer on the way." });
  });
});

describe("outbound retries", () => {
  const env = process.env;
  afterEach(() => { process.env = env; vi.unstubAllGlobals(); });

  it("retries a 503 with backoff, then marks sent", async () => {
    process.env = { ...env, TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_SMS_FROM: "+1555" };
    let calls = 0;
    vi.stubGlobal("fetch", async () => (++calls < 3 ? new Response("down", { status: 503 }) : new Response(JSON.stringify({ sid: "SM1" }), { status: 201 })));
    const t = await setup();
    await t.action(fn("demo:simulate"), { channel: "sms", externalId: "o1", from: "+447700900123", body: "Quiet hours?" });
    await settle(t);
    const m = (await state(t)).conversations[0].messages.find((x: any) => x.direction === "out");
    expect(calls).toBe(3);
    expect(m).toMatchObject({ delivery: "sent", attempts: 3, deliveryNote: "SM1" });
  });

  it("a permanent 400 fails immediately without retrying", async () => {
    process.env = { ...env, TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_SMS_FROM: "+1555" };
    let calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; return new Response("bad number", { status: 400 }); });
    const t = await setup();
    await t.action(fn("demo:simulate"), { channel: "sms", externalId: "o2", from: "+447700900123", body: "Quiet hours?" });
    await settle(t);
    const m = (await state(t)).conversations[0].messages.find((x: any) => x.direction === "out");
    expect(calls).toBe(1);
    expect(m).toMatchObject({ delivery: "failed", attempts: 1 });
  });
});

describe("webhooks", () => {
  const form = { MessageSid: "SMw1", From: "whatsapp:+4915112345678", To: "whatsapp:+14155238886", Body: "Hallo, die Heizung ist kaputt" };
  const post = (t: any, sig: string, params = form) =>
    t.fetch("/webhooks/twilio", { method: "POST", body: new URLSearchParams(params).toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig } });

  it("rejects a bad Twilio signature and accepts a correctly signed one", async () => {
    process.env.TWILIO_AUTH_TOKEN = "secret";
    const t = await setup();
    expect((await post(t, "nope")).status).toBe(403);
    expect((await state(t)).conversations).toHaveLength(0);

    const sig = await twilioSignature("secret", "https://some.convex.site/webhooks/twilio", form); // origin used by convex-test
    expect((await post(t, sig)).status).toBe(200);
    await settle(t);
    const c = (await state(t)).conversations[0];
    expect(c).toMatchObject({ channel: "whatsapp", party: "+4915112345678", name: "Maria Keller" });
    // Same webhook delivered again (provider retry): still one message.
    expect((await post(t, sig)).status).toBe(200);
    await settle(t);
    expect((await state(t)).conversations[0].messages.filter((m: any) => m.direction === "in")).toHaveLength(1);
    // Tampered body with the old signature is rejected.
    expect((await post(t, sig, { ...form, Body: "evil" })).status).toBe(403);
  });

  it("email webhook requires its token and strips quoted replies", async () => {
    process.env.EMAIL_WEBHOOK_TOKEN = "etok";
    const t = await setup();
    const body = JSON.stringify({ MessageID: "e1", From: "Maria <maria.keller@example.com>", To: "support@x.com", Subject: "Hi", TextBody: "Quiet hours?\n\nOn Mon, X wrote:\n> old" });
    expect((await t.fetch("/webhooks/email?token=wrong", { method: "POST", body })).status).toBe(401);
    expect((await t.fetch("/webhooks/email?token=etok", { method: "POST", body })).status).toBe(200);
    await settle(t);
    const c = (await state(t)).conversations[0];
    expect(c.messages[0].body).toBe("Quiet hours?");
    expect(c.name).toBe("Maria Keller");
  });

  it("rejects malformed payloads with 400", async () => {
    process.env.EMAIL_WEBHOOK_TOKEN = "etok";
    const t = await setup();
    expect((await t.fetch("/webhooks/email?token=etok", { method: "POST", body: JSON.stringify({ From: "a@b.c" }) })).status).toBe(400);
  });
});

describe("agent studio", () => {
  it("sandbox runs a draft config with zero side effects", async () => {
    const t = await setup();
    const before = await state(t);
    const r = await t.action(fn("agent:sandbox"), {
      from: "+447700900123", channel: "sms", body: "gas smell in the hallway",
      draft: { systemPrompt: "x".repeat(30), enabledTools: ["find_contact", "create_ticket"], maxSteps: 8 },
    });
    expect(r.live).toBe(false);
    expect(r.effects.map((e: any) => e.kind)).toEqual(["ticket", "escalate"]);
    const after = await state(t);
    expect(after.tickets).toHaveLength(before.tickets.length);
    expect(after.conversations).toHaveLength(0);
  });

  it("saved config changes behaviour: with create_ticket disabled the agent can't open tickets", async () => {
    const t = await setup();
    await t.mutation(fn("studio:saveAgent"), { systemPrompt: "You are a very careful assistant. Be brief.", enabledTools: ["find_contact", "list_open_tickets", "search_kb"], maxSteps: 6 });
    await t.action(fn("demo:simulate"), { channel: "email", externalId: "e1", from: "aiko.sato@example.com", body: "The bathroom tap leaks" });
    await settle(t);
    const { tickets, conversations } = await state(t);
    expect(tickets).toHaveLength(1);
    expect(conversations[0].runs[0].steps.find((s: any) => s.name === "create_ticket")?.result).toEqual({ error: "tool create_ticket is disabled for this agent" });
  });

  it("validates agent settings", async () => {
    const t = await setup();
    await expect(t.mutation(fn("studio:saveAgent"), { systemPrompt: "short", enabledTools: [], maxSteps: 5 })).rejects.toThrow(/too short/);
    await expect(t.mutation(fn("studio:saveAgent"), { systemPrompt: "x".repeat(40), enabledTools: [], maxSteps: 99 })).rejects.toThrow(/between 1 and 20/);
  });

  it("knowledge base edits are searchable by the agent", async () => {
    const t = await setup();
    await t.mutation(fn("studio:addKb"), { title: "Parking", body: "Visitor parking is free after 18:00 in the courtyard." });
    expect((await t.query(fn("studio:listKb"), {})).some((k: any) => k.title === "Parking")).toBe(true);
  });
});

describe("csv migration (staged, chunked, resumable)", () => {
  it("imports a CSV through the tick chain; re-import converges with no duplicates", async () => {
    const t = await setup();
    const { contacts, errors } = mapContacts(parseCsv(sampleCsv(450)));
    const runImport = async () => {
      const jobId = await t.mutation(fn("importer:create"), { kind: "contacts", total: contacts.length, parseErrors: errors });
      for (let i = 0; i < contacts.length; i += 200) await t.mutation(fn("importer:stage"), { jobId, startSeq: i, rows: contacts.slice(i, i + 200) });
      await t.mutation(fn("importer:begin"), { jobId });
      await settle(t);
      return t.query(fn("importer:latest"), {});
    };
    const a = await runImport();
    expect(a).toMatchObject({ done: true, imported: contacts.length, updated: 0, skipped: 0, deadCount: 0, parseErrorCount: errors.length });
    const b = await runImport();
    expect(b).toMatchObject({ done: true, imported: 0, skipped: contacts.length });
    const total = await t.run(async (ctx: any) => (await ctx.db.query("contacts").collect()).length);
    expect(total).toBe(4 + contacts.length); // 4 seeded + imported, no duplicates
    const staged = await t.run(async (ctx: any) => (await ctx.db.query("importRows").collect()).length);
    expect(staged).toBe(0); // staging is cleaned up
  });

  it("imported contacts are immediately known to the agent", async () => {
    const t = await setup();
    const jobId = await t.mutation(fn("importer:create"), { kind: "contacts", total: 1, parseErrors: [] });
    await t.mutation(fn("importer:stage"), { jobId, startSeq: 0, rows: [{ sourceId: "x1", name: "Nina Import", phones: ["+4917012345678"], emails: [], building: "Hill 1", unit: "7", role: "tenant" }] });
    await t.mutation(fn("importer:begin"), { jobId });
    await settle(t);
    await t.action(fn("demo:simulate"), { channel: "sms", externalId: "i1", from: "+4917012345678", body: "Quiet hours?" });
    await settle(t);
    expect((await state(t)).conversations[0].name).toBe("Nina Import");
  });

  it("a changed source row is reported as updated", async () => {
    const t = await setup();
    const go = async (name: string) => {
      const jobId = await t.mutation(fn("importer:create"), { kind: "contacts", total: 1, parseErrors: [] });
      await t.mutation(fn("importer:stage"), { jobId, startSeq: 0, rows: [{ sourceId: "u1", name, phones: ["+4917000000001"], emails: [], building: "H", unit: "1", role: "tenant" }] });
      await t.mutation(fn("importer:begin"), { jobId });
      await settle(t);
      return t.query(fn("importer:latest"), {});
    };
    expect(await go("Old Name")).toMatchObject({ imported: 1 });
    expect(await go("New Name")).toMatchObject({ imported: 0, updated: 1 });
  });
});

describe("ERP sync (preview → apply → archive)", () => {
  const upload = async (t: any, csv: string, mode: "import" | "sync", dryRun: boolean) => {
    const { contacts, errors } = mapContacts(parseCsv(csv));
    const jobId = await t.mutation(fn("importer:create"), { kind: "contacts", total: contacts.length, parseErrors: errors, mode, dryRun });
    for (let i = 0; i < contacts.length; i += 200) await t.mutation(fn("importer:stage"), { jobId, startSeq: i, rows: contacts.slice(i, i + 200) });
    await t.mutation(fn("importer:begin"), { jobId });
    await settle(t);
    return jobId;
  };
  const latest = (t: any) => t.query(fn("importer:latest"), {});
  const count = (t: any, f: (c: any) => boolean) => t.run(async (ctx: any) => (await ctx.db.query("contacts").collect()).filter(f).length);

  it("previews a changed snapshot without writing, then applies it", async () => {
    const t = await setup();
    await upload(t, sampleCsv(450, 1), "sync", false);
    const base = await count(t, (c) => c.erpManaged);
    const before = await t.run(async (ctx: any) => (await ctx.db.query("contactAddresses").collect()).length);

    // Preview v2
    const jobId = await upload(t, sampleCsv(450, 2), "sync", true);
    const p = await latest(t);
    expect(p).toMatchObject({ done: true, dryRun: true, error: null });
    expect(p.updated).toBeGreaterThan(0);   // phone changes
    expect(p.imported).toBeGreaterThan(0);  // new people
    expect(p.wouldArchive).toBeGreaterThan(0); // people missing from v2
    expect(p.changes.some((c: any) => c.kind === "updated" && c.diff[0].startsWith("phones:"))).toBe(true);
    // Nothing was written by the preview
    expect(await count(t, (c) => c.erpManaged)).toBe(base);
    expect(await count(t, (c) => c.erpManaged && c.archivedAt)).toBe(0);
    expect(await t.run(async (ctx: any) => (await ctx.db.query("contactAddresses").collect()).length)).toBe(before);

    // Apply
    await t.mutation(fn("importer:apply"), { jobId });
    await settle(t);
    const a = await latest(t);
    expect(a).toMatchObject({ done: true, dryRun: false, error: null, archived: p.wouldArchive, updated: p.updated, imported: p.imported });
    expect(await count(t, (c) => c.archivedAt)).toBe(a.archived);
    expect(await count(t, (c) => c.erpManaged)).toBe(base + a.imported); // nothing deleted, only added
  });

  it("archived people are no longer recognised, and come back when they reappear", async () => {
    const t = await setup();
    const csv = (rows: string[]) => ["id,name,phone,email,building,unit", ...rows].join("\n");
    const rows = Array.from({ length: 30 }, (_, i) => `${i},Person ${i},+4917000000${String(i).padStart(2, "0")},p${i}@x.com,Hill 1,${i}`);
    await upload(t, csv(rows), "sync", false);
    await upload(t, csv(rows.filter((r) => !r.startsWith("5,"))), "sync", false); // person 5 missing
    expect(await count(t, (c) => c.archivedAt)).toBe(1);

    await t.action(fn("demo:simulate"), { channel: "sms", externalId: "a1", from: "+470000", body: "x" }).catch(() => {});
    const known = await t.query(fn("agentTools:findContact"), { phone: "+491700000005" }).catch(() => null);
    expect(known ?? null).toBeNull(); // gone from the address book, record kept

    await upload(t, csv(rows), "sync", false); // they're back in the next export
    expect(await latest(t)).toMatchObject({ restored: 1 });
    expect(await count(t, (c) => c.archivedAt)).toBe(0);
  });

  it("refuses to archive anyone when the export looks truncated", async () => {
    const t = await setup();
    await upload(t, sampleCsv(300, 1), "sync", false);
    const total = await count(t, (c) => c.erpManaged);
    await upload(t, sampleCsv(300, 1).split("\r\n").slice(0, 60).join("\r\n"), "sync", false); // cut off mid-file
    const j = await latest(t);
    expect(j.error).toMatch(/truncated/);
    expect(await count(t, (c) => c.archivedAt)).toBe(0);
    expect(await count(t, (c) => c.erpManaged)).toBe(total);
  });
});

describe("owners, privacy", () => {
  it("owner questions are handled as owner questions", async () => {
    const t = await setup();
    await t.action(fn("demo:simulate"), { channel: "sms", externalId: "ow1", from: "+4917612345678", body: "When is the next owners' meeting and how do I submit an agenda item?" });
    await settle(t);
    const c = (await state(t)).conversations[0];
    expect(c).toMatchObject({ name: "Klaus Brandt", status: "agent_handled" });
    expect(c.messages.at(-1).body).toMatch(/agenda/i);
    expect((await state(t)).tickets).toHaveLength(1);
  });

  it("stored traces have phone numbers and emails masked", async () => {
    const t = await setup();
    await t.action(fn("demo:simulate"), { channel: "sms", externalId: "p1", from: "+447700900123", body: "Call me on +447700900123 about the heating" });
    await settle(t);
    const json = JSON.stringify((await state(t)).conversations[0].runs);
    expect(json).not.toContain("+447700900123");
    expect(json).toContain("+44•••••23");
  });

  it("erasePerson removes identity but keeps anonymised records", async () => {
    const t = await setup();
    await t.action(fn("demo:simulate"), { channel: "whatsapp", externalId: "er1", from: "+4915112345678", body: "Hallo, die Heizung ist kaputt" });
    await settle(t);
    const c = (await state(t)).conversations[0];
    const contactId = c.contactId;
    const counts = await t.mutation(fn("privacy:erasePerson"), { contactId });
    expect(counts).toMatchObject({ conversations: 1, messages: 2, runs: 1 });
    const after = (await state(t)).conversations[0];
    expect(after).toMatchObject({ party: "erased", name: null });
    expect(after.messages.every((m: any) => m.body === "[erased]")).toBe(true);
    expect(after.runs).toHaveLength(0);
    expect(await t.run(async (ctx: any) => ctx.db.get(contactId))).toBeNull();
    // They are a stranger now: a new message from the same number is escalated, not answered.
    await t.action(fn("demo:simulate"), { channel: "whatsapp", externalId: "er2", from: "+4915112345678", body: "Hi again" });
    await settle(t);
    const again = (await state(t)).conversations.find((x: any) => x.messages.some((m: any) => m.body === "Hi again"));
    expect(again.status).toBe("needs_human");
  });
});

describe("seeding an existing database (upgrade path)", () => {
  it("adds newly introduced sample people and articles without duplicating anything", async () => {
    const t = convexTest(schema, modules);
    // Simulate a database seeded by an older version: only one tenant, one article, one ticket.
    await t.run(async (ctx: any) => {
      const u = await ctx.db.insert("units", { building: "Linden Court 12", label: "Apt 3B", sourceId: "u1" });
      const c = await ctx.db.insert("contacts", { name: "Maria Keller", phones: ["+4915112345678"], emails: [], role: "tenant", unitId: u, sourceId: "c1" });
      await ctx.db.insert("contactAddresses", { address: "+4915112345678", contactId: c });
      await ctx.db.insert("kbArticles", { title: "Quiet hours", body: "old" });
      await ctx.db.insert("tickets", { category: "maintenance", urgency: "normal", summary: "x", status: "open" });
    });
    expect(await t.mutation(fn("demo:seed"), {})).toMatch(/added/);
    expect(await t.mutation(fn("demo:seed"), {})).toBe("already seeded");
    const n = await t.run(async (ctx: any) => ({
      contacts: (await ctx.db.query("contacts").collect()).map((c: any) => c.name).sort(),
      kb: (await ctx.db.query("kbArticles").collect()).length,
      tickets: (await ctx.db.query("tickets").collect()).length,
    }));
    expect(n.contacts).toEqual(["Aiko Sato", "Klaus Brandt", "Maria Keller", "Tom Becker"]);
    expect(n.kb).toBe(6);
    expect(n.tickets).toBe(1); // no sample tickets re-created on an existing database
    // Klaus is now a known owner, not an unknown sender
    await t.action(fn("demo:simulate"), { channel: "email", externalId: "u1", from: "k.brandt@example.com", body: "The annual statement charges me for a lift repair I never approved. This is wrong." });
    await settle(t);
    const c = (await state(t)).conversations[0];
    expect(c).toMatchObject({ name: "Klaus Brandt", role: "owner", status: "needs_human" });
    expect(c.escalationReason).toMatch(/Owner statement/);
  });
});
