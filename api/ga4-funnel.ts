/**
 * GA4 Funnel Attribution — Module 5
 *
 * Pulls site-search impressions, page views, and conversion events per tracked
 * term from Google Analytics 4. Computes a per-term funnel and writes results
 * to the `term_funnel` Supabase table (upsert by term + date).
 *
 * Endpoint: POST /api/ga4-funnel
 * Auth: x-cron-secret header OR admin request
 *
 * Called from:
 *   - Vercel Cron (after cron-score, same daily cycle) — scores all tracked terms
 *   - Admin UI "Refresh Funnel" button — scores a single term
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '../lib/api-auth.js';
import { normalizeTermKey, similarityScore } from '../lib/term-normalizer.js';

// --- Config ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const CRON_SECRET = process.env.CRON_SECRET;
const EXTERNAL_TIMEOUT_MS = 8000;

const GA_API = `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`;

// Lookback window for GA4 data
const LOOKBACK_DAYS = 14;

// Minimum page views to count as a real page match
const MIN_PAGE_VIEWS = 5;

// Healthy conversion rate threshold
const HEALTHY_CVR = 0.02;

// --- GA4 Auth (same pattern as ga4-backtest.ts) ---

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
  } catch (e) { console.error('GA4 funnel auth error:', e); return null; }
}

interface GA4Row {
  dimensionValues: { value: string }[];
  metricValues: { value: string }[];
}

async function runGA4Report(request: object): Promise<GA4Row[]> {
  const token = await getGA4AccessToken();
  if (!token) throw new Error('GA4 auth failed');
  const { data } = await axios.post(GA_API, request, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: EXTERNAL_TIMEOUT_MS * 2,
  });
  return (data.rows || []) as GA4Row[];
}

// --- Date helpers ---

function daysAgoDate(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- Term matching ---

/**
 * Check if a GA4 dimension value (page path, page title, or search term) is
 * meaningfully related to the tracked term. Uses normalizeTermKey + similarity.
 */
function matchesTerm(value: string, normTerm: string): boolean {
  if (!value) return false;
  const normValue = normalizeTermKey(value);
  // Substring match (fast path)
  if (normValue.includes(normTerm) || normTerm.includes(normValue)) return true;
  // Fuzzy Jaccard for short terms that may split differently
  if (normTerm.length > 4 && similarityScore(normTerm, normValue) >= 0.5) return true;
  return false;
}

// --- Gemini diagnosis ---

async function generateFunnelDiagnosis(
  term: string,
  searchImpressions: number,
  pageViews: number,
  conversionEvents: number,
  conversionRate: number,
  dropoffStage: string,
): Promise<string | null> {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return null;
  try {
    const prompt = `You are advising the owner of Local Effort, a Minneapolis private chef and meal prep company.

The food trend term "${term}" has this customer journey on our website:
- Site search impressions: ${searchImpressions}
- Page views on matching pages: ${pageViews}
- Conversion events (bookings/purchases): ${conversionEvents}
- Conversion rate: ${(conversionRate * 100).toFixed(1)}%
- Funnel drop-off stage: ${dropoffStage === 'no_page' ? 'no relevant page exists yet' : dropoffStage === 'low_conversion' ? 'page exists but converts poorly' : 'healthy funnel'}

Write exactly one actionable sentence (under 25 words) telling the business owner what to do next. Be specific and direct.`;

    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 80 } },
      { timeout: 10_000 },
    );
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch { return null; }
}

// --- Core computation per term ---

export interface TermFunnelResult {
  term: string;
  searchImpressions: number;
  pageViews: number;
  conversionEvents: number;
  conversionRate: number;
  dropoffStage: 'no_page' | 'low_conversion' | 'healthy' | 'unknown';
  geminiDiagnosis: string | null;
}

