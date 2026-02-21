/**
 * SerpAPI Governor
 * Centralized search proxy with caching, TTL, deduplication, budgeting, and stop rules.
 * Budget: $40/mo = 10,000 calls. This module enforces it.
 */
import axios from 'axios';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SERP_ENABLED = (process.env.ENABLE_SERPAPI ?? process.env.ENABLE_SERP ?? 'true').toLowerCase() !== 'false';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SERPAPI_TIMEOUT_MS = Number(process.env.SERPAPI_TIMEOUT_MS || 5000);
const AUTH_FAILURE_COOLDOWN_MS = Number(process.env.SERPAPI_AUTH_FAILURE_COOLDOWN_MS || 10 * 60_000);

const supabase: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// --- Budget ---
const MONTHLY_BUDGET = 10_000; // calls
const DAILY_SOFT_CAP = 400;   // ~$1.60/day leaves headroom

let authFailureUntil = 0;

// --- TTL by query type (hours) ---
const TTL: Record<string, number> = {
  google_trends_timeseries: 72,     // budget constraint: <1000 calls/month; trends shift weekly not daily
  google_trends_related: 72,        // rising queries shift slowly
  google_light: 72,                 // discovery scans — weekly-ish
  google: 48,                       // TikTok site: searches — budget constraint
  google_maps: 168,                 // supplier/business data — weekly
  google_news: 48,                  // food trend news doesn't change hourly; budget constraint
  youtube: 48,                      // video results shift slowly
  yelp: 72,                         // yelp restaurant data — budget constraint
};

// --- Cache key ---
function cacheKey(engine: string, params: Record<string, string | undefined>): string {
  const sorted = Object.keys(params).filter(k => params[k] !== undefined).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha256').update(`${engine}:${sorted}`).digest('hex');
}

// --- Read cache ---
async function getCache(key: string, ttlHours: number): Promise<any | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from('serp_cache')
      .select('response, created_at')
      .eq('cache_key', key)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    const age = (Date.now() - new Date(data.created_at).getTime()) / 3_600_000;
    if (age > ttlHours) return null;
    return data.response;
  } catch (error) {
    console.error('[SerpGovernor] Cache read error:', error);
    return null;
  }
}

