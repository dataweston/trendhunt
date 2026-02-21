/**
 * Lead-Lag Detection — Module 3
 *
 * Tests the core TrendHunt hypothesis: food trends appear on social media
 * (TikTok, Reddit) before they surface in Google search. A positive lead-lag
 * means social signals are ahead of search, indicating an entry window.
 *
 * Algorithm:
 *   1. Extract per-row social composite and search composite from raw_signals.
 *   2. Compute cross-correlation at lags 0–4 weeks.
 *   3. The lag with the highest correlation coefficient is the lead-lag estimate.
 *   4. Classify into PRE_PEAK / AT_PEAK / POST_PEAK / INSUFFICIENT_DATA.
 */

export type TrendState = 'PRE_PEAK' | 'AT_PEAK' | 'POST_PEAK' | 'INSUFFICIENT_DATA';

export interface LeadLagResult {
  trendState: TrendState;
  leadLagWeeks: number;      // positive = social leads search; negative = search leads
  correlation: number;       // best cross-correlation coefficient (-1 to 1)
}

// Platforms that form the "social" composite signal
const SOCIAL_PLATFORMS = new Set([
  'TikTok', 'Reddit', 'LocalRedditIntent',
]);

// Platforms that form the "search" composite signal
const SEARCH_PLATFORMS = new Set([
  'GoogleSearch', 'ConversationalSearch',
]);

// Minimum history rows required for a meaningful computation
const MIN_ROWS = 6;

// Lag range to test (weeks)
const MAX_LAG = 4;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function average(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Extract composite score for a platform set from a raw_signals array. */
function compositeFromSignals(
  rawSignals: { platform: string; currentIntensity: number; velocity: number }[],
  platforms: Set<string>,
  useVelocity = false,
): number {
  const values = rawSignals
    .filter(s => platforms.has(s.platform))
    .map(s => useVelocity ? s.velocity : s.currentIntensity);
  return values.length ? average(values) : 0;
}

/**
 * Pearson cross-correlation between series X and Y at a given lag.
 * Positive lag = X leads Y (X[t] correlates with Y[t+lag]).
 */
function crossCorrelation(x: number[], y: number[], lag: number): number {
  const n = Math.min(x.length, y.length);
  const effectiveN = n - Math.abs(lag);
  if (effectiveN < 3) return 0;

  let xi: number[], yi: number[];
  if (lag >= 0) {
    xi = x.slice(0, effectiveN);
    yi = y.slice(lag, lag + effectiveN);
  } else {
    xi = x.slice(-lag, -lag + effectiveN);
    yi = y.slice(0, effectiveN);
  }

  const mx = average(xi);
  const my = average(yi);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < effectiveN; i++) {
    const dx = xi[i] - mx;
    const dy = yi[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : 0;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface TrendHistoryRow {
  timestamp: string;
  raw_signals: { platform: string; currentIntensity: number; velocity: number }[] | null;
  gap_score?: number;
  intent_score?: number;
}

/**
 * Compute social-vs-search lead-lag for a term given its trend_history rows.
 * Rows should be ordered oldest → newest (ascending timestamp).
 */
export function computeLeadLag(historyRows: TrendHistoryRow[]): LeadLagResult {
  const INSUFFICIENT: LeadLagResult = {
    trendState: 'INSUFFICIENT_DATA',
    leadLagWeeks: 0,
    correlation: 0,
  };

  // Filter rows that have raw_signals
  const rows = historyRows
    .filter(r => Array.isArray(r.raw_signals) && r.raw_signals.length > 0)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (rows.length < MIN_ROWS) return INSUFFICIENT;

  // Build time series
  const socialSeries = rows.map(r =>
    compositeFromSignals(r.raw_signals!, SOCIAL_PLATFORMS, true), // use velocity for social
  );
  const searchSeries = rows.map(r =>
    compositeFromSignals(r.raw_signals!, SEARCH_PLATFORMS, false), // use intensity for search
  );

  // Cross-correlation at lags 0..MAX_LAG (social leading search = positive lag)
  let bestCorr = -Infinity;
  let bestLag = 0;
  for (let lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
    const corr = crossCorrelation(socialSeries, searchSeries, lag);
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  // Current-period values for state classification
  const recentRows = rows.slice(-3);
  const socialAvg = average(recentRows.map(r => compositeFromSignals(r.raw_signals!, SOCIAL_PLATFORMS, false)));
  const searchAvg = average(recentRows.map(r => compositeFromSignals(r.raw_signals!, SEARCH_PLATFORMS, false)));

  // Search velocity (last 2 weeks) to detect POST_PEAK
  const lastSearch = searchSeries[searchSeries.length - 1] ?? 0;
  const prevSearch = searchSeries[searchSeries.length - 2] ?? lastSearch;
  const searchDecline = lastSearch < prevSearch - 5;

  let trendState: TrendState;
  if (searchDecline && searchAvg < 30) {
    trendState = 'POST_PEAK';
  } else if (bestLag >= 2 && socialAvg > searchAvg * 1.2 && socialAvg > 10) {
    trendState = 'PRE_PEAK';
  } else if (socialAvg > 30 && searchAvg > 30) {
    trendState = 'AT_PEAK';
  } else if (searchAvg > socialAvg * 1.5 && searchAvg > 20) {
    // Search dominates — past the social-led phase
    trendState = 'POST_PEAK';
  } else {
    // Ambiguous — not enough signal differentiation yet
    trendState = 'INSUFFICIENT_DATA';
  }

  return {
    trendState,
    leadLagWeeks: bestLag,
    correlation: Math.round(bestCorr * 100) / 100,
  };
}
