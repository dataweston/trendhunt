/**
 * Outcome Evaluation — Module 7
 *
 * GET  /api/evaluate-launches        - list pending launch decisions (>30 days old)
 * POST /api/evaluate-launches { id } - evaluate a single decision using GA4 data
 *
 * Fetches GA4 page views and conversions since launch, classifies outcome:
 *   'hit'  — views_90d > 50 AND conversions_90d > 0
 *   'miss' — otherwise
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { requireAdminAuth } from '../lib/api-auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const EXTERNAL_TIMEOUT_MS = 8000;

const GA_API = `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// --- GA4 Auth (same pattern throughout codebase) ---

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
  } catch (e) { console.error('GA4 evaluate-launches auth error:', e); return null; }
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

// --- Helpers ---

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAfter(dateStr: string, n: number): Date {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * Fetch GA4 page views and conversion events for a given page path
 * within a date range.
 */
async function fetchGA4ForPage(
  pagePath: string,
  startDate: string,
  endDate: string,
): Promise<{ views: number; conversions: number }> {
  const [viewRows, convRows] = await Promise.allSettled([
    runGA4Report({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      dimensionFilter: {
        filter: {
          fieldName: 'pagePath',
          stringFilter: { matchType: 'CONTAINS', value: pagePath, caseSensitive: false },
        },
      },
      limit: 1000,
    }),
    runGA4Report({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            {
              filter: {
                fieldName: 'pagePath',
                stringFilter: { matchType: 'CONTAINS', value: pagePath, caseSensitive: false },
              },
            },
            {
              filter: {
                fieldName: 'eventName',
                inListFilter: { values: ['purchase', 'generate_lead', 'booking', 'form_submit'] },
              },
            },
          ],
        },
      },
      limit: 1000,
    }),
  ]);

  let views = 0;
  if (viewRows.status === 'fulfilled') {
    for (const row of viewRows.value) {
      views += Number(row.metricValues[0]?.value || 0);
    }
  }

  let conversions = 0;
  if (convRows.status === 'fulfilled') {
    for (const row of convRows.value) {
      conversions += Number(row.metricValues[0]?.value || 0);
    }
  }

  return { views, conversions };
}

// --- Main handler ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (!requireAdminAuth(req, res)) return;

  // GET: list pending decisions older than 30 days
  if (req.method === 'GET') {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const { data, error } = await supabase
      .from('launch_decisions')
      .select('*')
      .eq('outcome', 'pending')
      .lt('launched_at', cutoff.toISOString())
      .order('launched_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  // POST: evaluate a single decision
  if (req.method === 'POST') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const { data: decision } = await supabase
      .from('launch_decisions')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!decision) return res.status(404).json({ error: 'Not found' });

    if (!GA4_PROPERTY_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(200).json({ skipped: true, reason: 'GA4 not configured' });
    }

    try {
      const launchedAt = decision.launched_at as string;
      const pagePath = (decision.page_url as string | null) ||
        `/menu/${String(decision.term).toLowerCase().replace(/\s+/g, '-')}`;

      // Fetch 30d, 60d, 90d views + conversions
      const end30 = isoDate(daysAfter(launchedAt, 30));
      const end60 = isoDate(daysAfter(launchedAt, 60));
      const end90 = isoDate(daysAfter(launchedAt, 90));
      const startDate = isoDate(new Date(launchedAt));
      const today = isoDate(new Date());

      const [d30, d60, d90] = await Promise.all([
        fetchGA4ForPage(pagePath, startDate, end30 < today ? end30 : today),
        fetchGA4ForPage(pagePath, startDate, end60 < today ? end60 : today),
        fetchGA4ForPage(pagePath, startDate, end90 < today ? end90 : today),
      ]);

      const outcome = (d90.views > 50 && d90.conversions > 0) ? 'hit' : 'miss';

      await supabase.from('launch_decisions').update({
        ga4_views_30d: d30.views,
        ga4_views_60d: d60.views,
        ga4_views_90d: d90.views,
        ga4_conversions_90d: d90.conversions,
        outcome,
        evaluated_at: new Date().toISOString(),
      }).eq('id', id);

      return res.status(200).json({
        id,
        term: decision.term,
        outcome,
        views_30d: d30.views,
        views_60d: d60.views,
        views_90d: d90.views,
        conversions_90d: d90.conversions,
      });
    } catch (error) {
      console.error('evaluate-launches error:', error);
      return res.status(500).json({ error: 'Evaluation failed' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
