import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

export interface MetaAnalysisTask {
  direction: 'incoming' | 'outgoing';
  sourceType: string;
  sourceId?: string;
  trendTerm?: string;
  payload: any;
  context?: any;
}

export interface MetaAnalysisResult {
  provider: string;
  model: string;
  summary: string;
  scores: {
    focusScore: number;
    audienceFitScore: number;
    conversionLikelihoodScore: number;
    complianceRiskScore: number;
  };
  opportunities: string[];
  risks: string[];
  recommendations: string[];
  nextActions: string[];
  ga4Context?: any;
}

type SupabaseClientLike = any;

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = String(process.env.META_ANALYZER_MODEL_OPENAI || process.env.OPENAI_MODEL || 'gpt-5').trim();
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim();

const ANTHROPIC_API_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
const ANTHROPIC_MODEL = String(process.env.META_ANALYZER_MODEL_ANTHROPIC || 'claude-opus-4-1').trim();
const ANTHROPIC_BASE_URL = String(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').trim();

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
const GEMINI_MODEL = String(process.env.META_ANALYZER_MODEL_GEMINI || 'gemini-2.5-pro').trim();

const ANALYZER_PROVIDER = String(process.env.META_ANALYZER_PROVIDER || 'auto').trim().toLowerCase();
const ANALYZER_ENABLED = String(process.env.META_ANALYZER_ENABLED || 'true').trim().toLowerCase() !== 'false';

const geminiClient = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function safeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 10);
}

function extractJsonObject(text: string): any | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeResult(raw: any, fallback: MetaAnalysisResult): MetaAnalysisResult {
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    provider: String(raw.provider || fallback.provider),
    model: String(raw.model || fallback.model),
    summary: String(raw.summary || fallback.summary),
    scores: {
      focusScore: clamp(Number(raw?.scores?.focusScore ?? fallback.scores.focusScore)),
      audienceFitScore: clamp(Number(raw?.scores?.audienceFitScore ?? fallback.scores.audienceFitScore)),
      conversionLikelihoodScore: clamp(Number(raw?.scores?.conversionLikelihoodScore ?? fallback.scores.conversionLikelihoodScore)),
      complianceRiskScore: clamp(Number(raw?.scores?.complianceRiskScore ?? fallback.scores.complianceRiskScore)),
    },
    opportunities: safeStringArray(raw.opportunities).length ? safeStringArray(raw.opportunities) : fallback.opportunities,
    risks: safeStringArray(raw.risks).length ? safeStringArray(raw.risks) : fallback.risks,
    recommendations: safeStringArray(raw.recommendations).length ? safeStringArray(raw.recommendations) : fallback.recommendations,
    nextActions: safeStringArray(raw.nextActions).length ? safeStringArray(raw.nextActions) : fallback.nextActions,
    ga4Context: raw.ga4Context ?? fallback.ga4Context,
  };
}

function heuristicAnalysis(task: MetaAnalysisTask, ga4Context?: any): MetaAnalysisResult {
  const payload = task.payload || {};
  const ctr = Number(payload.ctr ?? payload.avg_ctr ?? 0);
  const cpc = Number(payload.cpc ?? payload.avg_cpc ?? 0);
  const purchases = Number(payload.purchase_count ?? payload.purchases ?? 0);
  const spend = Number(payload.spend ?? payload.total_spend ?? 0);
  const searchGap = Number(ga4Context?.funnel?.search_impressions || 0) - Number(ga4Context?.funnel?.conversion_events || 0);

  const focusScore = clamp(50 + ctr * 8 - cpc * 3);
  const audienceFitScore = clamp(45 + ctr * 6 + (ga4Context?.backtest?.composite_score ? Number(ga4Context.backtest.composite_score) * 0.15 : 0));
  const conversionLikelihoodScore = clamp(40 + purchases * 2 + (searchGap > 0 ? 10 : 0));
  const complianceRiskScore = clamp(18 + (spend > 250 ? 10 : 0));

  return {
    provider: 'heuristic',
    model: 'rule-based',
    summary: `Rule-based analysis for ${task.sourceType}: focus ${focusScore}/100, audience fit ${audienceFitScore}/100, conversion likelihood ${conversionLikelihoodScore}/100.`,
    scores: {
      focusScore,
      audienceFitScore,
      conversionLikelihoodScore,
      complianceRiskScore,
    },
    opportunities: [
      'Match targeting with high-growth GA4 backtest terms and offer-intent clusters.',
      'Promote creatives with stronger save/share hooks and clear call-to-action copy.',
    ],
    risks: [
      'Weak audience segmentation can inflate CPC and reduce conversion efficiency.',
      'Attribution lag may temporarily understate purchase outcomes in recent windows.',
    ],
    recommendations: [
      'Refresh lookback windows daily and compare last 7d vs prior 7d by campaign.',
      'Prioritize ad sets tied to GA4 offer_type terms with high funnel drop-off.',
    ],
    nextActions: [
      'Run incremental sync and re-score active drafts before publication.',
      'Route low-fit drafts to manual review with revised audience lists.',
    ],
    ga4Context,
  };
}

