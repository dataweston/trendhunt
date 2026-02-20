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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// --- Generic terms that are NOT trends — permanent food categories ---
const GENERIC_BLOCKLIST = new Set([
  // Broad Yelp categories that always appear
  'noodles', 'burgers', 'pizza', 'sandwiches', 'salads', 'sushi', 'tacos',
  'wings', 'seafood', 'steakhouses', 'delis', 'bakeries', 'cafes', 'diners',
  'buffets', 'barbeque', 'barbecue', 'breweries', 'bars', 'pubs',
  'pan asian', 'asian fusion', 'chinese', 'japanese', 'thai', 'indian',
  'mexican', 'italian', 'greek', 'mediterranean', 'french', 'korean',
  'vietnamese', 'middle eastern', 'american', 'southern', 'cajun',
  // Generic food words
  'food', 'restaurants', 'dining', 'takeout', 'delivery', 'catering',
  'fast food', 'fine dining', 'casual dining', 'breakfast', 'brunch',
  'lunch', 'dinner', 'desserts', 'appetizers', 'drinks', 'beverages',
  'coffee', 'tea', 'smoothies', 'juice', 'beer', 'wine', 'cocktails',
  'ice cream', 'frozen yogurt', 'donuts', 'pastries', 'bread',
  // Too vague
  'comfort food', 'street food', 'soul food', 'home cooking', 'healthy',
  'organic', 'vegan', 'vegetarian', 'gluten free', 'gluten-free',
  'food trucks', 'food delivery services', 'food stands',
  'chicken', 'steak', 'pasta', 'soup', 'salad', 'rice', 'wraps',
  'hot dogs', 'fries', 'chips', 'nachos', 'quesadillas',
]);

function isGenericTerm(term: string): boolean {
  const normalized = term.toLowerCase().trim();
  if (GENERIC_BLOCKLIST.has(normalized)) return true;
  // Also block single-word cuisine types and very short terms
  if (normalized.split(/\s+/).length === 1 && normalized.length < 8) return true;
  return false;
}

async function queueTerm(term: string, source: string, score: number) {
  if (!supabase || !term || term.length < 3 || term.length > 80) return;
  const normalized = term.trim().replace(/\s+/g, ' ');
  if (normalized.length < 3) return;
  // Block generic food categories — these are not trends
  if (isGenericTerm(normalized)) return;
  // Skip if already tracked
  const { data: existing } = await supabase.from('trends').select('id').ilike('term', normalized).maybeSingle();
  if (existing) return;
  // Skip if already queued
  const { data: queued } = await supabase.from('discovery_queue').select('id').ilike('term', normalized).maybeSingle();
  if (queued) return;
  await supabase.from('discovery_queue').insert({ term: normalized, source, initial_score: Math.round(score), status: 'pending' });
}

