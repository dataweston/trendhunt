/**
 * Discovery Endpoint
 * Finds new food trend terms in a geographic area.
 * 
 * Trigger methods:
 *   - Vercel cron (daily at 6am) — uses default region
 *   - Manual: GET /api/discover?manual=true&zip=55113
 * 
 * Sources: Yelp businesses + categories, SerpAPI rising queries, Reddit local subs.
 * Uses Gemini to extract clean food terms from raw titles.
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import { serpSearch } from '../lib/serp-governor.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const YELP_API_KEY = process.env.YELP_API_KEY;
const GEMINI_API_KEY = process.env.API_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

async function queueTerm(term: string, source: string, score: number) {
  if (!supabase || !term || term.length < 3 || term.length > 80) return;
  const normalized = term.trim().replace(/\s+/g, ' ');
  if (normalized.length < 3) return;
  // Skip if already tracked
  const { data: existing } = await supabase.from('trends').select('id').ilike('term', normalized).maybeSingle();
  if (existing) return;
  // Skip if already queued
  const { data: queued } = await supabase.from('discovery_queue').select('id').ilike('term', normalized).maybeSingle();
  if (queued) return;
  await supabase.from('discovery_queue').insert({ term: normalized, source, initial_score: Math.round(score), status: 'pending' });
}

// --- Yelp: popular + hot_and_new businesses in location ---
async function discoverYelp(location: string): Promise<{ terms: string[]; businessNames: string[] }> {
  if (!YELP_API_KEY) return { terms: [], businessNames: [] };
  const terms: string[] = [];
  const businessNames: string[] = [];
  
  // Search both hot_and_new and general popular food
  const searches = [
    { location, categories: 'food,restaurants', attributes: 'hot_and_new', limit: 20, sort_by: 'rating' },
    { location, categories: 'food,restaurants', limit: 50, sort_by: 'best_match' },
    { location, term: 'trending food', limit: 20, sort_by: 'best_match' },
  ];

  for (const params of searches) {
    try {
      const { data } = await axios.get('https://api.yelp.com/v3/businesses/search', {
        headers: { Authorization: `Bearer ${YELP_API_KEY}` },
        params,
      });
      for (const b of (data.businesses || [])) {
        // Extract category titles as potential food terms
        for (const cat of (b.categories || [])) {
          if (cat.title && !['Restaurants', 'Food', 'Food Delivery Services', 'Food Trucks'].includes(cat.title)) {
            terms.push(cat.title);
          }
        }
        // Also collect business names — Gemini can extract food concepts from them
        if (b.name) businessNames.push(b.name);
      }
    } catch (e) {
      console.error('Yelp discovery error:', e);
    }
  }

  return { terms: [...new Set(terms)], businessNames: [...new Set(businessNames)] };
}

// --- SerpAPI Rising Queries ---
async function discoverRisingQueries(seedTerms: string[]) {
  const results: { term: string; score: number }[] = [];
  // Use seed terms + generic food seeds
  const seeds = seedTerms.length > 0 ? seedTerms.slice(0, 2) : ['food near me', 'best restaurants'];
  for (const seed of seeds) {
    try {
      const result = await serpSearch({ engine: 'google_trends', q: seed, data_type: 'RELATED_QUERIES' });
      if (!result.data) continue;
      const rising = result.data?.related_queries?.rising || [];
      for (const q of rising) {
        if (q.query) {
          results.push({ term: q.query, score: q.value || 50 });
        }
      }
    } catch { /* skip */ }
  }
  return results;
}

