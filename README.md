# Trend Hunter

Trend Hunter is a ZIP-first food trend intelligence dashboard. It discovers emerging terms, estimates unmet demand from intent vs. availability vs. realization, and helps operators move from detection to launch copy.

## Agent Context

- Agent quick entry: `AGENTS.md`
- Detailed executive vision and roadmap: `AGENT_EXECUTIVE_VISION.md`

## Stack

- Frontend: Vite + React + Tailwind
- API: Vercel serverless functions in `api/`
- Data: Supabase (`trends`, `trend_history`, `discovery_queue`, `page_drafts`, `serp_cache`)
- External signals: SerpAPI, Reddit, optional GA4/Square/Meta
- AI: Gemini (analysis + content generation)

## Local Run

1. Install dependencies:
   `npm install`
2. Create `.env` with at least:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `SERPAPI_KEY`
   - `GEMINI_API_KEY`
   - `CRON_SECRET` (also used as admin token fallback)
   - Optional location defaults:
     - `DEFAULT_REGION_LABEL` (default: `United States`)
     - `DEFAULT_QUERY_HINT` (used when no ZIP is provided)
     - `DEFAULT_SERP_GEO` (default: `US`)
   - Optional Meta/Instagram integration:
     - `FACEBOOK_ACCESS_TOKEN`
     - `FACEBOOK_AD_ACCOUNT_ID`
     - `FACEBOOK_PAGE_ID`
     - `INSTAGRAM_BUSINESS_ACCOUNT_ID` (or `INSTAGRAM_IG_USER_ID`)
     - `META_WEBHOOK_VERIFY_TOKEN`
   - Optional deep analyzer providers:
     - `META_ANALYZER_PROVIDER=auto|openai|anthropic|gemini`
     - `OPENAI_API_KEY`
     - `ANTHROPIC_API_KEY`
3. Start app:
   `npm run dev`

## Scripts

- `npm run dev` - local dev server
- `npm run build` - production build
- `npm run preview` - preview build locally
- `npm run typecheck` - TypeScript check for frontend + API

## API Overview

- `GET /api/trends` - fetch tracked trends (live signals, scoring)
  - Supports `?q=<term>` and optional `&zip=<5-digit-zip>` for local gap scoring
  - Returns component scores: intent, availability, realization, gap, confidence
  - Includes SerpAPI contribution fields (`serpapiShare`, `serpapiSignals`)
- `GET /api/discover` - SerpAPI-first discovery job (cron or authenticated manual run)
  - Supports optional `&zip=<5-digit-zip>` for ZIP-scoped discovery
  - Uses GA4 backtest priors to boost historically strong terms
- `GET|POST /api/queue` - review/approve discovered terms (authenticated)
- `POST /api/generate-page` - generate page draft for a tracked trend (authenticated)
- `GET|POST /api/meta-ads` - read or create Meta campaign drafts (authenticated)
- `GET|POST /api/meta-sync` - backfill or incremental sync for Meta Ads + Instagram (authenticated/cron)
- `GET|POST /api/meta-webhook` - Instagram webhook verification + event intake
- `GET /api/ga4-backtest` - mine historical GA4 terms and queue candidates (authenticated)

## Admin Auth

Sensitive endpoints require an admin token supplied via:
- `Authorization: Bearer <token>`
- or `x-admin-token: <token>`

Token source on server:
- `ADMIN_API_KEY` if present
- otherwise `CRON_SECRET`

Frontend admin actions use a token saved from the Discovery Queue panel (session storage).

## Database

Apply `supabase/schema.sql` before running ingestion and draft generation features.
