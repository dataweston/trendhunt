/**
 * Discovery Cron Endpoint
 * Runs on a schedule (every 12h via Vercel cron) to find new trend terms.
 * Sources: Yelp Hot & New, SerpAPI rising queries, Reddit local subs.
 * Uses Gemini to extract clean food terms from raw titles.
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const YELP_API_KEY = process.env.YELP_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const GEMINI_API_KEY = process.env.API_KEY;
const REGION = 'Minneapolis';

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

async function queueTerm(term: string, source: string, score: number) {
  if (!supabase || !term || term.length < 3 || term.length > 80) return;
  // Skip if already tracked
  const { data: existing } = await supabase.from('trends').select('id').eq('term', term).maybeSingle();
  if (existing) return;
  // Skip if already queued
  const { data: queued } = await supabase.from('discovery_queue').select('id').eq('term', term).maybeSingle();
  if (queued) return;
  await supabase.from('discovery_queue').insert({ term, source, initial_score: score, status: 'pending' });
}

// --- Yelp Hot & New ---
async function discoverYelp() {
  if (!YELP_API_KEY) return [];
  try {
    const { data } = await axios.get('https://api.yelp.com/v3/businesses/search', {
      headers: { Authorization: `Bearer ${YELP_API_KEY}` },
      params: { location: REGION, attributes: 'hot_and_new', limit: 20, categories: 'food,restaurants' },
    });
    const terms: string[] = [];
    for (const b of (data.businesses || [])) {
      for (const cat of (b.categories || [])) {
        terms.push(cat.title);
      }
    }
    return [...new Set(terms)];
  } catch { return []; }
}

// --- SerpAPI Rising Queries ---
async function discoverRisingQueries(seedTerms: string[]) {
  if (!SERPAPI_KEY) return [];
  const results: { term: string; score: number }[] = [];
  for (const seed of seedTerms.slice(0, 3)) {
    try {
      const { data } = await axios.get('https://serpapi.com/search.json', {
        params: { engine: 'google_trends', q: seed, data_type: 'RELATED_QUERIES', api_key: SERPAPI_KEY },
      });
      const rising = data?.related_queries?.rising || [];
      for (const q of rising) {
        if (q.query && !q.query.toLowerCase().includes(seed.toLowerCase())) {
          results.push({ term: q.query, score: q.value || 50 });
        }
      }
    } catch { /* skip */ }
  }
  return results;
}

// --- Reddit Local Subs ---
async function discoverReddit(): Promise<string[]> {
  const subs = ['Minneapolis', 'TwinCities'];
  const keywords = ['food', 'eat', 'restaurant', 'drink', 'coffee', 'pizza', 'taco', 'burger', 'sushi', 'bakery', 'tried', 'best', 'opening', 'new'];
  const titles: string[] = [];
  for (const sub of subs) {
    try {
      const { data } = await axios.get(`https://www.reddit.com/r/${sub}/hot.json?limit=15`);
      for (const post of (data.data.children || [])) {
        const title = post.data.title;
        if (keywords.some(k => title.toLowerCase().includes(k))) {
          titles.push(title);
        }
      }
    } catch { /* skip */ }
  }
  return titles;
}

// --- Gemini NLP: extract food terms from raw titles ---
async function extractFoodTerms(rawTitles: string[]): Promise<string[]> {
  if (!ai || rawTitles.length === 0) return rawTitles.slice(0, 10);
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `You are a food trend analyst. From each Reddit post title below, extract the specific food item, dish name, or cuisine concept being discussed. Return null for titles that aren't about a specific food trend.

Titles:
${rawTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return a JSON array of objects with "index" and "term" (or null).`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              index: { type: Type.NUMBER },
              term: { type: Type.STRING, nullable: true },
            },
          },
        },
      },
    });
    if (!response.text) return [];
    const parsed = JSON.parse(response.text) as { index: number; term: string | null }[];
    return parsed.filter(p => p.term && p.term.length >= 3 && p.term.length <= 60).map(p => p.term!);
  } catch (e) {
    console.error('Gemini extraction failed:', e);
    return [];
  }
}

// --- Handler ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret or allow manual trigger
  const cronSecret = req.headers['authorization'];
  const isVercelCron = cronSecret === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = req.query.manual === 'true';
  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    // Get current tracked terms for seed queries
    const { data: tracked } = await supabase.from('trends').select('term');
    const seedTerms = (tracked || []).map(t => t.term);

    // Run all discovery sources in parallel
    const [yelpCategories, risingQueries, redditTitles] = await Promise.all([
      discoverYelp(),
      discoverRisingQueries(seedTerms),
      discoverReddit(),
    ]);

    // NLP extract food terms from Reddit titles
    const extractedTerms = await extractFoodTerms(redditTitles);

    // Queue everything
    let queued = 0;
    for (const cat of yelpCategories) {
      await queueTerm(cat, 'Yelp Hot & New', 50);
      queued++;
    }
    for (const rq of risingQueries) {
      await queueTerm(rq.term, 'SerpAPI Rising Query', rq.score);
      queued++;
    }
    for (const term of extractedTerms) {
      await queueTerm(term, 'Reddit Local (NLP extracted)', 30);
      queued++;
    }

    res.status(200).json({ ok: true, processed: queued, sources: { yelp: yelpCategories.length, rising: risingQueries.length, reddit: extractedTerms.length } });
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: 'Discovery failed' });
  }
}
