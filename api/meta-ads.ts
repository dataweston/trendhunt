/**
 * Meta Ads Integration
 * GET  /api/meta-ads?view=overview|performance|drafts|campaigns
 * POST /api/meta-ads { action: "draft" | "publish" | "analyze", ... }
 *
 * Default POST action is "draft" to keep safety-first behavior.
 * Publish path always creates resources in PAUSED state.
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import { requireAdminAuth } from '../lib/api-auth.js';
import { analyzeAndPersist, enqueueMetaAnalysisTask, processMetaAnalysisQueue } from '../lib/meta-analyzer.js';
import { metaGet, metaPost, parseMetricNumber, resolveMetaConnection } from '../lib/meta-graph.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
const DEFAULT_DAILY_BUDGET = Number(process.env.META_DEFAULT_DAILY_BUDGET || 10);
const DAILY_BUDGET_CAP = Number(process.env.META_DAILY_BUDGET_CAP || 200);
const DEFAULT_LANDING_URL = String(process.env.META_DEFAULT_LANDING_URL || process.env.SITE_URL || 'https://example.com').trim();

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const ALLOWED_OBJECTIVES = new Set([
  'OUTCOME_TRAFFIC',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_SALES',
  'OUTCOME_AWARENESS',
]);

function safeBudget(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_BUDGET;
  return Math.max(1, Math.min(DAILY_BUDGET_CAP, Math.round(n)));
}

function normalizeObjective(input: unknown): string {
  const candidate = String(input || 'OUTCOME_TRAFFIC').trim().toUpperCase();
  if (ALLOWED_OBJECTIVES.has(candidate)) return candidate;
  return 'OUTCOME_TRAFFIC';
}

function parseArray(input: unknown): any[] {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string' && input.trim()) {
    return input.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function buildTargetingSpec(body: any): Record<string, any> {
  const zipCodes = parseArray(body?.zipCodes || body?.zip).map((z) => String(z).trim()).filter(Boolean);
  const countries = parseArray(body?.countries).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
  const interests = parseArray(body?.interests).map((interest) => {
    if (typeof interest === 'object' && interest) return interest;
    return { id: String(interest), name: String(interest) };
  });
  const customAudienceIds = parseArray(body?.customAudienceIds).map((id) => String(id).trim()).filter(Boolean);
  const excludedAudienceIds = parseArray(body?.excludedAudienceIds).map((id) => String(id).trim()).filter(Boolean);

  const targeting: Record<string, any> = {
    age_min: Number(body?.ageMin || 21),
    age_max: Number(body?.ageMax || 65),
    publisher_platforms: parseArray(body?.publisherPlatforms).length
      ? parseArray(body?.publisherPlatforms)
      : ['facebook', 'instagram'],
    facebook_positions: parseArray(body?.facebookPositions),
    instagram_positions: parseArray(body?.instagramPositions),
  };

  if (zipCodes.length > 0) {
    targeting.geo_locations = {
      zips: zipCodes.map((zip) => ({ key: String(zip), country: 'US' })),
    };
  } else if (countries.length > 0) {
    targeting.geo_locations = {
      countries,
    };
  } else {
    targeting.geo_locations = { countries: ['US'] };
  }

  if (interests.length > 0) targeting.interests = interests;
  if (customAudienceIds.length > 0) targeting.custom_audiences = customAudienceIds.map((id) => ({ id }));
  if (excludedAudienceIds.length > 0) targeting.excluded_custom_audiences = excludedAudienceIds.map((id) => ({ id }));

  return targeting;
}

async function generateAdCopy(trendTerm: string, neighborhood: string, objective: string): Promise<{ headline: string; body: string; description: string; callToAction: string }> {
  const fallback = {
    headline: trendTerm,
    body: `Try ${trendTerm} from Local Effort.`,
    description: 'Local food, locally sourced.',
    callToAction: objective === 'OUTCOME_ENGAGEMENT' ? 'Learn More' : 'Order Now',
  };
  if (!ai) return fallback;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Write high-performing Meta ad copy for a local food business.
Trend term: ${trendTerm}
Market: ${neighborhood || 'Twin Cities'}
Objective: ${objective}
Return concise copy with one headline, one primary text body, and one short description.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            headline: { type: Type.STRING },
            body: { type: Type.STRING },
            description: { type: Type.STRING },
            callToAction: { type: Type.STRING },
          },
        },
      },
    });
    if (!response.text) return fallback;
    const parsed = JSON.parse(response.text);
    return {
      headline: String(parsed.headline || fallback.headline),
      body: String(parsed.body || fallback.body),
      description: String(parsed.description || fallback.description),
      callToAction: String(parsed.callToAction || fallback.callToAction),
    };
  } catch {
    return fallback;
  }
}

async function fetchStoredPerformance(days: number, term?: string) {
  if (!supabase) return [];
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - Math.max(1, days));
  const fromIso = fromDate.toISOString().slice(0, 10);

  let query = supabase
    .from('meta_ads_insights_daily')
    .select('entity_id, entity_name, date_start, spend, impressions, clicks, ctr, cpc, purchase_count, add_to_cart_count, initiate_checkout_count')
    .gte('date_start', fromIso)
    .order('date_start', { ascending: false })
    .limit(1200);

  if (term) {
    query = query.ilike('entity_name', `%${term}%`);
  }

  const { data } = await query;
  const rows = data || [];
  const byCampaign = new Map<string, any>();
  for (const row of rows) {
    const key = String(row.entity_id || row.entity_name || 'unknown');
    if (!byCampaign.has(key)) {
      byCampaign.set(key, {
        campaignId: row.entity_id,
        campaignName: row.entity_name,
        spend: 0,
        impressions: 0,
        clicks: 0,
        purchases: 0,
        addToCart: 0,
        initiateCheckout: 0,
        days: 0,
      });
    }
    const agg = byCampaign.get(key);
    agg.spend += Number(row.spend || 0);
    agg.impressions += Number(row.impressions || 0);
    agg.clicks += Number(row.clicks || 0);
    agg.purchases += Number(row.purchase_count || 0);
    agg.addToCart += Number(row.add_to_cart_count || 0);
    agg.initiateCheckout += Number(row.initiate_checkout_count || 0);
    agg.days += 1;
  }

  return Array.from(byCampaign.values()).map((campaign) => ({
    ...campaign,
    ctr: campaign.impressions > 0 ? (campaign.clicks / campaign.impressions) * 100 : 0,
    cpc: campaign.clicks > 0 ? campaign.spend / campaign.clicks : 0,
  })).sort((a, b) => b.spend - a.spend);
}

async function fetchLiveCampaigns(accessToken: string, adAccountId: string) {
  const data: any = await metaGet(`/act_${adAccountId}/campaigns`, accessToken, {
    fields: 'id,name,status,objective,insights.date_preset(last_30d){impressions,clicks,spend,actions}',
    limit: 100,
  });
  return (data?.data || []).map((campaign: any) => {
    const insights = campaign?.insights?.data?.[0] || {};
    const purchases = Array.isArray(insights.actions)
      ? insights.actions.find((a: any) => String(a.action_type || '').toLowerCase().includes('purchase'))?.value
      : 0;
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective,
      impressions: parseMetricNumber(insights.impressions),
      clicks: parseMetricNumber(insights.clicks),
      spend: parseMetricNumber(insights.spend),
      purchases: parseMetricNumber(purchases),
    };
  });
}

async function createDraft(body: any) {
  if (!supabase) throw new Error('Supabase not configured');

  const trendTerm = String(body?.trendTerm || '').trim();
  if (!trendTerm) throw new Error('trendTerm required');

  const objective = normalizeObjective(body?.objective);
  const dailyBudget = safeBudget(body?.budget);
  const neighborhood = String(body?.neighborhood || '').trim();
  const landingUrl = String(body?.landingUrl || DEFAULT_LANDING_URL).trim();
  const targetingSpec = buildTargetingSpec(body);
  const audienceLists = {
    customAudienceIds: parseArray(body?.customAudienceIds),
    excludedAudienceIds: parseArray(body?.excludedAudienceIds),
    lookalikeSources: parseArray(body?.lookalikeSources),
  };
  const adCopy = await generateAdCopy(trendTerm, neighborhood, objective);
  const campaignName = String(body?.campaignName || `[TrendHunt] ${trendTerm}`).trim();

  let trendId: string | null = null;
  try {
    const { data: trend } = await supabase
      .from('trends')
      .select('id')
      .ilike('term', trendTerm)
      .maybeSingle();
    trendId = trend?.id || null;
  } catch {
    trendId = null;
  }

  const payload = {
    name: campaignName,
    objective,
    status: 'PAUSED',
    special_ad_categories: '[]',
  };

  const adsetPayload = {
    name: `${campaignName} - Ad Set`,
    daily_budget: dailyBudget,
    optimization_goal: objective === 'OUTCOME_TRAFFIC' ? 'LINK_CLICKS' : 'OFFSITE_CONVERSIONS',
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: targetingSpec,
    status: 'PAUSED',
  };

  const creativePayload = {
    headline: adCopy.headline,
    body: adCopy.body,
    description: adCopy.description,
    callToAction: adCopy.callToAction,
    link: landingUrl,
  };

  const { data: row } = await supabase
    .from('meta_ad_drafts')
    .insert({
      trend_id: trendId,
      trend_term: trendTerm,
      name: campaignName,
      objective,
      daily_budget: dailyBudget,
      status: 'draft',
      campaign_payload: payload,
      adset_payload: adsetPayload,
      creative_payload: creativePayload,
      targeting_spec: targetingSpec,
      audience_lists: audienceLists,
      created_by: String(body?.createdBy || 'api'),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  const analysisTask = {
    direction: 'outgoing' as const,
    sourceType: 'meta_ad_draft',
    sourceId: row.id,
    trendTerm,
    payload: {
      draftId: row.id,
      campaignPayload: payload,
      adsetPayload,
      creativePayload,
      targetingSpec,
      audienceLists,
    },
    context: {
      neighborhood,
      landingUrl,
    },
  };

  const analysis = await analyzeAndPersist(supabase, analysisTask);
  await supabase.from('meta_ad_drafts')
    .update({ analysis_report_id: analysis.reportId, updated_at: new Date().toISOString() })
    .eq('id', row.id);

  await enqueueMetaAnalysisTask(supabase, analysisTask);

  return {
    draft: {
      ...row,
      analysisReportId: analysis.reportId,
      analysisSummary: analysis.analysis.summary,
    },
  };
}

async function publishDraft(draftId: string) {
  if (!supabase) throw new Error('Supabase not configured');

  const connection = await resolveMetaConnection(supabase);
  if (!connection || !connection.accessToken || !connection.adAccountId) {
    throw new Error('Meta access token/ad account not configured');
  }

  const { data: draft } = await supabase
    .from('meta_ad_drafts')
    .select('*')
    .eq('id', draftId)
    .maybeSingle();

  if (!draft) throw new Error('Draft not found');

  const campaignPayload = draft.campaign_payload || {};
  const adsetPayload = draft.adset_payload || {};
  const creativePayload = draft.creative_payload || {};
  const targetingSpec = draft.targeting_spec || {};
  const dailyBudget = safeBudget(draft.daily_budget);

  const campaign: any = await metaPost(`/act_${connection.adAccountId}/campaigns`, connection.accessToken, {
    ...campaignPayload,
    name: campaignPayload.name || draft.name,
    objective: normalizeObjective(campaignPayload.objective || draft.objective),
    status: 'PAUSED',
    special_ad_categories: '[]',
  });

  const adset: any = await metaPost(`/act_${connection.adAccountId}/adsets`, connection.accessToken, {
    name: adsetPayload.name || `${draft.name} - Ad Set`,
    campaign_id: campaign.id,
    daily_budget: Math.round(dailyBudget * 100),
    billing_event: adsetPayload.billing_event || 'IMPRESSIONS',
    optimization_goal: adsetPayload.optimization_goal || 'LINK_CLICKS',
    bid_strategy: adsetPayload.bid_strategy || 'LOWEST_COST_WITHOUT_CAP',
    targeting: JSON.stringify(targetingSpec),
    status: 'PAUSED',
  });

  let creativeId: string | null = null;
  let adId: string | null = null;
  const notes: string[] = [];

  if (connection.pageId) {
    const callToActionType = String(creativePayload.callToAction || 'LEARN_MORE').toUpperCase().replace(/\s+/g, '_');
    const storySpec = {
      page_id: connection.pageId,
      instagram_actor_id: connection.igUserId || undefined,
      link_data: {
        message: creativePayload.body || draft.trend_term,
        link: creativePayload.link || DEFAULT_LANDING_URL,
        name: creativePayload.headline || draft.name,
        description: creativePayload.description || '',
        call_to_action: {
          type: callToActionType,
          value: { link: creativePayload.link || DEFAULT_LANDING_URL },
        },
      },
    };

    const creative: any = await metaPost(`/act_${connection.adAccountId}/adcreatives`, connection.accessToken, {
      name: `${draft.name} - Creative`,
      object_story_spec: JSON.stringify(storySpec),
    });
    creativeId = String(creative.id || '');

    const ad: any = await metaPost(`/act_${connection.adAccountId}/ads`, connection.accessToken, {
      name: `${draft.name} - Ad`,
      adset_id: adset.id,
      creative: JSON.stringify({ creative_id: creativeId }),
      status: 'PAUSED',
    });
    adId = String(ad.id || '');
  } else {
    notes.push('No FACEBOOK_PAGE_ID or connected page found; created campaign/adset only.');
  }

  await supabase
    .from('meta_ad_drafts')
    .update({
      status: 'published_paused',
      meta_campaign_id: campaign.id,
      meta_adset_id: adset.id,
      meta_ad_id: adId,
      publish_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', draft.id);

  const publishTask = {
    direction: 'outgoing' as const,
    sourceType: 'meta_ad_publish',
    sourceId: draft.id,
    trendTerm: draft.trend_term,
    payload: {
      campaignId: campaign.id,
      adsetId: adset.id,
      adId,
      creativeId,
      draftId: draft.id,
      campaignPayload,
      adsetPayload,
      creativePayload,
      targetingSpec,
      audienceLists: draft.audience_lists || {},
    },
    context: {
      notes,
    },
  };

  const analysis = await analyzeAndPersist(supabase, publishTask);
  await enqueueMetaAnalysisTask(supabase, publishTask);

  return {
    campaignId: campaign.id,
    adsetId: adset.id,
    adId,
    creativeId,
    status: 'PAUSED',
    notes,
    analysisReportId: analysis.reportId,
    analysisSummary: analysis.analysis.summary,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token,authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAdminAuth(req, res)) return;
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    if (req.method === 'GET') {
      const view = String(req.query.view || 'overview').trim().toLowerCase();
      const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
      const term = typeof req.query.term === 'string' ? req.query.term.trim() : '';
      const connection = await resolveMetaConnection(supabase);

      if (view === 'drafts') {
        const { data: drafts } = await supabase
          .from('meta_ad_drafts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(60);
        return res.status(200).json({ drafts: drafts || [] });
      }

      if (view === 'performance') {
        const performance = await fetchStoredPerformance(days, term || undefined);
        return res.status(200).json({ performance, days, term: term || null });
      }

      if (view === 'campaigns') {
        if (!connection?.accessToken || !connection?.adAccountId) {
          return res.status(200).json({ campaigns: [], error: 'Meta Ads not configured' });
        }
        const campaigns = await fetchLiveCampaigns(connection.accessToken, connection.adAccountId);
        return res.status(200).json({ campaigns });
      }

      const [performance, drafts] = await Promise.all([
        fetchStoredPerformance(days, term || undefined),
        supabase.from('meta_ad_drafts').select('*').order('created_at', { ascending: false }).limit(20),
      ]);
      let campaigns: any[] = [];
      if (connection?.accessToken && connection?.adAccountId) {
        campaigns = await fetchLiveCampaigns(connection.accessToken, connection.adAccountId);
      }

      return res.status(200).json({
        performance,
        campaigns,
        drafts: drafts.data || [],
      });
    }

    if (req.method === 'POST') {
      const action = String(req.body?.action || 'draft').trim().toLowerCase();
      if (action === 'draft') {
        const result = await createDraft(req.body || {});
        const publishNow = req.body?.publishNow === true || String(req.body?.publishNow || '').toLowerCase() === 'true';
        if (publishNow) {
          const publish = await publishDraft(result.draft.id);
          const queueStats = await processMetaAnalysisQueue(supabase, Number(process.env.META_ANALYSIS_PROCESS_LIMIT || 10));
          return res.status(200).json({
            ok: true,
            mode: 'draft_and_publish',
            draft: result.draft,
            publish,
            analysisQueue: queueStats,
          });
        }
        const queueStats = await processMetaAnalysisQueue(supabase, Number(process.env.META_ANALYSIS_PROCESS_LIMIT || 5));
        return res.status(200).json({
          ok: true,
          mode: 'draft',
          ...result,
          analysisQueue: queueStats,
        });
      }

      if (action === 'publish') {
        const draftId = String(req.body?.draftId || '').trim();
        if (!draftId) return res.status(400).json({ error: 'draftId required for publish' });
        const publish = await publishDraft(draftId);
        const queueStats = await processMetaAnalysisQueue(supabase, Number(process.env.META_ANALYSIS_PROCESS_LIMIT || 10));
        return res.status(200).json({
          ok: true,
          mode: 'publish',
          publish,
          analysisQueue: queueStats,
        });
      }

      if (action === 'analyze') {
        const payload = req.body?.payload || {};
        const trendTerm = String(req.body?.trendTerm || '').trim() || undefined;
        const sourceId = String(req.body?.sourceId || '').trim() || undefined;
        const task = {
          direction: 'outgoing' as const,
          sourceType: String(req.body?.sourceType || 'manual_meta_analysis'),
          sourceId,
          trendTerm,
          payload,
          context: req.body?.context || {},
        };
        const analysis = await analyzeAndPersist(supabase, task);
        return res.status(200).json({
          ok: true,
          reportId: analysis.reportId,
          analysis: analysis.analysis,
        });
      }

      return res.status(400).json({ error: `Unsupported action: ${action}` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Meta Ads API error:', error?.response?.data || error);
    return res.status(500).json({
      error: 'Meta Ads request failed',
      message: String(error?.response?.data?.error?.message || error?.message || error || 'unknown error'),
    });
  }
}
