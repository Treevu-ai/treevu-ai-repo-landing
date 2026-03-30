# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

This is the **Treevü landing page + backend** for [gettreevu.com](https://gettreevu.com), a B2B EWA (Earned Wage Access) SaaS for Peruvian companies.

The repo has two distinct runtime environments:

### 1. Vercel (serverless) — `index.html` + `api/`
- Static landing page (`index.html`) with embedded chat widget (Vü) and lead capture form.
- Serverless API functions in `api/` deployed to Vercel via `vercel.json`.
- Seven Vercel cron jobs (see vercel.json): `daily-summary`, `followup`, `reactivation`, `session-recovery`, `reunion-reminder`, `onboarding`, `content-reminder`.

### 2. Fly.io (persistent) — `whatsapp-service/`
- Long-running Node.js Express server (`whatsapp-service/server.js`) using Baileys to maintain a persistent WhatsApp connection.
- Cannot run on Vercel (requires 24/7 connection). Deployed to Fly.io (`app = "treevu-whatsapp"`, region `gru`).
- Auth session persisted in a Fly volume mounted at `/app/auth`.

## Key API Endpoints

| File | Route | Purpose |
|------|-------|---------|
| `api/submit.js` | `POST /api/submit` | Lead form handler — scores with Claude AI, saves to Notion, sends Telegram alert, creates Gmail draft |
| `api/chat.js` | `POST /api/chat` | Powers the Vü chatbot on the landing page (Claude Haiku) |
| `api/lead.js` | `POST /api/lead` | Unified CRM intake — all channels write here → Notion. Protected by `x-webhook-secret` |
| `api/abm-bot.js` | `POST /api/abm-bot` | ABM outbound automation bot |
| `api/abm-notify.js` | — | Shared helper for ABM notifications (imported by other handlers) |
| `api/telegram.js` | `POST /api/telegram` | Webhook for public @treevubot Telegram bot |
| `api/daily-summary.js` | `GET /api/daily-summary` | Cron — sends daily pipeline digest to Telegram |
| `api/followup.js` | `GET /api/followup` | Cron — triggers follow-up sequences |
| `api/calendly-webhook.js` | `POST /api/calendly-webhook` | Handles Calendly booking events |
| `api/setup-calendly.js` | `GET /api/setup-calendly` | One-time Calendly webhook registration |
| `api/ceo-bot.js` | `POST /api/ceo-bot` | CEO personal bot — propuestas, cierre de deal, onboarding post-firma |
| `api/router.js` | `POST /api/router` | Unified Telegram webhook — dispatches to CEO vs ABM bot by chat_id |
| `api/primera-reunion.js` | `POST /api/primera-reunion` | Pre/post-meeting automation — briefing generation, follow-up emails |
| `api/pandadoc-webhook.js` | `POST /api/pandadoc-webhook` | Contract signature webhook → CRM status update |
| `api/fathom-webhook.js` | `POST /api/fathom-webhook` | Call transcription (Fathom) → Notion update |
| `api/onboarding.js` | `GET /api/onboarding` | Cron 15:00 UTC daily — post-signature onboarding sequences |
| `api/content-reminder.js` | `GET /api/content-reminder` | Cron 12:00 UTC Mon–Fri — daily content post reminder |
| `api/reactivation.js` | `GET /api/reactivation` | Cron Mondays 14:00 UTC — re-engage leads inactive 45+ days |
| `api/session-recovery.js` | `GET /api/session-recovery` | Cron every 4h — recover abandoned @treevubot chat sessions via Telegram |

## Data Flow

1. **Inbound lead** (form or chat) → `api/submit.js` or `api/chat.js`
2. Both call `POST /api/lead` (with `LEAD_WEBHOOK_SECRET`) → saves to Notion CRM DB and cross-references against the outbound pipeline (Ejecución DB)
3. `api/submit.js` also: scores the lead with Claude Haiku (fallback to rule-based scoring), sends Telegram notification for ALTO/MEDIO leads, creates a Gmail draft for ALTO leads
4. ABM outbound events pass through `api/abm-bot.js` → `api/abm-notify.js`

## Notion Databases (hardcoded IDs)

| ID | Purpose |
|----|---------|
| `2e5f06c0295b46fbbc212bac5f6fcb3c` | CRM unificado (all inbound leads) |
| `bcebf14878f04db087f052722f9a084d` | Ejecución ABM (outbound pipeline, 14-day sequences) |
| `8a5cb4e6-16b9-4248-ac44-cab55c9ace6f` | Legacy — used only in `api/submit.js` directly |

## Environment Variables

### Vercel functions
| Variable | Used by |
|----------|---------|
| `OPENCLAW_TOKEN` | all Claude calls via `api/lib/anthropic.js` (OpenClaw gateway) |
| `ANTHROPIC_API_KEY` | unused — kept for legacy reference |
| `NOTION_API_KEY` / `NOTION_TOKEN` | all API files |
| `TELEGRAM_BOT_TOKEN` | `submit.js`, `lead.js`, `daily-summary.js`, `followup.js` |
| `TELEGRAM_CHAT_ID` | `submit.js` (personal alerts) |
| `TELEGRAM_ABM_CHAT_ID` | `lead.js`, `daily-summary.js`, `abm-bot.js` (ABM team channel) |
| `LEAD_WEBHOOK_SECRET` | authenticates calls to `/api/lead` |
| `CRON_SECRET` | allows manual trigger of cron endpoints |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Gmail draft creation in `submit.js` |
| `GMAIL_FROM` | sender address (default: `hello@gettreevu.com`) |
| `CALENDLY_TOKEN` | `calendly-webhook.js`, `setup-calendly.js`, `daily-summary.js` |

### WhatsApp service (`whatsapp-service/`)
| Variable | Purpose |
|----------|---------|
| `WHATSAPP_SERVICE_SECRET` | auth for `/send` endpoint |
| `TELEGRAM_BOT_TOKEN` | alerts on QR code + disconnect events |
| `TELEGRAM_ABM_CHAT_ID` | Telegram destination for alerts |
| `NOTION_API_KEY` | validate incoming messages against ABM pipeline (lookup only) |

## Development

### Vercel functions (local dev)
```bash
npx vercel dev
```

### WhatsApp service
```bash
cd whatsapp-service
npm install
npm run dev        # node --watch server.js (hot reload)
npm start          # production
```
First run: scan the QR code printed to terminal (or sent to Telegram) with a secondary WhatsApp number.

### Deploy WhatsApp service to Fly.io
```bash
cd whatsapp-service
fly deploy
fly secrets set WHATSAPP_SERVICE_SECRET=... NOTION_API_KEY=... TELEGRAM_BOT_TOKEN=... TELEGRAM_ABM_CHAT_ID=...
```

### Trigger cron endpoints manually
```bash
curl "https://gettreevu.com/api/daily-summary?secret=CRON_SECRET"
curl "https://gettreevu.com/api/followup?secret=CRON_SECRET"
```

## AI Model

All Claude calls go through the **OpenClaw gateway** (`https://treevu-openclaw.fly.dev/v1/chat/completions`) using an OpenAI-compatible API format. Auth via `OPENCLAW_TOKEN`. Current model: `claude-sonnet-4-6`. Centralized in `api/lib/anthropic.js` — `askClaude()` returns `null` gracefully when the token is absent.

## WhatsApp Service — Design Decisions

- **Incoming message relay is intentionally disabled** (`server.js:233`). The service validates incoming messages against the Notion ABM pipeline (lookup + cache) but does not forward them to Telegram. WhatsApp was removed from the ABM flow — the service now operates exclusively in **outbound mode** (sending messages via `POST /send`).
- If relay is re-enabled in the future, the logic exists at `server.js:225–234` — just replace the `console.log` with the Telegram forwarding call.
