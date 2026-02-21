/**
 * TrendSurge — open-source Glimpse / Exploding Topics mimic.
 *
 * What paid tools do that we replicate here:
 *
 *  1. MULTI-SOURCE CORROBORATION — a trend is "real" only when multiple independent
 *     sources agree within the same time window. Single-source spikes are noise.
 *
 *  2. SURGE DETECTION — compare recent N weeks vs prior N weeks across sources.
 *     Paid tools use proprietary panel data; we use the public signals we already have.
 *
 *  3. MATURITY CLASSIFICATION — where is this trend in its lifecycle?
 *     Emerging (<6 months of signal) → Rising (6–18 months) → Mainstream (18m+) → Saturating
 *
 *  4. VELOCITY ACCELERATION — is momentum increasing or decreasing?
 *     Second derivative of the signal slope, not just the slope itself.
 *
 *  5. LEAD INDICATOR WEIGHTING — social precedes search by 2–4 weeks.
 *     Upweight social velocity vs search velocity in surge score.
 *
 * All of this is computed from signals already in our pipeline — no new API calls.
 * This is the "intelligence layer" on top of raw intensities.
 */

export type TrendMaturity = 'EMERGING' | 'RISING' | 'MAINSTREAM' | 'SATURATING' | 'UNKNOWN';

export interface SurgeResult {
  /** Composite surge score 0–100. >60 = act now, 40–60 = monitor, <40 = low priority. */
  surgeScore: number;
  /** Number of independent sources showing upward signal in the last 30 days */
  corroboratingSignals: number;
  /** Total sources checked */
  totalSignals: number;
  /** Lifecycle stage */
  maturity: TrendMaturity;
  /** Second derivative of momentum — positive = accelerating, negative = decelerating */
  acceleration: number;
  /** Plain English label for display */
  surgeLabel: string;
  /** One-line rationale explaining the score */
  rationale: string;
}

export interface SignalInput {
  platform: string;
  currentIntensity: number;
  velocity: number;
  history: { week: number; value: number }[];
  /** Weight override (defaults to platform weight table) */
  weight?: number;
}

// Platform weights: social platforms are LEADING indicators; search is LAGGING
const SURGE_WEIGHTS: Record<string, number> = {
  // High-weight leading indicators (move first)
  TikTok: 2.0,
  Reddit: 1.8,
  LocalRedditIntent: 1.8,
  InstagramOrganic: 1.6,
  Pinterest: 1.4,
  YouTube: 1.3,
  GoogleNews: 1.2,
  // Lagging but high-confidence anchors
  GoogleSearch: 1.5,
  KeywordPlanner: 2.0,  // absolute volume = ground truth
  ConversationalSearch: 1.3,
  DoorDash: 1.1,
  // Owned — highest weight, but not a "surge" signal (already converted)
  OwnSales: 0.5,
  OwnTraffic: 0.5,
  // Supply signals — invert (high supply = lower surge potential)
  Yelp: -0.3,
  YelpFusion: -0.3,
  GoogleMaps: -0.3,
  // Background signals
  MetaAds: 0.8,
  GA4Backtest: 0.6,
};

const SUPPLY_PLATFORMS = new Set(['Yelp', 'YelpFusion', 'GoogleMaps']);

/** Detect trend maturity from history length + intensity trajectory. */
function classifyMaturity(signals: SignalInput[]): TrendMaturity {
  const nonSupply = signals.filter(s => !SUPPLY_PLATFORMS.has(s.platform));
  const withHistory = nonSupply.filter(s => s.history.length >= 4);

  if (withHistory.length === 0) return 'UNKNOWN';

  // How many weeks of history do we have? Proxy for how long the term has been tracked.
  const maxHistory = Math.max(...withHistory.map(s => s.history.length));

  // Compute average intensity across all non-supply signals
  const avgIntensity = nonSupply.reduce((s, sig) => s + sig.currentIntensity, 0) / Math.max(nonSupply.length, 1);

  // Detect if the overall trajectory is declining (saturating)
  const decliningCount = withHistory.filter(s => {
    const hist = s.history;
    const recent = hist.slice(-3).reduce((a, h) => a + h.value, 0) / 3;
    const older = hist.slice(0, 3).reduce((a, h) => a + h.value, 0) / 3;
    return recent < older * 0.85;
  }).length;
  const decliningFraction = decliningCount / withHistory.length;

  if (decliningFraction > 0.5 && avgIntensity > 40) return 'SATURATING';
  if (maxHistory <= 4 && avgIntensity < 40) return 'EMERGING';
  if (maxHistory <= 8) return 'RISING';
  if (avgIntensity > 60) return 'MAINSTREAM';
  return 'RISING';
}

