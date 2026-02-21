import React, { useState, useCallback } from 'react';
import { Loader2, TrendingUp, TrendingDown, ArrowRight, BarChart3, Clock, Zap } from 'lucide-react';
import { getAdminHeaders, getStoredAdminToken, setStoredAdminToken } from '../services/adminAuth';

interface BacktestCandidate {
  term: string;
  termType?: 'food_concept' | 'offer_type' | 'nav_noise';
  source: string;
  compositeScore: number;
  totalViews: number;
  recentMonthlyAvg: number;
  olderMonthlyAvg: number;
  growthRate: number;
  linearSlope: number;
  acceleration: number;
  seasonalityIndex: number;
  monthCount: number;
  monthlyData: { yearMonth: string; views: number }[];
}

interface BacktestResult {
  ok: boolean;
  stats: {
    paths: number;
    titles: number;
    searches: number;
    organicLandings: number;
    siteSearchEventRows?: number;
    siteSearchAcceptedRows?: number;
    siteSearchConfigured?: number;
  };
  candidateCount: number;
  queuedTerms: string[];
  candidates: BacktestCandidate[];
}

// Sparkline: tiny inline chart of monthly data
function Sparkline({ data, width = 120, height = 28 }: { data: { yearMonth: string; views: number }[]; width?: number; height?: number }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data.map(d => d.views), 1);
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (d.views / max) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(' ');

  // Color based on trend direction
  const recent = data.slice(-3).reduce((a, d) => a + d.views, 0) / 3;
  const older = data.slice(0, 3).reduce((a, d) => a + d.views, 0) / 3;
  const color = recent > older * 1.1 ? '#34d399' : recent < older * 0.9 ? '#f87171' : '#94a3b8';

  return (
    <svg width={width} height={height} className="inline-block">
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  );
}

