import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { requireAdminAuth } from '../lib/api-auth.js';
import { processMetaAnalysisQueue } from '../lib/meta-analyzer.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (!requireAdminAuth(req, res, { allowCron: true })) return;

  const limitRaw = req.method === 'POST' ? req.body?.limit : req.query.limit;
  const limit = Math.max(1, Math.min(100, Number(limitRaw || process.env.META_ANALYSIS_PROCESS_LIMIT || 20)));

  if (req.method === 'GET') {
    const { count: pending } = await supabase
      .from('meta_analysis_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    const { count: failed } = await supabase
      .from('meta_analysis_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed');
    const { data: recent } = await supabase
      .from('meta_analysis_reports')
      .select('id, direction, source_type, trend_term, provider, model, created_at')
      .order('created_at', { ascending: false })
      .limit(15);

    return res.status(200).json({
      queue: {
        pending: pending || 0,
        failed: failed || 0,
      },
      recentReports: recent || [],
      processLimit: limit,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const result = await processMetaAnalysisQueue(supabase, limit);
  return res.status(200).json({
    ok: true,
    limit,
    ...result,
  });
}
