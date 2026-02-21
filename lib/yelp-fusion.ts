/**
 * Yelp Places API — direct client replacing SerpAPI's Yelp scrape.
 *
 * Naming note: "Yelp Fusion" was rebranded to "Yelp Places API" in 2024–2025.
 * The API endpoint (api.yelp.com/v3) and response schema are IDENTICAL —
 * only the marketing name changed. The YELP_API_KEY from yelp.com/developers
 * works for both. This file keeps the internal name consistent with current docs.
 *
 * Advantages over SerpAPI Yelp scrape:
 *  - Open/closed status (filter out permanently closed businesses)
 *  - Transactions array: delivery, pickup, restaurant_reservation
 *  - Price tier ($ to $$$$) — proxy for competitive intensity at your price point
 *  - review_count is accurate (not scraped/truncated)
 *  - Up to 240 results per call (vs SerpAPI's ~10 organic results)
 *
 * Pricing: 30-day trial (5,000 calls, evaluation only) → paid plan with
 * 30,000 calls/month included. Contact sales for volume pricing.
 *
 * Env required: YELP_API_KEY
 * Results cached 72h in Supabase serp_cache under engine='yelp_places'.
 */

import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const YELP_API_KEY = process.env.YELP_API_KEY;

const TTL_HOURS = 72;
const YELP_BASE = 'https://api.yelp.com/v3';

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export interface YelpBusiness {
  name: string;
  rating: number;
  reviewCount: number;
  isOpen: boolean;
  price: number;           // 1–4 dollar signs, 0 if unknown
  hasDelivery: boolean;
  hasPickup: boolean;
  distance: number | null; // meters from search center
}

export interface YelpFusionResult {
  total: number;           // Total results Yelp reports (not just page)
  businesses: YelpBusiness[];
  /** Open businesses that specifically match the term */
  specificCount: number;
  /** Avg rating across matching businesses (open only) */
  avgRating: number;
  /** Weighted supply quality 0–100 */
  supplyQuality: number;
  fromCache: boolean;
}

// ── Cache helpers ──────────────────────────────────────────────────────────

function cacheKey(term: string, location: string): string {
  return crypto.createHash('sha256').update(`yelp_places:${term.toLowerCase()}:${location.toLowerCase()}`).digest('hex');
}

async function getCached(key: string): Promise<YelpFusionResult | null> {
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
    return { ...(data.response as YelpFusionResult), fromCache: true };
  } catch { return null; }
}

async function setCache(key: string, term: string, result: YelpFusionResult): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('serp_cache').insert({
      cache_key: key,
      engine: 'yelp_places',
      query: term,
      response: result,
      call_cost: 0, // track separately; doesn't consume SerpAPI budget
      created_at: new Date().toISOString(),
    });
  } catch { /* non-fatal */ }
}

// ── Supply quality (same formula as SerpAPI path but with real data) ───────

function calcSupplyQuality(businesses: YelpBusiness[]): number {
  const open = businesses.filter(b => b.isOpen);
  if (!open.length) return 0;
  const densityScore = Math.min(1, open.length / 10);
  const qualityScores = open.map(b =>
    (b.rating / 5) * Math.min(1, Math.log10(b.reviewCount + 1) / 3)
  );
  const avgQuality = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
  return Math.round((densityScore * 0.5 + avgQuality * 0.5) * 100);
}

// ── Main export ─────────────────────────────────────────────────────────────

const EMPTY: YelpFusionResult = {
  total: 0, businesses: [], specificCount: 0, avgRating: 0, supplyQuality: 0, fromCache: false,
};

export async function fetchYelpFusion(
  term: string,
  location: string,  // e.g. "55401" or "Minneapolis, MN"
): Promise<YelpFusionResult> {
  if (!YELP_API_KEY) return EMPTY;

  const key = cacheKey(term, location);
  const cached = await getCached(key);
  if (cached) return cached;

  try {
    const { data } = await axios.get(`${YELP_BASE}/businesses/search`, {
      headers: { Authorization: `Bearer ${YELP_API_KEY}` },
      params: {
        term,
        location,
        limit: 50,
        sort_by: 'best_match',
        // Don't filter by open_now — we want to count all supply, just label it
      },
      timeout: 8000,
    });

    const termLower = term.toLowerCase();
    const businesses: YelpBusiness[] = (data.businesses || []).map((b: any) => {
      const cats = (b.categories || []).map((c: any) => (c.title || '').toLowerCase()).join(' ');
      const name = (b.name || '').toLowerCase();
      return {
        name: b.name || '',
        rating: parseFloat(b.rating) || 0,
        reviewCount: parseInt(b.review_count, 10) || 0,
        isOpen: !(b.is_closed ?? true),
        price: (b.price || '').length || 0, // '$' = 1, '$$' = 2, etc.
        hasDelivery: (b.transactions || []).includes('delivery'),
        hasPickup: (b.transactions || []).includes('pickup'),
        distance: b.distance != null ? Math.round(b.distance) : null,
        _matches: cats.includes(termLower) || name.includes(termLower),
      } as YelpBusiness & { _matches: boolean };
    });

    const matching = (businesses as (YelpBusiness & { _matches: boolean })[]).filter(b => b._matches);
    const openMatching = matching.filter(b => b.isOpen);
    const avgRating = openMatching.length
      ? openMatching.reduce((s, b) => s + b.rating, 0) / openMatching.length
      : 0;

    const result: YelpFusionResult = {
      total: data.total || 0,
      businesses: businesses.map(({ ...b }) => b),
      specificCount: matching.length,
      avgRating: Math.round(avgRating * 10) / 10,
      supplyQuality: calcSupplyQuality(matching),
      fromCache: false,
    };

    await setCache(key, term, result);
    return result;
  } catch (e: any) {
    console.error('[YelpFusion] API error:', e?.response?.data || e?.message);
    return EMPTY;
  }
}

/**
 * Convert Yelp Fusion specific count to intensity (0–100).
 * Better than SerpAPI: uses only open, matching businesses.
 * Scale: 1 competitor = 10, 5 = 50, 10+ = 100 (open only).
 * At $65-85/person, 5 quality competitors in a metro is already strong supply.
 */
export function yelpCountToIntensity(specificCount: number, openOnly = true): number {
  // Tighter scale than raw listing count because these are confirmed open + relevant
  return Math.min(100, specificCount * (openOnly ? 12 : 8));
}
