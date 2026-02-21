/**
 * GA4 Backtest Endpoint
 *
 * Mines 3 years of Google Analytics data from your restaurant site to find
 * keywords/phrases with trend-like growth patterns that should be added
 * to the trend hunter.
 *
 * Usage:
 *   GET /api/ga4-backtest?mode=discover          — extract & rank all terms
 *   GET /api/ga4-backtest?mode=discover&queue=1   — same + auto-queue top candidates
 *   GET /api/ga4-backtest?mode=timeseries&term=birria — monthly timeseries for one term
 *
 * Requires: GA4_PROPERTY_ID, GOOGLE_SERVICE_ACCOUNT_KEY env vars.
 *
 * Data sources mined (in priority order):
 *   1. Page paths   — menu item pages like /menu/birria-tacos
 *   2. Page titles   — titles containing food terms
 *   3. Site search   — what visitors search for on-site (searchTerm dimension)
 *   4. Organic landing pages — pages attracting growing organic traffic
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import { requireAdminAuth } from '../lib/api-auth.js';

// --- Config ---
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
const EXTERNAL_TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS || 8000);

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// --- How far back to look (months) ---
const LOOKBACK_MONTHS = 36;

// --- GA4 Auth (reused from trends.ts pattern) ---
function parseServiceAccount(): any | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  const tryParse = (v: string) => { try { return JSON.parse(v); } catch { return null; } };
  const direct = tryParse(raw);
  if (direct) return direct;
  let decoded = '';
  try { decoded = Buffer.from(raw, 'base64').toString('utf-8'); } catch { return null; }
  const parsed = tryParse(decoded);
  if (parsed) return parsed;
  const repaired = decoded.replace(
    /("private_key"\s*:\s*")([\s\S]*?)(")/m,
    (_m, start, key, end) => `${start}${String(key).replace(/\r?\n/g, '\\n')}${end}`
  );
  return tryParse(repaired);
}

let _ga4Token: string | null = null;
let _ga4TokenExp = 0;

async function getGA4AccessToken(): Promise<string | null> {
  if (_ga4Token && Date.now() < _ga4TokenExp) return _ga4Token;
  const sa = parseServiceAccount();
  if (!sa) return null;
  try {
    const privateKey = String(sa.private_key || '').replace(/\\n/g, '\n');
    if (!privateKey || !sa.client_email) return null;
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    })).toString('base64url');
    const crypto = await import('crypto');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    const jwt = `${header}.${payload}.${signature}`;
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt,
    }, { timeout: EXTERNAL_TIMEOUT_MS });
    _ga4Token = data.access_token;
    _ga4TokenExp = Date.now() + 50 * 60_000;
    return _ga4Token;
  } catch (e) { console.error('GA4 auth error:', e); return null; }
}

// --- GA4 Report Runner ---
interface GA4ReportRequest {
  dateRanges: { startDate: string; endDate: string }[];
  dimensions: { name: string }[];
  metrics: { name: string }[];
  dimensionFilter?: any;
  limit?: number;
  offset?: number;
  orderBys?: any[];
}

interface GA4Row {
  dimensionValues: { value: string }[];
  metricValues: { value: string }[];
}

async function runGA4Report(request: GA4ReportRequest): Promise<GA4Row[]> {
  const token = await getGA4AccessToken();
  if (!token) throw new Error('GA4 auth failed');

  const allRows: GA4Row[] = [];
  let offset = 0;
  const pageSize = request.limit || 10000;

  // Paginate through all results
  while (true) {
    const { data } = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
      { ...request, limit: pageSize, offset },
      { headers: { Authorization: `Bearer ${token}` }, timeout: EXTERNAL_TIMEOUT_MS * 2 }
    );
    const rows: GA4Row[] = data.rows || [];
    allRows.push(...rows);
    // If we got fewer rows than page size, we're done
    if (rows.length < pageSize) break;
    offset += pageSize;
    // Safety: don't fetch more than 50k rows
    if (offset >= 50000) break;
  }
  return allRows;
}

// ========== STRATEGY 1: Mine Page Paths ==========
// Looks for pages like /menu/birria-tacos, /specials/mochi-donuts, etc.
// Groups by path, buckets by month, finds growth patterns.

async function minePagePaths(): Promise<Map<string, MonthlyBucket[]>> {
  const startDate = monthsAgoDate(LOOKBACK_MONTHS);
  const rows = await runGA4Report({
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [{ name: 'pagePath' }, { name: 'yearMonth' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'yearMonth' }, desc: false }],
    limit: 10000,
  });

  const pathMap = new Map<string, MonthlyBucket[]>();
  for (const row of rows) {
    const path = row.dimensionValues[0].value;
    const yearMonth = row.dimensionValues[1].value;
    const views = parseInt(row.metricValues[0].value, 10);
    const sessions = parseInt(row.metricValues[1].value, 10);

    // Skip homepage, admin, cart, checkout, etc.
    if (isBoringPath(path)) continue;

    if (!pathMap.has(path)) pathMap.set(path, []);
    pathMap.get(path)!.push({ yearMonth, views, sessions });
  }
  return pathMap;
}

// ========== STRATEGY 2: Mine Page Titles ==========

async function minePageTitles(): Promise<Map<string, MonthlyBucket[]>> {
  const startDate = monthsAgoDate(LOOKBACK_MONTHS);
  const rows = await runGA4Report({
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [{ name: 'pageTitle' }, { name: 'yearMonth' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'yearMonth' }, desc: false }],
    limit: 10000,
  });

  const titleMap = new Map<string, MonthlyBucket[]>();
  for (const row of rows) {
    const title = row.dimensionValues[0].value;
    const yearMonth = row.dimensionValues[1].value;
    const views = parseInt(row.metricValues[0].value, 10);
    const sessions = parseInt(row.metricValues[1].value, 10);

    if (isBoringTitle(title)) continue;

    if (!titleMap.has(title)) titleMap.set(title, []);
    titleMap.get(title)!.push({ yearMonth, views, sessions });
  }
  return titleMap;
}

// ========== STRATEGY 3: Mine Site Search ==========

async function mineSiteSearch(): Promise<Map<string, MonthlyBucket[]>> {
  const startDate = monthsAgoDate(LOOKBACK_MONTHS);
  try {
    const rows = await runGA4Report({
      dateRanges: [{ startDate, endDate: 'today' }],
      dimensions: [{ name: 'searchTerm' }, { name: 'yearMonth' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { matchType: 'EXACT', value: 'view_search_results' },
        },
      },
      orderBys: [{ dimension: { dimensionName: 'yearMonth' }, desc: false }],
      limit: 10000,
    });

    const searchMap = new Map<string, MonthlyBucket[]>();
    for (const row of rows) {
      const term = row.dimensionValues[0].value;
      const yearMonth = row.dimensionValues[1].value;
      const count = parseInt(row.metricValues[0].value, 10);

      if (!term || term === '(not set)' || term.length < 2) continue;

      if (!searchMap.has(term)) searchMap.set(term, []);
      searchMap.get(term)!.push({ yearMonth, views: count, sessions: count });
    }
    return searchMap;
  } catch (e) {
    // Site search may not be configured — that's fine
    console.warn('Site search mining failed (may not be configured):', e);
    return new Map();
  }
}

// ========== STRATEGY 4: Mine Organic Landing Pages ==========

async function mineOrganicLandings(): Promise<Map<string, MonthlyBucket[]>> {
  const startDate = monthsAgoDate(LOOKBACK_MONTHS);
  const rows = await runGA4Report({
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [{ name: 'landingPagePlusQueryString' }, { name: 'yearMonth' }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionDefaultChannelGroup',
        stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
      },
    },
    orderBys: [{ dimension: { dimensionName: 'yearMonth' }, desc: false }],
    limit: 10000,
  });

  const landingMap = new Map<string, MonthlyBucket[]>();
  for (const row of rows) {
    let path = row.dimensionValues[0].value;
    const yearMonth = row.dimensionValues[1].value;
    const sessions = parseInt(row.metricValues[0].value, 10);
    const users = parseInt(row.metricValues[1].value, 10);

    // Strip query strings for grouping
    path = path.split('?')[0];
    if (isBoringPath(path)) continue;

    if (!landingMap.has(path)) landingMap.set(path, []);
    landingMap.get(path)!.push({ yearMonth, views: users, sessions });
  }
  return landingMap;
}

// ========== TERM EXTRACTION ==========

/** Extract a food-relevant term from a page path */
function termFromPath(path: string): string | null {
  // Patterns: /menu/birria-tacos, /specials/ube-latte, /food/detroit-style-pizza
  const segments = path.replace(/^\/+|\/+$/g, '').split('/');
  // Take the last meaningful segment
  const slug = segments[segments.length - 1] || '';
  if (!slug || slug.length < 3) return null;
  // Convert slug to readable term: birria-tacos -> Birria Tacos
  const term = slug
    .replace(/[-_]+/g, ' ')
    .replace(/\.(html?|php|aspx?)$/i, '')
    .trim();
  if (term.length < 3 || term.length > 60) return null;
  // Title-case
  return term.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** Extract food term from page title */
function termFromTitle(title: string): string {
  // Strip common suffixes like "| Restaurant Name", "— My Restaurant"
  return title
    .replace(/\s*[|–—-]\s*[^|–—-]*$/, '')
    .replace(/\s*[-]\s*(menu|order|restaurant|food|home).*$/i, '')
    .trim();
}

// ========== TREND ANALYSIS ==========

interface MonthlyBucket {
  yearMonth: string; // e.g. "202301"
  views: number;
  sessions: number;
}

interface TrendAnalysis {
  term: string;
  source: string; // 'path' | 'title' | 'search' | 'organic'
  rawKey: string; // original path/title/search term
  totalViews: number;
  monthCount: number; // how many months had data
  recentMonthlyAvg: number; // avg views last 6 months
  olderMonthlyAvg: number; // avg views 7-18 months ago
  growthRate: number; // % change recent vs older
  linearSlope: number; // slope of linear fit (views per month)
  acceleration: number; // is growth accelerating? (2nd derivative)
  seasonalityIndex: number; // 0-1, how seasonal is it
  recencyScore: number; // higher if recent months are strong
  compositeScore: number; // final ranking score
  monthlyData: { yearMonth: string; views: number }[];
}

function analyzeTrend(term: string, source: string, rawKey: string, buckets: MonthlyBucket[]): TrendAnalysis | null {
  if (buckets.length < 3) return null; // need at least 3 months of data

  // Sort by yearMonth
  buckets.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));

  // Fill missing months with 0
  const filled = fillMonthlyGaps(buckets);
  const n = filled.length;
  const views = filled.map(b => b.views);
  const totalViews = views.reduce((a, b) => a + b, 0);

  if (totalViews < 10) return null; // too little data

  // Recent vs older comparison
  const recentMonths = views.slice(-6);
  const olderMonths = views.slice(Math.max(0, n - 18), Math.max(0, n - 6));
  const recentAvg = recentMonths.length > 0 ? recentMonths.reduce((a, b) => a + b, 0) / recentMonths.length : 0;
  const olderAvg = olderMonths.length > 0 ? olderMonths.reduce((a, b) => a + b, 0) / olderMonths.length : 0;
  const growthRate = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : (recentAvg > 0 ? 100 : 0);

  // Linear regression: slope = trend direction
  const { slope, r2 } = linearRegression(views);

  // Acceleration: compare slope of first half vs second half
  const halfN = Math.floor(n / 2);
  const firstHalfSlope = halfN >= 3 ? linearRegression(views.slice(0, halfN)).slope : 0;
  const secondHalfSlope = halfN >= 3 ? linearRegression(views.slice(halfN)).slope : 0;
  const acceleration = secondHalfSlope - firstHalfSlope;

  // Seasonality index: coefficient of variation of same-month averages
  const seasonality = calculateSeasonality(filled);

  // Recency score: weight recent months heavily
  const recency = calculateRecencyScore(views);

  // Composite score — what we ultimately rank by
  // Prioritizes: recent growth, positive slope, acceleration, volume
  const compositeScore = calculateCompositeScore({
    growthRate, slope, acceleration, recency,
    totalViews, recentAvg, monthCount: n, seasonality,
  });

  return {
    term, source, rawKey, totalViews,
    monthCount: n,
    recentMonthlyAvg: Math.round(recentAvg * 10) / 10,
    olderMonthlyAvg: Math.round(olderAvg * 10) / 10,
    growthRate: Math.round(growthRate * 10) / 10,
    linearSlope: Math.round(slope * 100) / 100,
    acceleration: Math.round(acceleration * 100) / 100,
    seasonalityIndex: Math.round(seasonality * 100) / 100,
    recencyScore: Math.round(recency * 100) / 100,
    compositeScore: Math.round(compositeScore * 10) / 10,
    monthlyData: filled.map(b => ({ yearMonth: b.yearMonth, views: b.views })),
  };
}

