# Unified Inbox + Agent + Migration Importer

A small, working slice of the three areas in the job post: **Product** (inbox UI),
**Integrations** (Twilio / Vonage / email webhooks, bulk importer) and **Agents**
(tool-using agent with guardrails). TypeScript end to end: Convex, React, Tailwind.

![screenshot](docs/screenshot.png)

## Run it

```bash
npm install
npm run dev      # demo UI, no keys or backend needed (scripted model runs in-browser)
npm test         # 14 tests on the core logic
npm run typecheck
```

Click **Simulate inbound** (WhatsApp, SMS, email), watch the agent trace, and hit
**Import 5,000 records** to see retries and dead-lettering.

## Layout

| Path | What |
|---|---|
| `core/` | Pure TypeScript, no framework. All the interesting logic, fully tested. |
| `convex/` | Thin Convex layer over `core/`: schema + indexes, HTTP webhooks, agent action, importer. |
| `src/` | React inbox UI. Demo mode drives the in-memory twin of the Convex tables (`core/store.ts`). |
| `test/` | Vitest. |

## Design decisions

**Integrations**
- Every channel normalizes to one `InboundMessage` (`core/normalize.ts`), then one write path (`convex/ingest.ts`).
- **Idempotent**: providers retry webhooks. Key is `(channel, externalId)` with an index; the check and insert happen in one Convex mutation, so concurrent retries can't both win.
- Twilio signature verified with WebCrypto HMAC-SHA1 and constant-time compare. Webhooks return fast; the agent runs via `scheduler.runAfter`, never inline.
- Email: display-name parsing and quoted-reply stripping.

**Importer** (`core/importer.ts`)
- Cursor-based, bounded batches so each tick fits a transaction; it reschedules itself until done, so a 500k-record import is a chain of short transactions.
- Idempotent upserts keyed by `sourceId`, so re-running is safe. Exponential backoff with jitter; poison records go to a dead-letter list instead of blocking the rest. A retried page doesn't redo or double-count settled rows.

**Agent** (`core/agent.ts`)
- Model-agnostic `Llm` interface; `anthropicLlm` (plain `fetch`, works in a Convex action) and a deterministic `scriptedLlm` for demo and tests.
- Tools hit a `Ports` interface, so the same loop runs against Convex or memory.
- Guardrails: hard step cap (then escalate), tool errors fed back to the model, unknown sender or emergency goes to a human, a crashed run escalates so no customer message is left unanswered, every step is recorded in `agentRuns`.

## Status: what is verified

- **Verified on a live Convex deployment:** schema and indexes, the ingest mutation, the scheduled agent action running all tools against the real database, real-time UI updates, and idempotent re-delivery.
- **Run it live:** `npx convex dev` in one terminal, `npm run dev` in another. With `VITE_CONVEX_URL` set (Convex writes it to `.env.local`) the UI uses the real backend; without it, the in-browser demo.
- **Unit-tested:** normalizers, Twilio signature check, KB ranking, agent guardrails, importer retries and dead-lettering (`npm test`).

## Not done yet (honest limits)

- The three HTTP webhooks are written and typecheck, but I have not pointed real Twilio, Vonage or email traffic at them. The in-app "simulate" path uses the same ingest mutation.
- The agent runs on the scripted model by default. `anthropicLlm` is implemented but not exercised against the live API; set `ANTHROPIC_API_KEY` in the Convex dashboard to try it.
- Outbound sending (Twilio/Vonage/SMTP) is a marked TODO in `convex/agentTools.ts`; the importer's source adapter in `convex/importer.ts` is a stub. The importer demo in the UI runs on in-memory data.
- Vonage webhook auth is a shared bearer token; production should verify their signed JWT.
- KB search is a Convex text search index; production would add a vector index.
- Function references are strings (`"ingest:receive"`) rather than generated `internal.*` references.
- Plain Tailwind; no shadcn/ui components yet.
