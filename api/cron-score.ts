/**
 * Cron Score — Module 2 + Module 3
 *
 * Runs daily (2 AM UTC via Vercel Cron) to write consistent time-series
 * snapshots to trend_history and compute social-vs-search lead-lag state.
 *
 * Unlike user-session scoring (which writes to trend_history on every page
 * load at arbitrary intervals), this produces one row per term per day at a
 * consistent timestamp — enabling reliable velocity regression and cross-
 * correlation math in computeLeadLag().
 *
 * Trigger: Vercel Cron at 0 2 * * * (2 AM UTC)
 * Auth: x-cron-secret header must match CRON_SECRET env var
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import { serpSearch } from '../lib/serp-governor.js';
import { getLocationContext } from '../lib/location.js';
import { computeLeadLag, type TrendHistoryRow } from '../lib/lead-lag.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const EXTERNAL_TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS || 8000);

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Dedup window: skip if a cron row was written within this many hours
const DEDUP_WINDOW_HOURS = 20;

// Concurrency: score N terms at once to stay within Vercel 60s limit
const CONCURRENCY = 3;

// ─── Auth ──────────────────────────────────────────────────────────────────────

function isCronAuth(req: VercelRequest): boolean {
  const header = req.headers['x-cron-secret'] || req.headers['authorization'];
  return !!CRON_SECRET && (header === CRON_SECRET || header === `Bearer ${CRON_SECRET}`);
}

// ─── Signal fetchers (minimal — reuse SerpAPI cache, no new live calls needed) ─

/** Pull the most recent signal snapshot from trend_history for a term. */
async function getLatestSignals(
  trendId: string,
): Promise<{ platform: string; currentIntensity: number; velocity: number }[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from('trend_history')
    .select('raw_signals')
    .eq('trend_id', trendId)
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.raw_signals as { platform: string; currentIntensity: number; velocity: number }[]) || [];
}

/** Fetch the last N trend_history rows for a term, oldest first. */
async function getHistory(trendId: string, n: number): Promise<TrendHistoryRow[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from('trend_history')
    .select('timestamp, raw_signals, gap_score, intent_score, trend_state')
    .eq('trend_id', trendId)
    .order('timestamp', { ascending: false })
    .limit(n);
  if (!data) return [];
  return data.reverse() as TrendHistoryRow[];
}

/** Check whether a cron row was already written recently for this term. */
async function wasWrittenRecently(trendId: string): Promise<boolean> {
  if (!supabase) return false;
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_HOURS * 3_600_000).toISOString();
  const { data } = await supabase
    .from('trend_history')
    .select('id')
    .eq('trend_id', trendId)
    .eq('source', 'cron')
    .gte('timestamp', cutoff)
    .limit(1)
    .maybeSingle();
  return !!data;
}

// ─── Scoring helpers (duplicated minimal subset — avoids importing 1000-line trends.ts) ─

function clamp(v: number): number { return Math.max(0, Math.min(100, Math.round(v))); }

const SUPPLY_PLATFORMS = new Set(['Yelp', 'GoogleMaps']);
const WEIGHTS: Record<string, number> = {
  OwnSales: 3.2, OwnTraffic: 1.4, GA4Backtest: 0.8,
  GoogleSearch: 2.8, DoorDash: 1.3, Reddit: 1.0,
  TikTok: 1.1, YouTube: 1.0, GoogleNews: 0.8, Pinterest: 0.6,
  Yelp: 2.0, GoogleMaps: 2.2, MetaAds: 0.7, RedditPushshift: 0.3,
  ConversationalSearch: 1.2, LocalRedditIntent: 1.3,
};

function calcIntent(signals: { platform: string; currentIntensity: number; velocity: number }[]): number {
  let w = 0, wt = 0;
  for (const s of signals) {
    if (SUPPLY_PLATFORMS.has(s.platform)) continue;
    if (s.currentIntensity === 0 && s.velocity === 0) continue;
    const weight = WEIGHTS[s.platform] || 1;
    w += s.currentIntensity * weight;
    wt += weight;
  }
  return clamp(wt > 0 ? w / wt : 0);
}

function calcAvailability(signals: { platform: string; currentIntensity: number }[]): number {
  const supply = signals.filter(s => SUPPLY_PLATFORMS.has(s.platform));
  if (!supply.length) return 5;
  const yelp = supply.find(s => s.platform === 'Yelp')?.currentIntensity || 0;
  const maps = supply.find(s => s.platform === 'GoogleMaps')?.currentIntensity || 0;
  return clamp(maps * 0.6 + yelp * 0.4);
}

function calcGap(intent: number, availability: number, realization: number): number {
  const deficit = Math.max(0, intent - realization);
  const friction = Math.max(0, 100 - availability);
  return clamp(deficit * 0.6 + (intent * friction / 100) * 0.4);
}