// --- Write cache ---
async function setCache(key: string, engine: string, query: string, response: any, callCost: number) {
  if (!supabase) return;
  try {
    await supabase.from('serp_cache').insert({
      cache_key: key,
      engine,
      query,
      response,
      call_cost: callCost,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[SerpGovernor] Cache write error:', error);
  }
}

// --- Budget check ---
async function getUsage(): Promise<{ today: number; month: number }> {
  if (!supabase) return { today: 0, month: 0 };
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [dayResult, monthResult] = await Promise.all([
      supabase.from('serp_cache').select('call_cost', { count: 'exact', head: false })
        .gte('created_at', todayStart).gt('call_cost', 0),
      supabase.from('serp_cache').select('call_cost', { count: 'exact', head: false })
        .gte('created_at', monthStart).gt('call_cost', 0),
    ]);

    return {
      today: dayResult.count || 0,
      month: monthResult.count || 0,
    };
  } catch (error) {
    console.error('[SerpGovernor] Usage query error:', error);
    return { today: 0, month: 0 };
  }
}

// --- Main search function ---
export interface SerpSearchParams {
  engine: string;
  q?: string;  // Optional since some engines use search_query, find_desc, etc.
  [key: string]: string | undefined;
}

export interface SerpResult {
  data: any;
  fromCache: boolean;
  callsRemaining: { today: number; month: number };
}

export async function serpSearch(params: SerpSearchParams): Promise<SerpResult> {
  if (!SERP_ENABLED) {
    return { data: null, fromCache: false, callsRemaining: { today: DAILY_SOFT_CAP, month: MONTHLY_BUDGET } };
  }

  if (!SERPAPI_KEY) {
    return { data: null, fromCache: false, callsRemaining: { today: DAILY_SOFT_CAP, month: MONTHLY_BUDGET } };
  }

  const { engine, ...rest } = params;

  // Determine TTL category
  let ttlKey = engine;
  if (engine === 'google_trends' && rest.data_type === 'TIMESERIES') ttlKey = 'google_trends_timeseries';
  else if (engine === 'google_trends' && rest.data_type === 'RELATED_QUERIES') ttlKey = 'google_trends_related';
  const ttlHours = TTL[ttlKey] || 24;

  // Build cache key (exclude api_key)
  const keyParams = { ...rest };
  delete keyParams.api_key;
  const key = cacheKey(engine, keyParams);

  // Check cache
  const cached = await getCache(key, ttlHours);
  if (cached) {
    const usage = await getUsage();
    return {
      data: cached,
      fromCache: true,
      callsRemaining: { today: DAILY_SOFT_CAP - usage.today, month: MONTHLY_BUDGET - usage.month },
    };
  }

  if (Date.now() < authFailureUntil) {
    return {
      data: null,
      fromCache: false,
      callsRemaining: { today: DAILY_SOFT_CAP, month: MONTHLY_BUDGET },
    };
  }

  // Budget gate
  const usage = await getUsage();
  if (usage.month >= MONTHLY_BUDGET) {
    console.warn('[SerpGovernor] Monthly budget exhausted');
    return { data: null, fromCache: false, callsRemaining: { today: 0, month: 0 } };
  }
  if (usage.today >= DAILY_SOFT_CAP) {
    console.warn('[SerpGovernor] Daily soft cap reached');
    return { data: null, fromCache: false, callsRemaining: { today: 0, month: MONTHLY_BUDGET - usage.month } };
  }

  // Make the call
  try {
    const { data } = await axios.get('https://serpapi.com/search.json', {
      params: { engine, ...rest, api_key: SERPAPI_KEY },
      timeout: SERPAPI_TIMEOUT_MS,
    });

    // Cache it (call_cost = 1 for a real API call)
    const queryLabel = params.q || params.search_query || params.find_desc || key.slice(0, 20);
    await setCache(key, engine, queryLabel, data, 1);

    return {
      data,
      fromCache: false,
      callsRemaining: { today: DAILY_SOFT_CAP - usage.today - 1, month: MONTHLY_BUDGET - usage.month - 1 },
    };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      authFailureUntil = Date.now() + AUTH_FAILURE_COOLDOWN_MS;
      console.error(`[SerpGovernor] API error: status=401 Unauthorized. Live calls disabled for ${Math.round(AUTH_FAILURE_COOLDOWN_MS / 1000)}s.`);
    } else if (axios.isAxiosError(err)) {
      const apiMessage = typeof err.response?.data === 'object' && err.response?.data
        ? (err.response?.data as { error?: string }).error
        : undefined;
      console.error(`[SerpGovernor] API error: status=${err.response?.status ?? 'unknown'} ${apiMessage || err.message}`);
    } else {
      console.error(`[SerpGovernor] API error: ${String(err)}`);
    }
    return { data: null, fromCache: false, callsRemaining: { today: DAILY_SOFT_CAP - usage.today, month: MONTHLY_BUDGET - usage.month } };
  }
}

// --- Convenience: batch search with dedup + stop rules ---
export async function serpBatch(
  queries: SerpSearchParams[],
  opts: { maxCalls?: number; stopOnLowYield?: boolean } = {}
): Promise<SerpResult[]> {
  const maxCalls = opts.maxCalls ?? 20;
  const results: SerpResult[] = [];
  let liveCallCount = 0;

  for (const q of queries) {
    if (liveCallCount >= maxCalls) break;

    const result = await serpSearch(q);
    results.push(result);

    if (!result.fromCache && result.data) liveCallCount++;
    if (result.callsRemaining.today <= 0) break;
    if (result.callsRemaining.month <= 0) break;
  }

  return results;
}

// --- Usage stats endpoint helper ---
export async function getUsageStats() {
  const usage = await getUsage();
  return {
    today: usage.today,
    dailyCap: DAILY_SOFT_CAP,
    month: usage.month,
    monthlyCap: MONTHLY_BUDGET,
    estimatedCost: `$${((usage.month / 1000) * 4).toFixed(2)}`,
    remainingBudget: `$${(((MONTHLY_BUDGET - usage.month) / 1000) * 4).toFixed(2)}`,
  };
}
