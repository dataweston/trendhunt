import React, { useState, useEffect } from 'react';
import { TrendEntity, AnalysisResult } from '../types';
import { analyzeTrendWithGemini } from '../services/geminiService';
import { X, BrainCircuit, Loader2 } from 'lucide-react';
import { TrendTimeSeries } from './Visualizations';

interface TrendDetailProps {
  trend: TrendEntity | null;
  onClose: () => void;
}

export const TrendDetail: React.FC<TrendDetailProps> = ({ trend, onClose }) => {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (trend) {
      setLoading(true);
      setAnalysis(null);
      analyzeTrendWithGemini(trend)
        .then(setAnalysis)
        .finally(() => setLoading(false));
    }
  }, [trend]);

  if (!trend) return null;

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-4xl h-[85vh] rounded-xl shadow-2xl flex flex-col overflow-hidden relative">
        {/* Header */}
        <div className="p-6 border-b border-slate-700 flex justify-between items-start bg-slate-900 z-10">
          <div>
            <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded">
                    Breakout Detected
                </span>
                <span className="text-xs text-slate-400">{trend.region}</span>
            </div>
            <h2 className="text-3xl font-bold text-white">{trend.term}</h2>
            <p className="text-slate-400">{trend.category} • {trend.neighborhood}</p>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white p-2 rounded-full hover:bg-slate-800 transition"
          >
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700">
              <span className="text-sm text-slate-400 block mb-1">Unmet Demand</span>
              <div className="text-3xl font-bold text-red-400">{trend.unmetDemandScore}</div>
            </div>
            <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700">
              <span className="text-sm text-slate-400 block mb-1">Supply Saturation</span>
              <div className="text-3xl font-bold text-slate-200">{trend.supplyScore}%</div>
            </div>
            <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700">
              <span className="text-sm text-slate-400 block mb-1">Breakout Prob.</span>
              <div className="text-3xl font-bold text-emerald-400">{trend.breakoutProbability}%</div>
            </div>
          </div>

          {/* AI Insight */}
          <div className="bg-indigo-950/30 border border-indigo-500/30 rounded-lg p-6 relative">
             <div className="flex items-center gap-2 mb-4 text-indigo-300">
                <BrainCircuit size={20} />
                <h3 className="font-semibold">Gemini Intelligence</h3>
             </div>
             
             {loading ? (
                 <div className="flex items-center gap-3 text-slate-400 py-4">
                     <Loader2 className="animate-spin" />
                     <span>Analyzing cross-platform signals...</span>
                 </div>
             ) : analysis ? (
                 <div className="space-y-4 text-slate-200">
                     <div>
                         <h4 className="text-sm text-indigo-400 uppercase font-bold mb-1">Analysis</h4>
                         <p className="leading-relaxed">{analysis.summary}</p>
                     </div>
                     <div className="grid md:grid-cols-2 gap-4 mt-4">
                        <div className="bg-slate-900/50 p-4 rounded border border-slate-700/50">
                            <h4 className="text-sm text-emerald-400 uppercase font-bold mb-1">Action Item</h4>
                            <p className="text-sm">{analysis.recommendation}</p>
                        </div>
                        <div className="bg-slate-900/50 p-4 rounded border border-slate-700/50">
                            <h4 className="text-sm text-orange-400 uppercase font-bold mb-1">Risk Profile</h4>
                            <p className="text-sm">{analysis.riskAssessment}</p>
                        </div>
                     </div>
                 </div>
             ) : (
                 <div className="text-red-400">Analysis failed. Check API Key configuration.</div>
             )}
          </div>

          {/* Deep Dive Chart */}
          <div>
             <h3 className="text-lg font-semibold text-white mb-4">Signal Source Attribution</h3>
             <TrendTimeSeries trend={trend} />
          </div>

        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 bg-slate-900 flex justify-end">
             <button onClick={onClose} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-medium transition-colors">
                 Close Analysis
             </button>
        </div>
      </div>
    </div>
  );
};
