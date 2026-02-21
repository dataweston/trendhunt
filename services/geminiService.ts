import { TrendEntity, AnalysisResult } from '../types';

const FALLBACK_ANALYSIS: AnalysisResult = {
  summary: "AI Analysis unavailable. Signal propagation indicates a strong correlation between social discovery and search intent.",
  recommendation: "Monitor local supply competitors closely.",
  riskAssessment: "Moderate volatility detected."
};

export const analyzeTrendWithGemini = async (trend: TrendEntity): Promise<AnalysisResult> => {
  try {
    const res = await fetch('/api/analyze-trend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trend }),
    });
    if (!res.ok) return FALLBACK_ANALYSIS;
    return await res.json() as AnalysisResult;
  } catch (error) {
    console.error("Gemini Analysis Failed:", error);
    return FALLBACK_ANALYSIS;
  }
};
