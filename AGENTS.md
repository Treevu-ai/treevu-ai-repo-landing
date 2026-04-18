# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

This repository powers the Treevu landing page and backend automation stack for gettreevu.com.

There are two runtime environments:

1. **Vercel (serverless)**: static site + API handlers in `api/`
2. **Fly.io (persistent)**: WhatsApp service in `whatsapp-service/`

Treat them as separate deployment targets with different constraints.

## Architecture Snapshot

### Vercel side (`index.html`, `api/`)

- `index.html`: Landing page and lead capture/chat UI.
- `api/submit.js`: Form submission intake, scoring, notifications, Gmail draft support.
- `api/chat.js`: Chat endpoint for the site assistant.
- `api/lead.js`: Unified CRM ingestion endpoint (requires `x-webhook-secret`).
- `api/ceo-bot.js`, `api/abm-bot.js`, `api/telegram.js`: Telegram bots and routing flows.
- `api/daily-summary.js`, `api/followup.js`, `api/reactivation.js`, `api/session-recovery.js`, `api/onboarding.js`, `api/content-reminder.js`: Cron handlers.
- `api/lib/*`: Shared adapters and helpers (Notion, Anthropic/OpenClaw, Telegram, validators, prompts, state, etc).

### Fly.io side (`whatsapp-service/`)

- `whatsapp-service/server.js`: Long-running Baileys-based WhatsApp process.
- Requires persistent auth storage (`/app/auth` in Fly volume).
- Used for outbound messaging flow; do not assume inbound relay is active.

## Key Implementation Rules

1. **Use existing shared libs first**  
   Prefer reusing `api/lib/*` utilities over duplicating integration logic.

2. **Validate env vars early**  
   Use `checkEnvVars()` from `api/lib/constants.js` at the start of handlers when adding/changing required configuration.

3. **Protect webhook endpoints**  
   Preserve existing auth patterns (`x-webhook-secret`, cron `secret`, signature verification) when modifying handlers.

4. **Fail safely with external APIs**  
   Integrations (Notion, Telegram, Calendly, PandaDoc, Apollo, Tavily, X/Twitter, LinkedIn, Instagram, Firecrawl) should degrade gracefully and log actionable errors.

5. **Do not break CRM write path**  
   Inbound leads should continue flowing through `api/lead` and the current Notion schema expectations.

6. **Respect bot tone and prompting conventions**  
   Prompt structure generally follows:
   - `system`: identity + behavior rules + constraints
   - `user`: request-specific variables

## AI Integration Notes

- Claude calls are centralized in `api/lib/anthropic.js`.
- Calls use the OpenClaw gateway (`OPENCLAW_TOKEN`).
- `askClaude()` is designed to return `null` safely when tokens are missing; preserve this resilience when refactoring.

## Local Development

### Vercel functions

```bash
npx vercel dev
```

### WhatsApp service

```bash
cd whatsapp-service
npm install
npm run dev
```

## Testing and Verification

Before finalizing changes:

1. Run relevant tests under `api/__tests__/` for touched areas.
2. For handler changes, perform a local request or unit-level verification path.
3. Confirm no secrets are hardcoded and no auth checks were removed.
4. Verify cron handlers still enforce expected secret checks.

## Change Scope Guidelines

- Keep edits minimal and focused on the requested behavior.
- Avoid unrelated refactors in the same change.
- Preserve backwards compatibility for public webhook routes whenever possible.
- Prefer explicit, readable code over clever abstractions.

## Deployment Awareness

- Vercel functions are stateless and short-lived.
- WhatsApp service is stateful and persistent on Fly.io.
- Do not move long-lived connection logic into Vercel handlers.

## Security and Data Handling

- Never log tokens, secrets, refresh tokens, or full webhook payloads containing sensitive data.
- Use redaction/safe logging patterns for external API failures.
- Keep existing auth gates and signature checks intact when modifying endpoints.

## High-Risk Areas (extra caution)

- `api/submit.js` and `api/lead.js` (core inbound flow)
- `api/ceo-bot.js` and `api/abm-bot.js` state transitions
- `api/lib/notion*.js` schema/field mapping
- `whatsapp-service/server.js` auth/session lifecycle

When changing these files, favor small patches plus targeted verification.

