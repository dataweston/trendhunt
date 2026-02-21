/**
 * Discovery Queue Admin API
 * GET  /api/queue         - list pending items
 * POST /api/queue         - approve or reject { id, action: 'approve' | 'reject' }
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { requireAdminAuth } from '../lib/api-auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEFAULT_REGION_LABEL = (process.env.DEFAULT_REGION_LABEL || 'All Locations').trim();

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (!requireAdminAuth(req, res)) return;

  // GET: list pending
  if (req.method === 'GET') {
    const status = (req.query.status as string) || 'pending';
    const { data, error } = await supabase
      .from('discovery_queue')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  // POST: approve or reject
  if (req.method === 'POST') {
    const { id, action, category, neighborhood, region } = req.body || {};
    if (!id || !action) return res.status(400).json({ error: 'id and action required' });

    if (action === 'approve') {
      // Get the queue item
      const { data: item } = await supabase.from('discovery_queue').select('*').eq('id', id).single();
      if (!item) return res.status(404).json({ error: 'Not found' });

      const zipFromBody = /^\d{5}$/.test(String(neighborhood || '').trim()) ? String(neighborhood).trim() : '';
      const zipFromSource = String(item.source || '').match(/\bzip\s+(\d{5})\b/i)?.[1] || '';
      const zipCode = zipFromBody || zipFromSource;
      const resolvedNeighborhood = zipCode ? `ZIP ${zipCode}` : (neighborhood || 'Unknown');
      const resolvedRegion = region || (zipCode ? `ZIP ${zipCode}` : DEFAULT_REGION_LABEL);

      // Insert into tracked trends
      const { data: trendRow, error: insertError } = await supabase.from('trends').upsert({
        term: item.term,
        category: category || 'Uncategorized',
        neighborhood: resolvedNeighborhood,
        region: resolvedRegion,
      }, { onConflict: 'term' }).select('id').single();

      if (insertError) return res.status(500).json({ error: insertError.message });

      // Module 7: Insert a launch_decision row to begin outcome tracking
      if (trendRow?.id) {
        try {
          // Pull the latest scores from trend_history for this term
          const { data: latestHistory } = await supabase
            .from('trend_history')
            .select('gap_score, intent_score, confidence_score, trend_state')
            .eq('trend_id', trendRow.id)
            .order('timestamp', { ascending: false })
            .limit(1)
            .maybeSingle();

          await supabase.from('launch_decisions').insert({
            term: item.term,
            trend_id: trendRow.id,
            gap_score_at_launch: latestHistory?.gap_score ?? null,
            intent_score_at_launch: latestHistory?.intent_score ?? null,
            confidence_score_at_launch: latestHistory?.confidence_score ?? null,
            trend_state_at_launch: latestHistory?.trend_state ?? null,
            outcome: 'pending',
          });
        } catch (e) {
          console.error('launch_decisions insert failed (non-fatal):', e);
        }
      }

      // Mark as approved
      await supabase.from('discovery_queue').update({ status: 'approved' }).eq('id', id);
      return res.status(200).json({ ok: true, action: 'approved', term: item.term });
    }

    if (action === 'reject') {
      await supabase.from('discovery_queue').update({ status: 'rejected' }).eq('id', id);
      return res.status(200).json({ ok: true, action: 'rejected' });
    }

    return res.status(400).json({ error: 'action must be approve or reject' });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
