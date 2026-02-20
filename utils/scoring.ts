import { SignalData, Platform } from '../types';

const PLATFORM_WEIGHTS: Record<Platform, number> = {
  [Platform.OwnSales]: 3.0,     // Strongest signal: actual purchases
  [Platform.TikTok]: 2.5,       // High viral potential (Demand)
  [Platform.YouTube]: 2.2,      // Video content traction (Demand)
  [Platform.OwnTraffic]: 1.8,   // Your own page views
  [Platform.Reddit]: 1.5,       // Community interest (Demand)
  [Platform.GoogleNews]: 1.4,   // Media coverage (Demand)
  [Platform.Pinterest]: 1.2,    // Visual interest / planning (Demand)
  [Platform.GoogleSearch]: 1.0,  // General intent
  [Platform.MetaAds]: 0.8,      // Ad performance feedback
  [Platform.Wildchat]: 0.6,     // LLM curiosity signal
  [Platform.Yelp]: 0.5,         // Established supply (Supply indicator)
  [Platform.DoorDash]: 0.5,     // Established supply (Supply indicator)
  [Platform.GoogleMaps]: 0.5,   // Local supply density (Supply indicator)
  [Platform.RedditPushshift]: 0.3,
};

const SUPPLY_PLATFORMS = new Set<Platform>([
  Platform.Yelp,
  Platform.DoorDash,
  Platform.GoogleMaps,
]);

const DEMAND_PLATFORMS = new Set<Platform>([
  Platform.OwnSales,
  Platform.TikTok,
  Platform.YouTube,
  Platform.OwnTraffic,
  Platform.Reddit,
  Platform.GoogleNews,
  Platform.Pinterest,
  Platform.GoogleSearch,
  Platform.MetaAds,
  Platform.Wildchat,
]);

/**
 * Demand Score: weighted average of demand-side signal intensities.
 */
export const calculateDemandScore = (signals: SignalData[]): number => {
  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (const signal of signals) {
    if (!DEMAND_PLATFORMS.has(signal.platform)) continue;
    const weight = PLATFORM_WEIGHTS[signal.platform] || 1;
    totalWeightedScore += signal.currentIntensity * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return Math.min(100, Math.round(totalWeightedScore / totalWeight));
};

/**
 * Supply Score: average of supply-side signal intensities.
 * Google Places count (stored as GoogleSearch from Places API) also counts as supply.
 */
export const calculateSupplyScore = (signals: SignalData[]): number => {
  const supplySignals = signals.filter(s => SUPPLY_PLATFORMS.has(s.platform));
  if (supplySignals.length === 0) return 10; // baseline low supply
  const avg = supplySignals.reduce((acc, s) => acc + s.currentIntensity, 0) / supplySignals.length;
  return Math.min(100, Math.round(avg));
};

/**
 * Unmet Demand = Demand - discounted Supply. Clamped [0, 100].
 */
export const calculateUnmetDemandScore = (demand: number, supply: number): number => {
  const raw = demand - (supply * 0.8);
  return Math.max(0, Math.min(100, Math.round(raw)));
};

/**
 * Breakout Probability based on weighted signal velocity.
 * OwnSales velocity is the strongest predictor.
 */
export const calculateBreakoutProbability = (signals: SignalData[]): number => {
  let weightedVelocity = 0;
  let totalWeight = 0;

  for (const signal of signals) {
    const weight = PLATFORM_WEIGHTS[signal.platform] || 1;
    weightedVelocity += signal.velocity * weight;
    totalWeight += weight;
  }

  const avgVelocity = totalWeight > 0 ? weightedVelocity / totalWeight : 0;

  // Map: velocity 0 -> 20%, velocity 10 -> 60%, velocity 20 -> 100%
  const prob = 20 + (avgVelocity * 4);
  return Math.max(0, Math.min(100, Math.round(prob)));
};

/**
 * Predict breakout week using linear projection of unmet demand history.
 * Returns 0 if slope is flat or negative (not breaking out).
 */
export const predictBreakoutWeek = (
  historyScores: { week: number; unmetDemandScore: number }[],
  currentUnmetDemand: number,
  threshold = 80
): number => {
  if (currentUnmetDemand >= threshold) return 0; // already broken out

  // Need at least 3 data points
  if (historyScores.length < 3) {
    return currentUnmetDemand > 50 ? 4 : 0; // rough guess
  }

  // Use last 6 points max for slope calculation
  const recent = historyScores.slice(-6);
  const n = recent.length;
  const sumX = recent.reduce((a, h) => a + h.week, 0);
  const sumY = recent.reduce((a, h) => a + h.unmetDemandScore, 0);
  const sumXY = recent.reduce((a, h) => a + h.week * h.unmetDemandScore, 0);
  const sumX2 = recent.reduce((a, h) => a + h.week * h.week, 0);

  const denom = (n * sumX2 - sumX * sumX);
  if (denom === 0) return 0;

  const slope = (n * sumXY - sumX * sumY) / denom;

  if (slope <= 0) return 0; // flat or declining

  const weeksToThreshold = Math.ceil((threshold - currentUnmetDemand) / slope);
  return Math.min(52, Math.max(1, weeksToThreshold));
};