// --- Yelp via SerpAPI: popular + trending businesses in location ---
async function discoverYelp(location: string): Promise<{ terms: string[]; businessNames: string[] }> {
  const terms: string[] = [];
  const businessNames: string[] = [];
  const genericCategories = new Set(['Restaurants', 'Food', 'Food Delivery Services', 'Food Trucks', 'American (New)', 'American (Traditional)', 'Bars',
    'Noodles', 'Burgers', 'Pizza', 'Sandwiches', 'Salads', 'Seafood', 'Steakhouses', 'Delis', 'Bakeries',
    'Cafes', 'Diners', 'Buffets', 'Barbeque', 'Breweries', 'Pubs', 'Pan Asian', 'Asian Fusion',
    'Chinese', 'Japanese', 'Thai', 'Indian', 'Mexican', 'Italian', 'Greek', 'Mediterranean',
    'French', 'Korean', 'Vietnamese', 'Middle Eastern', 'Southern', 'Breakfast & Brunch',
    'Coffee & Tea', 'Ice Cream & Frozen Yogurt', 'Chicken Wings', 'Hot Dogs', 'Soup',
    'Fast Food', 'Comfort Food', 'Soul Food', 'Vegetarian', 'Vegan',
  ]);

  // SerpAPI yelp engine searches — uses your SERPAPI_KEY, no Yelp API key needed
  const searches = [
    { engine: 'yelp', find_desc: 'restaurants', find_loc: location, sortby: 'recommended' },
    { engine: 'yelp', find_desc: 'trending food', find_loc: location, sortby: 'recommended' },
    { engine: 'yelp', find_desc: 'new restaurants', find_loc: location, sortby: 'recommended' },
  ];

  for (const params of searches) {
    try {
      const result = await serpSearch(params as any);
      if (!result.data) continue;
      const results = result.data.organic_results || [];
      for (const b of results) {
        // Extract category names
        if (b.categories) {
          for (const cat of b.categories) {
            const title = cat.title || cat;
            if (typeof title === 'string' && title.length > 2 && !genericCategories.has(title)) {
              terms.push(title);
            }
          }
        }
        // Collect business names for NLP extraction
        if (b.title) businessNames.push(b.title);
        // Also extract from snippet/highlights
        if (b.snippet) {
          const foodMentions = b.snippet.match(/(?:known for|famous for|specializing in|try the|best)\s+([^.!,]{3,40})/gi);
          if (foodMentions) {
            for (const m of foodMentions) {
              const clean = m.replace(/^(known for|famous for|specializing in|try the|best)\s+/i, '').trim();
              if (clean.length >= 3) businessNames.push(clean);
            }
          }
        }
      }
    } catch (e) {
      console.error('SerpAPI Yelp discovery error:', e);
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
  const subs = ['Minneapolis', 'TwinCities', 'minnesota', 'MSPFood', 'MinneapolisFood'];
  const keywords = ['food', 'eat', 'restaurant', 'drink', 'coffee', 'pizza', 'taco', 'burger', 'sushi', 'bakery',
    'tried', 'best', 'opening', 'new', 'menu', 'brunch', 'dinner', 'lunch', 'dessert', 'ramen', 'thai', 'korean',
    'bbq', 'brewery', 'bar', 'café', 'cafe', 'diner', 'pho', 'boba', 'chicken', 'vegan', 'wings', 'steak',
    'tasting', 'popup', 'pop-up', 'food truck', 'ice cream', 'donut', 'bagel', 'sandwich', 'bowl', 'curry',
    'happy hour', 'smash burger', 'birria', 'elote', 'ube', 'mochi', 'matcha'];
  const titles: string[] = [];

  // Fetch hot + search for food in local subs
  const fetches: { url: string; sub: string }[] = [];
  for (const sub of subs) {
    fetches.push({ url: `https://www.reddit.com/r/${sub}/hot.json?limit=50`, sub });
    fetches.push({ url: `https://www.reddit.com/r/${sub}/search.json?q=food+OR+restaurant+OR+new+opening&restrict_sr=on&sort=new&limit=25`, sub });
  }
  // Also hit broader food subs with Minneapolis filter
  fetches.push({ url: `https://www.reddit.com/r/foodie/search.json?q=minneapolis+OR+twin+cities&sort=new&limit=15`, sub: 'foodie' });

  for (const { url, sub } of fetches) {
    try {
      const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'TrendHunter/1.0' },
        timeout: 5000,
      });
      for (const post of (data?.data?.children || [])) {
        const title = post.data?.title || '';
        const selftext = (post.data?.selftext || '').slice(0, 200);
        const combined = `${title} ${selftext}`.toLowerCase();
        if (keywords.some(k => combined.includes(k))) {
          titles.push(title);
        }
      }
    } catch (e) {
      console.error('Reddit discovery error for r/' + sub, e);
    }
  }
  return [...new Set(titles)];
}

// --- Gemini NLP: extract food terms from raw titles + business names ---
async function extractFoodTerms(rawTitles: string[], businessNames: string[]): Promise<string[]> {
  const combined = [
    ...rawTitles.map((t) => `Reddit: ${t}`),
    ...businessNames.slice(0, 20).map((n) => `Restaurant: ${n}`),
  ];

  // If Gemini is available, use it for smart extraction
  if (ai && combined.length > 0) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `You are a food trend analyst for the Minneapolis–St Paul metro area. Your job is to identify EMERGING food trends — specific dishes, preparations, or food concepts that are NEW, GROWING, or BREAKING OUT.

Critical rules:
- REJECT generic categories that have always existed ("burgers", "pizza", "sushi", "noodles", "thai food", etc.)
- ONLY return specific, distinctive food items or preparations (e.g., "Nashville Hot Chicken", "Mochi Donuts", "Birria Ramen", "Ube Crinkle Cookies", "Filipino Lumpia")
- A good trend term is something a food blogger would write about as NEW or NOTEWORTHY
- Multi-word terms are almost always better than single words
- Return FEWER high-quality terms rather than many generic ones

Sources:
${combined.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return a JSON array of objects with "term" (the clean food concept name) and "confidence" (0-100, how likely this is a real emerging trend, NOT just a common food).`,
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
      if (response.text) {
        const parsed = JSON.parse(response.text) as { term: string; confidence: number }[];
        const geminiTerms = parsed
          .filter(p => p.term && p.term.length >= 3 && p.term.length <= 60 && p.confidence >= 50 && !isGenericTerm(p.term))
          .map(p => p.term);
        if (geminiTerms.length > 0) return geminiTerms;
      }
    } catch (e) {
      console.error('Gemini extraction failed, using keyword fallback:', e);
    }
  }

  // Keyword-based fallback — extract food concepts from Reddit titles directly
  return extractFoodTermsKeyword(rawTitles, businessNames);
}