// ─── Gemini narrative ──────────────────────────────────────────────────────────

async function generateLeadLagNarrative(
  term: string,
  leadLagWeeks: number,
  trendState: string,
): Promise<string | null> {
  if (!ai || leadLagWeeks === 0) return null;
  try {
    const direction = leadLagWeeks > 0 ? `${leadLagWeeks} week${leadLagWeeks > 1 ? 's' : ''} ahead of` : 'behind';
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `For the food trend "${term}": social media signals are currently ${direction} Google search interest (state: ${trendState}). Write exactly one sentence (under 25 words) for a Minneapolis food business owner explaining what this means for their launch timing. Be direct and actionable.`,
    });
    return (response.text ?? '').trim().slice(0, 200) || null;
  } catch { return null; }
}

// ─── Main handler ──────────────────────────────────────────────────────────────

async function scoreOneTerm(
  term: { id: string; term: string; region: string; neighborhood: string },
  now: string,
): Promise<{ term: string; skipped?: boolean; error?: string }> {
  try {
    // Dedup — skip if already scored today by cron
    if (await wasWrittenRecently(term.id)) {
      return { term: term.term, skipped: true };
    }

    // Use latest cached signals rather than making fresh SerpAPI calls
    // (SerpAPI cache is already populated by user sessions or previous cron runs)
    const signals = await getLatestSignals(term.id);
    if (!signals.length) return { term: term.term, skipped: true };

    const intent = calcIntent(signals);
    const availability = calcAvailability(signals);
    const gap = calcGap(intent, availability, 0);

    // Compute lead-lag from full history
    const history = await getHistory(term.id, 14);
    const leadLagResult = computeLeadLag(history);

    // Write cron snapshot to trend_history
    const { data: inserted } = await supabase!
      .from('trend_history')
      .insert({
        trend_id: term.id,
        timestamp: now,
        source: 'cron',
        zip_code: null,
        demand_score: intent,
        supply_score: availability,
        unmet_demand_score: gap,
        breakout_probability: clamp(15 + gap * 0.45 + intent * 0.2),
        intent_score: intent,
        availability_score: availability,
        realization_score: 0,
        gap_score: gap,
        confidence_score: clamp(20 + signals.length * 4),
        serpapi_share: 0,
        evidence: [],
        raw_signals: signals,
        trend_state: leadLagResult.trendState,
        lead_lag_weeks: leadLagResult.leadLagWeeks,
        lead_lag_correlation: leadLagResult.correlation,
      })
      .select('id')
      .maybeSingle();

    // Fetch last state from trends table to detect change
    const { data: currentTrend } = await supabase!
      .from('trends')
      .select('trend_state')
      .eq('id', term.id)
      .maybeSingle();

    const stateChanged = currentTrend?.trend_state !== leadLagResult.trendState;
    let narrative: string | null = null;
    if (stateChanged && leadLagResult.trendState !== 'INSUFFICIENT_DATA') {
      narrative = await generateLeadLagNarrative(
        term.term,
        leadLagResult.leadLagWeeks,
        leadLagResult.trendState,
      );
    }

    // Update trends table with latest lead-lag state
    const trendsUpdate: Record<string, unknown> = {
      trend_state: leadLagResult.trendState,
      lead_lag_weeks: leadLagResult.leadLagWeeks,
      last_lead_lag_at: now,
      last_updated: now,
    };
    if (narrative) trendsUpdate.trend_state_narrative = narrative;

    await supabase!.from('trends').update(trendsUpdate).eq('id', term.id);

    return { term: term.term };
  } catch (e) {
    return { term: term.term, error: String(e) };
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isCronAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

  const now = new Date().toISOString();

  // Fetch all tracked terms
  const { data: tracked, error } = await supabase
    .from('trends')
    .select('id, term, region, neighborhood')
    .order('last_updated', { ascending: true }); // oldest-first so stalest terms score first

  if (error || !tracked) return res.status(500).json({ error: 'Failed to fetch tracked terms' });

  const results = await mapConcurrent(tracked, CONCURRENCY, item => scoreOneTerm(item, now));

  const scored = results.filter(r => !r.skipped && !r.error).length;
  const skipped = results.filter(r => r.skipped).length;
  const errors = results.filter(r => r.error).length;

  console.log(`[cron-score] ${now} — scored: ${scored}, skipped: ${skipped}, errors: ${errors}`);

  return res.status(200).json({
    ok: true,
    timestamp: now,
    total: tracked.length,
    scored,
    skipped,
    errors,
    errorDetails: results.filter(r => r.error).map(r => ({ term: r.term, error: r.error })),
  });
}