function linearRegression(values: number[]): { slope: number; intercept: number; r2: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };

  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += values[i];
    sxy += i * values[i]; sx2 += i * i; sy2 += values[i] * values[i];
  }
  const den = n * sx2 - sx * sx;
  if (den === 0) return { slope: 0, intercept: values[0] || 0, r2: 0 };

  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;

  // R² (coefficient of determination)
  const yMean = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yHat = intercept + slope * i;
    ssRes += (values[i] - yHat) ** 2;
    ssTot += (values[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, r2 };
}

function calculateSeasonality(buckets: { yearMonth: string; views: number }[]): number {
  // Group by month-of-year, compute coefficient of variation
  const monthAvgs = new Map<number, number[]>();
  for (const b of buckets) {
    const month = parseInt(b.yearMonth.slice(4), 10);
    if (!monthAvgs.has(month)) monthAvgs.set(month, []);
    monthAvgs.get(month)!.push(b.views);
  }
  if (monthAvgs.size < 4) return 0;

  const avgs = [...monthAvgs.values()].map(
    vals => vals.reduce((a, b) => a + b, 0) / vals.length
  );
  const mean = avgs.reduce((a, b) => a + b, 0) / avgs.length;
  if (mean === 0) return 0;
  const stdDev = Math.sqrt(avgs.reduce((a, v) => a + (v - mean) ** 2, 0) / avgs.length);
  return Math.min(1, stdDev / mean); // CV capped at 1
}

