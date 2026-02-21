export enum Platform {
  Reddit = 'Reddit',
  TikTok = 'TikTok',
  GoogleSearch = 'GoogleSearch',
  Yelp = 'Yelp',
  DoorDash = 'DoorDash',
  Pinterest = 'Pinterest',
  RedditPushshift = 'RedditPushshift',
  Wildchat = 'Wildchat',
  OwnSales = 'OwnSales',
  OwnTraffic = 'OwnTraffic',
  GA4Backtest = 'GA4Backtest',
  MetaAds = 'MetaAds',
  YouTube = 'YouTube',
  GoogleNews = 'GoogleNews',
  GoogleMaps = 'GoogleMaps',
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
  zipCode?: string;
  signals: SignalData[];
  intentScore: number; // 0-100 local intent
  availabilityScore: number; // 0-100 local availability
  realizationScore: number; // 0-100 local purchase realization
  gapScore: number; // 0-100 unmet demand gap
  confidenceScore: number; // 0-100 score confidence
  serpapiShare: number; // 0-100 signal share from SerpAPI-backed sources
  serpapiSignals: string[]; // contributing SerpAPI-backed platforms
  evidence: string[]; // short explanatory evidence lines
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

export interface DiscoveryQueueItem {
  id: string;
  term: string;
  source: string;
  initial_score: number;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

export interface ProductPageDraft {
  id: string;
  trendTerm: string;
  title: string;
  description: string;
  seoMeta: { title: string; description: string; keywords: string[] };
  suggestedPrice?: number;
  status: 'draft' | 'review' | 'published';
  createdAt: string;
}
