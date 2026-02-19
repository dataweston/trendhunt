import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

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
const YELP_API_KEY = process.env.YELP_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// --- Scoring ---
const WEIGHTS: Record<string, number> = {
  OwnSales: 3.0, TikTok: 2.0, OwnTraffic: 1.8, Reddit: 1.5,
  Pinterest: 1.2, GoogleSearch: 1.0, MetaAds: 0.8, Wildchat: 0.6,
  Yelp: 0.5, DoorDash: 0.5, RedditPushshift: 0.3,
};
const SUPPLY = new Set(['Yelp', 'DoorDash']);

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
  if (!SERPAPI_KEY) return { platform: Platform.GoogleSearch, currentIntensity: 0, velocity: 0, history: [] };
  try {
    const { data } = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google_trends', q: term, geo: 'US-MN', data_type: 'TIMESERIES', api_key: SERPAPI_KEY },
    });
    const tl = data?.interest_over_time?.timeline_data;
    if (!tl?.length) return { platform: Platform.GoogleSearch, currentIntensity: 0, velocity: 0, history: [] };
    const vals = tl.map((t: any) => t.values?.[0]?.extracted_value ?? 0);
    const last = vals[vals.length - 1] || 0;
    const prev = vals[vals.length - 2] || 0;
    return {
      platform: Platform.GoogleSearch,
      currentIntensity: Math.min(100, last),
      velocity: last - prev,
      history: vals.slice(-12).map((v: number, i: number) => ({ week: i + 1, value: v })),
    };
  } catch { return { platform: Platform.GoogleSearch, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchSerpDelivery(term: string): Promise<SignalData> {
  if (!SERPAPI_KEY) return { platform: Platform.DoorDash, currentIntensity: 0, velocity: 0, history: [] };
  try {
    const { data } = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google_trends', q: `${term} delivery`, geo: 'US-MN', data_type: 'TIMESERIES', api_key: SERPAPI_KEY },
    });
    const tl = data?.interest_over_time?.timeline_data;
    if (!tl?.length) return { platform: Platform.DoorDash, currentIntensity: 0, velocity: 0, history: [] };
    const vals = tl.map((t: any) => t.values?.[0]?.extracted_value ?? 0);
    return {
      platform: Platform.DoorDash,
      currentIntensity: Math.min(100, vals[vals.length - 1] || 0),
      velocity: 0,
      history: vals.slice(-12).map((v: number, i: number) => ({ week: i + 1, value: v })),
    };
  } catch { return { platform: Platform.DoorDash, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchYelp(term: string): Promise<SignalData> {
  if (!YELP_API_KEY) return { platform: Platform.Yelp, currentIntensity: 0, velocity: 0, history: [] };
  try {
    const { data } = await axios.get('https://api.yelp.com/v3/businesses/search', {
      headers: { Authorization: `Bearer ${YELP_API_KEY}` },
      params: { term, location: REGION, limit: 50 },
    });
    return {
      platform: Platform.Yelp,
      currentIntensity: Math.min(100, Math.round(((data.total || 0) / 50) * 100)),
      velocity: 0, history: [],
    };
  } catch { return { platform: Platform.Yelp, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchReddit(term: string): Promise<SignalData> {
  try {
    const { data } = await axios.get('https://www.reddit.com/search.json', { params: { q: term, sort: 'new', limit: 25 } });
    const posts = data.data.children;
    const now = Date.now() / 1000;
    const recent = posts.filter((p: any) => (now - p.data.created_utc) < 86400).length;
    return { platform: Platform.Reddit, currentIntensity: Math.min(100, posts.length * 4), velocity: recent * 5, history: [] };
  } catch { return { platform: Platform.Reddit, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchTikTokProxy(term: string): Promise<SignalData> {
  try {
    const { data } = await axios.get('https://www.reddit.com/search.json', { params: { q: `"${term}" site:tiktok.com`, sort: 'new', limit: 50 } });
    const posts = data.data.children;
    const now = Date.now() / 1000;
    const recent = posts.filter((p: any) => (now - p.data.created_utc) < 172800).length;
    return { platform: Platform.TikTok, currentIntensity: Math.min(100, posts.length * 5), velocity: recent * 10, history: [] };
  } catch { return { platform: Platform.TikTok, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchPinterestProxy(term: string): Promise<SignalData> {
  try {
    const { data } = await axios.get('https://www.reddit.com/search.json', { params: { q: `"${term}" site:pinterest.com`, sort: 'new', limit: 25 } });
    return { platform: Platform.Pinterest, currentIntensity: Math.min(100, data.data.children.length * 10), velocity: 0, history: [] };
  } catch { return { platform: Platform.Pinterest, currentIntensity: 0, velocity: 0, history: [] }; }
}

async function fetchWildchat(term: string): Promise<SignalData> {
  try {
    const { data } = await axios.get('https://datasets-server.huggingface.co/search', {
      params: { dataset: 'allenai/WildChat-1M', config: 'default', split: 'train', query: term, offset: 0, limit: 10 },
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
    }, { headers: { Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });

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

// GA4 stub — requires service account JWT exchange
async function fetchGA4Traffic(_term: string): Promise<SignalData> {
  // TODO: wire once GOOGLE_SERVICE_ACCOUNT_KEY env var is set
  return { platform: Platform.OwnTraffic, currentIntensity: 0, velocity: 0, history: [] };
}

// ========== SUPABASE HELPERS ==========

async function getHistory(trendId: string, limit = 12) {
  if (!supabase) return [];
  const { data } = await supabase
    .from('trend_history')
    .select('timestamp, demand_score, supply_score, unmet_demand_score, breakout_probability, raw_signals')
    .eq('trend_id', trendId)
    .order('timestamp', { ascending: true })
    .limit(limit);
  return data || [];
}

const DEFAULT_TERMS = [
  { term: 'Birria Tacos', category: 'Mexican', neighborhood: 'Northeast', region: 'Minneapolis–St Paul' },
  { term: 'Mochi Donuts', category: 'Bakery', neighborhood: 'North Loop', region: 'Minneapolis–St Paul' },
  { term: 'Korean Corn Dogs', category: 'Street Food', neighborhood: 'Dinkytown', region: 'Minneapolis–St Paul' },
  { term: 'Detroit-style Pizza', category: 'Pizza', neighborhood: 'Uptown', region: 'Minneapolis–St Paul' },
  { term: 'Ube Lattes', category: 'Cafe', neighborhood: 'Powderhorn', region: 'Minneapolis–St Paul' },
];

async function getTrackedTerms() {
  if (!supabase) return DEFAULT_TERMS.map(d => ({ ...d, id: '' }));
  const { data } = await supabase.from('trends').select('id, term, category, neighborhood').order('created_at');
  if (!data?.length) {
    const { data: seeded } = await supabase.from('trends').upsert(DEFAULT_TERMS, { onConflict: 'term' }).select();
    return (seeded || DEFAULT_TERMS).map(d => ({ id: d.id || '', term: d.term, category: d.category || '', neighborhood: d.neighborhood || '' }));
  }
  return data.map(d => ({ id: d.id, term: d.term, category: d.category || '', neighborhood: d.neighborhood || '' }));
}

// ========== HANDLER ==========

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const terms = await getTrackedTerms();

    const trends: TrendEntity[] = await Promise.all(terms.map(async (item) => {
      const [yelp, reddit, google, tiktok, pinterest, delivery, wildchat, sales, traffic] = await Promise.all([
        fetchYelp(item.term),
        fetchReddit(item.term),
        fetchSerpTrends(item.term),
        fetchTikTokProxy(item.term),
        fetchPinterestProxy(item.term),
        fetchSerpDelivery(item.term),
        fetchWildchat(item.term),
        fetchSquareSales(item.term),
        fetchGA4Traffic(item.term),
      ]);

      const signals = [yelp, reddit, google, tiktok, pinterest, delivery, wildchat, sales, traffic];
      const ds = demandScore(signals);
      const ss = supplyScore(signals);
      const ud = unmetDemand(ds, ss);
      const bp = breakoutProb(signals);

      // Persist
      let trendId = item.id || '';
      if (supabase) {
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
      if (trendId) {
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
    }));

    res.status(200).json(trends);
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
}
