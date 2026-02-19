/**
 * Discovery Queue Admin API
 * GET  /api/queue         — list pending items
 * POST /api/queue         — approve or reject { id, action: 'approve' | 'reject' }
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

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
    const { id, action, category, neighborhood } = req.body || {};
    if (!id || !action) return res.status(400).json({ error: 'id and action required' });

    if (action === 'approve') {
      // Get the queue item
      const { data: item } = await supabase.from('discovery_queue').select('*').eq('id', id).single();
      if (!item) return res.status(404).json({ error: 'Not found' });

      // Insert into tracked trends
      const { error: insertError } = await supabase.from('trends').upsert({
        term: item.term,
        category: category || 'Uncategorized',
        neighborhood: neighborhood || 'Unknown',
        region: 'Minneapolis–St Paul',
      }, { onConflict: 'term' });

      if (insertError) return res.status(500).json({ error: insertError.message });

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
