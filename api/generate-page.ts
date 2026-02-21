/**
 * Product Page Draft Generator
 * POST /api/generate-page { trendId }
 * Uses Gemini to generate a product page draft, saves to Supabase.
 * Optionally pushes to Sanity CMS if configured.
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import { requireAdminAuth } from '../lib/api-auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
const SANITY_PROJECT_ID = process.env.SANITY_PROJECT_ID;
const SANITY_TOKEN = process.env.SANITY_TOKEN;
const SANITY_DATASET = process.env.SANITY_DATASET || 'production';

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireAdminAuth(req, res)) return;

  if (!supabase || !ai) return res.status(500).json({ error: 'Missing config' });

  const { trendId } = req.body || {};
  if (!trendId) return res.status(400).json({ error: 'trendId required' });

  try {
    // Get trend data
    const { data: trend } = await supabase.from('trends').select('*').eq('id', trendId).single();
    if (!trend) return res.status(404).json({ error: 'Trend not found' });

    // Get latest scores
    const { data: latest } = await supabase
      .from('trend_history')
      .select('demand_score, supply_score, unmet_demand_score, breakout_probability')
      .eq('trend_id', trendId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    const scores = latest || { demand_score: 0, supply_score: 0, unmet_demand_score: 0, breakout_probability: 0 };

    // Get raw signals for richer context
    const { data: history } = await supabase
      .from('trend_history')
      .select('raw_signals')
      .eq('trend_id', trendId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    const signals = (history?.raw_signals || []) as { platform: string; currentIntensity: number; velocity: number }[];
    const signalSummary = signals
      .filter(s => s.currentIntensity > 0)
      .map(s => `${s.platform}: intensity ${s.currentIntensity}/100, velocity ${s.velocity > 0 ? '+' : ''}${s.velocity}`)
      .join('; ');

    // Generate with Gemini
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `You are a copywriter for Local Effort, a Minneapolis-based food company that does private chef dinners, weekly meal prep, and local food products. Generate a product page for a new offering based on this trending food concept:

Term: ${trend.term}
Category: ${trend.category}
Neighborhood demand: ${trend.neighborhood}
Demand score: ${scores.demand_score}/100 (how much people want this)
Supply gap: ${scores.unmet_demand_score}/100 (how underserved the market is)
Breakout probability: ${scores.breakout_probability}/100

Live signal data: ${signalSummary || 'No live signals available'}

The page should feel artisanal, local, and seasonal. Local Effort sources 100% locally in Minnesota. The tone is warm but confident — like a chef who knows their craft.

If the demand score and signals show this is trending strongly, lean into urgency and excitement. If the supply gap is high, emphasize that Local Effort is among the first to offer this locally.

Generate:
1. A page title (short, compelling)
2. A subtitle/tagline
3. A product description (2-3 paragraphs, focusing on sourcing, craft, and the dining experience)
4. SEO meta title (under 60 chars)
5. SEO meta description (under 155 chars)
6. 5 SEO keywords
7. A suggested price point in dollars (based on Local Effort's range: $65-85/person for dinners, $12-25 for individual items)`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            subtitle: { type: Type.STRING },
            description: { type: Type.STRING },
            seoTitle: { type: Type.STRING },
            seoDescription: { type: Type.STRING },
            seoKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
            suggestedPrice: { type: Type.NUMBER },
          },
        },
      },
    });

    if (!response.text) return res.status(500).json({ error: 'Gemini returned empty' });

    const generated = JSON.parse(response.text);

    // Save draft to Supabase page_drafts table
    const draft = {
      trend_id: trendId,
      trend_term: trend.term,
      title: generated.title,
      subtitle: generated.subtitle,
      description: generated.description,
      seo_title: generated.seoTitle,
      seo_description: generated.seoDescription,
      seo_keywords: generated.seoKeywords,
      suggested_price: generated.suggestedPrice,
      status: 'draft',
      created_at: new Date().toISOString(),
    };

    // Save in page_drafts
    const { data: saved, error: saveError } = await supabase
      .from('page_drafts')
      .insert(draft)
      .select()
      .single();

    if (saveError) {
      console.error('Failed to save page draft:', saveError.message);
      return res.status(500).json({ error: `Failed to save draft: ${saveError.message}` });
    }

    // Module 7: Update launch_decision with the page slug
    const pageSlug = `/menu/${trend.term.toLowerCase().replace(/\s+/g, '-')}`;
    try {
      await supabase
        .from('launch_decisions')
        .update({ page_url: pageSlug })
        .eq('term', trend.term)
        .eq('outcome', 'pending');
    } catch (e) {
      console.error('launch_decisions page_url update (non-fatal):', e);
    }

    // Optionally push to Sanity CMS
    if (SANITY_PROJECT_ID && SANITY_TOKEN) {
      try {
        const sanityDoc = {
          _type: 'productPage',
          title: generated.title,
          slug: { _type: 'slug', current: trend.term.toLowerCase().replace(/\s+/g, '-') },
          subtitle: generated.subtitle,
          description: generated.description,
          seoTitle: generated.seoTitle,
          seoDescription: generated.seoDescription,
          status: 'draft',
          trendSource: trend.term,
          suggestedPrice: generated.suggestedPrice,
        };

        await fetch(`https://${SANITY_PROJECT_ID}.api.sanity.io/v2024-01-01/data/mutate/${SANITY_DATASET}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SANITY_TOKEN}`,
          },
          body: JSON.stringify({
            mutations: [{ createOrReplace: { ...sanityDoc, _id: `trend-page-${trendId}` } }],
          }),
        });
      } catch (e) {
        console.error('Sanity push failed (non-fatal):', e);
      }
    }

    return res.status(200).json({ ok: true, draft: saved || draft });
  } catch (error) {
    console.error('Generate page error:', error);
    return res.status(500).json({ error: 'Failed to generate page' });
  }
}