// --- Reddit Local Subs ---
async function discoverReddit(): Promise<string[]> {
  const subs = ['Minneapolis', 'TwinCities', 'minnesota'];
  const keywords = ['food', 'eat', 'restaurant', 'drink', 'coffee', 'pizza', 'taco', 'burger', 'sushi', 'bakery',
    'tried', 'best', 'opening', 'new', 'menu', 'brunch', 'dinner', 'lunch', 'dessert', 'ramen', 'thai', 'korean'];
  const titles: string[] = [];
  for (const sub of subs) {
    try {
      const { data } = await axios.get(`https://www.reddit.com/r/${sub}/hot.json?limit=25`, {
        headers: { 'User-Agent': 'TrendHunter/1.0' },
      });
      for (const post of (data.data.children || [])) {
        const title = post.data.title;
        if (keywords.some(k => title.toLowerCase().includes(k))) {
          titles.push(title);
        }
      }
    } catch (e) {
      console.error('Reddit discovery error for r/' + sub, e);
    }
  }
  return titles;
}

// --- Gemini NLP: extract food terms from raw titles + business names ---
async function extractFoodTerms(rawTitles: string[], businessNames: string[]): Promise<string[]> {
  if (!ai) {
    // Fallback: return business names as-is (limited)
    return businessNames.slice(0, 5);
  }
  
  const combined = [
    ...rawTitles.map((t, i) => `Reddit: ${t}`),
    ...businessNames.slice(0, 20).map((n, i) => `Restaurant: ${n}`),
  ];
  
  if (combined.length === 0) return [];

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `You are a food trend analyst for the Minneapolis–St Paul metro area. From the sources below (Reddit post titles and restaurant business names), extract specific food items, dish names, cuisine types, or food concepts that represent current or emerging food trends.

Do NOT return generic terms like "Food", "Restaurants", "American". Focus on specific dishes, food types, or cuisine concepts (e.g., "Nashville Hot Chicken", "Mochi Donuts", "Korean BBQ", "Ube Lattes", "Filipino Street Food").

Sources:
${combined.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return a JSON array of objects with "term" (the clean food concept name) and "confidence" (0-100, how likely this is a real food trend).`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              term: { type: Type.STRING },
              confidence: { type: Type.NUMBER },
            },
          },
        },
      },
    });
    if (!response.text) return [];
    const parsed = JSON.parse(response.text) as { term: string; confidence: number }[];
    return parsed
      .filter(p => p.term && p.term.length >= 3 && p.term.length <= 60 && p.confidence >= 30)
      .map(p => p.term);
  } catch (e) {
    console.error('Gemini extraction failed:', e);
    return businessNames.slice(0, 5);
  }
}

// --- Handler ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth: Vercel cron secret or manual trigger
  const cronSecret = req.headers['authorization'];
  const isVercelCron = cronSecret === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = req.query.manual === 'true';
  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized. Use ?manual=true or cron secret.' });
  }

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    // Determine location — use zip code if provided, else default
    const zip = typeof req.query.zip === 'string' ? req.query.zip.trim() : '';
    const location = zip.length === 5 ? zip : 'Minneapolis, MN';

    // Get current tracked terms for seed queries
    const { data: tracked } = await supabase.from('trends').select('term');
    const seedTerms = (tracked || []).map((t: any) => t.term);

    // Run all discovery sources in parallel
    const [yelpResult, risingQueries, redditTitles] = await Promise.all([
      discoverYelp(location),
      discoverRisingQueries(seedTerms),
      discoverReddit(),
    ]);

    // NLP extract food terms from Reddit titles + Yelp business names
    const extractedTerms = await extractFoodTerms(redditTitles, yelpResult.businessNames);

    // Queue everything
    let queued = 0;
    const sourceLabel = zip ? `Zip ${zip}` : 'Cron';

    for (const cat of yelpResult.terms) {
      await queueTerm(cat, `Yelp Category (${sourceLabel})`, 50);
      queued++;
    }
    for (const rq of risingQueries) {
      await queueTerm(rq.term, `SerpAPI Rising Query`, rq.score);
      queued++;
    }
    for (const term of extractedTerms) {
      await queueTerm(term, `NLP Extracted (${sourceLabel})`, 40);
      queued++;
    }

    res.status(200).json({
      ok: true,
      location,
      processed: queued,
      sources: {
        yelp: yelpResult.terms.length,
        rising: risingQueries.length,
        reddit: extractedTerms.length,
      },
    });
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: 'Discovery failed', detail: String(error) });
  }
}
