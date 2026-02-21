# TrendHunt 2.0 Roadmap

## Mission

TrendHunt exists to detect unmet local demand by ZIP code and convert that signal into actionable launch decisions for Local Effort. Version 1.0 established the correct architecture: ZIP-first scoring, SerpAPI-primary sensing, GA4 historical priors, and a five-component scoring model. Version 2.0 converts this from a **signal board** into a **demand-gap decision engine** that learns from business outcomes.

The winning system answers not "what is trending?" but "what should we launch next in this ZIP, with expected upside and confidence?"

---

## What Changed in 1.0 → 2.0 Transition

### Signal Replacements (shipped)
- **Removed:** Wildchat (HuggingFace static corpus — no velocity, no localization, 0.4 weight)
- **Added:** `ConversationalSearch` — Google Trends for `"{term} near me"` queries. Captures latent demand where people know what they want but don't know where to find it. Single SerpAPI call, 72h cache. Weight: 1.2.
- **Added:** `LocalRedditIntent` — Question-pattern posts (`where can I find`, `looking for`, `anyone know`) in local subreddits (Minneapolis, TwinCities, minnesota) plus global food search. Zero SerpAPI cost (Reddit public API). Weight: 1.3.
- **Discovery:** Expanded default `DISCOVERY_REDDIT_SUBS` to include local Minnesota subreddits. Added question-pattern phrases to keyword filter.

---

## 2.0 Modules (Priority Order)

---

### Module 1: Canonical Term Normalization
**Priority: 1 — Foundational**

**Problem:** "birria tacos," "birria taco," "beef birria," and "birria" are the same opportunity but treated as separate terms. The current 0.62 Jaccard fuzzy match is a workaround for a structural problem.

**What to build:**
- A `term_normalization` Supabase table: `canonical_term → [variant_terms]`
- A normalization service called at ingestion, GA4 matching, and scoring
- Use Gemini to cluster semantically similar discovered terms: "Are 'smash burger,' 'smashburger,' and 'Oklahoma smash burger' the same trend or different?"
- All scoring, GA4 attribution, and discovery run through canonical terms

**Files to change:** `lib/term-normalizer.ts` (new), `api/discover.ts`, `api/trends.ts`, `api/ga4-backtest.ts`

**Supabase migration:** Add `term_canonical` table

---

### Module 2: Cron-Driven Time Series (Critical Architectural Fix)
**Priority: 2 — Enables everything else**

**Problem:** `trend_history` gets a new row when a user loads the app. Velocity and breakout prediction use data points from arbitrary session intervals, not real time intervals. Real cross-correlation math requires consistent timestamps.

**What to build:**
- A Vercel Cron job (daily) that scores all tracked terms and writes a `trend_history` snapshot with a consistent timestamp
- Move velocity calculation to use actual elapsed days between snapshots, not session count
- Store weekly signal snapshots per platform in `trend_history.raw_signals`

**Files to change:** `api/cron-score.ts` (new), `vercel.json` (add cron schedule), `api/trends.ts` (velocity calculation)

**Acceptance criteria:** `trend_history` accumulates one row per term per day regardless of user activity.

---

### Module 3: Social Signal Lead-Lag Detection
**Priority: 3 — Tests the core hypothesis**
**Depends on:** Module 2

**Problem:** The original hypothesis — "food trends start on social media before Google search" — is never actually tested. Signals are combined additively. The timing relationship that creates the opportunity window is invisible.

**What to build:**
- For each tracked term, compute cross-correlation with lag between social signals (TikTok, Reddit, LocalRedditIntent) and Google Trends (GoogleSearch, ConversationalSearch)
- Specifically: does a spike in Reddit/TikTok at week T predict a Google Trends spike at week T+2 or T+4?
- Tag each term with a trend state:
  - `PRE_PEAK` — social leading, search lagging (entry window)
  - `AT_PEAK` — both high (competitive, act fast)
  - `POST_PEAK` — search declining (saturating, deprioritize)
- Store `trend_state` and `lead_lag_weeks` in `trend_history`

**Use Gemini for:** Plain-English interpretation — "Reddit and TikTok activity for 'elote cups' started rising 3 weeks before Google search interest. This pattern historically precedes local market demand by 4-8 weeks. Consider piloting now."

**Files to change:** `lib/lead-lag.ts` (new), `api/cron-score.ts`, `supabase/schema.sql` (add `trend_state` column)

---

### Module 4: Supply Quality Index
**Priority: 4**