// --- Keyword fallback: simple pattern-based extraction ---
function extractFoodTermsKeyword(titles: string[], businessNames: string[]): string[] {
  const foodPatterns = [
    // Cuisine types
    /\b(korean|thai|vietnamese|japanese|mexican|indian|ethiopian|italian|chinese|mediterranean|greek|filipino|somali|hmong|cajun|creole|southern|hawaiian|peruvian)\s*(bbq|barbecue|food|cuisine|street food|fusion)?\b/gi,
    // Specific food items/dishes
    /\b(ramen|pho|boba|bubble tea|sushi|birria|elote|ube|mochi|matcha|acai|poke|banh mi|dim sum|dumplings|gyoza|pad thai|tikka masala|shawarma|falafel|kimchi|bulgogi|bibimbap|tonkotsu|takoyaki|okonomiyaki|empanada|arepa|pupusa)\b/gi,
    // Food categories
    /\b(smash burger|nashville hot chicken|detroit style pizza|neapolitan pizza|sourdough|croissant|charcuterie|wagyu|tartare|ceviche|al pastor|carnitas|chicharron|pozole|tamale|hot pot|korean fried chicken|chicken sandwich|breakfast burrito|breakfast sandwich)\b/gi,
    // Trend-y food terms
    /\b(food truck|pop-?up|tasting menu|omakase|prix fixe|farm.to.table|craft cocktail|natural wine|kombucha|cold brew|oat milk|plant.based|vegan|gluten.free)\b/gi,
    // Desserts
    /\b(donut|doughnut|ice cream|gelato|macaron|churro|crème brûlée|tiramisu|baklava|mochi donut|ube cake|matcha latte|affogato|croffle|croffin)\b/gi,
  ];

  const extracted = new Set<string>();
  const allText = [...titles, ...businessNames];

  for (const text of allText) {
    for (const pattern of foodPatterns) {
      const matches = text.matchAll(new RegExp(pattern.source, 'gi'));
      for (const match of matches) {
        const term = match[0].trim();
        if (term.length >= 3) {
          // Title-case the term
          extracted.add(term.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' '));
        }
      }
    }
  }

  return [...extracted].slice(0, 20);
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

    // Queue with cross-source scoring: terms found in multiple sources score higher
    // Track how many sources mentioned each term
    const termSources = new Map<string, { sources: Set<string>; bestScore: number }>();
    
    const trackTerm = (term: string, source: string, score: number) => {
      if (isGenericTerm(term)) return;
      const key = term.toLowerCase().trim();
      const existing = termSources.get(key) || { sources: new Set(), bestScore: 0 };
      existing.sources.add(source);
      existing.bestScore = Math.max(existing.bestScore, score);
      termSources.set(key, existing);
    };

    // Yelp categories are only interesting if they're specific/niche — most will be blocked
    for (const cat of yelpResult.terms) {
      trackTerm(cat, 'yelp', 30);
    }
    for (const rq of risingQueries) {
      trackTerm(rq.term, 'rising', rq.score);
    }
    for (const term of extractedTerms) {
      trackTerm(term, 'nlp', 40);
    }

    // Score: base score + bonus for multi-source corroboration
    let queued = 0;
    for (const [term, info] of termSources) {
      const sourceCount = info.sources.size;
      // Multi-source bonus: 2 sources = +20, 3+ = +40
      const multiSourceBonus = sourceCount >= 3 ? 40 : sourceCount >= 2 ? 20 : 0;
      const finalScore = Math.min(100, info.bestScore + multiSourceBonus);
      const sourceLabel = [...info.sources].join('+');
      // Prefer multi-source terms; single-source terms need high base score (>= 60)
      if (sourceCount >= 2 || info.bestScore >= 60) {
        // Use original casing from extracted terms if available
        const displayTerm = extractedTerms.find(t => t.toLowerCase() === term) 
          || risingQueries.find(rq => rq.term.toLowerCase() === term)?.term 
          || yelpResult.terms.find(t => t.toLowerCase() === term) 
          || term;
        await queueTerm(displayTerm, `${sourceLabel} (${sourceLabel.includes('zip') ? `Zip ${zip}` : 'Cron'})`, finalScore);
        queued++;
      }
    }

    res.status(200).json({
      ok: true,
      location,
      processed: queued,
      sources: {
        yelp_categories: yelpResult.terms.length,
        yelp_businesses: yelpResult.businessNames.length,
        rising: risingQueries.length,
        reddit_titles: redditTitles.length,
        nlp_extracted: extractedTerms.length,
      },
      debug: {
        gemini_available: !!ai,
        yelp_via_serpapi: true,
        extracted_terms: extractedTerms.slice(0, 10),
        sample_reddit: redditTitles.slice(0, 3),
      },
    });
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: 'Discovery failed', detail: String(error) });
  }
}
