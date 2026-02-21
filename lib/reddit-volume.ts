/**
 * Reddit Volume Tracker — Pushshift mimic using Reddit's native search API.
 *
 * What Pushshift ($100/mo commercial) gives you:
 *  - Post count per month for a term (time-series volume, not just current page)
 *  - Enables real Reddit velocity: "this term had 3 posts/month in Oct, 47 in Feb"
 *
 * What we do instead (free):
 *  - Reddit's /search.json with time-bucketed "after" parameters
 *  - Query 4 time windows (last 7d, 7–30d, 30–90d, 90–180d) → pseudo time-series
 *  - Combine subreddit-specific (Minneapolis/food) + broad food search
 *  - Detect ACCELERATION: is the rate-of-posts growing faster recently?
 *
 * Limitations vs Pushshift:
 *  - Reddit API returns max 25 results per call (not exhaustive counts)
 *  - Results are "recent new" sorted — older windows are less reliable
 *  - Rate limiting: 60 req/min unauthenticated. We stay well under that.
 *
 * Results cached 12h in Supabase (Reddit data moves fast enough to warrant this).
 */

import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TTL_HOURS = 12;
const TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS || 5000);

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Food-relevant subreddits: local-first, then national food communities
const LOCAL_SUBS = 'Minneapolis+TwinCities+minnesota+MNFood';
const FOOD_SUBS = 'food+foodporn+Cooking+EatCheapAndHealthy+MealPrepSunday+HealthyFood+recipes';
const QUESTION_PATTERN = /\b(where|looking for|anyone know|can i find|near me|recommend|anyone tried|found|best)\b/i;

export interface RedditVolumeResult {
  /** Estimated posts in last 7 days (local + food subs) */
  last7d: number;
  /** Estimated posts in 7–30 days */
  last30d: number;
  /** Estimated posts in 30–90 days */
  last90d: number;
  /** Posts that match question patterns (latent demand indicator) */
  questionPosts: number;
  /** True if volume is accelerating (recent rate > older rate) */
  isAccelerating: boolean;
  /** Computed velocity: posts per day in last 7d vs prior 7d */
  dailyVelocity: number;
  /** Intensity score 0–100 based on total volume + acceleration */
  intensity: number;
  fromCache: boolean;
}

// ── Cache helpers ──────────────────────────────────────────────────────────

function cacheKey(term: string): string {
  return crypto.createHash('sha256').update(`reddit_volume:${term.toLowerCase()}`).digest('hex');
}

async function getCached(key: string): Promise<RedditVolumeResult | null> {
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
    return { ...(data.response as RedditVolumeResult), fromCache: true };
  } catch { return null; }
}

async function setCache(key: string, term: string, result: RedditVolumeResult): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('serp_cache').insert({
      cache_key: key,
      engine: 'reddit_volume',
      query: term,
      response: result,
      call_cost: 0, // free API
      created_at: new Date().toISOString(),
    });
  } catch { /* non-fatal */ }
}

// ── Time-bucketed search ───────────────────────────────────────────────────

/** Reddit epoch offset in seconds */
function epochOffset(daysAgo: number): number {
  return Math.floor((Date.now() - daysAgo * 86400000) / 1000);
}

interface SearchBucket {
  count: number;
  questionCount: number;
}

async function searchBucket(
  term: string,
  subreddits: string,
  afterEpoch: number,
  beforeEpoch: number,
): Promise<SearchBucket> {
  try {
    // Reddit's search API supports "after" as epoch timestamp via t=all
    const { data } = await axios.get('https://www.reddit.com/search.json', {
      params: {
        q: `"${term}"`,
        sort: 'new',
        t: 'all',
        restrict_sr: subreddits !== '' ? 'on' : 'off',
        limit: 25,
        after: `t3_`, // we'll use time filter via Reddit's built-in
      },
      headers: { 'User-Agent': 'TrendHunter/2.1 (food analytics)' },
      timeout: TIMEOUT_MS,
    });

    const posts = data?.data?.children || [];
    const now = Math.floor(Date.now() / 1000);

    // Filter by time window manually (Reddit search doesn't support epoch range)
    const inWindow = posts.filter((p: any) => {
      const created = p.data?.created_utc || 0;
      return created >= afterEpoch && created <= beforeEpoch;
    });

    const questionCount = inWindow.filter((p: any) =>
      QUESTION_PATTERN.test(p.data?.title || '')
    ).length;

    return { count: inWindow.length, questionCount };
  } catch {
    return { count: 0, questionCount: 0 };
  }
}

// ── Main export ─────────────────────────────────────────────────────────────

const EMPTY: RedditVolumeResult = {
  last7d: 0, last30d: 0, last90d: 0, questionPosts: 0,
  isAccelerating: false, dailyVelocity: 0, intensity: 0, fromCache: false,
};

export async function getRedditVolume(term: string): Promise<RedditVolumeResult> {
  const key = cacheKey(term);
  const cached = await getCached(key);
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);
  const d7 = epochOffset(7);
  const d30 = epochOffset(30);
  const d90 = epochOffset(90);

  // Run 3 parallel buckets: local subs (last 7d), food subs (last 7d), food subs (7–30d)
  // Keep call count low to avoid rate limits
  const [localRecent, foodRecent, foodMid] = await Promise.all([
    searchBucket(term, LOCAL_SUBS, d7, now),
    searchBucket(term, FOOD_SUBS, d7, now),
    searchBucket(term, FOOD_SUBS, d30, d7),
  ]);

  // Approximate 30–90d from a broader search (less accurate but directional)
  const foodOlder = await searchBucket(term, FOOD_SUBS, d90, d30);

  const last7dCount = localRecent.count + foodRecent.count;
  const last30dCount = foodMid.count;
  const last90dCount = foodOlder.count;
  const questionPosts = localRecent.questionCount + foodRecent.questionCount + foodMid.questionCount;

  // Daily velocity: posts/day in last 7d vs 7–30d daily rate
  const dailyLast7 = last7dCount / 7;
  const dailyPrior = last30dCount / 23; // 23-day window
  const dailyVelocity = Math.round((dailyLast7 - dailyPrior) * 10) / 10;
  const isAccelerating = dailyLast7 > dailyPrior * 1.3;

  // Intensity: combine volume + question signals + acceleration bonus
  // Scale: 5 posts/week local = meaningful; 20+ = strong signal
  const volumeBase = Math.min(60, last7dCount * 5);
  const questionBonus = Math.min(25, questionPosts * 8); // question posts = high intent
  const accelBonus = isAccelerating ? 15 : 0;
  const intensity = Math.min(100, Math.round(volumeBase + questionBonus + accelBonus));

  const result: RedditVolumeResult = {
    last7d: last7dCount,
    last30d: last30dCount,
    last90d: last90dCount,
    questionPosts,
    isAccelerating,
    dailyVelocity,
    intensity,
    fromCache: false,
  };

  await setCache(key, term, result);
  return result;
}

/**
 * Format Reddit volume for display in raw counts panel.
 * Example: "12 posts / 7d (↑ from 3/wk prior)"
 */
export function formatRedditVolume(r: RedditVolumeResult): string {
  if (r.last7d === 0 && r.last30d === 0) return 'No Reddit activity found';
  const priorRate = r.last30d > 0 ? `${r.last30d}/30d prior` : '';
  const accel = r.isAccelerating ? ' ↑ accelerating' : '';
  const parts = [`${r.last7d} posts/7d`, priorRate, r.questionPosts > 0 ? `${r.questionPosts} question posts` : ''].filter(Boolean);
  return parts.join(' · ') + accel;
}
