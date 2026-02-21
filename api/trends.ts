import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { serpSearch, getUsageStats } from '../lib/serp-governor.js';
import { isAdminRequest } from '../lib/api-auth.js';
import { getLocationContext, type LocationContext } from '../lib/location.js';
import { normalizeTermKey, similarityScore } from '../lib/term-normalizer.js';

// --- Types (standalone for serverless) ---
enum Platform {
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
  InstagramOrganic = 'InstagramOrganic',
  YouTube = 'YouTube',
  GoogleNews = 'GoogleNews',
  GoogleMaps = 'GoogleMaps',
  ConversationalSearch = 'ConversationalSearch',
  LocalRedditIntent = 'LocalRedditIntent',
}

interface SignalData {
  platform: Platform;
  history: { week: number; value: number }[];
  currentIntensity: number;
  velocity: number;
  supplyQuality?: number; // 0-100, set on Yelp/GoogleMaps signals (Module 4)
}

interface TermFunnel {
  term: string;
  searchImpressions: number;
  pageViews: number;
  conversionEvents: number;
  conversionRate: number;
  dropoffStage: 'no_page' | 'low_conversion' | 'healthy' | 'unknown';
  geminiDiagnosis?: string;
}

interface TrendEntity {
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
  // Module 3: Lead-lag
  trendState?: string;
  leadLagWeeks?: number;
  trendStateNarrative?: string;
  // Module 5: Funnel attribution
  conversionDeficitScore?: number;
  funnelData?: TermFunnel;
}

// --- Config ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const EXTERNAL_TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS || 5000);
const TERM_PROCESS_CONCURRENCY = Number(process.env.TERM_PROCESS_CONCURRENCY || 3);
const MAX_TERMS_PER_REQUEST = Number(process.env.MAX_TERMS_PER_REQUEST || 25);

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const DEMO_TERMS = new Set([
  'Birria Tacos',
  'Mochi Donuts',
  'Korean Corn Dogs',
  'Detroit-style Pizza',
  'Ube Lattes',
]);


const GA4_BOOSTABLE_TYPES = new Set(['food_concept', 'offer_type']);
const NAV_NOISE_TOKENS = [
  '(not set)', 'about', 'contact', 'privacy', 'terms', 'account', 'login', 'calendar', 'portal',
  'partner', 'partners', 'wedding', 'weddings', 'release', 'releases', 'crowdfunding', 'gallery',
  'master calendar', 'our purveyors', 'services',
];

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

// --- Scoring ---
interface ScoreComponents {
  intentScore: number;
  availabilityScore: number;
  realizationScore: number;
  gapScore: number;
  confidenceScore: number;
  serpapiShare: number;
  serpapiSignals: string[];
  evidence: string[];
}

const WEIGHTS: Record<string, number> = {
  OwnSales: 3.2, OwnTraffic: 1.4, GA4Backtest: 0.8,
  GoogleSearch: 2.8, DoorDash: 1.3, Reddit: 1.0,
  TikTok: 1.1, YouTube: 1.0, GoogleNews: 0.8, Pinterest: 0.6,
  Yelp: 2.0, GoogleMaps: 2.2, MetaAds: 0.9, InstagramOrganic: 0.9, RedditPushshift: 0.3,
  ConversationalSearch: 1.2, LocalRedditIntent: 1.3,
};
const SUPPLY = new Set<Platform>([Platform.Yelp, Platform.GoogleMaps]);
const SERPAPI_PLATFORMS = new Set<Platform>([
  Platform.GoogleSearch,
  Platform.DoorDash,
  Platform.Yelp,
  Platform.TikTok,
  Platform.YouTube,
  Platform.GoogleNews,
  Platform.GoogleMaps,
  Platform.ConversationalSearch,
]);

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function signalByPlatform(signals: SignalData[]): Map<Platform, SignalData> {
  const map = new Map<Platform, SignalData>();
  for (const signal of signals) map.set(signal.platform, signal);
  return map;
}

const demandScore = (signals: SignalData[]): number => {
  let weighted = 0;
  let weightTotal = 0;
  for (const signal of signals) {
    if (SUPPLY.has(signal.platform)) continue;
    if (signal.currentIntensity === 0 && signal.velocity === 0) continue;
    const weight = WEIGHTS[signal.platform] || 1;
    weighted += signal.currentIntensity * weight;
    weightTotal += weight;
  }
  return clampScore(weightTotal > 0 ? weighted / weightTotal : 0);
};

const supplyScore = (signals: SignalData[]): number => {
  const supplySignals = signals.filter((s) => SUPPLY.has(s.platform));
  if (supplySignals.length === 0) return 5;
  const yelp = supplySignals.find((s) => s.platform === Platform.Yelp)?.currentIntensity || 0;
  const maps = supplySignals.find((s) => s.platform === Platform.GoogleMaps)?.currentIntensity || 0;
  const weighted = maps * 0.6 + yelp * 0.4;
  return clampScore(weighted || 5);
};

const calculateRealizationScore = (signals: SignalData[]): number => {
  const byPlatform = signalByPlatform(signals);
  const sales = byPlatform.get(Platform.OwnSales)?.currentIntensity || 0;
  const traffic = byPlatform.get(Platform.OwnTraffic)?.currentIntensity || 0;
  const availability = supplyScore(signals);
  const base = sales > 0
    ? sales * 0.75 + traffic * 0.2 + availability * 0.05
    : traffic * 0.35 + availability * 0.1;
  return clampScore(base);
};

const unmetDemand = (demand: number, availability: number, realization = 0) => {
  const conversionDeficit = Math.max(0, demand - realization);
  const availabilityFriction = Math.max(0, 100 - availability);
  const combined = conversionDeficit * 0.6 + ((demand * availabilityFriction) / 100) * 0.4;
  return clampScore(combined);
};