/** Compute velocity acceleration (second derivative) from history. */
function computeAcceleration(history: { week: number; value: number }[]): number {
  if (history.length < 4) return 0;
  const recent = history.slice(-4);
  // Velocity of recent half vs older half
  const firstHalf = recent.slice(0, 2);
  const secondHalf = recent.slice(2);
  const v1 = (firstHalf[1]?.value ?? 0) - (firstHalf[0]?.value ?? 0);
  const v2 = (secondHalf[1]?.value ?? 0) - (secondHalf[0]?.value ?? 0);
  return v2 - v1; // positive = accelerating
}

/**
 * Compute a surge score from existing signals.
 * No new API calls — pure computation on what's already been fetched.
 */
export function computeSurge(signals: SignalInput[]): SurgeResult {
  if (!signals.length) {
    return { surgeScore: 0, corroboratingSignals: 0, totalSignals: 0, maturity: 'UNKNOWN', acceleration: 0, surgeLabel: 'No data', rationale: 'No signals available.' };
  }

  const nonSupply = signals.filter(s => !SUPPLY_PLATFORMS.has(s.platform));
  const totalSignals = nonSupply.length;

  // Count corroborating signals: independently trending upward
  let corroboratingSignals = 0;
  let weightedSurge = 0;
  let totalWeight = 0;
  let overallAcceleration = 0;
  let accelCount = 0;

  for (const sig of nonSupply) {
    const weight = sig.weight ?? SURGE_WEIGHTS[sig.platform] ?? 1.0;
    if (weight <= 0) continue; // skip supply-as-demand inverters

    const isActive = sig.currentIntensity > 0 || sig.velocity > 0;
    const isSurging = sig.velocity > 0 && sig.currentIntensity > 10;

    if (isActive) {
      totalWeight += weight;
      // Surge contribution: intensity × velocity bonus × weight
      const velocityBonus = sig.velocity > 0 ? 1 + sig.velocity / 20 : 1;
      weightedSurge += sig.currentIntensity * velocityBonus * weight;
    }

    if (isSurging) corroboratingSignals++;

    // Acceleration from history
    if (sig.history.length >= 4) {
      overallAcceleration += computeAcceleration(sig.history);
      accelCount++;
    }
  }

  // Normalize to 0–100
  const rawSurge = totalWeight > 0 ? weightedSurge / totalWeight : 0;
  // Apply corroboration multiplier: more sources = more confidence
  const corrobMultiplier = 0.7 + 0.3 * Math.min(1, corroboratingSignals / 4);
  const surgeScore = Math.max(0, Math.min(100, Math.round(rawSurge * corrobMultiplier)));

  const acceleration = accelCount > 0 ? Math.round(overallAcceleration / accelCount) : 0;
  const maturity = classifyMaturity(signals);

  // Labels
  const surgeLabel =
    surgeScore >= 70 ? 'Surging' :
    surgeScore >= 50 ? 'Rising' :
    surgeScore >= 30 ? 'Stirring' :
    surgeScore > 0  ? 'Quiet' : 'Flat';

  const corrobText = corroboratingSignals >= 3
    ? `${corroboratingSignals} independent sources trending up`
    : corroboratingSignals === 2
      ? '2 sources trending up (moderate confidence)'
      : corroboratingSignals === 1
        ? '1 source trending up (low confidence — watch closely)'
        : 'no sources trending up';

  const accelText = acceleration > 2 ? ' Momentum is accelerating.' :
                    acceleration < -2 ? ' Momentum is decelerating.' : '';

  const rationale = `${corrobText}.${accelText} Maturity: ${maturity.toLowerCase()}.`;

  return { surgeScore, corroboratingSignals, totalSignals, maturity, acceleration, surgeLabel, rationale };
}

/** Format surge score for display in TrendDetail / OpportunityTable. */
export function surgeBadgeProps(surge: SurgeResult): { label: string; color: string; pulse: boolean } {
  if (surge.surgeScore >= 70) return { label: 'Surging', color: 'text-emerald-400', pulse: true };
  if (surge.surgeScore >= 50) return { label: 'Rising', color: 'text-amber-400', pulse: false };
  if (surge.surgeScore >= 30) return { label: 'Stirring', color: 'text-blue-400', pulse: false };
  return { label: 'Quiet', color: 'text-slate-500', pulse: false };
}
