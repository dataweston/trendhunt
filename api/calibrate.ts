/**
 * Empirical Weight Calibration Report — Module 8
 *
 * GET /api/calibrate
 *
 * Queries launch_decisions with outcome != 'pending', joins with trend_history
 * scores at launch time, and computes Pearson correlation of each score component
 * against the binary outcome (hit=1, miss=0).
 *
 * Calls Gemini to produce plain-English weight recommendations.
 * Returns a JSON report — NEVER modifies scoring weights automatically.
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { requireAdminAuth } from '../lib/api-auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// --- Pearson correlation ---

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return NaN;
  const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : NaN;
}

// --- Gemini recommendation ---

async function getGeminiRecommendation(
  correlationTable: Record<string, number>,
  sampleSize: number,
): Promise<string | null> {
  if (!GEMINI_API_KEY) return null;
  const rows = Object.entries(correlationTable)
    .filter(([, v]) => !isNaN(v))
    .map(([k, v]) => `  ${k}: r=${v.toFixed(3)}`)
    .join('\n');

  const prompt = `You are advising the data science team at Local Effort, a Minneapolis food business.

We ran an outcome study on ${sampleSize} food trend decisions (launched terms tracked as 'hit' or 'miss' based on GA4 page views and conversions 90 days after launch).

Pearson correlation of each score component with outcome (hit=1, miss=0):
${rows}

A positive correlation means higher scores predicted hits. A negative means higher scores predicted misses.
A correlation near 0 means the score had no predictive value.

In 3-5 plain English sentences, explain:
1. Which scores are the best predictors of success
2. Which scores appear to be misleading or noise
3. One concrete weight adjustment to consider for the next scoring iteration

Be direct and practical. Do not suggest changes > 20% from current weights.`;

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 300 } },
      { timeout: 15_000 },
    );
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch { return null; }
}

// --- Main handler ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (!requireAdminAuth(req, res)) return;

  try {
    // Fetch evaluated decisions (outcome = 'hit' or 'miss')
    const { data: decisions, error } = await supabase
      .from('launch_decisions')
      .select('term, trend_id, launched_at, outcome, gap_score_at_launch, intent_score_at_launch, confidence_score_at_launch, trend_state_at_launch')
      .neq('outcome', 'pending')
      .order('launched_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    if (!decisions || decisions.length < 3) {
      return res.status(200).json({
        report: null,
        reason: `Insufficient data — need at least 3 evaluated outcomes, have ${decisions?.length ?? 0}.`,
        sampleSize: decisions?.length ?? 0,
      });
    }

    // Build vectors — outcome binary, score components
    const outcomes: number[] = [];
    const gapScores: number[] = [];
    const intentScores: number[] = [];
    const confidenceScores: number[] = [];

    // For serpapi_share and trendState we need trend_history at launch time
    // Pull from trend_id + launched_at (closest row)
    const trendStateMap: Record<string, number> = {
      PRE_PEAK: 1, AT_PEAK: 0.5, POST_PEAK: 0, INSUFFICIENT_DATA: -1,
    };

    const trendStateNums: number[] = [];
    const serpapiShares: number[] = [];

    for (const d of decisions) {
      const outcomeVal = d.outcome === 'hit' ? 1 : 0;
      outcomes.push(outcomeVal);
      gapScores.push(Number(d.gap_score_at_launch ?? 0));
      intentScores.push(Number(d.intent_score_at_launch ?? 0));
      confidenceScores.push(Number(d.confidence_score_at_launch ?? 0));
      trendStateNums.push(trendStateMap[d.trend_state_at_launch as string] ?? -1);

      // Fetch serpapiShare from the closest trend_history row
      let serpShare = 0;
      if (d.trend_id) {
        try {
          const { data: histRow } = await supabase
            .from('trend_history')
            .select('serpapi_share')
            .eq('trend_id', d.trend_id)
            .lte('timestamp', d.launched_at)
            .order('timestamp', { ascending: false })
            .limit(1)
            .maybeSingle();
          serpShare = Number(histRow?.serpapi_share ?? 0);
        } catch { /* skip */ }
      }
      serpapiShares.push(serpShare);
    }

    const correlations: Record<string, number> = {
      gapScore: pearson(gapScores, outcomes),
      intentScore: pearson(intentScores, outcomes),
      confidenceScore: pearson(confidenceScores, outcomes),
      trendState: pearson(trendStateNums, outcomes),
      serpapiShare: pearson(serpapiShares, outcomes),
    };

    // Tally outcomes
    const hitCount = outcomes.filter(v => v === 1).length;
    const missCount = outcomes.filter(v => v === 0).length;

    const geminiRecommendation = await getGeminiRecommendation(correlations, decisions.length);

    return res.status(200).json({
      sampleSize: decisions.length,
      hitCount,
      missCount,
      hitRate: Math.round((hitCount / decisions.length) * 100),
      correlations,
      geminiRecommendation,
      note: 'This is a report only. No weights are modified automatically.',
    });
  } catch (error) {
    console.error('calibrate error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}