const calculateConfidenceScore = (signals: SignalData[], hasZip: boolean): number => {
  const activeSignals = signals.filter((s) => s.currentIntensity > 0 || s.velocity !== 0);
  const activeSerpSignals = activeSignals.filter((s) => SERPAPI_PLATFORMS.has(s.platform));
  const hasSales = activeSignals.some((s) => s.platform === Platform.OwnSales);
  const hasTraffic = activeSignals.some((s) => s.platform === Platform.OwnTraffic);
  const hasBacktest = activeSignals.some((s) => s.platform === Platform.GA4Backtest);
  const hasMetaAds = activeSignals.some((s) => s.platform === Platform.MetaAds);
  const hasInstagramOrganic = activeSignals.some((s) => s.platform === Platform.InstagramOrganic);

  let score = 20;
  score += activeSignals.length * 4;
  score += activeSerpSignals.length * 7;
  if (hasSales) score += 15;
  if (hasTraffic) score += 8;
  if (hasBacktest) score += 4;
  if (hasMetaAds) score += 3;
  if (hasInstagramOrganic) score += 3;
  if (hasZip) score += 5;
  return clampScore(score);
};

const calculateSerpapiShare = (signals: SignalData[]): number => {
  const activeSignals = signals.filter((s) => s.currentIntensity > 0);
  const total = activeSignals.reduce((acc, s) => acc + s.currentIntensity, 0);
  if (total === 0) return 0;
  const serp = activeSignals
    .filter((s) => SERPAPI_PLATFORMS.has(s.platform))
    .reduce((acc, s) => acc + s.currentIntensity, 0);
  return clampScore((serp / total) * 100);
};

const buildEvidence = (
  signals: SignalData[],
  scores: Omit<ScoreComponents, 'evidence' | 'serpapiSignals'>
): string[] => {
  const evidence: string[] = [];
  const byPlatform = signalByPlatform(signals);
  const google = byPlatform.get(Platform.GoogleSearch)?.currentIntensity || 0;
  const sales = byPlatform.get(Platform.OwnSales)?.currentIntensity || 0;
  const yelp = byPlatform.get(Platform.Yelp)?.currentIntensity || 0;
  const maps = byPlatform.get(Platform.GoogleMaps)?.currentIntensity || 0;
  const backtest = byPlatform.get(Platform.GA4Backtest)?.currentIntensity || 0;
  const metaAds = byPlatform.get(Platform.MetaAds)?.currentIntensity || 0;
  const instagramOrganic = byPlatform.get(Platform.InstagramOrganic)?.currentIntensity || 0;

  evidence.push(`Intent ${scores.intentScore}/100 from search and cross-platform demand signals.`);
  evidence.push(`Availability ${scores.availabilityScore}/100 from SerpAPI Yelp+Maps local supply.`);
  evidence.push(`Realization ${scores.realizationScore}/100 from owned sales/traffic signals.`);
  evidence.push(`Gap ${scores.gapScore}/100 indicates unserved demand in current local supply.`);

  const convSearch = byPlatform.get(Platform.ConversationalSearch)?.currentIntensity || 0;
  const localRedditIntent = byPlatform.get(Platform.LocalRedditIntent)?.currentIntensity || 0;

  if (google > 0) evidence.push(`Google Trends local interest signal: ${google}/100.`);
  if (yelp > 0 || maps > 0) {
    const yelpSig = byPlatform.get(Platform.Yelp);
    const mapsSig = byPlatform.get(Platform.GoogleMaps);
    const qualityNote = (yelpSig?.supplyQuality != null || mapsSig?.supplyQuality != null)
      ? ` Competitive quality index: Yelp ${yelpSig?.supplyQuality ?? '--'}/100, Maps ${mapsSig?.supplyQuality ?? '--'}/100.`
      : '';
    evidence.push(`Local listings density (Yelp ${yelp}, Maps ${maps}).${qualityNote}`);
  }
  if (sales > 0) evidence.push(`Observed in-store/online sales proxy present (${sales}/100).`);
  if (backtest > 0) evidence.push(`GA4 backtest prior provides calibration context (${backtest}/100).`);
  if (metaAds > 0) evidence.push(`Meta paid performance signal present (${metaAds}/100), used as realization calibration.`);
  if (instagramOrganic > 0) evidence.push(`Instagram organic engagement signal present (${instagramOrganic}/100), used as demand calibration.`);
  if (convSearch > 0) evidence.push(`Question-form search interest ("near me"): ${convSearch}/100 — latent demand without local supply.`);
  if (localRedditIntent > 0) evidence.push(`Local community question posts: ${localRedditIntent}/100 — people actively seeking but not finding locally.`);
  if (scores.serpapiShare > 0) evidence.push(`SerpAPI contributes ${scores.serpapiShare}% of active signal intensity.`);

  return evidence;
};

const scoreTrend = (signals: SignalData[], hasZip: boolean): ScoreComponents => {
  const intentScore = demandScore(signals);
  const availabilityScore = supplyScore(signals);
  const realizationScore = calculateRealizationScore(signals);
  const gapScore = unmetDemand(intentScore, availabilityScore, realizationScore);
  const confidenceScore = calculateConfidenceScore(signals, hasZip);
  const serpapiShare = calculateSerpapiShare(signals);
  const serpapiSignals = signals
    .filter((s) => SERPAPI_PLATFORMS.has(s.platform) && s.currentIntensity > 0)
    .map((s) => s.platform);
  const evidence = buildEvidence(signals, {
    intentScore,
    availabilityScore,
    realizationScore,
    gapScore,
    confidenceScore,
    serpapiShare,
  });

  return {
    intentScore,
    availabilityScore,
    realizationScore,
    gapScore,
    confidenceScore,
    serpapiShare,
    serpapiSignals,
    evidence,
  };
};

const breakoutProb = (signals: SignalData[], components: ScoreComponents): number => {
  let weightedVelocity = 0;
  let totalWeight = 0;
  for (const signal of signals) {
    const weight = WEIGHTS[signal.platform] || 1;
    weightedVelocity += signal.velocity * weight;
    totalWeight += weight;
  }
  const velocityScore = totalWeight > 0 ? (weightedVelocity / totalWeight) * 3 : 0;
  const base = 15 + components.gapScore * 0.45 + components.intentScore * 0.2 + velocityScore + components.confidenceScore * 0.15;
  return clampScore(base);
};

const predictBreakout = (hist: { week: number; score: number }[], cur: number, thr = 80): number => {
  if (cur >= thr) return 0;
  if (hist.length < 3) return cur > 50 ? 4 : 0;
  const r = hist.slice(-6), n = r.length;
  const sx = r.reduce((a, h) => a + h.week, 0);
  const sy = r.reduce((a, h) => a + h.score, 0);
  const sxy = r.reduce((a, h) => a + h.week * h.score, 0);
  const sx2 = r.reduce((a, h) => a + h.week * h.week, 0);
  const den = n * sx2 - sx * sx;
  if (den === 0) return 0;
  const slope = (n * sxy - sx * sy) / den;
  if (slope <= 0) return 0;
  return Math.min(52, Math.max(1, Math.ceil((thr - cur) / slope)));
};

