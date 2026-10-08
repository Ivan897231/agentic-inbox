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
  }).index("by_sourceId", ["sourceId"]),

  // Lookup tables: a contact can have many addresses, and we match inbound by exact address.
  contactAddresses: defineTable({ address: v.string(), contactId: v.id("contacts") })
    .index("by_address", ["address"]),

  conversations: defineTable({
    party: v.string(),
    channel,
    contactId: v.optional(v.id("contacts")),
    status: v.union(v.literal("open"), v.literal("agent_handled"), v.literal("needs_human")),
    lastAt: v.number(),
  })
    .index("by_party_channel", ["party", "channel"])
    .index("by_status_lastAt", ["status", "lastAt"]),

  messages: defineTable({
    conversationId: v.id("conversations"),
    direction: v.union(v.literal("in"), v.literal("out")),
    channel,
    externalId: v.optional(v.string()),
    body: v.string(),
    by: v.optional(v.union(v.literal("agent"), v.literal("human"))),
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
  }).index("by_unit_status", ["unitId", "status"]),

  kbArticles: defineTable({ title: v.string(), body: v.string() })
    .searchIndex("search_body", { searchField: "body" }),

  agentRuns: defineTable({
    conversationId: v.id("conversations"),
    steps: v.any(),
    outcome: v.union(v.literal("replied"), v.literal("escalated"), v.literal("failed")),
  }).index("by_conversation", ["conversationId"]),

  importJobs: defineTable({
    kind: v.string(),
    cursor: v.union(v.string(), v.null()),
    done: v.boolean(),
    imported: v.number(),
    skipped: v.number(),
    retry: v.any(),
    dead: v.any(),
    pageDone: v.array(v.string()),
  }),
});