**Problem:** `availabilityScore` counts Yelp/Maps listings without weighting quality or relevance. One 4.8-star birria restaurant 0.5 miles away is more competitive than 10 ghost listings.

**What to build:**
- Extract from Yelp/Maps results: star rating, review count, price tier, distance from ZIP centroid, open/closed status
- Compute `supplyQualityIndex` with sub-components:
  - `supplyDensity` (listing count, normalized — current behavior)
  - `supplyQuality` (rating × review count composite)
  - `supplyProximity` (distance-weighted to scored ZIP)
  - `competitiveIntensity` = weighted combination of above
- Replace raw listing count with `competitiveIntensity` in `availabilityScore`

**Use Gemini for:** Reading top 5 competitor listings and summarizing: "3 local birria providers, but only 1 with strong reviews. Reviews mention long waits — positioning opportunity for reliable delivery/meal prep."

**Files to change:** `api/trends.ts` (`fetchYelp`, `fetchGoogleMaps`, `supplyScore`), `supabase/schema.sql`

---

### Module 5: Funnel Attribution per Term
**Priority: 5**
**Depends on:** Module 1 (canonical terms)

**Problem:** `gapScore` conflates two different business problems: "nobody local sells it" vs "people aren't converting on your existing pages." These require different responses.

**What to build:**
- GA4 event schema for the full funnel: `search_impression → page_view → menu_click → inquiry/purchase`
- Tag each event with normalized `term` attribute
- Materialize a daily `term_funnel` Supabase table:
  - `search_impressions`, `page_views`, `conversion_rate`, `dropoff_stage`
- New score: `conversionDeficitScore`
  - High intent + low page views → discovery/awareness problem
  - High page views + low conversion → offer/price/description problem
  - Low supply + both → genuine gap opportunity (launch signal)

**Use Gemini for:** Per-term funnel synthesis: "Birria tacos shows 480 monthly searches locally but 0 conversions on your site — your page doesn't exist for this term. Market supply is thin. High launch priority."

**Files to change:** `api/ga4-backtest.ts`, `supabase/schema.sql` (add `term_funnel` table), `api/trends.ts`

---

### Module 6: LLM-Powered Targeted Discovery
**Priority: 6**

**Problem:** Discovery is generic food trend detection. A trend like "gas station sushi" and "lamb birria" might both score high, but only one fits a private chef + meal prep business at $65-85/person.

**What to build:**
- Feed Gemini the business context: format (private chef, meal prep), price point, demographics, Minneapolis market, seasonal calendar
- Weekly targeted discovery prompt: "Given this business context, what food concepts are trending nationally that have NOT yet saturated the Minneapolis market and are plausibly deliverable as meal prep or private chef experiences at $65-85/person?"
- Add `businessFitScore` field to `discovery_queue` (0-100, LLM-assigned)
- Filter queue by `businessFitScore >= 60` before surfacing to admin

**Files to change:** `api/discover.ts`, `supabase/schema.sql` (add `business_fit_score` column to `discovery_queue`)

---

### Module 7: Outcome Tracking & Learning Loop
**Priority: 7 — Start immediately, payoff is long-term**

**Problem:** No feedback loop. When a recommended term is launched, there's no mechanism to record that and evaluate whether the signal was right. Weights stay permanently heuristic.

**What to build:**
- `launch_decisions` Supabase table: term, launch date, menu page URL, 30/60/90-day GA4 metrics post-launch
- When a term is approved from the queue and a page is generated, record a `launch_decision`
- After 30/60/90 days, compute: did predicted demand materialize? Compare actual performance to gap score at time of approval
- Feed outcomes into Module 8

**Files to change:** `api/queue.ts`, `api/generate-page.ts`, `supabase/schema.sql` (add `launch_decisions` table)

---

### Module 8: Empirical Weight Calibration
**Priority: 8 — Requires Modules 5 + 7 data**
**Depends on:** Modules 5 and 7

**Problem:** Platform weights (GoogleSearch: 2.8, TikTok: 1.1, etc.) were set by intuition and have never been backtested against actual business outcomes.

**What to build:**
- Export `trend_history` paired with GA4 conversion events for same terms/time windows
- Run regression: which score components actually predicted demand conversion?
- Surface a weight recommendation report
- Use Gemini to interpret: "Your model overweights TikTok signals relative to their actual conversion correlation. Recommend reducing TikTok weight from 1.1 to 0.7."
- Gate weight changes behind backtest metrics — never auto-apply without human review