function calculateRecencyScore(values: number[]): number {
  // Exponentially weight recent months
  const n = values.length;
  if (n === 0) return 0;
  let weightedSum = 0, totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const weight = Math.exp(0.15 * (i - n + 1)); // recent months get higher weight
    weightedSum += values[i] * weight;
    totalWeight += weight;
  }
  const weightedAvg = weightedSum / totalWeight;
  const simpleAvg = values.reduce((a, b) => a + b, 0) / n;
  return simpleAvg > 0 ? weightedAvg / simpleAvg : 0;
}

function calculateCompositeScore(params: {
  growthRate: number;
  slope: number;
  acceleration: number;
  recency: number;
  totalViews: number;
  recentAvg: number;
  monthCount: number;
  seasonality: number;
}): number {
  const { growthRate, slope, acceleration, recency, totalViews, recentAvg, monthCount, seasonality } = params;

  // Volume score: log-scaled, 100+ total views = decent, 1000+ = strong
  const volumeScore = Math.min(30, Math.log10(Math.max(1, totalViews)) * 10);

  // Growth score: positive growth = good (capped at +200% for scoring)
  const growthScore = Math.min(25, Math.max(-10, growthRate * 0.25));

  // Slope score: positive slope means consistently growing
  const slopeScore = Math.min(15, Math.max(-5, slope * 3));

  // Acceleration score: growth is speeding up
  const accelScore = Math.min(10, Math.max(-5, acceleration * 5));

  // Recency score: recent months stronger than average
  const recencyBonus = Math.min(10, (recency - 1) * 15);

  // Anti-seasonality bonus: less seasonal = more genuine trend
  const steadyBonus = Math.min(5, (1 - seasonality) * 5);

  // Data coverage penalty: less than 6 months = reduce confidence
  const coveragePenalty = monthCount < 6 ? -5 : 0;

  // Recent activity requirement: must have SOME recent traffic
  const recentPenalty = recentAvg < 2 ? -15 : 0;

  return volumeScore + growthScore + slopeScore + accelScore + recencyBonus + steadyBonus + coveragePenalty + recentPenalty;
}

