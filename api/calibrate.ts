/**
 * Weight Calibration Report — Module 8
 *
 * GET /api/calibrate
 *
 * Queries launch_decisions with resolved outcomes (hit/miss), correlates
 * signal scores at launch time with outcomes, and calls Gemini to produce
 * plain-English weight recommendations.
 *
 * IMPORTANT: This endpoint is READ-ONLY. It never modifies WEIGHTS in
 * trends.ts. It produces a report for human review only.
 *
 * Requires: admin auth header, Supabase, GEMINI_API_KEY (optional — skips
 * LLM analysis if absent but still returns correlation data).
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { requireAdminAuth } from '../lib/api-auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ── Pearson correlation ─────────────────────────────────────────────────────

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : Math.round((num / denom) * 1000) / 1000;
}

// ── Gemini call ─────────────────────────────────────────────────────────────

async function callGemini(correlationTable: string): Promise<string> {
  if (!GEMINI_API_KEY) return 'Gemini API key not configured — manual review required.';
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a data analyst reviewing signal weight calibration for a food trend prediction system.

The system scores food trends using multiple signals (gapScore, intentScore, confidenceScore, etc.) and a composite breakoutProbability. A "hit" is a launched term that achieved >50 page views and at least 1 conversion in 90 days. A "miss" is a launched term that did not.

Here is the Pearson correlation of each score at launch time with actual outcomes (hit=1, miss=0):

${correlationTable}

Based on these correlations:
1. Which scores are the strongest predictors of success? Which are weakest or inverse?
2. What specific weight adjustments would you recommend (be concrete, e.g. "increase gapScore weight by 20%")?
3. Are there any signals that appear to be anti-predictive (negative correlation) that should be discounted?
4. What caveats apply given the sample size?

Keep your response to 150 words or fewer. Be direct and actionable.`,
            }],
          }],
          generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
        }),
      },
    );
    const json = await res.json() as any;
    return json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No recommendation generated.';
  } catch (e) {
    return `Gemini call failed: ${(e as Error).message}`;
  }
}

// ── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (!requireAdminAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Fetch resolved launch decisions
  const { data: decisions, error } = await supabase
    .from('launch_decisions')
    .select('*')
    .neq('outcome', 'pending')
    .order('launched_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  if (!decisions || decisions.length < 3) {
    return res.status(200).json({
      message: 'Not enough resolved outcomes yet (minimum 3 required).',
      resolved: decisions?.length ?? 0,
      correlations: {},
      recommendation: 'Insufficient data.',
    });
  }

  // 2. For each decision, join with trend_history to get scores at launch time.
  //    We look for the trend_history row closest in time to launched_at.
  const enriched: {
    term: string;
    outcome: number;
    gapScore: number;
    intentScore: number;
    confidenceScore: number;
    breakoutProbability: number;
    supplyScore: number;
  }[] = [];

  for (const d of decisions) {
    const outcome = d.outcome === 'hit' ? 1 : 0;

    // Use scores stored at launch time if available (gap_score_at_launch etc.)
    // These columns were added in migration 006.
    const gap = Number(d.gap_score_at_launch ?? 0);
    const intent = Number(d.intent_score_at_launch ?? 0);
    const confidence = Number(d.confidence_score_at_launch ?? 0);

    // Fallback: query trend_history for the trend_id closest to launched_at
    let breakout = 0;
    let supply = 0;
    if (d.trend_id) {
      const { data: hist } = await supabase
        .from('trend_history')
        .select('raw_signals, timestamp')
        .eq('trend_id', d.trend_id)
        .lte('timestamp', d.launched_at)
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (hist?.raw_signals) {
        const rs = hist.raw_signals as Record<string, any>;
        breakout = Number(rs.breakoutProbability ?? rs.breakout_probability ?? 0);
        supply = Number(rs.supplyScore ?? rs.supply_score ?? 0);
      }
    }

    enriched.push({ term: d.term, outcome, gapScore: gap, intentScore: intent, confidenceScore: confidence, breakoutProbability: breakout, supplyScore: supply });
  }

  // 3. Compute Pearson correlations
  const outcomes = enriched.map(e => e.outcome);
  const scoreKeys = ['gapScore', 'intentScore', 'confidenceScore', 'breakoutProbability', 'supplyScore'] as const;
  const correlations: Record<string, number> = {};
  for (const key of scoreKeys) {
    correlations[key] = pearson(enriched.map(e => e[key]), outcomes);
  }

  // 4. Build correlation table for Gemini
  const tableLines = Object.entries(correlations)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .map(([k, v]) => `  ${k}: r=${v} (n=${enriched.length})`);
  const correlationTable = tableLines.join('\n');

  // 5. Call Gemini for recommendation
  const recommendation = await callGemini(correlationTable);

  return res.status(200).json({
    resolved: enriched.length,
    hitRate: Math.round(enriched.filter(e => e.outcome === 1).length / enriched.length * 100),
    correlations,
    recommendation,
    terms: enriched.map(e => ({ term: e.term, outcome: e.outcome === 1 ? 'hit' : 'miss' })),
    note: 'This report is read-only. Adjust WEIGHTS in api/trends.ts manually after review.',
  });
}