// ========== FETCHERS ==========

async function fetchSerpTrends(term: string, context: LocationContext): Promise<SignalData> {
  const empty: SignalData = { platform: Platform.GoogleSearch, currentIntensity: 0, velocity: 0, history: [] };
  try {
    const localizedQuery = context.hasZip ? `${term} ${context.queryHint}` : term;
    const result = await serpSearch({ engine: 'google_trends', q: localizedQuery, geo: context.serpGeo, data_type: 'TIMESERIES' });
    if (!result.data) return empty;
    const tl = result.data?.interest_over_time?.timeline_data;
    if (!tl?.length) return empty;
    const vals = tl.map((t: any) => t.values?.[0]?.extracted_value ?? 0);
    const last = vals[vals.length - 1] || 0;
    const prev = vals[vals.length - 2] || 0;
    return {
      platform: Platform.GoogleSearch,
      currentIntensity: Math.min(100, last),
      velocity: last - prev,
      history: vals.slice(-12).map((v: number, i: number) => ({ week: i + 1, value: v })),
    };
  } catch { return empty; }
}

async function fetchSerpDelivery(term: string, context: LocationContext): Promise<SignalData> {
  const empty: SignalData = { platform: Platform.DoorDash, currentIntensity: 0, velocity: 0, history: [] };
  try {
    const localizedQuery = context.hasZip ? `${term} delivery ${context.queryHint}` : `${term} delivery`;
    const result = await serpSearch({ engine: 'google_trends', q: localizedQuery, geo: context.serpGeo, data_type: 'TIMESERIES' });
    if (!result.data) return empty;
    const tl = result.data?.interest_over_time?.timeline_data;
    if (!tl?.length) return empty;
    const vals = tl.map((t: any) => t.values?.[0]?.extracted_value ?? 0);
    return {
      platform: Platform.DoorDash,
      currentIntensity: Math.min(100, vals[vals.length - 1] || 0),
      velocity: 0,
      history: vals.slice(-12).map((v: number, i: number) => ({ week: i + 1, value: v })),
    };
  } catch { return empty; }
}

/** Supply quality score: blends listing density with average rating × review depth (0–100). */
function calcSupplyQuality(specificCount: number, ratings: number[], reviewCounts: number[]): number {
  const densityScore = Math.min(1, specificCount / 10);
  if (!ratings.length) return Math.round(densityScore * 100);
  // Quality = avg(rating/5 * log10(reviews+1)/3) clamped 0–1
  const qualityScores = ratings.map((r, i) =>
    (r / 5) * Math.min(1, Math.log10((reviewCounts[i] || 0) + 1) / 3)
  );
  const avgQuality = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
  return Math.round((densityScore * 0.5 + avgQuality * 0.5) * 100);
}

