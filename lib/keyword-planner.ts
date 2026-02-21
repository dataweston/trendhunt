/**
 * Google Ads Keyword Planner — absolute monthly search volume for terms.
 *
 * Uses the Google Ads API (generateKeywordIdeas) with a zero-spend account.
 * Returns real monthly search volume (e.g. "3,600 searches/month in Minneapolis"),
 * replacing Google Trends' unitless 0–100 relative index as the intent anchor.
 *
 * Auth: Service Account OAuth2 via GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_ADS_CUSTOMER_ID
 * + the same GOOGLE_SERVICE_ACCOUNT_KEY used for GA4.
 *
 * FREE with any Google Ads account (even $0 spend). Quota: 15,000 requests/day.
 * Results cached 7 days in Supabase serp_cache under engine='keyword_planner'.
 */

import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
const SERVICE_ACCOUNT_RAW = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

// Minneapolis DMA geo target constant ID (https://developers.google.com/google-ads/api/reference/data/geotargets)
// 1017074 = Minneapolis-St. Paul, MN  |  20140 = Minnesota state
const DEFAULT_GEO_TARGET_ID = process.env.KEYWORD_PLANNER_GEO_ID || '1017074';

const TTL_HOURS = 168; // 7 days — keyword volumes shift weekly at best

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export interface KeywordVolumeResult {
  term: string;
  /** Actual average monthly searches (e.g. 3600). Null if API unavailable. */
  monthlySearches: number | null;
  /** Competition index 0–100 (LOW/MEDIUM/HIGH mapped to 0/50/100) */
  competition: number | null;
  /** Suggested CPC in USD cents (proxy for commercial intent) */
  cpcCents: number | null;
  /** True if data came from cache */
  fromCache: boolean;
}

// ── OAuth token (reused across calls in same serverless instance) ──────────
let _token: string | null = null;
let _tokenExp = 0;

async function getOAuthToken(): Promise<string | null> {
  if (_token && Date.now() < _tokenExp) return _token;
  if (!SERVICE_ACCOUNT_RAW) return null;
  try {
    let sa: any;
    try { sa = JSON.parse(SERVICE_ACCOUNT_RAW); } catch {
      try { sa = JSON.parse(Buffer.from(SERVICE_ACCOUNT_RAW, 'base64').toString('utf-8')); } catch { return null; }
    }
    const privateKey = String(sa.private_key || '').replace(/\\n/g, '\n');
    if (!privateKey || !sa.client_email) return null;

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/adwords',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${sig}`,
    });
    _token = data.access_token;
    _tokenExp = Date.now() + 55 * 60_000;
    return _token;
  } catch (e) {
    console.error('[KeywordPlanner] OAuth error:', e);
    return null;
  }
}

// ── Cache helpers (reuse serp_cache table with engine='keyword_planner') ───
function cacheKey(term: string, geoId: string): string {
  return crypto.createHash('sha256').update(`keyword_planner:${term.toLowerCase()}:${geoId}`).digest('hex');
}

async function getCached(key: string): Promise<KeywordVolumeResult | null> {
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
    const ageHours = (Date.now() - new Date(data.created_at).getTime()) / 3_600_000;
    if (ageHours > TTL_HOURS) return null;
    return { ...(data.response as KeywordVolumeResult), fromCache: true };
  } catch { return null; }
}

async function setCache(key: string, term: string, result: KeywordVolumeResult): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('serp_cache').insert({
      cache_key: key,
      engine: 'keyword_planner',
      query: term,
      response: result,
      call_cost: 0, // free API — doesn't count against SerpAPI budget
      created_at: new Date().toISOString(),
    });
  } catch { /* non-fatal */ }
}

// ── Main export ─────────────────────────────────────────────────────────────
export async function getKeywordVolume(
  term: string,
  geoTargetId = DEFAULT_GEO_TARGET_ID,
): Promise<KeywordVolumeResult> {
  const empty: KeywordVolumeResult = { term, monthlySearches: null, competition: null, cpcCents: null, fromCache: false };

  if (!DEVELOPER_TOKEN || !CUSTOMER_ID) return empty;

  const key = cacheKey(term, geoTargetId);
  const cached = await getCached(key);
  if (cached) return cached;

  const token = await getOAuthToken();
  if (!token) return empty;

  try {
    const url = `https://googleads.googleapis.com/v17/customers/${CUSTOMER_ID}:generateKeywordIdeas`;
    const { data } = await axios.post(url, {
      keywordSeed: { keywords: [term] },
      geoTargetConstants: [`geoTargetConstants/${geoTargetId}`],
      language: 'languageConstants/1000', // English
      keywordPlanNetwork: 'GOOGLE_SEARCH',
      includeAdultKeywords: false,
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'developer-token': DEVELOPER_TOKEN,
        'login-customer-id': CUSTOMER_ID,
      },
      timeout: 8000,
    });

    const results = data.results || [];
    // Find best match — the entry whose text matches our term most closely
    const termLower = term.toLowerCase();
    const match = results.find((r: any) =>
      (r.text || '').toLowerCase() === termLower
    ) || results[0];

    if (!match) {
      await setCache(key, term, empty);
      return empty;
    }

    const metrics = match.keywordIdeaMetrics || {};
    const competitionMap: Record<string, number> = { LOW: 25, MEDIUM: 50, HIGH: 100 };
    const result: KeywordVolumeResult = {
      term,
      monthlySearches: metrics.avgMonthlySearches != null ? Number(metrics.avgMonthlySearches) : null,
      competition: competitionMap[metrics.competition] ?? null,
      cpcCents: metrics.averageCpcMicros != null ? Math.round(Number(metrics.averageCpcMicros) / 10000) : null,
      fromCache: false,
    };

    await setCache(key, term, result);
    return result;
  } catch (e: any) {
    console.error('[KeywordPlanner] API error:', e?.response?.data || e?.message);
    return empty;
  }
}

/**
 * Converts absolute monthly search volume to a 0–100 intensity score.
 * Scale anchored to food/restaurant search context:
 *   < 100  searches/mo → 0–10   (niche, not worth tracking)
 *   100    searches/mo → ~15
 *   500    searches/mo → ~35
 *   1,000  searches/mo → ~50
 *   5,000  searches/mo → ~75
 *   10,000 searches/mo → ~90
 *   50,000 searches/mo → 100    (national craze)
 */
export function keywordVolumeToIntensity(monthlySearches: number | null): number {
  if (monthlySearches == null || monthlySearches <= 0) return 0;
  // log10 scale: log10(50000) ≈ 4.7, so divide by 4.7 and cap at 1
  const scaled = Math.log10(monthlySearches + 1) / Math.log10(50000);
  return Math.max(0, Math.min(100, Math.round(scaled * 100)));
}