// ========== UTILITIES ==========

function monthsAgoDate(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function fillMonthlyGaps(buckets: MonthlyBucket[]): MonthlyBucket[] {
  if (buckets.length === 0) return [];
  const sorted = [...buckets].sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
  const first = sorted[0].yearMonth;
  const last = sorted[sorted.length - 1].yearMonth;

  const existing = new Map(sorted.map(b => [b.yearMonth, b]));
  const filled: MonthlyBucket[] = [];

  let year = parseInt(first.slice(0, 4), 10);
  let month = parseInt(first.slice(4), 10);
  const endYear = parseInt(last.slice(0, 4), 10);
  const endMonth = parseInt(last.slice(4), 10);

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const ym = `${year}${String(month).padStart(2, '0')}`;
    const entry = existing.get(ym);
    filled.push(entry || { yearMonth: ym, views: 0, sessions: 0 });
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return filled;
}

function isBoringPath(path: string): boolean {
  const boring = [
    '/', '/index', '/home', '/about', '/contact', '/cart', '/checkout',
    '/login', '/signup', '/register', '/account', '/privacy', '/terms',
    '/wp-admin', '/wp-login', '/admin', '/favicon', '/robots.txt',
    '/sitemap', '/404', '/search', '/tag/', '/category/',
  ];
  const lower = path.toLowerCase();
  if (boring.some(b => lower === b || lower.startsWith(b + '/'))) return true;
  // Skip static assets
  if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|ttf|pdf)$/i.test(lower)) return true;
  // Skip very short paths
  if (lower.replace(/\//g, '').length < 3) return true;
  return false;
}

function isBoringTitle(title: string): boolean {
  const boring = [
    'home', 'homepage', 'welcome', 'contact', 'about', 'login',
    'cart', 'checkout', '404', 'page not found', 'privacy policy',
    'terms of service', 'terms and conditions', 'search results',
  ];
  const lower = title.toLowerCase().trim();
  if (lower.length < 3) return true;
  if (boring.some(b => lower === b || lower.startsWith(b + ' '))) return true;
  // Skip titles that are just the restaurant name (no food term)
  if (lower.split(/\s+/).length <= 1) return true;
  return false;
}

// --- Generic food term blocklist (same as discover.ts) ---
const GENERIC_BLOCKLIST = new Set([
  'noodles', 'burgers', 'pizza', 'sandwiches', 'salads', 'sushi', 'tacos',
  'wings', 'seafood', 'steakhouses', 'delis', 'bakeries', 'cafes', 'diners',
  'buffets', 'barbeque', 'barbecue', 'breweries', 'bars', 'pubs',
  'pan asian', 'asian fusion', 'chinese', 'japanese', 'thai', 'indian',
  'mexican', 'italian', 'greek', 'mediterranean', 'french', 'korean',
  'vietnamese', 'middle eastern', 'american', 'southern', 'cajun',
  'food', 'restaurants', 'dining', 'takeout', 'delivery', 'catering',
  'fast food', 'fine dining', 'casual dining', 'breakfast', 'brunch',
  'lunch', 'dinner', 'desserts', 'appetizers', 'drinks', 'beverages',
  'coffee', 'tea', 'smoothies', 'juice', 'beer', 'wine', 'cocktails',
  'ice cream', 'frozen yogurt', 'donuts', 'pastries', 'bread',
  'comfort food', 'street food', 'soul food', 'home cooking', 'healthy',
  'organic', 'vegan', 'vegetarian', 'gluten free', 'gluten-free',
  'food trucks', 'food delivery services', 'food stands',
  'chicken', 'steak', 'pasta', 'soup', 'salad', 'rice', 'wraps',
  'hot dogs', 'fries', 'chips', 'nachos', 'quesadillas',
  'menu', 'order', 'order online', 'online ordering', 'reservation',
  'reservations', 'hours', 'location', 'directions', 'reviews',
  'specials', 'deals', 'coupons', 'gift cards',
]);

function isGenericTerm(term: string): boolean {
  const normalized = term.toLowerCase().trim();
  if (GENERIC_BLOCKLIST.has(normalized)) return true;
  if (normalized.split(/\s+/).length === 1 && normalized.length < 8) return true;
  return false;
}

// ========== GEMINI: EXTRACT FOOD TERMS FROM RAW DATA ==========

interface RawCandidate {
  key: string; // path, title, or search term
  source: string;
  totalViews: number;
}

async function extractFoodTermsWithGemini(candidates: RawCandidate[]): Promise<Map<string, string>> {
  if (!ai || candidates.length === 0) return new Map();

  // Map raw keys to clean food terms using Gemini
  const keyToTerm = new Map<string, string>();

  // Batch into chunks of 80 to avoid token limits
  const chunks: RawCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += 80) {
    chunks.push(candidates.slice(i, i + 80));
  }

  for (const chunk of chunks) {
    try {
      const input = chunk.map((c, i) =>
        `${i + 1}. [${c.source}] "${c.key}" (${c.totalViews} views)`
      ).join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `You are a food trend analyst. Below are page paths, page titles, and search terms from a restaurant's Google Analytics data over 3 years.

Your job: For each entry, determine if it contains a specific, actionable FOOD TREND term — a dish, preparation style, ingredient, or food concept that a restaurant could add to their menu.

Rules:
- EXTRACT the food-specific term, not the full title/path
- SKIP entries about the restaurant itself (e.g., "Joe's Bar & Grill - Menu")
- SKIP generic categories (pizza, burgers, sushi, salads, etc.)
- KEEP specific preparations (e.g., "Nashville Hot Chicken", "Smash Burger", "Detroit-Style Pizza", "Birria Ramen")
- KEEP trending ingredients/styles (e.g., "Ube", "Everything Bagel Seasoning", "Chili Crunch")
- For paths like "/menu/birria-ramen", extract "Birria Ramen"
- Return the CLEAN term in Title Case
- If an entry has no extractable food trend, skip it

Entries:
${input}

Return a JSON array of objects with "index" (1-based, matching the entry number) and "term" (the clean food trend name).`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                index: { type: Type.NUMBER },
                term: { type: Type.STRING },
              },
            },
          },
        },
      });

      if (response.text) {
        const parsed = JSON.parse(response.text) as { index: number; term: string }[];
        for (const p of parsed) {
          const idx = p.index - 1;
          if (idx >= 0 && idx < chunk.length && p.term && p.term.length >= 3 && !isGenericTerm(p.term)) {
            keyToTerm.set(chunk[idx].key, p.term);
          }
        }
      }
    } catch (e) {
      console.error('Gemini extraction error:', e);
    }
  }

  return keyToTerm;
}

