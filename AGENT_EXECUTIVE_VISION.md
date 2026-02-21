# Trend Hunt Refactor: Executive Vision and Stage 2 Roadmap

## 1. Mission

Trend Hunt exists to detect **unmet local demand** by ZIP code:
- What people are actively searching for
- What local supply currently offers
- What demand is not being realized as purchases

The product decision objective is simple:
- Prioritize concepts where **intent is high**, **availability is low**, and **realized conversion is weak**.

## 2. Strategic Positioning of Data Sources

### Primary external source: SerpAPI
SerpAPI is the backbone for demand and availability evidence because it can be localized and queried consistently across sources.

Current primary SerpAPI channels:
- Google Trends (search intent)
- Delivery-related trend search
- Yelp (local supply)
- Google Maps (local supply)
- YouTube/Google News/TikTok-via-Google for momentum context

### First-party source: GA4 + sales systems
First-party data is the realism anchor:
- GA4 traffic for current realization signals
- GA4 backtest for historical keyword priors
- Square sales proxy where available

Strategic rule:
- SerpAPI drives market sensing.
- First-party data calibrates what is actually monetizing.

## 3. Refactor Thesis (Stage 1 Delivered)

### Core model shift
The system moved from a single unmet-demand abstraction to explicit components:
- `intentScore`
- `availabilityScore`
- `realizationScore`
- `gapScore`
- `confidenceScore`

Plus explainability:
- `serpapiShare`
- `serpapiSignals`
- `evidence[]`

### Scope shift
The system moved from metro hardcoding to ZIP-first context:
- Shared location utility (`lib/location.ts`)
- Zip-aware trend scoring requests (`/api/trends?zip=...`)
- Zip-aware discovery (`/api/discover?manual=true&zip=...`)
- Queue approvals persist ZIP-oriented region/neighborhood instead of fixed city labels

### Pipeline shift
Discovery now prioritizes:
1. SerpAPI evidence
2. Cross-source corroboration
3. GA4 backtest priors as ranking boosts

This aligns candidate generation with both market demand and owned historical performance.

## 4. What This Solves vs. What It Does Not Yet Solve

### Solved now
- ZIP-scoped signal collection and scoring
- SerpAPI made explicit as primary external signal layer
- GA4 backtest integrated into discovery ranking and trend confidence context
- Better explainability for why a term is flagged

### Not fully solved yet
The app still infers "searched but not purchased" rather than measuring it directly.

Current gap:
- No strict per-term funnel from search/view intent to purchase conversion by ZIP.

Implication:
- `gapScore` is directionally useful but still partly heuristic.

## 5. Stage 2 North Star

Build a **causal demand-gap engine**:
- Estimate lost demand attributable to local unavailability.
- Rank opportunities by expected incremental revenue if supply is introduced.

Required upgrade:
- Move from "signal scoring" to "funnel + counterfactual estimation."

## 6. Stage 2 Roadmap (Execution Order)

## Phase 2.1: Measurement Foundation (highest priority)

Goal:
- Capture direct conversion-dropoff evidence for each term and ZIP.

Deliverables:
- Event schema for `search -> content view -> product detail -> add to cart -> purchase`
- Term normalization service shared across ingestion and analytics
- ZIP attribution for all first-party events where feasible
- Daily materialized tables for term-level funnel metrics

Acceptance criteria:
- For top tracked terms, system can output:
  - Search volume
  - Conversion rate
  - Dropoff point
  - ZIP-specific comparison

## Phase 2.2: Availability Deficit Modeling

Goal:
- Quantify whether low conversion is plausibly caused by low local supply.

Deliverables:
- SerpAPI supply depth index:
  - Listing count
  - Result quality signals (ratings/reviews)
  - Distance/coverage heuristics
- Availability-to-conversion relationship features per term/ZIP
- `availability_deficit_score` separated from raw supply intensity

Acceptance criteria:
- For each term/ZIP, dashboard can distinguish:
  - Low conversion due to low demand quality
  - Low conversion due to probable supply deficit

## Phase 2.3: Counterfactual Revenue Estimation

Goal:
- Estimate upside if a concept is launched in a ZIP.

Deliverables:
- Baseline conversion model from first-party history
- Counterfactual uplift estimate for improved availability
- Confidence interval bands
- New output metric: `expected_incremental_revenue`

Acceptance criteria:
- Opportunity list sortable by expected revenue impact, not only gap score.

## Phase 2.4: Backtesting and Calibration

Goal:
- Replace heuristic weights with empirical calibration.

Deliverables:
- Historical replay tests on launched vs non-launched terms
- Weight tuning for score components
- Precision/recall reporting for "successful opportunity" predictions

Acceptance criteria:
- Demonstrated uplift in hit rate vs current heuristic baseline.

## Phase 2.5: Operational Hardening

Goal:
- Make system dependable for daily decisioning.

Deliverables:
- Data freshness and ingestion health checks
- Alerting for API/source failures
- Cost guardrails for SerpAPI query classes
- Caching and fallback strategy docs

Acceptance criteria:
- Daily pipeline runs without manual intervention and with visible health status.

## 7. Product Surface Evolution for Stage 2

Dashboard should evolve from "signal board" to "decision board."

Required UI changes:
- Funnel panel per term (search->purchase)
- Availability deficit panel (supply depth + coverage)
- Revenue impact panel with confidence range
- Explicit rationale text: "Flagged because X demand, Y supply deficit, Z projected upside"

## 8. Data and Modeling Guardrails

Rules future agents should preserve:
- Keep SerpAPI as primary external sensing layer.
- Never allow pure virality signals to dominate without supply/realization checks.
- Keep first-party data privileged for calibration decisions.
- Preserve explainability in every score change.
- No hardcoded geography assumptions in core scoring/discovery paths.

## 9. Execution Notes for Agents

When implementing Stage 2, follow this order:
1. Ship event schema + ingestion first.
2. Add model features only after data is complete and validated.
3. Gate each model change behind backtest metrics.
4. Update docs and dashboard language with each metric change.

Definition of done per increment:
- Typecheck/build pass
- Migration and rollback notes
- Clear API contract changes
- KPI impact measured against prior baseline

## 10. KPI Framework (Program-Level)

Track these program metrics continuously:
- Opportunity precision at top N
- Launch-to-win rate for recommended terms
- Median time from detection to decision
- Revenue lift from launched recommendations
- False-positive rate by ZIP

Success condition:
- Recommendations become reliable enough to directly drive launch calendars by geography.

---

## Executive Summary

Stage 1 established the correct architecture: ZIP-first scoring, SerpAPI-primary sensing, and GA4 historical priors.  
Stage 2 must convert this into a measurable demand-conversion engine with counterfactual revenue estimates.  
The winning system is not just "what is trending," but "what we should launch next in this ZIP, with expected upside and confidence."