async function computeFunnelForTerm(term: string): Promise<TermFunnelResult> {
  const normTerm = normalizeTermKey(term);
  const startDate = daysAgoDate(LOOKBACK_DAYS);
  const endDate = todayDate();

  const [searchRows, pageRows, conversionRows] = await Promise.allSettled([
    // 1. Site search impressions (searchTerm dimension)
    runGA4Report({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'searchTerm' }],
      metrics: [{ name: 'sessions' }],
      limit: 5000,
    }),
    // 2. Page views for pages matching the term
    runGA4Report({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
      metrics: [{ name: 'screenPageViews' }],
      limit: 5000,
    }),
    // 3. Conversion events on pages matching the term
    runGA4Report({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: { values: ['purchase', 'generate_lead', 'booking', 'form_submit'] },
        },
      },
      limit: 5000,
    }),
  ]);

  // --- Count search impressions ---
  let searchImpressions = 0;
  if (searchRows.status === 'fulfilled') {
    for (const row of searchRows.value) {
      const searchTerm = row.dimensionValues[0]?.value || '';
      if (matchesTerm(searchTerm, normTerm)) {
        searchImpressions += Number(row.metricValues[0]?.value || 0);
      }
    }
  }

  // --- Count page views and collect matching paths ---
  let pageViews = 0;
  const matchingPaths = new Set<string>();
  if (pageRows.status === 'fulfilled') {
    for (const row of pageRows.value) {
      const path = row.dimensionValues[0]?.value || '';
      const title = row.dimensionValues[1]?.value || '';
      if (matchesTerm(path, normTerm) || matchesTerm(title, normTerm)) {
        pageViews += Number(row.metricValues[0]?.value || 0);
        matchingPaths.add(path);
      }
    }
  }

  // --- Count conversions on matching paths ---
  let conversionEvents = 0;
  if (conversionRows.status === 'fulfilled') {
    for (const row of conversionRows.value) {
      const path = row.dimensionValues[0]?.value || '';
      if (matchingPaths.has(path)) {
        conversionEvents += Number(row.metricValues[0]?.value || 0);
      }
    }
  }

  // --- Compute derived metrics ---
  const conversionRate = pageViews > 0 ? conversionEvents / pageViews : 0;

  let dropoffStage: TermFunnelResult['dropoffStage'];
  if (pageViews < MIN_PAGE_VIEWS && searchImpressions > 5) {
    dropoffStage = 'no_page';
  } else if (pageViews >= MIN_PAGE_VIEWS && conversionRate < HEALTHY_CVR) {
    dropoffStage = 'low_conversion';
  } else if (pageViews >= MIN_PAGE_VIEWS && conversionRate >= HEALTHY_CVR) {
    dropoffStage = 'healthy';
  } else {
    dropoffStage = 'unknown';
  }

  // Gemini diagnosis — only when there's signal worth diagnosing
  let geminiDiagnosis: string | null = null;
  if (dropoffStage !== 'unknown') {
    geminiDiagnosis = await generateFunnelDiagnosis(
      term, searchImpressions, pageViews, conversionEvents, conversionRate, dropoffStage,
    );
  }

  return { term, searchImpressions, pageViews, conversionEvents, conversionRate, dropoffStage, geminiDiagnosis };
}

// --- Main handler ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: cron secret or admin
  const cronHeader = req.headers['x-cron-secret'];
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET;
  if (!isCron && !isAdminRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!GA4_PROPERTY_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(200).json({ skipped: true, reason: 'GA4 not configured' });
  }

  const supabase = (SUPABASE_URL && SUPABASE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    // Determine which terms to process
    let terms: string[];
    const bodyTerm = (req.body as any)?.term;

    if (bodyTerm && typeof bodyTerm === 'string') {
      // Single-term mode (admin UI refresh)
      terms = [bodyTerm];
    } else {
      // All tracked terms (cron mode)
      const { data: rows, error } = await supabase.from('trends').select('term').order('term');
      if (error) throw error;
      terms = (rows || []).map((r: any) => r.term as string);
    }

    if (terms.length === 0) {
      return res.status(200).json({ processed: 0, skipped: 0 });
    }

    const today = todayDate();
    let processed = 0;
    let skipped = 0;

    for (const term of terms) {
      try {
        // Dedup: skip if already processed today
        const { data: existing } = await supabase
          .from('term_funnel')
          .select('id')
          .eq('term', term)
          .eq('date', today)
          .maybeSingle();

        if (existing && !bodyTerm) {
          // In cron mode, skip already-processed terms; in manual mode, always refresh
          skipped++;
          continue;
        }

        const result = await computeFunnelForTerm(term);

        // Upsert into term_funnel
        await supabase.from('term_funnel').upsert({
          term,
          date: today,
          search_impressions: result.searchImpressions,
          page_views: result.pageViews,
          conversion_events: result.conversionEvents,
          conversion_rate: result.conversionRate,
          dropoff_stage: result.dropoffStage,
          gemini_diagnosis: result.geminiDiagnosis,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'term,date' });

        processed++;
      } catch (e) {
        console.error(`ga4-funnel: error for term "${term}":`, e);
        skipped++;
      }
    }

    return res.status(200).json({ processed, skipped, date: today });
  } catch (error) {
    console.error('ga4-funnel handler error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}
