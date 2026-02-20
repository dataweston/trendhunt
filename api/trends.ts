import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { serpSearch } from '../lib/serp-governor.js';

// --- Types (standalone for serverless) ---
enum Platform {
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
  MetaAds = 'MetaAds',
  YouTube = 'YouTube',
  GoogleNews = 'GoogleNews',
  GoogleMaps = 'GoogleMaps',
}

interface SignalData {
  platform: Platform;
  history: { week: number; value: number }[];
  currentIntensity: number;
  velocity: number;
}

interface TrendEntity {
  id: string;
  term: string;
  category: string;
  region: string;
  neighborhood: string;
  signals: SignalData[];
  supplyScore: number;
  demandScore: number;
  unmetDemandScore: number;
  breakoutProbability: number;
  predictedBreakoutWeek: number;
}

// --- Config ---
const REGION = 'Minneapolis';
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const EXTERNAL_TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS || 5000);
const TERM_PROCESS_CONCURRENCY = Number(process.env.TERM_PROCESS_CONCURRENCY || 3);

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
const WEIGHTS: Record<string, number> = {
  OwnSales: 3.0, TikTok: 2.5, YouTube: 2.2, OwnTraffic: 1.8, Reddit: 1.5,
  GoogleNews: 1.4, Pinterest: 1.2, GoogleSearch: 1.0, MetaAds: 0.8, Wildchat: 0.6,
  Yelp: 0.5, DoorDash: 0.5, GoogleMaps: 0.5, RedditPushshift: 0.3,
};
const SUPPLY = new Set(['Yelp', 'DoorDash', 'GoogleMaps']);

const demandScore = (signals: SignalData[]): number => {
  let tw = 0, tws = 0;
  for (const s of signals) {
    if (SUPPLY.has(s.platform)) continue;
    const w = WEIGHTS[s.platform] || 1;
    tws += s.currentIntensity * w; tw += w;
  }
  return tw === 0 ? 0 : Math.min(100, Math.round(tws / tw));
};

const supplyScore = (signals: SignalData[]): number => {
  const ss = signals.filter(s => SUPPLY.has(s.platform));
  if (!ss.length) return 10;
  return Math.min(100, Math.round(ss.reduce((a, s) => a + s.currentIntensity, 0) / ss.length));
};

const unmetDemand = (d: number, s: number) => Math.max(0, Math.min(100, Math.round(d - s * 0.8)));

