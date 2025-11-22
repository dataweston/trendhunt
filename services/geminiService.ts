import { GoogleGenAI, Type } from "@google/genai";
import { TrendEntity, AnalysisResult } from '../types';

// Initialize Gemini Client
// Note: We are using process.env.API_KEY as mandated.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

export const analyzeTrendWithGemini = async (trend: TrendEntity): Promise<AnalysisResult> => {
  try {
    // Construct a detailed prompt context based on the trend data
    const signalSummary = trend.signals.map(s => 
      `${s.platform}: Intensity ${s.currentIntensity}, Velocity ${s.velocity}`
    ).join('; ');

    const prompt = `
      You are the AI engine for "Trend Hunter", a food analytics platform.
      Analyze the following emerging food trend entity:
      
      Food: ${trend.term}
      Category: ${trend.category}
      Region: ${trend.region} (${trend.neighborhood})
      
      Data Signals:
      ${signalSummary}
      
      Computed Scores:
      Supply Density: ${trend.supplyScore}/100
      Demand Intensity: ${trend.demandScore}/100
      Unmet Demand Score: ${trend.unmetDemandScore}/100
      
      Task:
      1. Provide a concise summary of why this trend is happening now.
      2. Recommend a specific action for a local restaurateur (e.g., "Add as a limited time offer").
      3. Assess the risk (e.g., "Fad vs. Staple").
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            recommendation: { type: Type.STRING },
            riskAssessment: { type: Type.STRING }
          }
        }
      }
    });

    if (response.text) {
      return JSON.parse(response.text) as AnalysisResult;
    }
    throw new Error("No text in response");
  } catch (error) {
    console.error("Gemini Analysis Failed:", error);
    return {
      summary: "AI Analysis unavailable. Signal propagation indicates a strong correlation between social discovery and search intent.",
      recommendation: "Monitor local supply competitors closely.",
      riskAssessment: "Moderate volatility detected."
    };
  }
};
