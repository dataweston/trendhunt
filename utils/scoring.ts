import { SignalData, Platform } from '../types';

const PLATFORM_WEIGHTS: Record<Platform, number> = {
  [Platform.TikTok]: 2.0, // High viral potential (Demand)
  [Platform.Reddit]: 1.5, // Community interest (Demand)
  [Platform.Pinterest]: 1.2, // Visual interest (Demand)
  [Platform.GoogleSearch]: 1.0, // General interest
  [Platform.Yelp]: 0.5, // Established supply (Supply indicator)
  [Platform.DoorDash]: 0.5 // Established supply (Supply indicator)
};

/**
 * Calculates the Demand Score based on weighted average of signal intensities.
 * Focuses on "Demand" platforms like TikTok, Reddit, Pinterest.
 */
export const calculateDemandScore = (signals: SignalData[]): number => {
  let totalWeightedScore = 0;
  let totalWeight = 0;

  signals.forEach(signal => {
    // Skip supply-heavy platforms for demand calculation or give them very low weight
    // For this logic, we'll treat Yelp/DoorDash as purely supply signals
    if (signal.platform === Platform.Yelp || signal.platform === Platform.DoorDash) return;

    const weight = PLATFORM_WEIGHTS[signal.platform] || 1;
    totalWeightedScore += signal.currentIntensity * weight;
    totalWeight += weight;
  });

  if (totalWeight === 0) return 0;
  return Math.min(100, Math.round(totalWeightedScore / totalWeight));
};

/**
 * Calculates the Supply Score based on presence in "Supply" platforms.
 * Uses Yelp, DoorDash, and GoogleSearch (as a proxy for business listings).
 */
export const calculateSupplyScore = (signals: SignalData[]): number => {
  const supplySignals = signals.filter(s => 
    s.platform === Platform.Yelp || 
    s.platform === Platform.DoorDash ||
    s.platform === Platform.GoogleSearch
  );

  if (supplySignals.length === 0) return 10; // Baseline low supply

  // Simple average of supply signal intensities
  const avgIntensity = supplySignals.reduce((acc, curr) => acc + curr.currentIntensity, 0) / supplySignals.length;
  return Math.min(100, Math.round(avgIntensity));
};

/**
 * Calculates Unmet Demand Score: Demand - Supply.
 */
export const calculateUnmetDemandScore = (demand: number, supply: number): number => {
  // If demand is high and supply is low, this score is high.
  // If supply > demand, this score is 0.
  // We add a small buffer or scaling if needed, but simple subtraction is a good start.
  const rawScore = demand - (supply * 0.8); // Discount supply slightly to be generous to opportunities
  return Math.max(0, Math.min(100, Math.round(rawScore)));
};

/**
 * Calculates Breakout Probability based on signal velocity (growth rate).
 */
export const calculateBreakoutProbability = (signals: SignalData[]): number => {
  let weightedVelocity = 0;
  let totalWeight = 0;

  signals.forEach(signal => {
    const weight = PLATFORM_WEIGHTS[signal.platform] || 1;
    weightedVelocity += signal.velocity * weight;
    totalWeight += weight;
  });

  const avgVelocity = totalWeight > 0 ? weightedVelocity / totalWeight : 0;

  // Map velocity to probability.
  // Velocity of 0 -> 20% probability
  // Velocity of 10 -> 60% probability
  // Velocity of 20 -> 100% probability
  const baseProb = 20;
  const velocityFactor = 4; 
  
  const prob = baseProb + (avgVelocity * velocityFactor);
  return Math.max(0, Math.min(100, Math.round(prob)));
};