export function BacktestPanel({ onApproved }: { onApproved?: () => void }) {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoQueue, setAutoQueue] = useState(false);
  const [sortBy, setSortBy] = useState<'score' | 'growth' | 'volume' | 'recent'>('score');
  const [expandedTerm, setExpandedTerm] = useState<string | null>(null);
  const [adminTokenInput, setAdminTokenInput] = useState(() => getStoredAdminToken());
  const [authNotice, setAuthNotice] = useState('');
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [trackedTerms, setTrackedTerms] = useState<Set<string>>(new Set());
  const [trackingTerm, setTrackingTerm] = useState<string | null>(null);

  const trackTerm = useCallback(async (term: string, category: string) => {
    setTrackingTerm(term);
    try {
      const res = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAdminHeaders() },
        body: JSON.stringify({ action: 'direct_track', term, category }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `API ${res.status}`);
      }
      setTrackedTerms((prev: Set<string>) => new Set(prev).add(term));
      if (onApproved) onApproved();
    } catch (e: any) {
      setError(`Track failed for "${term}": ${e.message}`);
    } finally {
      setTrackingTerm(null);
    }
  }, [onApproved]);

  const saveAdminToken = () => {
    setStoredAdminToken(adminTokenInput);
    setAuthNotice(adminTokenInput.trim() ? 'Token saved for this session.' : 'Token cleared.');
    setTimeout(() => setAuthNotice(''), 3000);
  };

  const runBacktest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/ga4-backtest?mode=discover${autoQueue ? '&queue=1' : ''}`;
      const response = await fetch(url, { headers: getAdminHeaders() });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `API ${response.status}`);
      }
      const data: BacktestResult = await response.json();
      setResult(data);
      if (data.queuedTerms.length > 0 && onApproved) onApproved();
    } catch (e: any) {
      setError(e.message || 'Backtest failed');
    } finally {
      setLoading(false);
    }
  }, [autoQueue, onApproved]);

  const sorted = result?.candidates ? [...result.candidates].sort((a, b) => {
    switch (sortBy) {
      case 'growth': return b.growthRate - a.growthRate;
      case 'volume': return b.totalViews - a.totalViews;
      case 'recent': return b.recentMonthlyAvg - a.recentMonthlyAvg;
      default: return b.compositeScore - a.compositeScore;
    }
  }) : [];

  return (
    <div className="space-y-4">
      {/* Admin Token */}
      {!getStoredAdminToken() && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
          <div className="text-xs text-slate-400 mb-2">Enter your admin token (CRON_SECRET) to authenticate API calls:</div>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="Admin token..."
              className="flex-1 bg-slate-900 border border-slate-700 text-sm text-slate-200 rounded px-3 py-1.5 focus:outline-none focus:border-amber-500/50"
              value={adminTokenInput}
              onChange={(e) => setAdminTokenInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveAdminToken()}
            />
            <button onClick={saveAdminToken} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded transition-colors">
              Save
            </button>
          </div>
          {authNotice && <div className="text-xs text-emerald-400 mt-1">{authNotice}</div>}
        </div>
      )}

      {/* Header / Controls */}
      <div className="bg-gradient-to-r from-amber-950/30 to-slate-800/30 rounded-lg border border-amber-500/20 p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-base font-semibold text-amber-200 flex items-center gap-2">
              <BarChart3 size={18} />
              GA4 Historical Backtest
            </h3>
            <p className="text-xs text-amber-100/60 mt-1 max-w-lg">
              Mines 3 years of your restaurant's Google Analytics data — page paths, titles, site search queries, and organic landing pages — to find food keywords showing trend-like growth patterns.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={autoQueue}
                onChange={(e) => setAutoQueue(e.target.checked)}
                className="rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500/50"
              />
              Auto-queue top terms
            </label>
            <button
              onClick={runBacktest}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 text-white text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {loading ? 'Analyzing...' : 'Run Backtest'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-3 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
            {error}
          </div>
        )}

        {/* Debug button */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={async () => {
              setDebugInfo(null);
              try {
                const resp = await fetch('/api/ga4-backtest?mode=debug', { headers: getAdminHeaders() });
                const data = await resp.json();
                setDebugInfo(data);
              } catch (e: any) {
                setDebugInfo({ error: e.message });
              }
            }}
            className="text-[10px] text-slate-500 hover:text-slate-300 underline transition-colors"
          >
            Test GA4 connection
          </button>
        </div>

        {/* Debug output */}
        {debugInfo && (
          <div className="mt-2 bg-slate-900 border border-slate-700 rounded p-3 text-xs font-mono text-slate-300 max-h-64 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(debugInfo, null, 2)}
          </div>
        )}
      </div>

      {/* Results */}
      {result && (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
              <div className="text-[10px] uppercase text-slate-500 font-medium">Pages Mined</div>
              <div className="text-lg font-bold text-white">{result.stats.paths}</div>
            </div>
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
              <div className="text-[10px] uppercase text-slate-500 font-medium">Titles Mined</div>
              <div className="text-lg font-bold text-white">{result.stats.titles}</div>
            </div>
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
              <div className="text-[10px] uppercase text-slate-500 font-medium">Site Searches</div>
              <div className="text-lg font-bold text-white">{result.stats.searches}</div>
            </div>
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
              <div className="text-[10px] uppercase text-slate-500 font-medium">Organic Landings</div>
              <div className="text-lg font-bold text-white">{result.stats.organicLandings}</div>
            </div>
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
              <div className="text-[10px] uppercase text-slate-500 font-medium">Candidates Found</div>
              <div className="text-lg font-bold text-emerald-400">{result.candidateCount}</div>
            </div>
          </div>

          {/* Queued notification */}
          {result.queuedTerms.length > 0 && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-xs text-emerald-300">
              <strong>{result.queuedTerms.length} terms auto-queued:</strong>{' '}
              {result.queuedTerms.join(', ')}
            </div>
          )}

          {/* Sort controls */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">Sort by:</span>
            {(['score', 'growth', 'volume', 'recent'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`px-2 py-1 rounded ${sortBy === s ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'} transition-colors`}
              >
                {s === 'score' ? 'Composite' : s === 'growth' ? 'Growth %' : s === 'volume' ? 'Total Views' : 'Recent Avg'}
              </button>
            ))}
          </div>

          {/* Candidate table */}
          <div className="bg-slate-800/30 rounded-lg border border-slate-700 divide-y divide-slate-700/50">
            {sorted.length === 0 && (
              <div className="p-6 text-center text-sm text-slate-500">
                No food trend candidates found. This might mean your GA4 data has limited food-related page structure.
              </div>
            )}
            {sorted.map((c, i) => (
              <div key={c.term} className="group">
                <div
                  className="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/40 cursor-pointer transition-colors"
                  onClick={() => setExpandedTerm(expandedTerm === c.term ? null : c.term)}
                >
                  {/* Rank */}
                  <span className="text-xs text-slate-500 w-6 text-right shrink-0">#{i + 1}</span>

                  {/* Sparkline */}
                  <div className="shrink-0">
                    <Sparkline data={c.monthlyData} />
                  </div>

                  {/* Term name */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">{c.term}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      via {c.source} &middot; {c.monthCount} months of data
                      {c.termType ? ` • ${c.termType.replace('_', ' ')}` : ''}
                    </div>
                  </div>

                  {/* Growth rate */}
                  <div className="text-right shrink-0 w-20">
                    <div className={`text-sm font-bold flex items-center justify-end gap-1 ${c.growthRate > 0 ? 'text-emerald-400' : c.growthRate < -10 ? 'text-red-400' : 'text-slate-400'}`}>
                      {c.growthRate > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {c.growthRate > 0 ? '+' : ''}{c.growthRate}%
                    </div>
                    <div className="text-[10px] text-slate-500">growth</div>
                  </div>

                  {/* Composite score */}
                  <div className="text-right shrink-0 w-16">
                    <div className={`text-sm font-bold ${c.compositeScore > 40 ? 'text-emerald-400' : c.compositeScore > 20 ? 'text-amber-400' : 'text-slate-400'}`}>
                      {c.compositeScore}
                    </div>
                    <div className="text-[10px] text-slate-500">score</div>
                  </div>

                  {/* Track button */}
                  <button
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); trackTerm(c.term, 'GA4 Backtest'); }}
                    disabled={trackedTerms.has(c.term) || trackingTerm === c.term}
                    className={`shrink-0 px-2.5 py-1 text-[10px] font-medium rounded transition-colors ${
                      trackedTerms.has(c.term)
                        ? 'bg-emerald-900/40 text-emerald-400 cursor-default'
                        : 'bg-slate-700 hover:bg-emerald-700 text-slate-300 hover:text-white'
                    } disabled:cursor-not-allowed`}
                  >
                    {trackingTerm === c.term ? '...' : trackedTerms.has(c.term) ? 'Tracked ✓' : 'Track'}
                  </button>

                  {/* Expand arrow */}
                  <ArrowRight size={14} className={`text-slate-600 transition-transform ${expandedTerm === c.term ? 'rotate-90' : ''}`} />
                </div>

                {/* Expanded detail */}
                {expandedTerm === c.term && (
                  <div className="px-4 pb-4 pt-1 bg-slate-900/30">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                      <div>
                        <span className="text-slate-500">Total Views</span>
                        <div className="text-white font-medium">{c.totalViews.toLocaleString()}</div>
                      </div>
                      <div>
                        <span className="text-slate-500">Recent Monthly Avg</span>
                        <div className="text-white font-medium">{c.recentMonthlyAvg}</div>
                      </div>
                      <div>
                        <span className="text-slate-500">Older Monthly Avg</span>
                        <div className="text-white font-medium">{c.olderMonthlyAvg}</div>
                      </div>
                      <div>
                        <span className="text-slate-500">Linear Slope</span>
                        <div className={`font-medium ${c.linearSlope > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{c.linearSlope > 0 ? '+' : ''}{c.linearSlope}/mo</div>
                      </div>
                      <div>
                        <span className="text-slate-500">Acceleration</span>
                        <div className={`font-medium ${c.acceleration > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>{c.acceleration > 0 ? '+' : ''}{c.acceleration}</div>
                      </div>
                      <div>
                        <span className="text-slate-500">Seasonality</span>
                        <div className="text-white font-medium">{Math.round(c.seasonalityIndex * 100)}%</div>
                      </div>
                      <div className="col-span-2">
                        <span className="text-slate-500">Interpretation</span>
                        <div className="text-slate-300 mt-0.5">
                          {interpretCandidate(c)}
                        </div>
                      </div>
                    </div>

                    {/* Monthly bar chart */}
                    <div className="mt-3">
                      <div className="text-[10px] text-slate-500 mb-1 flex items-center gap-1">
                        <Clock size={10} /> Monthly page views over time
                      </div>
                      <div className="flex items-end gap-[2px] h-16">
                        {c.monthlyData.map((m, mi) => {
                          const maxVal = Math.max(...c.monthlyData.map(d => d.views), 1);
                          const pct = (m.views / maxVal) * 100;
                          const isRecent = mi >= c.monthlyData.length - 6;
                          return (
                            <div
                              key={m.yearMonth}
                              className={`flex-1 rounded-t-sm ${isRecent ? 'bg-emerald-500/60' : 'bg-slate-600/40'}`}
                              style={{ height: `${Math.max(2, pct)}%` }}
                              title={`${m.yearMonth}: ${m.views} views`}
                            />
                          );
                        })}
                      </div>
                      <div className="flex justify-between text-[9px] text-slate-600 mt-0.5">
                        <span>{c.monthlyData[0]?.yearMonth}</span>
                        <span>{c.monthlyData[c.monthlyData.length - 1]?.yearMonth}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Empty state */}
      {!result && !loading && (
        <div className="bg-slate-800/20 border border-slate-700 border-dashed rounded-xl p-8 text-center">
          <BarChart3 size={32} className="mx-auto mb-3 text-amber-500/50" />
          <h3 className="text-sm font-medium text-white mb-2">Mine Your GA4 History</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Click "Run Backtest" to analyze 3 years of Google Analytics data from your restaurant site.
            The system will extract food-related terms from page paths, titles, site search,
            and organic landing pages, then score them for trend-like growth patterns.
          </p>
        </div>
      )}
    </div>
  );
}

function interpretCandidate(c: BacktestCandidate): string {
  const parts: string[] = [];

  if (c.growthRate > 50) parts.push('Strong growth trajectory');
  else if (c.growthRate > 20) parts.push('Moderate growth');
  else if (c.growthRate > 0) parts.push('Slight upward trend');
  else if (c.growthRate > -20) parts.push('Flat or slightly declining');
  else parts.push('Declining interest');

  if (c.acceleration > 0.5) parts.push('growth is accelerating');
  else if (c.acceleration < -0.5) parts.push('growth is decelerating');

  if (c.seasonalityIndex > 0.5) parts.push('highly seasonal');
  else if (c.seasonalityIndex > 0.3) parts.push('some seasonality');

  if (c.recentMonthlyAvg > 50) parts.push('strong recent traffic');
  else if (c.recentMonthlyAvg > 10) parts.push('moderate recent traffic');

  return parts.join('. ') + '.';
}
