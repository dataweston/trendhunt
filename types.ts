export enum Platform {
  Reddit = 'Reddit',
  TikTok = 'TikTok',
  GoogleSearch = 'GoogleSearch',
  Yelp = 'Yelp',
  DoorDash = 'DoorDash',
  Pinterest = 'Pinterest',
  RedditPushshift = 'RedditPushshift',
  OwnSales = 'OwnSales',
  OwnTraffic = 'OwnTraffic',
  GA4Backtest = 'GA4Backtest',
  MetaAds = 'MetaAds',
  YouTube = 'YouTube',
  GoogleNews = 'GoogleNews',
  GoogleMaps = 'GoogleMaps',
  ConversationalSearch = 'ConversationalSearch',
  LocalRedditIntent = 'LocalRedditIntent',
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
  supplyQuality?: number; // 0-100, only set for Yelp/GoogleMaps signals (Module 4)
}

// Trend state from social-vs-search lead-lag detection (Module 3)
export type TrendState = 'PRE_PEAK' | 'AT_PEAK' | 'POST_PEAK' | 'INSUFFICIENT_DATA';

// Per-term funnel metrics from GA4 (Module 5)
export interface TermFunnel {
  term: string;
  searchImpressions: number;
  pageViews: number;
  conversionEvents: number;
  conversionRate: number;
  dropoffStage: 'no_page' | 'low_conversion' | 'healthy' | 'unknown';
  geminiDiagnosis?: string;
}

export interface TrendEntity {
  id: string;
  term: string;
  category: string;
  region: string;
  neighborhood: string;
  zipCode?: string;
  signals: SignalData[];
  intentScore: number;
  availabilityScore: number;
  realizationScore: number;
  gapScore: number;
  confidenceScore: number;
  serpapiShare: number;
  serpapiSignals: string[];
  evidence: string[];
  supplyScore: number;
  demandScore: number;
  unmetDemandScore: number;
  breakoutProbability: number;
  predictedBreakoutWeek: number;
  // Module 3: Lead-lag detection
  trendState?: TrendState;
  leadLagWeeks?: number;
  trendStateNarrative?: string;
  // Module 5: Funnel attribution
  conversionDeficitScore?: number;
  funnelData?: TermFunnel;
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
  business_fit_score?: number;
  business_fit_rationale?: string;
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
