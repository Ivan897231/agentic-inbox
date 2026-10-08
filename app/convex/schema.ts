import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const channel = v.union(v.literal("email"), v.literal("whatsapp"), v.literal("sms"));

export default defineSchema({
  units: defineTable({ building: v.string(), label: v.string(), sourceId: v.optional(v.string()) })
    .index("by_sourceId", ["sourceId"]),

  contacts: defineTable({
    name: v.string(),
    phones: v.array(v.string()),
    emails: v.array(v.string()),
    unitId: v.optional(v.id("units")),
    role: v.union(v.literal("tenant"), v.literal("owner"), v.literal("vendor")),
    sourceId: v.optional(v.string()),
    // ERP sync bookkeeping: `seenJobId` marks "present in the latest snapshot"; absent => archived, never deleted.
    erpManaged: v.optional(v.boolean()),
    seenJobId: v.optional(v.string()),
    archivedAt: v.optional(v.number()),
  }).index("by_sourceId", ["sourceId"]).index("by_erpManaged", ["erpManaged"]),

  // Lookup tables: a contact can have many addresses, and we match inbound by exact address.
  contactAddresses: defineTable({ address: v.string(), contactId: v.id("contacts") })
    .index("by_address", ["address"])
    .index("by_contact", ["contactId"]),

  conversations: defineTable({
    party: v.string(),
    channel,
    contactId: v.optional(v.id("contacts")),
    status: v.union(v.literal("open"), v.literal("agent_handled"), v.literal("needs_human"), v.literal("resolved")),
    lastAt: v.number(),
    escalationReason: v.optional(v.string()),
  })
    .index("by_party_channel", ["party", "channel"])
    .index("by_contact", ["contactId"])
    .index("by_status_lastAt", ["status", "lastAt"]),

  messages: defineTable({
    conversationId: v.id("conversations"),
    direction: v.union(v.literal("in"), v.literal("out")),
    channel,
    externalId: v.optional(v.string()),
    body: v.string(),
    by: v.optional(v.union(v.literal("agent"), v.literal("human"))),
    // Outbound delivery state machine: pending -> sent | failed | skipped (no provider configured).
    delivery: v.optional(v.union(v.literal("pending"), v.literal("sent"), v.literal("failed"), v.literal("skipped"))),
    deliveryNote: v.optional(v.string()),
    attempts: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId"])
    // The idempotency key: provider retries hit this index and become no-ops.
    .index("by_channel_externalId", ["channel", "externalId"]),

  tickets: defineTable({
    unitId: v.optional(v.id("units")),
    contactId: v.optional(v.id("contacts")),
    category: v.string(),
    urgency: v.union(v.literal("low"), v.literal("normal"), v.literal("emergency")),
    summary: v.string(),
    status: v.union(v.literal("open"), v.literal("closed")),
  }).index("by_unit_status", ["unitId", "status"]).index("by_contact", ["contactId"]),

  kbArticles: defineTable({ title: v.string(), body: v.string() })
    .searchIndex("search_body", { searchField: "body" }),

  agentRuns: defineTable({
    conversationId: v.id("conversations"),
    steps: v.any(),
    outcome: v.union(v.literal("replied"), v.literal("escalated"), v.literal("failed")),
    usage: v.optional(v.any()),
    llmCalls: v.optional(v.number()),
    model: v.optional(v.string()),
    ms: v.optional(v.number()),
  }).index("by_conversation", ["conversationId"]),

  // One row per configurable agent. Customers edit prompt + tools without a deploy.
  agents: defineTable({
    name: v.string(),
    systemPrompt: v.string(),
    enabledTools: v.array(v.string()),
    maxSteps: v.number(),
    model: v.optional(v.string()),
  }),

  // Staging area for bulk imports: the client uploads parsed rows in chunks, ticks drain them by seq.
  importRows: defineTable({ jobId: v.id("importJobs"), seq: v.number(), data: v.any() })
    .index("by_job_seq", ["jobId", "seq"]),

  importJobs: defineTable({
    kind: v.string(),
    cursor: v.union(v.string(), v.null()),
    done: v.boolean(),
    imported: v.number(),
    skipped: v.number(),
    updated: v.optional(v.number()),
    total: v.optional(v.number()),
    parseErrors: v.optional(v.any()),
    mode: v.optional(v.union(v.literal("import"), v.literal("sync"))),
    dryRun: v.optional(v.boolean()),
    phase: v.optional(v.union(v.literal("upsert"), v.literal("archive"))),
    archiveCursor: v.optional(v.union(v.string(), v.null())),
    archiveStep: v.optional(v.union(v.literal("count"), v.literal("apply"))),
    wouldArchive: v.optional(v.number()),
    error: v.optional(v.string()),
    restored: v.optional(v.number()),
    archived: v.optional(v.number()),
    changes: v.optional(v.any()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    retry: v.any(),
    dead: v.any(),
    pageDone: v.array(v.string()),
  }),
});
