/**
 * Gemini Trend Analysis Proxy — replaces direct browser-to-Gemini calls.
 * POST /api/analyze-trend { trend: TrendEntity }
 * Returns { summary, recommendation, riskAssessment }
 *
 * Keeps the API key server-side only. Auth: open (no admin token required —
 * this is a read-only analysis call with no side effects).
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type } from '@google/genai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const FALLBACK = {
  summary: 'AI analysis unavailable. Signal propagation indicates a strong correlation between social discovery and search intent.',
  recommendation: 'Monitor local supply competitors closely.',
  riskAssessment: 'Moderate volatility detected.',
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!ai) return res.status(200).json(FALLBACK);

  const { trend } = req.body || {};
  if (!trend || !trend.term) return res.status(400).json({ error: 'trend required' });

  try {
    const signalSummary = (trend.signals || [])
      .map((s: any) => `${s.platform}: Intensity ${s.currentIntensity}, Velocity ${s.velocity}`)
      .join('; ');

    const trendContext = trend.trendState && trend.trendState !== 'INSUFFICIENT_DATA'
      ? `\nTrend phase: ${trend.trendState}${trend.leadLagWeeks ? ` (social leads search by ${trend.leadLagWeeks}w)` : ''}`
      : '';

    const funnelContext = trend.funnelData
      ? `\nWebsite funnel: ${trend.funnelData.searchImpressions} site searches, ${trend.funnelData.pageViews} page views, ${(trend.funnelData.conversionRate * 100).toFixed(1)}% CVR, drop-off: ${trend.funnelData.dropoffStage}`
      : '';

    const prompt = `You are the AI engine for TrendHunt, a food analytics platform serving Local Effort — a Minneapolis private chef and meal prep company ($65-85/person dinners, $12-25/item meal prep).

Analyze this emerging food trend:

Food: ${trend.term}
Category: ${trend.category}
Region: ${trend.region} (${trend.neighborhood})${trendContext}${funnelContext}

Signal data:
${signalSummary}

Scores:
Supply density: ${trend.supplyScore ?? trend.availabilityScore}/100
Demand intensity: ${trend.demandScore ?? trend.intentScore}/100
Unmet demand: ${trend.unmetDemandScore ?? trend.gapScore}/100

Task:
1. In 2-3 sentences, explain why this trend is gaining momentum NOW and what is driving it.
2. Recommend one specific action for Local Effort (e.g. "Add as a 4-week limited meal prep series starting in March").
3. Assess the risk: is this a durable trend or a fad? What would cause it to fade?`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            recommendation: { type: Type.STRING },
            riskAssessment: { type: Type.STRING },
          },
        },
      },
    });

    if (response.text) {
      return res.status(200).json(JSON.parse(response.text));
    }
    return res.status(200).json(FALLBACK);
  } catch (e) {
    console.error('analyze-trend error:', e);
    return res.status(200).json(FALLBACK);
  }
}