// ========== MAIN LOGIC ==========

async function discoverTerms(autoQueue: boolean): Promise<{
  candidates: TrendAnalysis[];
  queued: string[];
  stats: Record<string, number>;
}> {
  // 1. Mine all 4 GA4 data sources in parallel
  const [pathData, titleData, searchData, organicData] = await Promise.all([
    minePagePaths().catch(() => new Map<string, MonthlyBucket[]>()),
    minePageTitles().catch(() => new Map<string, MonthlyBucket[]>()),
    mineSiteSearch().catch(() => new Map<string, MonthlyBucket[]>()),
    mineOrganicLandings().catch(() => new Map<string, MonthlyBucket[]>()),
  ]);

  const stats = {
    paths: pathData.size,
    titles: titleData.size,
    searches: searchData.size,
    organicLandings: organicData.size,
  };

  // 2. Build raw candidate list for Gemini extraction
  const rawCandidates: RawCandidate[] = [];
  for (const [path, buckets] of pathData) {
    const total = buckets.reduce((a, b) => a + b.views, 0);
    rawCandidates.push({ key: path, source: 'path', totalViews: total });
  }
  for (const [title, buckets] of titleData) {
    const total = buckets.reduce((a, b) => a + b.views, 0);
    rawCandidates.push({ key: title, source: 'title', totalViews: total });
  }
  for (const [term, buckets] of searchData) {
    const total = buckets.reduce((a, b) => a + b.views, 0);
    rawCandidates.push({ key: term, source: 'search', totalViews: total });
  }
  for (const [path, buckets] of organicData) {
    const total = buckets.reduce((a, b) => a + b.views, 0);
    rawCandidates.push({ key: path, source: 'organic', totalViews: total });
  }

  // 3. Use Gemini to extract food terms from raw keys
  const keyToTerm = await extractFoodTermsWithGemini(rawCandidates);

  // 4. Also do simple extraction for paths/titles without Gemini hits
  for (const [path] of pathData) {
    if (!keyToTerm.has(path)) {
      const term = termFromPath(path);
      if (term && !isGenericTerm(term)) keyToTerm.set(path, term);
    }
  }
  for (const [title] of titleData) {
    if (!keyToTerm.has(title)) {
      const term = termFromTitle(title);
      if (term && !isGenericTerm(term)) keyToTerm.set(title, term);
    }
  }
  // Search terms can be used directly
  for (const [term] of searchData) {
    if (!keyToTerm.has(term) && !isGenericTerm(term) && term.length >= 3) {
      keyToTerm.set(term, term.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' '));
    }
  }

  // 5. Merge data for same extracted terms across sources
  const termDataMap = new Map<string, { source: string; rawKey: string; buckets: MonthlyBucket[] }[]>();

  const addTermData = (rawKey: string, source: string, buckets: MonthlyBucket[]) => {
    const term = keyToTerm.get(rawKey);
    if (!term) return;
    const normalized = term.toLowerCase();
    if (!termDataMap.has(normalized)) termDataMap.set(normalized, []);
    termDataMap.get(normalized)!.push({ source, rawKey, buckets });
  };

  for (const [path, buckets] of pathData) addTermData(path, 'path', buckets);
  for (const [title, buckets] of titleData) addTermData(title, 'title', buckets);
  for (const [term, buckets] of searchData) addTermData(term, 'search', buckets);
  for (const [path, buckets] of organicData) addTermData(path, 'organic', buckets);

  // 6. For each unique term, merge monthly data and analyze
  const analyses: TrendAnalysis[] = [];

  for (const [normalizedTerm, entries] of termDataMap) {
    // Merge monthly buckets: sum views across sources for same month
    const monthMap = new Map<string, MonthlyBucket>();
    for (const entry of entries) {
      for (const b of entry.buckets) {
        const existing = monthMap.get(b.yearMonth);
        if (existing) {
          existing.views += b.views;
          existing.sessions += b.sessions;
        } else {
          monthMap.set(b.yearMonth, { ...b });
        }
      }
    }

    // Use the best display term (from keyToTerm, pick the first one)
    const displayTerm = keyToTerm.get(entries[0].rawKey) || normalizedTerm;
    const sources = [...new Set(entries.map(e => e.source))].join('+');

    const analysis = analyzeTrend(displayTerm, sources, entries[0].rawKey, [...monthMap.values()]);
    if (analysis) analyses.push(analysis);
  }

  // 7. Sort by composite score descending
  analyses.sort((a, b) => b.compositeScore - a.compositeScore);

  // 8. Filter against already-tracked terms
  let filtered = analyses;
  if (supabase) {
    const { data: tracked } = await supabase.from('trends').select('term');
    const trackedSet = new Set((tracked || []).map((t: any) => t.term.toLowerCase()));
    filtered = analyses.filter(a => !trackedSet.has(a.term.toLowerCase()));
  }

  // 9. Optionally auto-queue top candidates
  const queued: string[] = [];
  if (autoQueue && supabase) {
    // Queue top 20 candidates with positive composite score
    const toQueue = filtered.filter(a => a.compositeScore > 15).slice(0, 20);
    for (const candidate of toQueue) {
      try {
        // Check not already queued
        const { data: existing } = await supabase
          .from('discovery_queue')
          .select('id')
          .ilike('term', candidate.term)
          .maybeSingle();
        if (!existing) {
          await supabase.from('discovery_queue').insert({
            term: candidate.term,
            source: `GA4 Backtest (${candidate.source})`,
            initial_score: Math.round(Math.min(100, Math.max(0, candidate.compositeScore))),
            status: 'pending',
          });
          queued.push(candidate.term);
        }
      } catch (e) {
        console.error('Queue error:', e);
      }
    }
  }

  return { candidates: filtered, queued, stats };
}

