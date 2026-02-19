/**
 * Meta Ads Integration
 * GET  /api/meta-ads              — read campaign performance as signal data
 * POST /api/meta-ads/create       — create a draft (PAUSED) campaign for a trend
 */
import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { GoogleGenAI, Type } from '@google/genai';

const META_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.FACEBOOK_AD_ACCOUNT_ID;
const GEMINI_API_KEY = process.env.API_KEY;

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const META_API = 'https://graph.facebook.com/v21.0';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    return res.status(200).json({ error: 'Meta Ads not configured', campaigns: [] });
  }

  // GET: read campaign performance
  if (req.method === 'GET') {
    try {
      const { data } = await axios.get(`${META_API}/act_${META_AD_ACCOUNT_ID}/campaigns`, {
        params: {
          access_token: META_ACCESS_TOKEN,
          fields: 'id,name,status,objective,insights.date_preset(last_30d){impressions,clicks,spend,actions}',
          limit: 50,
        },
      });

      const campaigns = (data.data || []).map((c: any) => {
        const insights = c.insights?.data?.[0] || {};
        const purchases = (insights.actions || []).find((a: any) => a.action_type === 'purchase')?.value || 0;
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          impressions: parseInt(insights.impressions || '0', 10),
          clicks: parseInt(insights.clicks || '0', 10),
          spend: parseFloat(insights.spend || '0'),
          purchases: parseInt(purchases, 10),
        };
      });

      return res.status(200).json({ campaigns });
    } catch (error: any) {
      console.error('Meta Ads read error:', error?.response?.data || error);
      return res.status(200).json({ error: 'Failed to read campaigns', campaigns: [] });
    }
  }

  // POST: create draft campaign for a trend
  if (req.method === 'POST') {
    const { trendTerm, neighborhood, budget = 10 } = req.body || {};
    if (!trendTerm) return res.status(400).json({ error: 'trendTerm required' });

    try {
      // Generate ad copy with Gemini
      let adCopy = { headline: trendTerm, body: `Try ${trendTerm} from Local Effort.`, description: 'Local food, locally sourced.' };
      if (ai) {
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Write a Facebook ad for Local Effort, a Minneapolis farm-to-table food company. The ad promotes "${trendTerm}" available in the ${neighborhood || 'Twin Cities'} area. Local Effort sources 100% locally from Minnesota farms. Tone: warm, artisanal, appetizing. Keep it short.`,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  headline: { type: Type.STRING },
                  body: { type: Type.STRING },
                  description: { type: Type.STRING },
                },
              },
            },
          });
          if (response.text) adCopy = JSON.parse(response.text);
        } catch { /* use default copy */ }
      }

      // Create campaign in PAUSED state
      const { data: campaign } = await axios.post(`${META_API}/act_${META_AD_ACCOUNT_ID}/campaigns`, null, {
        params: {
          access_token: META_ACCESS_TOKEN,
          name: `[TrendHunt] ${trendTerm}`,
          objective: 'OUTCOME_TRAFFIC',
          status: 'PAUSED',
          special_ad_categories: '[]',
        },
      });

      return res.status(200).json({
        ok: true,
        campaignId: campaign.id,
        adCopy,
        suggestedDailyBudget: budget,
        note: 'Campaign created in PAUSED state. Review and activate in Meta Ads Manager.',
      });
    } catch (error: any) {
      console.error('Meta Ads create error:', error?.response?.data || error);
      return res.status(500).json({ error: 'Failed to create campaign' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
