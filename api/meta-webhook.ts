import { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { enqueueMetaAnalysisTask } from '../lib/meta-analyzer.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBHOOK_VERIFY_TOKEN = String(process.env.META_WEBHOOK_VERIFY_TOKEN || '').trim();

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

function eventHash(obj: any): string {
  const text = JSON.stringify(obj || {});
  return createHash('sha256').update(text).digest('hex');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

  if (req.method === 'GET') {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');

    if (mode === 'subscribe' && WEBHOOK_VERIFY_TOKEN && token === WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Webhook verification failed' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const objectName = String(body.object || '');
    const entries: any[] = Array.isArray(body.entry) ? body.entry : [];
    let stored = 0;

    for (const entry of entries) {
      const entryId = String(entry?.id || '');
      const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const field = String(change?.field || '');
        const value = change?.value || {};
        const hash = eventHash({ objectName, entryId, field, value });

        const { error } = await supabase.from('ig_webhook_events').upsert({
          event_hash: hash,
          object: objectName || null,
          entry_id: entryId || null,
          field,
          value,
          status: 'pending',
        }, { onConflict: 'event_hash' });

        if (!error) {
          stored += 1;
          await enqueueMetaAnalysisTask(supabase, {
            direction: 'incoming',
            sourceType: 'instagram_webhook_event',
            sourceId: hash,
            trendTerm: String(value?.text || '').slice(0, 120) || undefined,
            payload: { object: objectName, entryId, field, value },
            context: { receivedAt: new Date().toISOString() },
          });
        }
      }
    }

    return res.status(200).json({
      received: true,
      stored,
      entries: entries.length,
    });
  } catch (error: any) {
    return res.status(500).json({
      error: 'Webhook processing failed',
      message: String(error?.message || error || 'unknown error'),
    });
  }
}