**Files to change:** `api/calibrate.ts` (new), weight constants in `api/trends.ts`

---

### Module 9: Decision-Ready Dashboard
**Priority: 9 — UI layer on top of all above**
**Depends on:** Modules 2, 3, 4, 5

**Current state:** Signal board — shows data, leaves interpretation to the analyst.
**Target state:** Decision board — tells you what to do and why.

**New UI components:**

**Opportunity Card** (replaces table row):
- Term + state badge: `PRE-PEAK` / `AT-PEAK` / `SATURATING`
- Three-line rationale: "High demand (85/100). Thin local supply (2 providers, avg 3.2★). Your site has no page for this term. Est. addressable sessions: 340/mo."
- Single action: `Create Menu Item Draft`

**Funnel Panel** (per-term detail):
- Visual funnel: Impressions → Views → Clicks → Conversions
- Highlighted dropoff point with Gemini diagnosis

**Revenue Impact Estimate:**
- GA4 conversion rate × estimated addressable search volume × average order value
- Shown with confidence band: "Est. $800–2,400/mo if ranking for this term"

**Trend State Timeline:**
- Social lead vs. search lag chart (from Module 3)
- Labels the entry window period

**Files to change:** `components/OpportunityTable.tsx`, `components/TrendDetail.tsx`, new `components/FunnelPanel.tsx`

---

## Signals to Deprioritize

These signals are low-credibility or structurally broken. Do not invest further until higher-priority modules are done:

| Signal | Issue | Recommendation |
|--------|-------|---------------|
| `Pinterest` (0.6) | Reddit-proxy of Pinterest links — stale, indirect | Deprioritize; replace if Pinterest API opens |
| `RedditPushshift` (0.3) | API unreliable since 2023 policy changes | Remove in next cleanup |
| `MetaAds` (0.7) | Only meaningful with active ad campaigns + API token | Keep as optional; zero-weight if no token |

---

## SerpAPI Budget Management (<1,000 calls/month)

**Budget constraint:** Under 1,000 calls/month (~33/day hard cap).

**Call count per term per refresh cycle** (with caching):
| Signal | Engine | TTL | Effective daily calls (25 terms) |
|--------|--------|-----|----------------------------------|
| GoogleSearch (Trends) | google_trends | 24h | 25 |
| Delivery (Trends) | google_trends | 24h | 25 |
| Yelp | yelp | 24h | 25 |
| TikTok | google | 24h | 25 |
| YouTube | youtube | 48h | ~12 |
| GoogleNews | google_news | 12h | 25 (×2/day) |
| GoogleMaps | google_maps | 168h | ~4 |
| ConversationalSearch | google_trends | 72h | ~8 |

**Estimated baseline:** ~150 calls/day uncached → well over budget. Caching is essential.

**Recommendations to stay under 1,000/month:**
1. Enforce 72h minimum TTL on all Trends calls (already 24h — extend)
2. Drop `GoogleNews` TTL from 12h to 48h (news for food trends doesn't change hourly)
3. Reduce `MAX_TERMS_PER_REQUEST` to 10 active terms scored on-demand; others lazy-loaded
4. Run full refresh only via daily cron, not on every user page load
5. Audit cache hit rate monthly via `serp_cache.call_cost` sum

---

## Data & Modeling Guardrails (preserved from v1.0)

- Keep SerpAPI as primary external sensing layer
- Never allow pure virality signals to dominate without supply/realization checks
- Keep first-party GA4 data privileged for calibration decisions
- Preserve explainability in every score change — every metric must have an evidence string
- No hardcoded geography assumptions in core scoring/discovery paths
- Gate every model weight change behind backtest metrics before applying

---

## KPI Framework

Track continuously:

| KPI | Target | Notes |
|-----|--------|-------|
| Opportunity precision at top 5 | >60% | How often top-5 terms generate actual sales within 90 days |
| Launch-to-win rate | >50% | Launched terms that show measurable demand within 60 days |
| Median time from detection to decision | <7 days | Queue review + launch speed |
| Revenue lift from recommendations | Measurable vs. baseline | Requires Module 7 |
| SerpAPI calls/month | <1,000 | Hard budget constraint |
| False-positive rate by ZIP | Track per-ZIP | Identify geo-specific noise sources |

**Success condition:** Recommendations become reliable enough to directly drive the monthly launch calendar by geography — with confidence scores that let you prioritize investment.
