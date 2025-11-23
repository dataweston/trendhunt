export enum Platform {
  Reddit = 'Reddit',
  TikTok = 'TikTok',
  GoogleSearch = 'GoogleSearch',
  Yelp = 'Yelp',
  DoorDash = 'DoorDash',
  Pinterest = 'Pinterest',
  RedditPushshift = 'RedditPushshift',
  Wildchat = 'Wildchat'
}

export interface TimeSeriesPoint {
  week: number; // Week number (1-52)
  value: number; // Normalized intensity (0-100)
}

export interface SignalData {
  platform: Platform;
  history: TimeSeriesPoint[];
  currentIntensity: number;
  velocity: number; // Change over last period
}

export interface TrendEntity {
  id: string;
  term: string; // e.g., "Birria Tacos"
  category: string; // e.g., "Mexican"
  region: string; // e.g., "Minneapolis–St Paul"
  neighborhood: string; // e.g. "North Loop"
  signals: SignalData[];
  supplyScore: number; // 0-100 (100 = saturated)
  demandScore: number; // 0-100 (100 = viral)
  unmetDemandScore: number; // Calculated (Demand - Supply)
  breakoutProbability: number; // 0-100%
  predictedBreakoutWeek: number; // estimated week number
}

export interface GeoRegion {
  id: string;
  name: string;
  lat: number;
  lng: number;
  demandHotspots: { lat: number; lng: number; intensity: number }[];
}

export interface AnalysisResult {
  summary: string;
  recommendation: string;
  riskAssessment: string;
}