const breakoutProb = (signals: SignalData[]): number => {
  let wv = 0, tw = 0;
  for (const s of signals) { const w = WEIGHTS[s.platform] || 1; wv += s.velocity * w; tw += w; }
  return Math.max(0, Math.min(100, Math.round(20 + (tw > 0 ? wv / tw : 0) * 4)));
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

async function fetchSerpTrends(term: string): Promise<SignalData> {
  const empty: SignalData = { platform: Platform.GoogleSearch, currentIntensity: 0, velocity: 0, history: [] };
  try {
    const result = await serpSearch({ engine: 'google_trends', q: term, geo: 'US-MN', data_type: 'TIMESERIES' });
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

async function fetchSerpDelivery(term: string): Promise<SignalData> {
  const empty: SignalData = { platform: Platform.DoorDash, currentIntensity: 0, velocity: 0, history: [] };
  try {
    const result = await serpSearch({ engine: 'google_trends', q: `${term} delivery`, geo: 'US-MN', data_type: 'TIMESERIES' });
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

async function fetchYelp(term: string): Promise<SignalData> {
  // Use SerpAPI's yelp engine instead of direct Yelp API (no Yelp key needed)
  try {
    const result = await serpSearch({ engine: 'yelp', find_desc: term, find_loc: REGION });
    if (!result.data) return { platform: Platform.Yelp, currentIntensity: 0, velocity: 0, history: [] };
    const total = result.data.organic_results?.length || 0;
    return {
      platform: Platform.Yelp,
      currentIntensity: Math.min(100, Math.round((total / 10) * 100)),
      velocity: 0, history: [],
    };
  } catch { return { platform: Platform.Yelp, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchReddit(term: string): Promise<SignalData> {
  try {
    const { data } = await axios.get('https://www.reddit.com/search.json', {
      params: { q: term, sort: 'new', limit: 25 },
      timeout: EXTERNAL_TIMEOUT_MS,
    });
    const posts = data.data.children;
    const now = Date.now() / 1000;
    const recent = posts.filter((p: any) => (now - p.data.created_utc) < 86400).length;
    return { platform: Platform.Reddit, currentIntensity: Math.min(100, posts.length * 4), velocity: recent * 5, history: [] };
  } catch { return { platform: Platform.Reddit, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchTikTokSerp(term: string): Promise<SignalData> {
  // Use SerpAPI Google search with site:tiktok.com for much better coverage than Reddit proxy
  try {
    const result = await serpSearch({ engine: 'google', q: `${term} food site:tiktok.com`, num: '50' });
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

async function fetchYouTube(term: string): Promise<SignalData> {
  // SerpAPI YouTube search - high signal for food trends
  try {
    const result = await serpSearch({ engine: 'youtube', search_query: `${term} recipe food` });
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

async function fetchGoogleNews(term: string): Promise<SignalData> {
  // SerpAPI Google News - media coverage indicates mainstream attention
  try {
    const result = await serpSearch({ engine: 'google_news', q: `${term} food restaurant` });
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

async function fetchGoogleMaps(term: string): Promise<SignalData> {
  // SerpAPI Google Maps - local supply density (how many places serve this)
  try {
    const result = await serpSearch({ engine: 'google_maps', q: `${term} ${REGION}`, type: 'search' });
    if (!result.data) return { platform: Platform.GoogleMaps, currentIntensity: 0, velocity: 0, history: [] };
    const places = result.data.local_results || [];
    // Count establishments and average rating
    const count = places.length;
    let totalRating = 0;
    let ratedCount = 0;
    for (const p of places) {
      if (p.rating) {
        totalRating += p.rating;
        ratedCount++;
      }
    }
    // High count = saturated supply, scale: 20 places = 100 intensity
    const intensity = Math.min(100, count * 5);
    return { platform: Platform.GoogleMaps, currentIntensity: intensity, velocity: 0, history: [] };
  } catch { return { platform: Platform.GoogleMaps, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchWildchat(term: string): Promise<SignalData> {
  try {
    const { data } = await axios.get('https://datasets-server.huggingface.co/search', {
      params: { dataset: 'allenai/WildChat-1M', config: 'default', split: 'train', query: term, offset: 0, limit: 10 },
      timeout: EXTERNAL_TIMEOUT_MS,
    });
    return { platform: Platform.Wildchat, currentIntensity: Math.min(100, (data.rows?.length || 0) * 10), velocity: 0, history: [] };
  } catch { return { platform: Platform.Wildchat, currentIntensity: 0, velocity: 0, history: [] }; }
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

// ========== SUPABASE HELPERS ==========

async function getHistory(trendId: string, limit = 12) {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from('trend_history')
      .select('timestamp, demand_score, supply_score, unmet_demand_score, breakout_probability, raw_signals')
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const isSearchMode = query.length > 0;
    const terms = isSearchMode
      ? [{ id: '', term: query, category: 'Search', neighborhood: 'All Neighborhoods' }]
      : await getTrackedTerms();

    if (!terms.length) {
      return res.status(200).json([]);
    }

    const trends: TrendEntity[] = await mapWithConcurrency(terms, TERM_PROCESS_CONCURRENCY, async (item) => {
      const [yelp, reddit, google, tiktok, pinterest, delivery, wildchat, sales, traffic, youtube, news, maps] = await Promise.all([
        fetchYelp(item.term),
        fetchReddit(item.term),
        fetchSerpTrends(item.term),
        fetchTikTokSerp(item.term),
        fetchPinterestProxy(item.term),
        fetchSerpDelivery(item.term),
        fetchWildchat(item.term),
        fetchSquareSales(item.term),
        fetchGA4Traffic(item.term),
        fetchYouTube(item.term),
        fetchGoogleNews(item.term),
        fetchGoogleMaps(item.term),
      ]);

      const signals = [yelp, reddit, google, tiktok, pinterest, delivery, wildchat, sales, traffic, youtube, news, maps];
      const ds = demandScore(signals);
      const ss = supplyScore(signals);
      const ud = unmetDemand(ds, ss);
      const bp = breakoutProb(signals);

      // Persist
      let trendId = item.id || '';
      if (supabase && !isSearchMode) {
        try {
          const { data: row } = await supabase
            .from('trends')
            .upsert({ term: item.term, category: item.category, region: 'Minneapolis–St Paul', neighborhood: item.neighborhood, last_updated: new Date().toISOString() }, { onConflict: 'term' })
            .select().single();
          if (row) {
            trendId = row.id;
            await supabase.from('trend_history').insert({
              trend_id: row.id, timestamp: new Date().toISOString(),
              demand_score: ds, supply_score: ss, unmet_demand_score: ud, breakout_probability: bp, raw_signals: signals,
            });
          }
        } catch (e) { console.error('Supabase persist:', e); }
      }

      // Build history from past snapshots
      let predicted = 0;
      if (trendId && !isSearchMode) {
        const past = await getHistory(trendId, 12);
        if (past.length > 0) {
          predicted = predictBreakout(past.map((r, i) => ({ week: i + 1, score: r.unmet_demand_score ?? 0 })), ud);
          for (const sig of signals) {
            sig.history = past.map((r, i) => {
              const raw = (r.raw_signals as SignalData[]) || [];
              const m = raw.find(rs => rs.platform === sig.platform);
              return { week: i + 1, value: m?.currentIntensity ?? 0 };
            });
          }
        }
      }

      return {
        id: trendId || item.term.replace(/\s+/g, '-').toLowerCase(),
        term: item.term, category: item.category, region: 'Minneapolis–St Paul', neighborhood: item.neighborhood,
        signals, supplyScore: ss, demandScore: ds, unmetDemandScore: ud, breakoutProbability: bp,
        predictedBreakoutWeek: predicted,
      };
    });

    res.status(200).json(trends);
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
}