// ========== SINGLE-TERM TIMESERIES ==========
// Detailed monthly view for a specific term — useful for validating
// whether a term shows genuine trend behavior.

async function getTermTimeseries(term: string): Promise<{
  term: string;
  analysis: TrendAnalysis | null;
  pagePaths: { path: string; data: MonthlyBucket[] }[];
  pageTitles: { title: string; data: MonthlyBucket[] }[];
  searchData: MonthlyBucket[];
}> {
  const startDate = monthsAgoDate(LOOKBACK_MONTHS);
  const token = await getGA4AccessToken();
  if (!token) throw new Error('GA4 auth failed');

  // Fetch page views containing the term in title, path, and search
  const [titleRows, pathRows, searchRows] = await Promise.all([
    runGA4Report({
      dateRanges: [{ startDate, endDate: 'today' }],
      dimensions: [{ name: 'pageTitle' }, { name: 'yearMonth' }],
      metrics: [{ name: 'screenPageViews' }],
      dimensionFilter: {
        filter: { fieldName: 'pageTitle', stringFilter: { matchType: 'CONTAINS', value: term, caseSensitive: false } },
      },
    }),
    runGA4Report({
      dateRanges: [{ startDate, endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }, { name: 'yearMonth' }],
      metrics: [{ name: 'screenPageViews' }],
      dimensionFilter: {
        filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: term.toLowerCase().replace(/\s+/g, '-'), caseSensitive: false } },
      },
    }),
    runGA4Report({
      dateRanges: [{ startDate, endDate: 'today' }],
      dimensions: [{ name: 'searchTerm' }, { name: 'yearMonth' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'searchTerm', stringFilter: { matchType: 'CONTAINS', value: term, caseSensitive: false } } },
            { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'view_search_results' } } },
          ],
        },
      },
    }).catch(() => []),
  ]);

  // Group title rows
  const titleGroups = new Map<string, MonthlyBucket[]>();
  for (const row of titleRows) {
    const title = row.dimensionValues[0].value;
    const ym = row.dimensionValues[1].value;
    const views = parseInt(row.metricValues[0].value, 10);
    if (!titleGroups.has(title)) titleGroups.set(title, []);
    titleGroups.get(title)!.push({ yearMonth: ym, views, sessions: 0 });
  }

  // Group path rows
  const pathGroups = new Map<string, MonthlyBucket[]>();
  for (const row of pathRows) {
    const path = row.dimensionValues[0].value;
    const ym = row.dimensionValues[1].value;
    const views = parseInt(row.metricValues[0].value, 10);
    if (!pathGroups.has(path)) pathGroups.set(path, []);
    pathGroups.get(path)!.push({ yearMonth: ym, views, sessions: 0 });
  }

  // Merge search rows
  const searchBuckets: MonthlyBucket[] = [];
  for (const row of searchRows) {
    searchBuckets.push({
      yearMonth: row.dimensionValues[1].value,
      views: parseInt(row.metricValues[0].value, 10),
      sessions: 0,
    });
  }

  // Build combined monthly data for analysis
  const combined = new Map<string, MonthlyBucket>();
  const allBuckets = [
    ...titleRows.map(r => ({ ym: r.dimensionValues[1].value, views: parseInt(r.metricValues[0].value, 10) })),
    ...pathRows.map(r => ({ ym: r.dimensionValues[1].value, views: parseInt(r.metricValues[0].value, 10) })),
    ...searchRows.map(r => ({ ym: r.dimensionValues[1].value, views: parseInt(r.metricValues[0].value, 10) })),
  ];
  for (const { ym, views } of allBuckets) {
    const existing = combined.get(ym);
    if (existing) existing.views += views;
    else combined.set(ym, { yearMonth: ym, views, sessions: 0 });
  }

  const analysis = analyzeTrend(term, 'combined', term, [...combined.values()]);

  return {
    term,
    analysis,
    pagePaths: [...pathGroups].map(([path, data]) => ({ path, data })),
    pageTitles: [...titleGroups].map(([title, data]) => ({ title, data })),
    searchData: searchBuckets,
  };
}

