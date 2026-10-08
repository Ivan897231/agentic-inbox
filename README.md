# Agentic Inbox

An AI-powered inbox for property management companies. Tenants and owners write by **WhatsApp, SMS or email**, an **AI agent** answers what it safely can and hands everything else to a human, and a **sync tool** brings customer data over from the system a company used before.

![Inbox](app/docs/inbox.png)

## What it does

- **One inbox for every channel.** WhatsApp, SMS and email messages all arrive in the same place.
- **An AI agent that uses tools.** It looks up who is writing, checks open tickets, searches a knowledge base, opens a ticket, and replies. Emergencies (like a gas smell), billing disputes and unknown senders always go to a human.
- **Safe by design.** Duplicate deliveries are ignored, failed sends are retried, and personal data is masked in stored logs. A person's data can be erased on request (GDPR).
- **Agent Studio.** Edit the agent's instructions, switch its tools on or off, manage its knowledge base, and test changes in a sandbox that saves and sends nothing.
- **Data import and sync.** Upload a CSV from an old system. A sync preview shows what would be created, updated or archived before anything changes. People missing from an export are archived, not deleted.

| Agent Studio | Migration and sync |
|---|---|
| ![Agent Studio](app/docs/studio.png) | ![Migration](app/docs/migration.png) |

## Tech

TypeScript everywhere: [Convex](https://convex.dev) (database and backend functions), React, Tailwind CSS. The AI agent uses the Claude API, or a built-in scripted stand-in when no API key is set. Tests use Vitest, and CI runs on GitHub Actions.

## Run it

```bash
cd app
npm install
npm run dev        # works without any backend: an in-browser demo
npx convex dev     # in a second terminal: connects the real backend
```

More detail, design notes and test commands are in [`app/README.md`](app/README.md).

## What is real and what is not

- **Working and tested:** the inbox, agent loop, duplicate protection, Agent Studio, CSV import and sync with preview, data erasure. It runs live on a Convex deployment, and the automated tests pass.
- **Not connected to real services:** WhatsApp/SMS (Twilio) and email sending are built and tested with mocks, but not connected to real accounts. By default the agent uses a scripted stand-in instead of a paid AI model.
- Full list in [`app/README.md`](app/README.md#honest-limits).

## About this project

I'm Ivan Tolj, a computing student in Mostar, Croatia. I built this with AI assistance (Claude Code) to learn how real software like this is designed, and I deployed, tested and documented it myself. It was inspired by the public description of AI tools for property management; it is not affiliated with any company.

GitHub: [Ivan897231](https://github.com/Ivan897231)
