import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { requireAdminAuth } from '../lib/api-auth.js';
import {
  parseActionValue,
  parseMetricNumber,
  resolveInstagramUserId,
  resolveMetaConnection,
  inspectMetaToken,
  metaGet,
  toISODate,
} from '../lib/meta-graph.js';
import { enqueueMetaAnalysisTask, processMetaAnalysisQueue } from '../lib/meta-analyzer.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const EXTERNAL_TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS || 8000);
const PROCESS_QUEUE_LIMIT = Number(process.env.META_ANALYSIS_PROCESS_LIMIT || 20);

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

type SyncScope = 'ads' | 'instagram' | 'all';
type SyncMode = 'incremental' | 'backfill';

function dateDaysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function parseScope(value: unknown): SyncScope {
  const normalized = String(value || 'all').trim().toLowerCase();
  if (normalized === 'ads' || normalized === 'instagram' || normalized === 'all') return normalized as SyncScope;
  return 'all';
}

function parseMode(value: unknown): SyncMode {
  const normalized = String(value || 'incremental').trim().toLowerCase();
  if (normalized === 'backfill') return 'backfill';
  return 'incremental';
}

function dateRange(mode: SyncMode, from?: unknown, to?: unknown): { fromDate: string; toDate: string } {
  const explicitFrom = String(from || '').trim();
  const explicitTo = String(to || '').trim();
  if (explicitFrom && explicitTo) {
    return { fromDate: explicitFrom, toDate: explicitTo };
  }
  if (mode === 'backfill') {
    return {
      fromDate: toISODate(dateDaysAgo(Number(process.env.META_BACKFILL_DAYS || 365))),
      toDate: toISODate(new Date()),
    };
  }
  return {
    fromDate: toISODate(dateDaysAgo(Number(process.env.META_INCREMENTAL_DAYS || 7))),
    toDate: toISODate(new Date()),
  };
}

function extractActionCount(actions: any[] | undefined, candidates: string[]): number {
  if (!Array.isArray(actions) || !actions.length) return 0;
  const lower = candidates.map((v) => v.toLowerCase());
  let total = 0;
  for (const action of actions) {
    const actionType = String(action?.action_type || '').toLowerCase();
    if (lower.some((needle) => actionType.includes(needle))) {
      total += parseMetricNumber(action?.value);
    }
  }
  return total;
}

function extractMetricMap(metrics: any[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const metric of metrics || []) {
    const name = String(metric?.name || '').trim();
    if (!name) continue;
    const value = metric?.values?.[0]?.value;
    if (typeof value === 'number' || typeof value === 'string') {
      out[name] = parseMetricNumber(value);
    } else if (value && typeof value === 'object') {
      const num = Number((value as any).value ?? (value as any).count ?? 0);
      out[name] = Number.isFinite(num) ? num : 0;
    } else {
      out[name] = 0;
    }
  }
  return out;
}

async function startSyncRun(scope: SyncScope, mode: SyncMode, fromDate: string, toDate: string): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from('meta_sync_runs')
    .insert({
      scope,
      mode,
      from_date: fromDate,
      to_date: toDate,
      status: 'running',
      metadata: { timeoutMs: EXTERNAL_TIMEOUT_MS },
    })
    .select('id')
    .maybeSingle();
  return data?.id || null;
}