// ========== HANDLER ==========

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!requireAdminAuth(req, res, { allowCron: true })) return;

  if (!GA4_PROPERTY_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(400).json({ error: 'GA4_PROPERTY_ID and GOOGLE_SERVICE_ACCOUNT_KEY are required' });
  }

  const mode = (typeof req.query.mode === 'string' ? req.query.mode : 'discover').toLowerCase();

  try {
    if (mode === 'timeseries') {
      // Single-term deep dive
      const term = typeof req.query.term === 'string' ? req.query.term.trim() : '';
      if (!term) return res.status(400).json({ error: 'term parameter required for timeseries mode' });

      const result = await getTermTimeseries(term);
      return res.status(200).json(result);
    }

    // Default: discover mode — mine all GA4 data for trend candidates
    const autoQueue = req.query.queue === '1' || req.query.queue === 'true';
    const result = await discoverTerms(autoQueue);

    return res.status(200).json({
      ok: true,
      mode: 'discover',
      autoQueued: autoQueue,
      stats: result.stats,
      candidateCount: result.candidates.length,
      queuedTerms: result.queued,
      candidates: result.candidates.slice(0, 50).map(c => ({
        term: c.term,
        source: c.source,
        compositeScore: c.compositeScore,
        totalViews: c.totalViews,
        recentMonthlyAvg: c.recentMonthlyAvg,
        olderMonthlyAvg: c.olderMonthlyAvg,
        growthRate: c.growthRate,
        linearSlope: c.linearSlope,
        acceleration: c.acceleration,
        seasonalityIndex: c.seasonalityIndex,
        monthCount: c.monthCount,
        monthlyData: c.monthlyData,
      })),
    });
  } catch (error) {
    console.error('GA4 Backtest error:', error);
    res.status(500).json({ error: 'Backtest failed', detail: String(error) });
  }
}
