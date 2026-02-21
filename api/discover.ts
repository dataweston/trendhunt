/**
 * Discovery Endpoint
 * Finds new food trend terms in a geographic area.
 * 
 * Trigger methods:
 *   - Vercel cron (daily at 6am): uses configured default region
 *   - Manual: GET /api/discover?manual=true&zip=10001 (admin token required)
 * 
 * Sources: SerpAPI Yelp + Google Trends as primary, plus Reddit enrichment.
 * GA4 backtest priors boost ranking for historically strong terms.
 * Gemini extracts clean food terms from raw text.
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import { serpSearch } from '../lib/serp-governor.js';
import { requireAdminAuth } from '../lib/api-auth.js';
import { getLocationContext } from '../lib/location.js';
import { normalizeTermKey, tokenizeKey, similarityScore, loadCanonicalMap, resolveCanonical } from '../lib/term-normalizer.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
type BacktestTermType = 'food_concept' | 'offer_type' | 'nav_noise';

interface GA4Prior {
  term: string;
  key: string;
  compositeScore: number;
  growthRate: number;
  termType: BacktestTermType;
}

const GA4_BOOSTABLE_TERM_TYPES = new Set<BacktestTermType>(['food_concept', 'offer_type']);
const NAV_NOISE_TOKENS = [
  '(not set)', 'about', 'contact', 'privacy', 'terms', 'account', 'login', 'calendar', 'portal',
  'partner', 'partners', 'wedding', 'weddings', 'release', 'releases', 'crowdfunding', 'gallery',
  'master calendar', 'our purveyors', 'services',
];
const OFFER_HINTS = [
  'personal chef', 'private chef', 'event catering', 'meal prep', 'meal plan',
  'weekly meal prep', 'dinner', 'dinners', 'pizza party',
];

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

function isLikelyNavNoise(term: string): boolean {
  const normalized = term.toLowerCase().trim();
  if (!normalized || normalized === '(not set)') return true;
  return NAV_NOISE_TOKENS.some((token) => normalized.includes(token));
}

function inferBacktestTermType(term: string): BacktestTermType {
  const normalized = term.toLowerCase().trim();
  if (isLikelyNavNoise(normalized)) return 'nav_noise';
  if (OFFER_HINTS.some((hint) => normalized.includes(hint))) return 'offer_type';
  return isGenericTerm(normalized) ? 'nav_noise' : 'food_concept';
}

async function queueTerm(
  term: string,
  source: string,
  score: number,
  opts?: { businessFitScore?: number; businessFitRationale?: string },
) {
  if (!supabase || !term || term.length < 3 || term.length > 80) return;
  const normalized = term.trim().replace(/\s+/g, ' ');
  if (normalized.length < 3) return;
  if (isGenericTerm(normalized)) return;
  if (isLikelyNavNoise(normalized)) return;
  const { data: existing } = await supabase.from('trends').select('id').ilike('term', normalized).maybeSingle();
  if (existing) return;
  const { data: queued } = await supabase.from('discovery_queue').select('id').ilike('term', normalized).maybeSingle();
  if (queued) return;
  await supabase.from('discovery_queue').insert({
    term: normalized,
    source,
    initial_score: Math.round(score),
    status: 'pending',
    business_fit_score: opts?.businessFitScore ?? null,
    business_fit_rationale: opts?.businessFitRationale ?? null,
  });
}

// Module 6: LLM-powered targeted discovery for Local Effort business context.
// Returns terms with confidence >= 65 that fit the private chef / meal prep format.
async function discoverWithGemini(existingTerms: string[]): Promise<void> {
  if (!ai || !supabase) return;
  try {
    const existingList = existingTerms.slice(0, 60).join(', ');
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `You are a food trend analyst for Local Effort, a Minneapolis private chef and meal prep company.

Business context:
- Format: private chef dinners ($65-85/person) and weekly meal prep boxes ($12-25/item)
- Customers: households and small businesses in Minneapolis metro
- Cannot offer: street food requiring on-site cooking equipment, items needing liquor license
- Strengths: locally-sourced Minnesota ingredients, dietary flexibility, home delivery

Currently tracked terms (exclude these): ${existingList}

Name 8-12 food concepts that:
1. Are trending nationally on social media or food media right now
2. Have NOT yet saturated the Minneapolis restaurant market
3. Could plausibly be offered as meal prep or private chef format at home
4. Would appeal to households willing to pay $65-85/person for a curated experience

Return only terms with confidence >= 65. Be specific — "birria short rib" not "Mexican food".`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object' as any,
          properties: {
            terms: {
              type: 'array' as any,
              items: {
                type: 'object' as any,
                properties: {
                  term: { type: 'string' as any },
                  confidence: { type: 'number' as any },
                  rationale: { type: 'string' as any },
                },
              },
            },
          },
        },
      },
    });

    const raw = response.text ?? '';
    let parsed: { terms?: { term: string; confidence: number; rationale: string }[] };
    try { parsed = JSON.parse(raw); } catch { return; }

    for (const item of (parsed.terms || [])) {
      if (!item.term || (item.confidence ?? 0) < 65) continue;
      await queueTerm(item.term, 'gemini-targeted', item.confidence, {
        businessFitScore: Math.round(item.confidence),
        businessFitRationale: item.rationale,
      });
    }
  } catch (e) {
    console.error('[discoverWithGemini]', e);
  }
}

async function loadGA4BacktestPriors(): Promise<{ byKey: Map<string, GA4Prior>; all: GA4Prior[] }> {
  const byKey = new Map<string, GA4Prior>();
  const all: GA4Prior[] = [];
  if (!supabase) return { byKey, all };

  try {
    const primary = await supabase
      .from('ga4_backtest_results')
      .select('term, composite_score, growth_rate, term_type')
      .order('composite_score', { ascending: false })
      .limit(600);

    let rows: any[] = [];
    if (!primary.error && primary.data) {
      rows = primary.data as any[];
    } else {
      const fallback = await supabase
        .from('ga4_backtest_results')
        .select('term, composite_score, growth_rate')
        .order('composite_score', { ascending: false })
        .limit(600);
      if (fallback.error || !fallback.data) return { byKey, all };
      rows = fallback.data as any[];
    }

    for (const row of rows) {
      const term = String(row.term || '').trim();
      const key = normalizeTermKey(term);
      if (!key || isLikelyNavNoise(term)) continue;
      const termType = String(row.term_type || inferBacktestTermType(term)) as BacktestTermType;
      if (!GA4_BOOSTABLE_TERM_TYPES.has(termType)) continue;

      const prior: GA4Prior = {
        term,
        key,
        compositeScore: Number(row.composite_score || 0),
        growthRate: Number(row.growth_rate || 0),
        termType,
      };
      const existing = byKey.get(key);
      if (!existing || prior.compositeScore > existing.compositeScore) {
        byKey.set(key, prior);
      }
    }
  } catch (error) {
    console.error('GA4 prior load failed:', error);
  }

  for (const prior of byKey.values()) all.push(prior);
  return { byKey, all };
}

function findGA4Prior(term: string, priors: { byKey: Map<string, GA4Prior>; all: GA4Prior[] }): GA4Prior | null {
  const key = normalizeTermKey(term);
  if (!key) return null;
  const direct = priors.byKey.get(key);
  if (direct) return direct;

  let best: GA4Prior | null = null;
  let bestScore = 0;
  for (const candidate of priors.all) {
    const score = similarityScore(key, candidate.key);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 0.62 ? best : null;
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
async function discoverRisingQueries(seedTerms: string[], locationHint: string, geo = 'US') {
  const results: { term: string; score: number }[] = [];
  // Use seed terms + generic food seeds
  const seeds = seedTerms.length > 0 ? seedTerms.slice(0, 2) : ['food near me', 'best restaurants'];
  for (const seed of seeds) {
    try {
      const localizedSeed = `${seed} ${locationHint}`.trim();
      const result = await serpSearch({
        engine: 'google_trends',
        q: localizedSeed,
        data_type: 'RELATED_QUERIES',
        geo,
      });
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

// --- Reddit enrichment (optional, not primary) ---
async function discoverReddit(locationHints: string[]): Promise<string[]> {
  const subs = (process.env.DISCOVERY_REDDIT_SUBS || 'food,foodporn,askculinary,recipes,Minneapolis,TwinCities,minnesota')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const keywords = ['food', 'eat', 'restaurant', 'drink', 'coffee', 'pizza', 'taco', 'burger', 'sushi', 'bakery',
    'tried', 'best', 'opening', 'new', 'menu', 'brunch', 'dinner', 'lunch', 'dessert', 'ramen', 'thai', 'korean',
    'bbq', 'brewery', 'bar', 'café', 'cafe', 'diner', 'pho', 'boba', 'chicken', 'vegan', 'wings', 'steak',
    'tasting', 'popup', 'pop-up', 'food truck', 'ice cream', 'donut', 'bagel', 'sandwich', 'bowl', 'curry',
    'happy hour', 'smash burger', 'birria', 'elote', 'ube', 'mochi', 'matcha',
    'where to find', 'looking for', 'anyone know', 'near me', 'can i find', 'does anyone know', 'where can i get'];
  const titles: string[] = [];

  // Fetch hot + search for food in configured subs
  const fetches: { url: string; sub: string }[] = [];
  for (const sub of subs) {
    fetches.push({ url: `https://www.reddit.com/r/${sub}/hot.json?limit=50`, sub });
    fetches.push({ url: `https://www.reddit.com/r/${sub}/search.json?q=food+OR+restaurant+OR+new+opening&restrict_sr=on&sort=new&limit=25`, sub });
  }
  fetches.push({ url: 'https://www.reddit.com/r/foodie/hot.json?limit=25', sub: 'foodie' });
  for (const hint of locationHints.slice(0, 3)) {
    const query = encodeURIComponent(`"${hint}" (food OR restaurant OR brunch OR "new opening")`);
    fetches.push({ url: `https://www.reddit.com/search.json?q=${query}&sort=new&limit=25`, sub: 'global' });
  }

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
async function extractFoodTerms(rawTitles: string[], businessNames: string[], locationLabel: string): Promise<string[]> {
  const combined = [
    ...rawTitles.map((t) => `Reddit: ${t}`),
    ...businessNames.slice(0, 20).map((n) => `Restaurant: ${n}`),
  ];

  // If Gemini is available, use it for smart extraction
  if (ai && combined.length > 0) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `You are a food trend analyst for ${locationLabel}. Your job is to identify emerging food trends: specific dishes, preparations, or food concepts that are new, growing, or breaking out.

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isManual = req.query.manual === 'true';
  if (!requireAdminAuth(req, res, { allowCron: !isManual })) return;

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    // Determine location — use zip code if provided, else default
    const zip = typeof req.query.zip === 'string' ? req.query.zip.trim() : '';
    const location = getLocationContext(zip);
    const hasZip = location.hasZip;

    // Get current tracked terms for seed queries
    const { data: tracked } = await supabase.from('trends').select('term');
    const seedTerms = (tracked || []).map((t: any) => t.term);
    const ga4Priors = await loadGA4BacktestPriors();

    // Load canonical map for term deduplication
    const canonicalMap = supabase ? await loadCanonicalMap(supabase) : new Map();

    // Run all discovery sources in parallel (Gemini targeted runs concurrently)
    const [yelpResult, risingQueries, redditTitles] = await Promise.all([
      discoverYelp(location.yelpLocation),
      discoverRisingQueries(seedTerms, location.queryHint, location.serpGeo),
      discoverReddit(location.locationHints),
    ]);

    // Gemini targeted discovery (Module 6) — runs after other sources so we have seedTerms
    // Fire-and-forget style: doesn't block the response
    discoverWithGemini(seedTerms).catch(e => console.error('[discover] Gemini targeted error:', e));

    // NLP extract food terms from Reddit titles + Yelp business names
    const extractedTerms = await extractFoodTerms(redditTitles, yelpResult.businessNames, location.regionLabel);

    // Queue with cross-source scoring: SerpAPI-backed terms are primary, GA4 priors boost.
    const termSources = new Map<string, { sources: Set<string>; bestScore: number; hasSerpapi: boolean }>();
    const SERPAPI_SOURCES = new Set(['yelp', 'rising']);

    const trackTerm = (term: string, source: string, score: number) => {
      if (isGenericTerm(term)) return;
      if (isLikelyNavNoise(term)) return;
      const key = normalizeTermKey(term);
      if (!key) return;
      const existing = termSources.get(key) || { sources: new Set(), bestScore: 0, hasSerpapi: false };
      existing.sources.add(source);
      existing.bestScore = Math.max(existing.bestScore, score);
      if (SERPAPI_SOURCES.has(source)) existing.hasSerpapi = true;
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

    // Score = base + corroboration + SerpAPI signal + GA4 prior bonus.
    let queued = 0;
    let ga4Boosted = 0;
    for (const [term, info] of termSources) {
      const sourceCount = info.sources.size;
      const multiSourceBonus = sourceCount >= 3 ? 40 : sourceCount >= 2 ? 20 : 0;
      const serpapiBonus = info.hasSerpapi ? 12 : 0;
      const ga4Prior = findGA4Prior(term, ga4Priors);
      const ga4Bonus = ga4Prior
        ? Math.min(
            15,
            Math.round(ga4Prior.compositeScore * 0.08) + Math.max(0, Math.min(5, Math.round(ga4Prior.growthRate / 40)))
          )
        : 0;
      if (ga4Bonus > 0) ga4Boosted++;

      const finalScore = Math.min(100, info.bestScore + multiSourceBonus + serpapiBonus + ga4Bonus);
      const sourceLabel = [...info.sources, ...(ga4Bonus > 0 ? [`ga4-prior:${ga4Prior?.termType}`] : [])].join('+');
      const hasPrimaryEvidence = info.hasSerpapi;
      const clearsEvidenceBar = sourceCount >= 2 || info.bestScore >= 60 || (info.hasSerpapi && ga4Bonus >= 8);

      if (hasPrimaryEvidence && clearsEvidenceBar) {
        // Use original casing from extracted terms if available
        const fallbackDisplay = term
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        const displayTerm = extractedTerms.find(t => normalizeTermKey(t) === term)
          || risingQueries.find(rq => normalizeTermKey(rq.term) === term)?.term
          || yelpResult.terms.find(t => normalizeTermKey(t) === term)
          || fallbackDisplay;
        const triggerLabel = hasZip ? `Manual Zip ${zip}` : (isManual ? 'Manual' : 'Cron');
        // Resolve to canonical form before queuing to prevent duplicate tracking
        const canonicalDisplay = resolveCanonical(displayTerm, canonicalMap);
        await queueTerm(canonicalDisplay, `${sourceLabel} (${triggerLabel})`, finalScore);
        queued++;
      }
    }

    res.status(200).json({
      ok: true,
      location: location.regionLabel,
      processed: queued,
      sources: {
        yelp_categories: yelpResult.terms.length,
        yelp_businesses: yelpResult.businessNames.length,
        rising: risingQueries.length,
        reddit_titles: redditTitles.length,
        nlp_extracted: extractedTerms.length,
        ga4_prior_terms: ga4Priors.byKey.size,
        ga4_boosted_candidates: ga4Boosted,
      },
      debug: {
        gemini_available: !!ai,
        yelp_via_serpapi: true,
        serpapi_primary: true,
        serp_geo: location.serpGeo,
        zip_scoped: hasZip,
        extracted_terms: extractedTerms.slice(0, 10),
        sample_reddit: redditTitles.slice(0, 3),
      },
    });
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: 'Discovery failed', detail: String(error) });
  }
}