async function fetchYelp(term: string, context: LocationContext): Promise<SignalData> {
  try {
    const result = await serpSearch({ engine: 'yelp', find_desc: term, find_loc: context.yelpLocation });
    if (!result.data) return { platform: Platform.Yelp, currentIntensity: 0, velocity: 0, history: [] };
    const results = result.data.organic_results || [];
    const termLower = term.toLowerCase();
    let specificCount = 0;
    const ratings: number[] = [];
    const reviewCounts: number[] = [];
    for (const r of results) {
      const cats = (r.categories || []).map((c: any) => (c.title || c || '').toLowerCase()).join(' ');
      const title = (r.title || '').toLowerCase();
      const snippet = (r.snippet || '').toLowerCase();
      if (cats.includes(termLower) || title.includes(termLower) || snippet.includes(termLower)) {
        specificCount++;
        const rating = parseFloat(r.rating ?? r.stars ?? '0') || 0;
        const reviews = parseInt(String(r.reviews ?? r.review_count ?? '0').replace(/[^0-9]/g, ''), 10) || 0;
        if (rating > 0) { ratings.push(rating); reviewCounts.push(reviews); }
      }
    }
    const supplyQuality = calcSupplyQuality(specificCount, ratings, reviewCounts);
    return {
      platform: Platform.Yelp,
      currentIntensity: Math.min(100, specificCount * 15),
      velocity: 0,
      history: [],
      supplyQuality,
    };
  } catch { return { platform: Platform.Yelp, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchReddit(term: string, context: LocationContext): Promise<SignalData> {
  try {
    const localizedQuery = context.hasZip
      ? `${term} ${context.queryHint} (food OR restaurant OR menu OR near me)`
      : term;
    const { data } = await axios.get('https://www.reddit.com/search.json', {
      params: { q: localizedQuery, sort: 'new', limit: 25 },
      timeout: EXTERNAL_TIMEOUT_MS,
    });
    const posts = data.data.children;
    const now = Date.now() / 1000;
    const recent = posts.filter((p: any) => (now - p.data.created_utc) < 86400).length;
    return { platform: Platform.Reddit, currentIntensity: Math.min(100, posts.length * 4), velocity: recent * 5, history: [] };
  } catch { return { platform: Platform.Reddit, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchTikTokSerp(term: string, context: LocationContext): Promise<SignalData> {
  // Use SerpAPI Google search with site:tiktok.com for much better coverage than Reddit proxy
  try {
    const localizedQuery = context.hasZip
      ? `${term} food ${context.queryHint} site:tiktok.com`
      : `${term} food site:tiktok.com`;
    const result = await serpSearch({ engine: 'google', q: localizedQuery, num: '50' });
    if (!result.data) return { platform: Platform.TikTok, currentIntensity: 0, velocity: 0, history: [] };
    const organic = result.data.organic_results || [];
    // Count results and check for recency signals in snippets
    const count = organic.length;
    let recentSignals = 0;
    for (const r of organic) {
      const snippet = (r.snippet || '').toLowerCase();
      if (snippet.includes('day') || snippet.includes('hour') || snippet.includes('new') || snippet.includes('trending')) {
        recentSignals++;
      }
    }
    return {
      platform: Platform.TikTok,
      currentIntensity: Math.min(100, count * 2),
      velocity: Math.min(20, recentSignals * 3),
      history: [],
    };
  } catch { return { platform: Platform.TikTok, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchPinterestProxy(term: string): Promise<SignalData> {
  try {
    const { data } = await axios.get('https://www.reddit.com/search.json', {
      params: { q: `"${term}" site:pinterest.com`, sort: 'new', limit: 25 },
      timeout: EXTERNAL_TIMEOUT_MS,
    });
    return { platform: Platform.Pinterest, currentIntensity: Math.min(100, data.data.children.length * 10), velocity: 0, history: [] };
  } catch { return { platform: Platform.Pinterest, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchYouTube(term: string, context: LocationContext): Promise<SignalData> {
  // SerpAPI YouTube search - high signal for food trends
  try {
    const localizedQuery = context.hasZip
      ? `${term} recipe food ${context.queryHint}`
      : `${term} recipe food`;
    const result = await serpSearch({ engine: 'youtube', search_query: localizedQuery });
    if (!result.data) return { platform: Platform.YouTube, currentIntensity: 0, velocity: 0, history: [] };
    const videos = result.data.video_results || [];
    let totalViews = 0;
    let recentCount = 0;
    for (const v of videos.slice(0, 20)) {
      // Parse view counts like "1.2M views" or "500K views"
      const viewStr = v.views || '';
      let views = 0;
      const match = viewStr.match(/([\d.]+)\s*([KMB])?/i);
      if (match) {
        views = parseFloat(match[1]);
        if (match[2]?.toUpperCase() === 'K') views *= 1000;
        else if (match[2]?.toUpperCase() === 'M') views *= 1000000;
        else if (match[2]?.toUpperCase() === 'B') views *= 1000000000;
      }
      totalViews += views;
      // Check for recent uploads
      const published = (v.published_date || '').toLowerCase();
      if (published.includes('day') || published.includes('hour') || published.includes('week')) {
        recentCount++;
      }
    }
    // Scale: 1M total views across top 20 = intensity 100
    const intensity = Math.min(100, Math.round(totalViews / 10000));
    const velocity = Math.min(20, recentCount * 2);
    return { platform: Platform.YouTube, currentIntensity: intensity, velocity, history: [] };
  } catch { return { platform: Platform.YouTube, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchGoogleNews(term: string, context: LocationContext): Promise<SignalData> {
  // SerpAPI Google News - media coverage indicates mainstream attention
  try {
    const localizedQuery = context.hasZip
      ? `${term} food restaurant ${context.queryHint}`
      : `${term} food restaurant`;
    const result = await serpSearch({ engine: 'google_news', q: localizedQuery });
    if (!result.data) return { platform: Platform.GoogleNews, currentIntensity: 0, velocity: 0, history: [] };
    const articles = result.data.news_results || [];
    let recentCount = 0;
    for (const a of articles) {
      const date = (a.date || '').toLowerCase();
      if (date.includes('hour') || date.includes('day') || date.includes('yesterday')) {
        recentCount++;
      }
    }
    // More articles = more mainstream coverage
    const intensity = Math.min(100, articles.length * 5);
    const velocity = Math.min(20, recentCount * 4);
    return { platform: Platform.GoogleNews, currentIntensity: intensity, velocity, history: [] };
  } catch { return { platform: Platform.GoogleNews, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchGoogleMaps(term: string, context: LocationContext): Promise<SignalData> {
  try {
    const locationQuery = context.hasZip ? `${term} ${context.queryHint}` : `${term} ${context.regionLabel}`;
    const result = await serpSearch({ engine: 'google_maps', q: locationQuery, type: 'search' });
    if (!result.data) return { platform: Platform.GoogleMaps, currentIntensity: 0, velocity: 0, history: [] };
    const places = result.data.local_results || [];
    const termLower = term.toLowerCase();
    let specificCount = 0;
    const ratings: number[] = [];
    const reviewCounts: number[] = [];
    for (const p of places) {
      const title = (p.title || '').toLowerCase();
      const type = (p.type || '').toLowerCase();
      const desc = (p.description || '').toLowerCase();
      if (title.includes(termLower) || type.includes(termLower) || desc.includes(termLower)) {
        specificCount++;
        const rating = parseFloat(p.rating ?? '0') || 0;
        const reviews = parseInt(String(p.reviews ?? '0').replace(/[^0-9]/g, ''), 10) || 0;
        if (rating > 0) { ratings.push(rating); reviewCounts.push(reviews); }
      }
    }
    const supplyQuality = calcSupplyQuality(specificCount, ratings, reviewCounts);
    return {
      platform: Platform.GoogleMaps,
      currentIntensity: Math.min(100, specificCount * 10),
      velocity: 0,
      history: [],
      supplyQuality,
    };
  } catch { return { platform: Platform.GoogleMaps, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchConversationalSearch(term: string, context: LocationContext): Promise<SignalData> {
  // Google Trends for "{term} near me" — captures latent demand where people know what they
  // want but don't know where to find it locally. Single SerpAPI call (budget-constrained).
  // Cached 72h (google_trends_related TTL) since near-me trends shift slowly.
  try {
    const result = await serpSearch({
      engine: 'google_trends',
      q: `${term} near me`,
      geo: context.serpGeo,
      data_type: 'TIMESERIES',
    });
    if (!result.data) return { platform: Platform.ConversationalSearch, currentIntensity: 0, velocity: 0, history: [] };

    const timeline = result.data?.interest_over_time?.timeline_data || [];
    const values: number[] = timeline.map((point: any) => Number(point.values?.[0]?.value || 0));

    if (values.length === 0) return { platform: Platform.ConversationalSearch, currentIntensity: 0, velocity: 0, history: [] };

    const currentIntensity = Math.min(100, values[values.length - 1]);
    const prevIntensity = values.length >= 2 ? values[values.length - 2] : currentIntensity;
    const velocity = Math.max(-20, Math.min(20, currentIntensity - prevIntensity));
    const history = values.map((value, i) => ({ week: i + 1, value: Math.round(value) }));

    return { platform: Platform.ConversationalSearch, currentIntensity, velocity, history };
  } catch { return { platform: Platform.ConversationalSearch, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchLocalRedditIntent(term: string, context: LocationContext): Promise<SignalData> {
  // Reddit question-pattern posts in local subreddits — "where can I find X near Minneapolis?"
  // These represent someone with a specific desire and no known local supply: the highest-quality
  // latent demand signal available from public data.
  const QUESTION_PATTERN = /\b(where|looking for|anyone know|can i find|near me|recommend|suggestions|does anyone|tried|found)\b/i;
  try {
    const localSubs = context.hasZip
      ? 'Minneapolis+TwinCities+minnesota+food'
      : 'food+foodporn+askculinary';

    const localQuery = `${term} (where OR "looking for" OR "anyone know" OR "can I find" OR "near me")`;
    const globalQuery = `${term} food restaurant ("where can I find" OR "looking for" OR "near me" OR "does anyone know")`;

    const [localResult, globalResult] = await Promise.all([
      axios.get('https://www.reddit.com/r/' + localSubs + '/search.json', {
        params: { q: localQuery, sort: 'new', limit: 25, restrict_sr: 'on' },
        headers: { 'User-Agent': 'TrendHunter/2.0' },
        timeout: EXTERNAL_TIMEOUT_MS,
      }).catch(() => null),
      axios.get('https://www.reddit.com/search.json', {
        params: { q: globalQuery, sort: 'new', limit: 25 },
        headers: { 'User-Agent': 'TrendHunter/2.0' },
        timeout: EXTERNAL_TIMEOUT_MS,
      }).catch(() => null),
    ]);

    const localPosts = localResult?.data?.data?.children || [];
    const globalPosts = globalResult?.data?.data?.children || [];
    const allPosts = [...localPosts, ...globalPosts];

    const now = Date.now() / 1000;
    let questionPostCount = 0;
    let recentQuestionCount = 0;

    for (const post of allPosts) {
      const title = post.data?.title || '';
      if (QUESTION_PATTERN.test(title)) {
        questionPostCount++;
        if ((now - (post.data?.created_utc || 0)) < 172800) { // 48h
          recentQuestionCount++;
        }
      }
    }

    const currentIntensity = Math.min(100, questionPostCount * 15);
    const velocity = Math.min(20, recentQuestionCount * 10);

    return { platform: Platform.LocalRedditIntent, currentIntensity, velocity, history: [] };
  } catch { return { platform: Platform.LocalRedditIntent, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchSquareSales(term: string): Promise<SignalData> {
  if (!SQUARE_ACCESS_TOKEN) return { platform: Platform.OwnSales, currentIntensity: 0, velocity: 0, history: [] };
  try {
    const now = new Date();
    const fourWeeksAgo = new Date(now.getTime() - 28 * 86400000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);
    const { data } = await axios.post('https://connect.squareup.com/v2/orders/search', {
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: fourWeeksAgo.toISOString() } },
          state_filter: { states: ['COMPLETED'] },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
      limit: 500,
    }, {
      headers: { Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: EXTERNAL_TIMEOUT_MS,
    });

    const orders = data.orders || [];
    const tl = term.toLowerCase();
    let recentCount = 0, olderCount = 0;
    for (const o of orders) {
      const match = (o.line_items || []).some((li: any) => (li.name || '').toLowerCase().includes(tl));
      if (!match) continue;
      new Date(o.created_at) >= twoWeeksAgo ? recentCount++ : olderCount++;
    }
    const total = recentCount + olderCount;
    const velocity = olderCount > 0 ? Math.round(((recentCount - olderCount) / olderCount) * 10) : (recentCount > 0 ? 10 : 0);
    return {
      platform: Platform.OwnSales,
      currentIntensity: Math.min(100, total * 8),
      velocity: Math.max(-20, Math.min(20, velocity)),
      history: [],
    };
  } catch { return { platform: Platform.OwnSales, currentIntensity: 0, velocity: 0, history: [] }; }
}

// --- GA4 Data API via service account ---
function parseServiceAccount(): any | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;

  const tryParse = (value: string) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  let decoded = '';
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    return null;
  }

  const parsed = tryParse(decoded);
  if (parsed) return parsed;

  const repaired = decoded.replace(
    /("private_key"\s*:\s*")([\s\S]*?)(")/m,
    (_m, start, key, end) => `${start}${String(key).replace(/\r?\n/g, '\\n')}${end}`
  );
  return tryParse(repaired);
}

async function getGA4AccessToken(): Promise<string | null> {
  const sa = parseServiceAccount();
  if (!sa) return null;
  try {
    const privateKey = String(sa.private_key || '').replace(/\\n/g, '\n');
    if (!privateKey || !sa.client_email) return null;
    // Build JWT
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })).toString('base64url');
    const crypto = await import('crypto');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey)
      .toString('base64url');
    const jwt = `${header}.${payload}.${signature}`;
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }, { timeout: EXTERNAL_TIMEOUT_MS });
    return data.access_token;
  } catch (e) { console.error('GA4 auth error:', e); return null; }
}

let _ga4Token: string | null = null;
let _ga4TokenExp = 0;

async function fetchGA4Traffic(term: string): Promise<SignalData> {
  const empty: SignalData = { platform: Platform.OwnTraffic, currentIntensity: 0, velocity: 0, history: [] };
  if (!GA4_PROPERTY_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return empty;
  try {
    // Cache token for ~50 min
    if (!_ga4Token || Date.now() > _ga4TokenExp) {
      _ga4Token = await getGA4AccessToken();
      _ga4TokenExp = Date.now() + 50 * 60_000;
    }
    if (!_ga4Token) return empty;

    // Query last 28 days, page views where page title or path contains the term
    const { data } = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
      {
        dateRanges: [
          { startDate: '28daysAgo', endDate: '14daysAgo' },
          { startDate: '14daysAgo', endDate: 'today' },
        ],
        dimensions: [{ name: 'dateRange' }],
        metrics: [{ name: 'screenPageViews' }],
        dimensionFilter: {
          filter: {
            fieldName: 'pageTitle',
            stringFilter: { matchType: 'CONTAINS', value: term, caseSensitive: false },
          },
        },
      },
      { headers: { Authorization: `Bearer ${_ga4Token}` }, timeout: EXTERNAL_TIMEOUT_MS }
    );

    const rows = data.rows || [];
    // dateRange 0 = older period, 1 = recent period
    let older = 0, recent = 0;
    for (const r of rows) {
      const range = r.dimensionValues?.[0]?.value;
      const views = parseInt(r.metricValues?.[0]?.value || '0', 10);
      if (range === 'date_range_0') older = views;
      else if (range === 'date_range_1') recent = views;
    }
    const total = older + recent;
    const velocity = older > 0 ? Math.round(((recent - older) / older) * 10) : (recent > 0 ? 10 : 0);

    return {
      platform: Platform.OwnTraffic,
      currentIntensity: Math.min(100, Math.round(total / 5)), // scale: 500 views = 100
      velocity: Math.max(-20, Math.min(20, velocity)),
      history: [],
    };
  } catch (e) { console.error('GA4 fetch error:', e); return empty; }
}

interface GA4BacktestPriorRow {
  term: string;
  key: string;
  composite_score: number;
  growth_rate: number;
  term_type?: string | null;
}

let _ga4BacktestIndexCache: { expiresAt: number; rows: GA4BacktestPriorRow[]; byKey: Map<string, GA4BacktestPriorRow> } | null = null;

function isLikelyNavNoise(term: string): boolean {
  const normalized = term.toLowerCase().trim();
  if (!normalized || normalized === '(not set)') return true;
  return NAV_NOISE_TOKENS.some((token) => normalized.includes(token));
}

async function loadGA4BacktestIndex(): Promise<{ rows: GA4BacktestPriorRow[]; byKey: Map<string, GA4BacktestPriorRow> }> {
  if (_ga4BacktestIndexCache && Date.now() < _ga4BacktestIndexCache.expiresAt) {
    return { rows: _ga4BacktestIndexCache.rows, byKey: _ga4BacktestIndexCache.byKey };
  }

  const rows: GA4BacktestPriorRow[] = [];
  const byKey = new Map<string, GA4BacktestPriorRow>();
  if (!supabase) return { rows, byKey };

  const primary = await supabase
    .from('ga4_backtest_results')
    .select('term, composite_score, growth_rate, term_type')
    .order('composite_score', { ascending: false })
    .limit(700);

  let dataRows: any[] = [];
  let hasTermType = false;
  if (!primary.error && primary.data) {
    dataRows = primary.data as any[];
    hasTermType = true;
  } else {
    const fallback = await supabase
      .from('ga4_backtest_results')
      .select('term, composite_score, growth_rate')
      .order('composite_score', { ascending: false })
      .limit(700);
    if (!fallback.error && fallback.data) dataRows = fallback.data as any[];
  }

  if (dataRows.length > 0) {
    for (const row of dataRows) {
      const term = String(row.term || '').trim();
      const key = normalizeTermKey(term);
      if (!key) continue;
      const termType = hasTermType
        ? String(row.term_type || 'nav_noise')
        : (isLikelyNavNoise(term) ? 'nav_noise' : 'food_concept');
      if (!GA4_BOOSTABLE_TYPES.has(termType)) continue;

      const prior: GA4BacktestPriorRow = {
        term,
        key,
        composite_score: Number(row.composite_score || 0),
        growth_rate: Number(row.growth_rate || 0),
        term_type: row.term_type,
      };
      const existing = byKey.get(key);
      if (!existing || prior.composite_score > existing.composite_score) {
        byKey.set(key, prior);
      }
    }
  }

  for (const row of byKey.values()) rows.push(row);
  _ga4BacktestIndexCache = { rows, byKey, expiresAt: Date.now() + 10 * 60_000 };
  return { rows, byKey };
}

function findBestGA4Prior(term: string, index: { rows: GA4BacktestPriorRow[]; byKey: Map<string, GA4BacktestPriorRow> }): GA4BacktestPriorRow | null {
  const key = normalizeTermKey(term);
  if (!key) return null;
  const direct = index.byKey.get(key);
  if (direct) return direct;

  let best: GA4BacktestPriorRow | null = null;
  let bestScore = 0;
  for (const candidate of index.rows) {
    const score = similarityScore(key, candidate.key);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 0.62 ? best : null;
}

async function fetchGA4BacktestSignal(term: string): Promise<SignalData> {
  const empty: SignalData = { platform: Platform.GA4Backtest, currentIntensity: 0, velocity: 0, history: [] };
  if (!supabase) return empty;
  try {
    const index = await loadGA4BacktestIndex();
    const prior = findBestGA4Prior(term, index);
    if (!prior) return empty;

    // Calibration prior only - dampen direct impact in live scoring.
    const intensity = clampScore(Math.round(Number(prior.composite_score || 0) * 0.65));
    const velocity = Math.max(-20, Math.min(20, Math.round(Number(prior.growth_rate || 0) / 15)));
    return {
      platform: Platform.GA4Backtest,
      currentIntensity: intensity,
      velocity,
      history: [],
    };
  } catch {
    return empty;
  }
}

function toDateKey(value: unknown): string {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function dayBucketOffset(dateKey: string): number {
  if (!dateKey) return Number.MAX_SAFE_INTEGER;
  const now = new Date();
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  return Math.floor((now.getTime() - d.getTime()) / 86400000);
}

async function fetchMetaAdsSignal(term: string): Promise<SignalData> {
  const empty: SignalData = { platform: Platform.MetaAds, currentIntensity: 0, velocity: 0, history: [] };
  if (!supabase) return empty;

  try {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 35);
    const fromIso = fromDate.toISOString().slice(0, 10);

    let query = supabase
      .from('meta_ads_insights_daily')
      .select('entity_name,date_start,spend,impressions,clicks,ctr,purchase_count,add_to_cart_count,initiate_checkout_count')
      .gte('date_start', fromIso)
      .order('date_start', { ascending: false })
      .limit(400);

    if (term.trim()) query = query.ilike('entity_name', `%${term}%`);
    const { data } = await query;
    const rows = data || [];
    if (!rows.length) return empty;

    let impressions = 0;
    let clicks = 0;
    let purchases = 0;
    let addToCart = 0;
    let avgCtrAcc = 0;
    let ctrRows = 0;

    let recentValue = 0;
    let priorValue = 0;

    for (const row of rows) {
      const imps = Number(row.impressions || 0);
      const clk = Number(row.clicks || 0);
      const pur = Number(row.purchase_count || 0);
      const atc = Number(row.add_to_cart_count || 0);
      const ctr = Number(row.ctr || 0);

      impressions += imps;
      clicks += clk;
      purchases += pur;
      addToCart += atc;
      if (ctr > 0) {
        avgCtrAcc += ctr;
        ctrRows += 1;
      }

      const value = clk + pur * 4 + atc * 2;
      const ageDays = dayBucketOffset(toDateKey(row.date_start));
      if (ageDays <= 7) recentValue += value;
      else if (ageDays <= 14) priorValue += value;
    }

    const avgCtr = ctrRows > 0 ? avgCtrAcc / ctrRows : (impressions > 0 ? (clicks / impressions) * 100 : 0);
    const clickScale = Math.min(35, Math.log10(clicks + 1) * 20);
    const purchaseScale = Math.min(35, Math.log10(purchases + addToCart + 1) * 20);
    const ctrScale = Math.min(30, avgCtr * 6);
    const intensity = clampScore(clickScale + purchaseScale + ctrScale);

    let velocity = 0;
    if (priorValue > 0) {
      velocity = Math.round(((recentValue - priorValue) / priorValue) * 20);
    } else if (recentValue > 0) {
      velocity = 10;
    }
    velocity = Math.max(-20, Math.min(20, velocity));

    return {
      platform: Platform.MetaAds,
      currentIntensity: intensity,
      velocity,
      history: [],
    };
  } catch {
    return empty;
  }
}

async function fetchInstagramOrganicSignal(term: string): Promise<SignalData> {
  const empty: SignalData = { platform: Platform.InstagramOrganic, currentIntensity: 0, velocity: 0, history: [] };
  if (!supabase) return empty;

  try {
    const { data: mediaRows } = await supabase
      .from('ig_media')
      .select('media_id, caption')
      .ilike('caption', `%${term}%`)
      .order('media_timestamp', { ascending: false })
      .limit(80);

    const mediaIds = (mediaRows || []).map((row: any) => String(row.media_id || '')).filter(Boolean);
    if (!mediaIds.length) return empty;

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 35);
    const fromIso = fromDate.toISOString().slice(0, 10);

    const { data: insightRows } = await supabase
      .from('ig_media_insights_daily')
      .select('snapshot_date,reach,impressions,likes,comments,saves,shares')
      .in('media_id', mediaIds)
      .gte('snapshot_date', fromIso)
      .order('snapshot_date', { ascending: false })
      .limit(600);

    const rows = insightRows || [];
    if (!rows.length) return empty;

    let totalReach = 0;
    let totalImpressions = 0;
    let totalEngagement = 0;
    let totalSavesShares = 0;
    let recentEngagement = 0;
    let priorEngagement = 0;

    for (const row of rows) {
      const reach = Number(row.reach || 0);
      const impressions = Number(row.impressions || 0);
      const likes = Number(row.likes || 0);
      const comments = Number(row.comments || 0);
      const saves = Number(row.saves || 0);
      const shares = Number(row.shares || 0);
      const engagement = likes + comments + saves + shares;

      totalReach += reach;
      totalImpressions += impressions;
      totalEngagement += engagement;
      totalSavesShares += (saves + shares);

      const ageDays = dayBucketOffset(toDateKey(row.snapshot_date));
      if (ageDays <= 7) recentEngagement += engagement;
      else if (ageDays <= 14) priorEngagement += engagement;
    }

    const base = Math.max(totalReach, totalImpressions, 1);
    const engagementRate = totalEngagement / base;
    const saveShareRate = totalSavesShares / base;

    const rateScore = Math.min(45, engagementRate * 900);
    const depthScore = Math.min(35, Math.log10(totalEngagement + 1) * 20);
    const intentScore = Math.min(20, saveShareRate * 700);
    const intensity = clampScore(rateScore + depthScore + intentScore);

    let velocity = 0;
    if (priorEngagement > 0) {
      velocity = Math.round(((recentEngagement - priorEngagement) / priorEngagement) * 20);
    } else if (recentEngagement > 0) {
      velocity = 8;
    }
    velocity = Math.max(-20, Math.min(20, velocity));

    return {
      platform: Platform.InstagramOrganic,
      currentIntensity: intensity,
      velocity,
      history: [],
    };
  } catch {
    return empty;
  }
}

// ========== SUPABASE HELPERS ==========

async function getHistory(trendId: string, limit = 12) {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from('trend_history')
      .select('timestamp, demand_score, supply_score, unmet_demand_score, breakout_probability, gap_score, raw_signals')
      .eq('trend_id', trendId)
      .order('timestamp', { ascending: true })
      .limit(limit);
    return data || [];
  } catch (error) {
    console.error('getHistory error:', error);
    return [];
  }
}

async function getTrackedTerms() {
  if (!supabase) return [];
  try {
    const { data } = await supabase.from('trends').select('id, term, category, neighborhood').order('created_at');
    const filtered = (data || []).filter(d => !DEMO_TERMS.has((d.term || '').trim()));
    return filtered.map(d => ({ id: d.id, term: d.term, category: d.category || '', neighborhood: d.neighborhood || '' }));
  } catch (error) {
    console.error('Supabase getTrackedTerms error:', error);
    return [];
  }
}

// ========== HANDLER ==========

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const canPersist = isAdminRequest(req);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const zipQuery = typeof req.query.zip === 'string' ? req.query.zip.trim() : '';
    const location = getLocationContext(zipQuery);
    const isSearchMode = query.length > 0;
    const trackedTerms = isSearchMode ? [] : await getTrackedTerms();
    const cappedTerms = trackedTerms.slice(0, Math.max(1, MAX_TERMS_PER_REQUEST));
    const terms = isSearchMode
      ? [{ id: '', term: query, category: 'Search', neighborhood: location.hasZip ? `ZIP ${location.zipCode}` : 'All Neighborhoods' }]
      : cappedTerms;

    if (!isSearchMode && trackedTerms.length > cappedTerms.length) {
      res.setHeader('x-trendhunt-terms-capped', `${cappedTerms.length}/${trackedTerms.length}`);
    }

    if (!terms.length) {
      return res.status(200).json([]);
    }

    res.setHeader('x-trendhunt-location', location.regionLabel);
    res.setHeader('x-trendhunt-serpapi-primary', 'true');

    const trends: TrendEntity[] = await mapWithConcurrency(terms, TERM_PROCESS_CONCURRENCY, async (item) => {
      const [yelp, reddit, google, tiktok, pinterest, delivery, convSearch, localRedditIntent, sales, traffic, backtest, metaAds, instagramOrganic, youtube, news, maps] = await Promise.all([
        fetchYelp(item.term, location),
        fetchReddit(item.term, location),
        fetchSerpTrends(item.term, location),
        fetchTikTokSerp(item.term, location),
        fetchPinterestProxy(item.term),
        fetchSerpDelivery(item.term, location),
        fetchConversationalSearch(item.term, location),
        fetchLocalRedditIntent(item.term, location),
        fetchSquareSales(item.term),
        fetchGA4Traffic(item.term),
        fetchGA4BacktestSignal(item.term),
        fetchMetaAdsSignal(item.term),
        fetchInstagramOrganicSignal(item.term),
        fetchYouTube(item.term, location),
        fetchGoogleNews(item.term, location),
        fetchGoogleMaps(item.term, location),
      ]);

      const signals = [yelp, reddit, google, tiktok, pinterest, delivery, convSearch, localRedditIntent, sales, traffic, backtest, metaAds, instagramOrganic, youtube, news, maps];
      const components = scoreTrend(signals, location.hasZip);
      const ds = components.intentScore;
      const ss = components.availabilityScore;
      const ud = components.gapScore;
      const bp = breakoutProb(signals, components);

      // Persist
      let trendId = item.id || '';
      if (supabase && !isSearchMode && canPersist) {
        try {
          const { data: row } = await supabase
            .from('trends')
            .upsert({
              term: item.term,
              category: item.category,
              region: location.regionLabel,
              neighborhood: item.neighborhood,
              last_updated: new Date().toISOString(),
            }, { onConflict: 'term' })
            .select().single();
          if (row) {
            trendId = row.id;
            await supabase.from('trend_history').insert({
              trend_id: row.id,
              timestamp: new Date().toISOString(),
              zip_code: location.zipCode || null,
              demand_score: ds,
              supply_score: ss,
              unmet_demand_score: ud,
              breakout_probability: bp,
              intent_score: components.intentScore,
              availability_score: components.availabilityScore,
              realization_score: components.realizationScore,
              gap_score: components.gapScore,
              confidence_score: components.confidenceScore,
              serpapi_share: components.serpapiShare,
              evidence: components.evidence,
              raw_signals: signals,
            });
          }
        } catch (e) { console.error('Supabase persist:', e); }
      }

      // Build history from past snapshots
      let predicted = 0;
      if (trendId && !isSearchMode) {
        const past = await getHistory(trendId, 12);
        if (past.length > 0) {
          predicted = predictBreakout(
            past.map((r, i) => ({ week: i + 1, score: Number(r.gap_score ?? r.unmet_demand_score ?? 0) })),
            ud
          );
          for (const sig of signals) {
            sig.history = past.map((r, i) => {
              const raw = (r.raw_signals as SignalData[]) || [];
              const m = raw.find(rs => rs.platform === sig.platform);
              return { week: i + 1, value: m?.currentIntensity ?? 0 };
            });
          }
        }
      }

      // Module 3: Read lead-lag state from trends table
      let trendState: string | undefined;
      let leadLagWeeks: number | undefined;
      let trendStateNarrative: string | undefined;
      if (trendId && supabase) {
        try {
          const { data: trendRow } = await supabase
            .from('trends')
            .select('trend_state, lead_lag_weeks, trend_state_narrative')
            .eq('id', trendId)
            .maybeSingle();
          if (trendRow) {
            trendState = trendRow.trend_state ?? undefined;
            leadLagWeeks = trendRow.lead_lag_weeks ?? undefined;
            trendStateNarrative = trendRow.trend_state_narrative ?? undefined;
          }
        } catch { /* non-fatal */ }
      }

      // Module 5: Read latest funnel row from term_funnel
      let funnelData: TermFunnel | undefined;
      let conversionDeficitScore: number | undefined;
      if (supabase) {
        try {
          const { data: funnelRow } = await supabase
            .from('term_funnel')
            .select('*')
            .eq('term', item.term)
            .order('date', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (funnelRow) {
            funnelData = {
              term: funnelRow.term,
              searchImpressions: funnelRow.search_impressions ?? 0,
              pageViews: funnelRow.page_views ?? 0,
              conversionEvents: funnelRow.conversion_events ?? 0,
              conversionRate: funnelRow.conversion_rate ?? 0,
              dropoffStage: funnelRow.dropoff_stage ?? 'unknown',
              geminiDiagnosis: funnelRow.gemini_diagnosis ?? undefined,
            };
            // conversionDeficitScore: how much of the intent is going unfulfilled
            if (funnelRow.dropoff_stage === 'no_page') {
              conversionDeficitScore = Math.round(components.intentScore * 0.9);
            } else if (funnelRow.dropoff_stage === 'low_conversion') {
              conversionDeficitScore = Math.round(components.intentScore * 0.5);
            } else if (funnelRow.dropoff_stage === 'healthy') {
              conversionDeficitScore = Math.max(0, components.intentScore - 60);
            }
          }
        } catch { /* non-fatal */ }
      }

      return {
        id: trendId || item.term.replace(/\s+/g, '-').toLowerCase(),
        term: item.term,
        category: item.category,
        region: location.regionLabel,
        neighborhood: item.neighborhood,
        zipCode: location.zipCode || undefined,
        signals,
        intentScore: components.intentScore,
        availabilityScore: components.availabilityScore,
        realizationScore: components.realizationScore,
        gapScore: components.gapScore,
        confidenceScore: components.confidenceScore,
        serpapiShare: components.serpapiShare,
        serpapiSignals: components.serpapiSignals,
        evidence: components.evidence,
        supplyScore: ss,
        demandScore: ds,
        unmetDemandScore: ud,
        breakoutProbability: bp,
        predictedBreakoutWeek: predicted,
        trendState,
        leadLagWeeks,
        trendStateNarrative,
        conversionDeficitScore,
        funnelData,
      };
    });

    const serpUsage = await getUsageStats();
    res.setHeader('x-serpapi-calls-today', String(serpUsage.today));
    res.setHeader('x-serpapi-calls-month', String(serpUsage.month));

    res.status(200).json(trends);
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
}