async function finishSyncRun(runId: string | null, payload: {
  status: 'completed' | 'failed';
  rowsSynced: number;
  error?: string | null;
  metadata?: Record<string, any>;
}) {
  if (!supabase || !runId) return;
  await supabase
    .from('meta_sync_runs')
    .update({
      status: payload.status,
      rows_synced: payload.rowsSynced,
      error: payload.error || null,
      metadata: payload.metadata || {},
      completed_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

async function syncAds(connection: {
  accessToken: string;
  adAccountId: string | null;
}, runId: string | null, fromDate: string, toDate: string): Promise<{ rows: number; insightsRows: number; entities: number }> {
  if (!supabase || !connection.adAccountId) return { rows: 0, insightsRows: 0, entities: 0 };
  const adAccountId = connection.adAccountId;
  let entities = 0;
  let insightsRows = 0;

  const campaignsResponse: any = await metaGet(`/act_${adAccountId}/campaigns`, connection.accessToken, {
    fields: 'id,name,status,objective,created_time,updated_time,configured_status,effective_status',
    limit: 200,
  });
  const campaigns = campaignsResponse?.data || [];
  if (campaigns.length > 0) {
    const rows = campaigns.map((campaign: any) => ({
      meta_account_id: adAccountId,
      entity_level: 'campaign',
      entity_id: String(campaign.id),
      name: String(campaign.name || ''),
      status: String(campaign.effective_status || campaign.status || ''),
      objective: String(campaign.objective || ''),
      targeting: null,
      creative: null,
      raw: campaign,
      created_time: campaign.created_time || null,
      updated_time: campaign.updated_time || null,
    }));
    await supabase.from('meta_ads_entities')
      .upsert(rows, { onConflict: 'meta_account_id,entity_level,entity_id' });
    entities += rows.length;
  }

  const insightsResponse: any = await metaGet(`/act_${adAccountId}/insights`, connection.accessToken, {
    level: 'campaign',
    time_increment: 1,
    time_range: JSON.stringify({ since: fromDate, until: toDate }),
    fields: 'campaign_id,campaign_name,date_start,date_stop,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,action_values,outbound_clicks',
    limit: 500,
  });

  const insights = insightsResponse?.data || [];
  if (insights.length > 0) {
    const insightRows = insights.map((row: any) => {
      const actions = Array.isArray(row.actions) ? row.actions : [];
      const outboundClicks = parseActionValue(actions, 'outbound_click') || parseMetricNumber(row?.outbound_clicks?.[0]?.value);
      const purchaseCount = extractActionCount(actions, ['purchase']);
      const addToCartCount = extractActionCount(actions, ['add_to_cart']);
      const checkoutCount = extractActionCount(actions, ['initiate_checkout']);
      return {
        sync_run_id: runId,
        meta_account_id: adAccountId,
        entity_level: 'campaign',
        entity_id: String(row.campaign_id || ''),
        entity_name: String(row.campaign_name || ''),
        date_start: row.date_start,
        date_stop: row.date_stop,
        spend: parseMetricNumber(row.spend),
        impressions: parseMetricNumber(row.impressions),
        reach: parseMetricNumber(row.reach),
        clicks: parseMetricNumber(row.clicks),
        ctr: parseMetricNumber(row.ctr),
        cpc: parseMetricNumber(row.cpc),
        cpm: parseMetricNumber(row.cpm),
        outbound_clicks: outboundClicks,
        purchase_count: purchaseCount,
        add_to_cart_count: addToCartCount,
        initiate_checkout_count: checkoutCount,
        actions,
        action_values: Array.isArray(row.action_values) ? row.action_values : [],
        raw: row,
      };
    }).filter((row: any) => row.entity_id);

    if (insightRows.length > 0) {
      await supabase.from('meta_ads_insights_daily')
        .upsert(insightRows, { onConflict: 'meta_account_id,entity_level,entity_id,date_start,date_stop' });
      insightsRows += insightRows.length;
    }

    const analysisJobs = insightRows.slice(0, Number(process.env.META_ANALYSIS_MAX_ROWS_PER_SYNC || 250));
    for (const row of analysisJobs) {
      await enqueueMetaAnalysisTask(supabase, {
        direction: 'incoming',
        sourceType: 'meta_ads_insight_row',
        sourceId: `${row.entity_id}:${row.date_start}`,
        trendTerm: row.entity_name || undefined,
        payload: row,
        context: { runId, fromDate, toDate },
      });
    }

    await enqueueMetaAnalysisTask(supabase, {
      direction: 'incoming',
      sourceType: 'meta_ads_sync_batch',
      sourceId: runId || undefined,
      payload: {
        fromDate,
        toDate,
        rows: insightRows.length,
        totalSpend: insightRows.reduce((acc: number, row: any) => acc + Number(row.spend || 0), 0),
        totalClicks: insightRows.reduce((acc: number, row: any) => acc + Number(row.clicks || 0), 0),
        avgCtr: insightRows.length
          ? insightRows.reduce((acc: number, row: any) => acc + Number(row.ctr || 0), 0) / insightRows.length
          : 0,
      },
      context: { runId, adAccountId },
    });
  }

  return {
    rows: entities + insightsRows,
    insightsRows,
    entities,
  };
}

async function fetchInstagramMetric(igUserId: string, accessToken: string, metric: string): Promise<number> {
  try {
    const data: any = await metaGet(`/${igUserId}/insights`, accessToken, {
      metric,
      period: 'day',
    });
    const first = data?.data?.[0];
    return parseMetricNumber(first?.values?.[0]?.value);
  } catch {
    return 0;
  }
}

async function fetchMediaMetrics(mediaId: string, accessToken: string): Promise<Record<string, number>> {
  try {
    const data: any = await metaGet(`/${mediaId}/insights`, accessToken, {
      metric: 'impressions,reach,saved,likes,comments,shares,views,video_views,plays',
    });
    return extractMetricMap(data?.data || []);
  } catch {
    return {};
  }
}

async function syncInstagram(connection: {
  accessToken: string;
  igUserId: string | null;
}, runId: string | null): Promise<{ rows: number; mediaRows: number; commentsRows: number }> {
  if (!supabase || !connection.igUserId) return { rows: 0, mediaRows: 0, commentsRows: 0 };
  const igUserId = connection.igUserId;
  const snapshotDate = toISODate(new Date());
  let mediaRows = 0;
  let commentsRows = 0;

  const mediaResponse: any = await metaGet(`/${igUserId}/media`, connection.accessToken, {
    fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count',
    limit: Number(process.env.INSTAGRAM_MEDIA_SYNC_LIMIT || 50),
  });
  const mediaItems = mediaResponse?.data || [];

  if (mediaItems.length > 0) {
    const mediaRowsToUpsert = mediaItems.map((media: any) => ({
      ig_user_id: igUserId,
      media_id: String(media.id),
      caption: media.caption || null,
      media_type: media.media_type || null,
      media_product_type: media.media_product_type || null,
      permalink: media.permalink || null,
      media_timestamp: media.timestamp || null,
      like_count: parseMetricNumber(media.like_count),
      comments_count: parseMetricNumber(media.comments_count),
      raw: media,
    }));
    await supabase.from('ig_media')
      .upsert(mediaRowsToUpsert, { onConflict: 'ig_user_id,media_id' });
    mediaRows += mediaRowsToUpsert.length;
  }

  const accountMetrics = {
    reach: await fetchInstagramMetric(igUserId, connection.accessToken, 'reach'),
    impressions: await fetchInstagramMetric(igUserId, connection.accessToken, 'impressions'),
    profile_views: await fetchInstagramMetric(igUserId, connection.accessToken, 'profile_views'),
    follows: await fetchInstagramMetric(igUserId, connection.accessToken, 'follows'),
    website_clicks: await fetchInstagramMetric(igUserId, connection.accessToken, 'website_clicks'),
  };

  await supabase.from('ig_account_insights_daily').upsert({
    sync_run_id: runId,
    ig_user_id: igUserId,
    snapshot_date: snapshotDate,
    reach: accountMetrics.reach,
    impressions: accountMetrics.impressions,
    profile_views: accountMetrics.profile_views,
    follows: accountMetrics.follows,
    website_clicks: accountMetrics.website_clicks,
    metrics: accountMetrics,
    raw: { metrics: accountMetrics },
  }, { onConflict: 'ig_user_id,snapshot_date' });

  await enqueueMetaAnalysisTask(supabase, {
    direction: 'incoming',
    sourceType: 'instagram_account_insights',
    sourceId: `${igUserId}:${snapshotDate}`,
    payload: accountMetrics,
    context: { runId, snapshotDate },
  });

  for (const media of mediaItems.slice(0, Number(process.env.INSTAGRAM_MEDIA_ANALYSIS_LIMIT || 30))) {
    const mediaId = String(media.id || '');
    if (!mediaId) continue;

    const metricMap = await fetchMediaMetrics(mediaId, connection.accessToken);
    await supabase.from('ig_media_insights_daily').upsert({
      sync_run_id: runId,
      ig_user_id: igUserId,
      media_id: mediaId,
      snapshot_date: snapshotDate,
      reach: parseMetricNumber(metricMap.reach),
      impressions: parseMetricNumber(metricMap.impressions),
      views: parseMetricNumber(metricMap.views || metricMap.video_views || metricMap.plays),
      likes: parseMetricNumber(metricMap.likes),
      comments: parseMetricNumber(metricMap.comments),
      saves: parseMetricNumber(metricMap.saved),
      shares: parseMetricNumber(metricMap.shares),
      metrics: metricMap,
      raw: metricMap,
    }, { onConflict: 'ig_user_id,media_id,snapshot_date' });
    mediaRows += 1;

    await enqueueMetaAnalysisTask(supabase, {
      direction: 'incoming',
      sourceType: 'instagram_media_insight',
      sourceId: `${mediaId}:${snapshotDate}`,
      trendTerm: String(media.caption || '').slice(0, 120) || undefined,
      payload: {
        media,
        metrics: metricMap,
      },
      context: { runId, snapshotDate },
    });

    try {
      const commentsResponse: any = await metaGet(`/${mediaId}/comments`, connection.accessToken, {
        fields: 'id,text,username,timestamp,like_count,hidden',
        limit: Number(process.env.INSTAGRAM_COMMENTS_SYNC_LIMIT || 50),
      });
      const comments = commentsResponse?.data || [];
      if (comments.length > 0) {
        const commentRows = comments.map((comment: any) => ({
          ig_user_id: igUserId,
          media_id: mediaId,
          comment_id: String(comment.id),
          parent_comment_id: null,
          username: comment.username || null,
          text: comment.text || null,
          like_count: parseMetricNumber(comment.like_count),
          comment_timestamp: comment.timestamp || null,
          hidden: !!comment.hidden,
          raw: comment,
        }));
        await supabase.from('ig_comments')
          .upsert(commentRows, { onConflict: 'comment_id' });
        commentsRows += commentRows.length;
      }
    } catch {
      // Comments access can fail when permissions are partial; keep sync resilient.
    }
  }

  return {
    rows: mediaRows + commentsRows + 1,
    mediaRows,
    commentsRows,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (!requireAdminAuth(req, res, { allowCron: true })) return;

  const connection = await resolveMetaConnection(supabase);
  if (!connection) {
    return res.status(200).json({ error: 'Meta connection is not configured' });
  }

  if (req.method === 'GET') {
    const tokenInfo = await inspectMetaToken(connection);
    const { data: latestRuns } = await supabase
      .from('meta_sync_runs')
      .select('id, scope, mode, status, rows_synced, started_at, completed_at, error')
      .order('started_at', { ascending: false })
      .limit(15);

    const { count: pendingQueue } = await supabase
      .from('meta_analysis_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    const { count: failedQueue } = await supabase
      .from('meta_analysis_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed');

    return res.status(200).json({
      connection: {
        source: connection.source,
        adAccountId: connection.adAccountId,
        pageId: connection.pageId,
        igUserId: connection.igUserId,
        scopes: connection.scopes,
      },
      tokenInspection: tokenInfo,
      latestRuns: latestRuns || [],
      queue: {
        pending: pendingQueue || 0,
        failed: failedQueue || 0,
      },
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const scope = parseScope(req.body?.scope || req.query.scope);
  const mode = parseMode(req.body?.mode || req.query.mode);
  const { fromDate, toDate } = dateRange(mode, req.body?.fromDate || req.query.fromDate, req.body?.toDate || req.query.toDate);
  const runId = await startSyncRun(scope, mode, fromDate, toDate);

  let rowsSynced = 0;
  const detail: Record<string, any> = {};

  try {
    if (scope === 'ads' || scope === 'all') {
      const adsResult = await syncAds(connection, runId, fromDate, toDate);
      rowsSynced += adsResult.rows;
      detail.ads = adsResult;
    }

    if (scope === 'instagram' || scope === 'all') {
      const igUserId = connection.igUserId || await resolveInstagramUserId(connection);
      const instagramResult = await syncInstagram({
        accessToken: connection.accessToken,
        igUserId,
      }, runId);
      rowsSynced += instagramResult.rows;
      detail.instagram = instagramResult;
    }

    const queueStats = await processMetaAnalysisQueue(supabase, PROCESS_QUEUE_LIMIT);
    detail.analysisQueue = queueStats;

    await finishSyncRun(runId, {
      status: 'completed',
      rowsSynced,
      metadata: detail,
    });

    return res.status(200).json({
      ok: true,
      runId,
      scope,
      mode,
      fromDate,
      toDate,
      rowsSynced,
      detail,
    });
  } catch (error: any) {
    const message = String(error?.response?.data?.error?.message || error?.message || error || 'unknown sync error');
    await finishSyncRun(runId, {
      status: 'failed',
      rowsSynced,
      error: message,
      metadata: detail,
    });
    return res.status(500).json({
      error: 'Meta sync failed',
      runId,
      message,
      rowsSynced,
      detail,
    });
  }
}