function analysisPrompt(task: MetaAnalysisTask, ga4Context: any): string {
  return [
    'You are a senior Meta/Instagram performance strategist for a local food business.',
    'Analyze incoming Meta/Instagram data or outgoing ad payloads with strict focus on unmet local demand.',
    'Use GA4 context as calibration evidence, not as the sole decision signal.',
    'Evaluate targeting spec, audience lists, placements, objective choice, creative fit, conversion likelihood, and risk.',
    'Return valid JSON only with this exact shape:',
    '{"provider":"...","model":"...","summary":"...","scores":{"focusScore":0,"audienceFitScore":0,"conversionLikelihoodScore":0,"complianceRiskScore":0},"opportunities":["..."],"risks":["..."],"recommendations":["..."],"nextActions":["..."],"ga4Context":{}}',
    `Direction: ${task.direction}`,
    `SourceType: ${task.sourceType}`,
    `TrendTerm: ${task.trendTerm || ''}`,
    `Payload JSON: ${JSON.stringify(task.payload || {})}`,
    `Context JSON: ${JSON.stringify(task.context || {})}`,
    `GA4 Context JSON: ${JSON.stringify(ga4Context || {})}`,
  ].join('\n');
}

async function runOpenAI(prompt: string): Promise<any> {
  if (!OPENAI_API_KEY) return null;
  const { data } = await axios.post(`${OPENAI_BASE_URL}/chat/completions`, {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: 'Return strict JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  }, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: Number(process.env.EXTERNAL_TIMEOUT_MS || 12000) * 2,
  });

  return extractJsonObject(String(data?.choices?.[0]?.message?.content || ''));
}

async function runAnthropic(prompt: string): Promise<any> {
  if (!ANTHROPIC_API_KEY) return null;
  const { data } = await axios.post(`${ANTHROPIC_BASE_URL}/messages`, {
    model: ANTHROPIC_MODEL,
    max_tokens: 1200,
    temperature: 0,
    system: 'Return strict JSON only.',
    messages: [{ role: 'user', content: prompt }],
  }, {
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    timeout: Number(process.env.EXTERNAL_TIMEOUT_MS || 12000) * 2,
  });

  const text = Array.isArray(data?.content)
    ? data.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
    : '';
  return extractJsonObject(text);
}

async function runGemini(prompt: string): Promise<any> {
  if (!geminiClient) return null;
  const response = await geminiClient.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  });
  return extractJsonObject(String(response?.text || ''));
}

async function pickProvider(prompt: string): Promise<{ provider: string; model: string; json: any | null }> {
  const provider = ANALYZER_PROVIDER;

  if (provider === 'openai') {
    return { provider: 'openai', model: OPENAI_MODEL, json: await runOpenAI(prompt) };
  }
  if (provider === 'anthropic') {
    return { provider: 'anthropic', model: ANTHROPIC_MODEL, json: await runAnthropic(prompt) };
  }
  if (provider === 'gemini') {
    return { provider: 'gemini', model: GEMINI_MODEL, json: await runGemini(prompt) };
  }

  if (OPENAI_API_KEY) {
    const json = await runOpenAI(prompt);
    if (json) return { provider: 'openai', model: OPENAI_MODEL, json };
  }
  if (ANTHROPIC_API_KEY) {
    const json = await runAnthropic(prompt);
    if (json) return { provider: 'anthropic', model: ANTHROPIC_MODEL, json };
  }
  if (geminiClient) {
    const json = await runGemini(prompt);
    if (json) return { provider: 'gemini', model: GEMINI_MODEL, json };
  }

  return { provider: 'heuristic', model: 'rule-based', json: null };
}

