# Data Ingestion Guide (Current State)

This project is no longer mock-data only. The ingestion path is already live:

`External Sources -> /api/trends + /api/discover -> Supabase -> React dashboard`

## What Runs Today

- `GET /api/trends`
  - Enriches tracked terms from multiple sources
  - Computes component scores: intent, availability, realization, gap, confidence
  - Uses SerpAPI-backed local search/supply signals as the primary external source layer
  - Accepts optional ZIP scoping (`/api/trends?zip=10001`)
  - Persists snapshots to `trend_history` when request is authenticated
- `GET /api/discover`
  - SerpAPI-first discovery pipeline for new terms
  - Optional ZIP scoping (`/api/discover?manual=true&zip=10001`)
  - Triggered by Vercel cron daily and by authenticated manual scans
  - Applies GA4 backtest priors when ranking queue candidates
  - Queues candidates in `discovery_queue`
- `GET|POST /api/queue`
  - Review and approve/reject discovered terms
- `POST /api/generate-page`
  - Generates and stores product page drafts for tracked trends
- `GET|POST /api/meta-sync`
  - Syncs historical/incremental Meta Ads and Instagram data into Supabase
  - Writes to `meta_sync_runs`, `meta_ads_*`, `ig_*` tables
- `GET|POST /api/meta-webhook`
  - Handles Instagram webhook verification and event ingestion
- `GET /api/ga4-backtest`
  - Mines 3 years of GA4 history for keyword trend candidates
  - Feeds an explicit GA4 backtest signal into live trend scoring

## Required Environment Variables

Core:
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `SERPAPI_KEY`
- `GEMINI_API_KEY`
- `CRON_SECRET`

Recommended security:
- `ADMIN_API_KEY` (if omitted, `CRON_SECRET` is used for admin auth fallback)

Optional sources:
- `SQUARE_ACCESS_TOKEN`
- `GA4_PROPERTY_ID`
- `GOOGLE_SERVICE_ACCOUNT_KEY`
- `FACEBOOK_ACCESS_TOKEN`
- `FACEBOOK_AD_ACCOUNT_ID`
- `FACEBOOK_PAGE_ID`
- `INSTAGRAM_BUSINESS_ACCOUNT_ID` or `INSTAGRAM_IG_USER_ID`
- `META_WEBHOOK_VERIFY_TOKEN`
- `META_ANALYZER_PROVIDER` (`auto|openai|anthropic|gemini`)
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (optional deep analyzer providers)
- `DEFAULT_REGION_LABEL` / `DEFAULT_QUERY_HINT` / `DEFAULT_SERP_GEO` (location defaults)
- `DISCOVERY_REDDIT_SUBS` (comma-separated enrichment subreddits)

## Cost / Reliability Controls

- SerpAPI caching and budget guardrails are implemented in `lib/serp-governor.ts`
- `TERM_PROCESS_CONCURRENCY` controls in-flight term enrichment concurrency
- `MAX_TERMS_PER_REQUEST` caps how many tracked terms are enriched in one request

## Recommended Next Work

1. Add automated tests for scoring and API contract behavior.
2. Add monitoring/alerts on discovery failures and 5xx rates.
3. Tune source-specific scaling constants using real historical outcomes.
