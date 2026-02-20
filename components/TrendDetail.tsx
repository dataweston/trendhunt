import React, { useState, useEffect } from 'react';
import { TrendEntity, AnalysisResult } from '../types';
import { analyzeTrendWithGemini } from '../services/geminiService';
import { X, BrainCircuit, Loader2, FileText, Copy, Check, ExternalLink } from 'lucide-react';
import { TrendTimeSeries } from './Visualizations';

interface PageDraft {
  title: string;
  subtitle: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  seoKeywords: string[];
  suggestedPrice: number;
}

interface TrendDetailProps {
  trend: TrendEntity | null;
  onClose: () => void;
}

export const TrendDetail: React.FC<TrendDetailProps> = ({ trend, onClose }) => {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<PageDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (trend) {
      setLoading(true);
      setAnalysis(null);
      setDraft(null);
      setDraftError(null);
      analyzeTrendWithGemini(trend)
        .then(setAnalysis)
        .finally(() => setLoading(false));
    }
  }, [trend]);

  const generateCopy = async () => {
    if (!trend) return;
    setDraftLoading(true);
    setDraftError(null);
    try {
      const res = await fetch('/api/generate-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trendId: trend.id }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      const d = data.draft;
      setDraft({
        title: d.title,
        subtitle: d.subtitle,
        description: d.description,
        seoTitle: d.seo_title || d.seoTitle,
        seoDescription: d.seo_description || d.seoDescription,
        seoKeywords: d.seo_keywords || d.seoKeywords || [],
        suggestedPrice: d.suggested_price || d.suggestedPrice,
      });
    } catch (e) {
      console.error('Generate copy failed:', e);
      setDraftError('Failed to generate copy. Make sure this term is tracked (not a search-only result).');
    } finally {
      setDraftLoading(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const copyAllAsMarkdown = () => {
    if (!draft) return;
    const md = `# ${draft.title}\n\n*${draft.subtitle}*\n\n${draft.description}\n\n---\n\n**SEO Title:** ${draft.seoTitle}\n**SEO Description:** ${draft.seoDescription}\n**Keywords:** ${draft.seoKeywords.join(', ')}\n**Suggested Price:** $${draft.suggestedPrice}`;
    copyToClipboard(md, 'all');
  };

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

          {/* All Signal Breakdown */}
          <div className="bg-slate-800/30 rounded-lg border border-slate-700 p-4">
            <h3 className="text-sm font-medium text-slate-300 mb-3">All Signal Sources</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {trend.signals.filter(s => s.currentIntensity > 0 || s.velocity !== 0).map(s => {
                const labels: Record<string, string> = {
                  GoogleSearch: 'Google Trends', Yelp: 'Yelp Supply', DoorDash: 'Delivery Search',
                  Reddit: 'Reddit', TikTok: 'TikTok', Pinterest: 'Pinterest',
                  OwnTraffic: 'Your GA4 Traffic', OwnSales: 'Your Square Sales',
                  Wildchat: 'LLM Mentions', MetaAds: 'Meta Ads', RedditPushshift: 'Reddit Archive',
                  YouTube: 'YouTube', GoogleNews: 'Google News', GoogleMaps: 'Google Maps Supply',
                };
                const colors: Record<string, string> = {
                  GoogleSearch: 'text-blue-400', Yelp: 'text-red-400', Reddit: 'text-orange-400',
                  TikTok: 'text-cyan-400', Pinterest: 'text-pink-400', OwnTraffic: 'text-violet-400',
                  OwnSales: 'text-emerald-400', DoorDash: 'text-red-500', Wildchat: 'text-yellow-400',
                  MetaAds: 'text-blue-500', YouTube: 'text-red-500', GoogleNews: 'text-blue-300',
                  GoogleMaps: 'text-green-400',
                };
                return (
                  <div key={s.platform} className="bg-slate-900/50 p-3 rounded border border-slate-700/50">
                    <div className={`text-xs font-bold ${colors[s.platform] || 'text-slate-400'} mb-1`}>{labels[s.platform] || s.platform}</div>
                    <div className="text-lg font-bold text-white">{s.currentIntensity}</div>
                    <div className={`text-xs ${s.velocity > 0 ? 'text-emerald-400' : s.velocity < 0 ? 'text-red-400' : 'text-slate-500'}`}>
                      {s.velocity > 0 ? '+' : ''}{s.velocity} velocity
                    </div>
                  </div>
                );
              })}
              {trend.signals.filter(s => s.currentIntensity > 0 || s.velocity !== 0).length === 0 && (
                <p className="col-span-3 text-xs text-slate-500">No signals detected for this term.</p>
              )}
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

          {/* Generate Website Copy */}
          <div className="bg-slate-800/30 border border-slate-700 rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 text-slate-200">
                <FileText size={20} />
                <h3 className="font-semibold">Website Copy Generator</h3>
              </div>
              {!draft && (
                <button
                  onClick={generateCopy}
                  disabled={draftLoading || !trend.id || trend.id === trend.term.replace(/\s+/g, '-').toLowerCase()}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {draftLoading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                  {draftLoading ? 'Generating...' : 'Generate Copy'}
                </button>
              )}
            </div>

            {!draft && !draftLoading && !draftError && (
              <p className="text-sm text-slate-400">
                Generate product page copy, SEO metadata, and pricing suggestions based on this trend's signals. 
                Copy can be pasted into your Sanity CMS or any website.
                {(!trend.id || trend.id === trend.term.replace(/\s+/g, '-').toLowerCase()) && (
                  <span className="block mt-2 text-yellow-400/70 text-xs">This term must be tracked (approved from Discovery Queue) to generate copy.</span>
                )}
              </p>
            )}

            {draftError && (
              <p className="text-sm text-red-400">{draftError}</p>
            )}

            {draft && (
              <div className="space-y-4">
                {/* Title + Subtitle */}
                <div className="bg-slate-900/50 p-4 rounded border border-slate-700/50">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="text-xs text-emerald-400 uppercase font-bold">Page Title</h4>
                    <button onClick={() => copyToClipboard(draft.title, 'title')} className="text-slate-500 hover:text-white transition-colors">
                      {copied === 'title' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                  <p className="text-lg font-bold text-white">{draft.title}</p>
                  <p className="text-sm text-slate-300 italic mt-1">{draft.subtitle}</p>
                </div>

                {/* Description */}
                <div className="bg-slate-900/50 p-4 rounded border border-slate-700/50">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="text-xs text-emerald-400 uppercase font-bold">Product Description</h4>
                    <button onClick={() => copyToClipboard(draft.description, 'desc')} className="text-slate-500 hover:text-white transition-colors">
                      {copied === 'desc' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                  <div className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">{draft.description}</div>
                </div>

                {/* SEO + Price */}
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="bg-slate-900/50 p-4 rounded border border-slate-700/50">
                    <h4 className="text-xs text-blue-400 uppercase font-bold mb-2">SEO Metadata</h4>
                    <div className="space-y-2 text-xs">
                      <div>
                        <span className="text-slate-500">Title: </span>
                        <span className="text-slate-200">{draft.seoTitle}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Description: </span>
                        <span className="text-slate-200">{draft.seoDescription}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Keywords: </span>
                        <span className="text-slate-200">{draft.seoKeywords.join(', ')}</span>
                      </div>
                    </div>
                  </div>
                  <div className="bg-slate-900/50 p-4 rounded border border-slate-700/50">
                    <h4 className="text-xs text-orange-400 uppercase font-bold mb-2">Suggested Price</h4>
                    <div className="text-3xl font-bold text-white">${draft.suggestedPrice}</div>
                    <p className="text-xs text-slate-500 mt-1">Based on Local Effort pricing and market signals</p>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={copyAllAsMarkdown}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    {copied === 'all' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    {copied === 'all' ? 'Copied!' : 'Copy All as Markdown'}
                  </button>
                  <button
                    onClick={generateCopy}
                    disabled={draftLoading}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm transition-colors"
                  >
                    <FileText size={14} />
                    Regenerate
                  </button>
                </div>
              </div>
            )}
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