async function loadGA4Context(supabase: SupabaseClientLike, term?: string): Promise<any> {
  if (!supabase) return {};
  const context: Record<string, any> = {};

  try {
    if (term) {
      const { data: backtest } = await supabase
        .from('ga4_backtest_results')
        .select('term, term_type, composite_score, growth_rate, recent_monthly_avg, older_monthly_avg')
        .ilike('term', term)
        .order('composite_score', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (backtest) context.backtest = backtest;

      const { data: funnel } = await supabase
        .from('term_funnel')
        .select('term, date, search_impressions, page_views, conversion_events, conversion_rate, dropoff_stage')
        .ilike('term', term)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (funnel) context.funnel = funnel;
    }

    const { data: topBacktest } = await supabase
      .from('ga4_backtest_results')
      .select('term, composite_score, growth_rate, term_type')
      .order('composite_score', { ascending: false })
      .limit(5);
    if (topBacktest) context.topBacktest = topBacktest;
  } catch {
    // Non-fatal: context is optional for runtime safety.
  }

  return context;
}

export async function analyzeMetaTask(
  task: MetaAnalysisTask,
  options: { supabase?: SupabaseClientLike; ga4Context?: any } = {}
): Promise<MetaAnalysisResult> {
  const ga4Context = options.ga4Context ?? await loadGA4Context(options.supabase, task.trendTerm);
  const fallback = heuristicAnalysis(task, ga4Context);
  if (!ANALYZER_ENABLED) return fallback;

  const prompt = analysisPrompt(task, ga4Context);

  try {
    const providerResult = await pickProvider(prompt);
    if (!providerResult.json) return fallback;

    const normalized = normalizeResult(providerResult.json, {
      ...fallback,
      provider: providerResult.provider,
      model: providerResult.model,
    });
    normalized.provider = providerResult.provider;
    normalized.model = providerResult.model;
    normalized.ga4Context = ga4Context;
    return normalized;
  } catch {
    return fallback;
  }
}

export async function enqueueMetaAnalysisTask(
  supabase: SupabaseClientLike,
  task: MetaAnalysisTask
): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from('meta_analysis_queue')
      .insert({
        direction: task.direction,
        source_type: task.sourceType,
        source_id: task.sourceId || null,
        trend_term: task.trendTerm || null,
        payload: task.payload || {},
        context: task.context || {},
        status: 'pending',
      })
      .select('id')
      .maybeSingle();

    return data?.id || null;
  } catch {
    return null;
  }
}

export async function persistMetaAnalysisReport(
  supabase: SupabaseClientLike,
  task: MetaAnalysisTask,
  analysis: MetaAnalysisResult
): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from('meta_analysis_reports')
      .insert({
        direction: task.direction,
        source_type: task.sourceType,
        source_id: task.sourceId || null,
        trend_term: task.trendTerm || null,
        provider: analysis.provider,
        model: analysis.model,
        summary: analysis.summary,
        scores: analysis.scores,
        opportunities: analysis.opportunities,
        risks: analysis.risks,
        recommendations: analysis.recommendations,
        next_actions: analysis.nextActions,
        ga4_context: analysis.ga4Context || {},
        payload: task.payload || {},
      })
      .select('id')
      .maybeSingle();

    return data?.id || null;
  } catch {
    return null;
  }
}

export async function processMetaAnalysisQueue(
  supabase: SupabaseClientLike,
  limit = 10
): Promise<{ processed: number; failed: number }> {
  if (!supabase || limit <= 0) return { processed: 0, failed: 0 };

  const { data: jobs } = await supabase
    .from('meta_analysis_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  const rows = jobs || [];
  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await supabase
        .from('meta_analysis_queue')
        .update({ status: 'processing', attempts: Number(row.attempts || 0) + 1 })
        .eq('id', row.id);

      const task: MetaAnalysisTask = {
        direction: row.direction,
        sourceType: row.source_type,
        sourceId: row.source_id || undefined,
        trendTerm: row.trend_term || undefined,
        payload: row.payload || {},
        context: row.context || {},
      };

      const analysis = await analyzeMetaTask(task, { supabase });
      const reportId = await persistMetaAnalysisReport(supabase, task, analysis);

      await supabase
        .from('meta_analysis_queue')
        .update({
          status: 'completed',
          report_id: reportId,
          processed_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', row.id);
      processed += 1;
    } catch (error: any) {
      await supabase
        .from('meta_analysis_queue')
        .update({
          status: 'failed',
          last_error: String(error?.message || error || 'unknown error'),
          processed_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      failed += 1;
    }
  }

  return { processed, failed };
}

export async function analyzeAndPersist(
  supabase: SupabaseClientLike,
  task: MetaAnalysisTask
): Promise<{ reportId: string | null; analysis: MetaAnalysisResult }> {
  const analysis = await analyzeMetaTask(task, { supabase });
  const reportId = await persistMetaAnalysisReport(supabase, task, analysis);
  return { reportId, analysis };
}
