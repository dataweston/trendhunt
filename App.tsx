import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { LayoutDashboard, Map, Activity, Search, Bell, Loader2, AlertCircle, Inbox, RefreshCw, BarChart3 } from 'lucide-react';
import { trendService } from './services/trendService';
import { TrendEntity } from './types';

const OpportunityTable = lazy(() => import('./components/OpportunityTable').then((m) => ({ default: m.OpportunityTable })));
const TrendDetail = lazy(() => import('./components/TrendDetail').then((m) => ({ default: m.TrendDetail })));
const PropagationGraph = lazy(() => import('./components/Visualizations').then((m) => ({ default: m.PropagationGraph })));
const GeoMap = lazy(() => import('./components/GeoMap').then((m) => ({ default: m.GeoMap })));
const DiscoveryQueue = lazy(() => import('./components/DiscoveryQueue').then((m) => ({ default: m.DiscoveryQueue })));
const BacktestPanel = lazy(() => import('./components/BacktestPanel').then((m) => ({ default: m.BacktestPanel })));

const App = () => {
  const [trends, setTrends] = useState<TrendEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrend, setSelectedTrend] = useState<TrendEntity | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [activeSearch, setActiveSearch] = useState(''); // committed search
  const [activeZip, setActiveZip] = useState(''); // committed zip scope
  const [activeNav, setActiveNav] = useState<'dashboard' | 'geo' | 'queue' | 'backtest'>('dashboard');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const loadData = useCallback(async (query = '', zip = '', forceRefresh = false) => {
    setLoading(true);
    try {
      const data = await trendService.getTrends(query, forceRefresh, zip);
      setTrends(data);
      setError(null);
      setLastRefresh(new Date());
    } catch (error) {
      console.error("Failed to fetch trends", error);
      setError("Failed to load trend data. Please check your connection or API keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load tracked trends on mount (uses cache if available)
  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleForceRefresh = useCallback(() => {
    trendService.clearCache();
    loadData(activeSearch, activeZip, true);
  }, [loadData, activeSearch, activeZip]);

  // Only search when user explicitly submits
  const handleSearch = useCallback(() => {
    const q = searchTerm.trim();
    const z = zipCode.trim();
    setActiveSearch(q);
    setActiveZip(z);
    loadData(q, z);
  }, [searchTerm, zipCode, loadData]);

  const clearSearch = useCallback(() => {
    setSearchTerm('');
    setZipCode('');
    setActiveSearch('');
    setActiveZip('');
    loadData('', '');
  }, [loadData]);

  const activeAlerts = trends.filter(t => t.breakoutProbability > 75).length;

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-200 flex">
      
      {/* Sidebar */}
      <aside className="w-64 bg-[#1e293b] border-r border-slate-800 flex-shrink-0 hidden md:flex flex-col">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-2 text-emerald-400 font-bold text-xl">
             <Activity size={24} />
             <span>TREND HUNTER</span>
          </div>
          <div className="mt-2 text-xs text-slate-500">Early-Signal Food Demand Detector</div>
        </div>
        
        <nav className="flex-1 p-4 space-y-2">
          <button onClick={() => setActiveNav('dashboard')} className={`flex items-center gap-3 px-4 py-3 w-full rounded-lg transition-colors ${activeNav === 'dashboard' ? 'bg-slate-800/50 text-white border border-slate-700 shadow-sm' : 'text-slate-400 hover:bg-slate-800/30 hover:text-slate-200'}`}>
            <LayoutDashboard size={18} />
            <span className="font-medium">Dashboard</span>
          </button>
          <button onClick={() => setActiveNav('geo')} className={`flex items-center gap-3 px-4 py-3 w-full rounded-lg transition-colors ${activeNav === 'geo' ? 'bg-slate-800/50 text-white border border-slate-700 shadow-sm' : 'text-slate-400 hover:bg-slate-800/30 hover:text-slate-200'}`}>
            <Map size={18} />
            <span className="font-medium">Geospatial</span>
          </button>
          <button onClick={() => setActiveNav('queue')} className={`flex items-center gap-3 px-4 py-3 w-full rounded-lg transition-colors ${activeNav === 'queue' ? 'bg-slate-800/50 text-white border border-slate-700 shadow-sm' : 'text-slate-400 hover:bg-slate-800/30 hover:text-slate-200'}`}>
            <Inbox size={18} />
            <span className="font-medium">Discovery Queue</span>
          </button>
          <button onClick={() => setActiveNav('backtest')} className={`flex items-center gap-3 px-4 py-3 w-full rounded-lg transition-colors ${activeNav === 'backtest' ? 'bg-slate-800/50 text-white border border-slate-700 shadow-sm' : 'text-slate-400 hover:bg-slate-800/30 hover:text-slate-200'}`}>
            <BarChart3 size={18} />
            <span className="font-medium">GA4 Backtest</span>
          </button>
          <div className="flex items-center gap-3 px-4 py-3 text-slate-400 hover:bg-slate-800/30 hover:text-slate-200 rounded-lg cursor-pointer transition-colors">
            <Bell size={18} />
            <span className="font-medium">Alerts</span>
            <span className="ml-auto bg-red-500/20 text-red-400 text-xs py-0.5 px-2 rounded-full border border-red-500/20">{activeAlerts}</span>
          </div>
        </nav>

        <div className="p-4 border-t border-slate-800">
           <div className="bg-slate-900/50 p-3 rounded border border-slate-800">
              <div className="text-xs text-slate-500 uppercase font-bold mb-2">System Status</div>
              {loading ? (
                <div className="flex items-center gap-2 text-xs text-yellow-400">
                  <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></div>
                  Fetching signals…
                </div>
              ) : error ? (
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <div className="w-2 h-2 bg-red-400 rounded-full"></div>
                  API error
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-emerald-400">
                  <div className="w-2 h-2 bg-emerald-400 rounded-full"></div>
                  {trends.length} terms tracked
                </div>
              )}
           </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        
        {/* Top Bar */}
        <header className="h-16 bg-[#0f172a]/80 backdrop-blur border-b border-slate-800 flex items-center justify-between px-6 z-20 sticky top-0">
           <div className="flex items-center gap-4 flex-1 max-w-xl">
              <form className="relative w-full flex gap-2" onSubmit={(e) => { e.preventDefault(); handleSearch(); }}>
                 <div className="relative flex-1">
                   <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                   <input 
                      type="text" 
                      placeholder="Search a food term, then press Enter..." 
                      className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-full pl-10 pr-4 py-2 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 transition-all"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                   />
                 </div>
                 <input
                   type="text"
                   inputMode="numeric"
                   pattern="\d{5}"
                   maxLength={5}
                   placeholder="ZIP"
                   className="w-24 bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-full px-3 py-2 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 transition-all"
                   value={zipCode}
                   onChange={(e) => setZipCode(e.target.value.replace(/[^\d]/g, ''))}
                 />
                 {(activeSearch || activeZip) && (
                    <button type="button" onClick={clearSearch} className="text-xs text-slate-400 hover:text-white px-3 py-1 rounded-full border border-slate-700 hover:border-slate-500 transition-colors">
                      Clear
                    </button>
                  )}
              </form>
           </div>
           <div className="flex items-center gap-4 ml-4">
              <button
                onClick={handleForceRefresh}
                disabled={loading}
                title={lastRefresh ? `Last refresh: ${lastRefresh.toLocaleTimeString()}` : 'Refresh data'}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-emerald-400 px-3 py-1.5 rounded-full border border-slate-700 hover:border-emerald-500/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                <span className="hidden sm:inline">Refresh</span>
              </button>
              <div className="text-right hidden sm:block">
                  <div className="text-xs text-slate-400">Scope</div>
                  <div className="text-sm font-medium text-white flex items-center gap-1 cursor-pointer hover:text-emerald-400">
                     {activeZip ? `ZIP ${activeZip}` : 'All Locations'} <span className="text-[10px] opacity-50">v</span>
                  </div>
              </div>
              <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white font-bold"> 
                 TH
              </div>
           </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

           {activeNav === 'queue' && (
              <div className="max-w-2xl">
                <h2 className="text-xl font-bold text-white mb-4">Discovery Queue</h2>
                <p className="text-sm text-slate-400 mb-6">Scan a ZIP code to discover local demand gaps, or review terms found automatically.</p>
                <Suspense fallback={<div className="text-slate-500 text-sm">Loading queue...</div>}>
                  <DiscoveryQueue onApproved={() => loadData(activeSearch, activeZip)} />
                </Suspense>
              </div>
            )}

           {activeNav === 'backtest' && (
              <div className="max-w-4xl">
                <h2 className="text-xl font-bold text-white mb-4">GA4 Historical Backtest</h2>
                <p className="text-sm text-slate-400 mb-6">Analyze 3 years of your restaurant's Google Analytics data to find keywords with trend-like growth patterns.</p>
                <Suspense fallback={<div className="text-slate-500 text-sm">Loading backtest panel...</div>}>
                  <BacktestPanel onApproved={() => loadData(activeSearch, activeZip)} />
                </Suspense>
              </div>
            )}

           {activeNav === 'dashboard' && error && (
             <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-lg flex items-center gap-3">
                <AlertCircle size={20} />
                <span>{error}</span>
             </div>
           )}

           {activeNav === 'dashboard' && !loading && trends.length === 0 && !activeSearch && (
             <div className="bg-slate-800/30 border border-slate-700 border-dashed rounded-xl p-8 text-center">
               <Inbox size={32} className="mx-auto mb-3 text-slate-500" />
               <h3 className="text-lg font-medium text-white mb-2">No terms tracked yet</h3>
               <p className="text-sm text-slate-400 mb-4 max-w-md mx-auto">
                 Go to the <button onClick={() => setActiveNav('queue')} className="text-emerald-400 underline hover:text-emerald-300">Discovery Queue</button> and scan a ZIP code (for example, 10001) to discover local food demand gaps. Approve terms to start tracking them here.
               </p>
               <p className="text-xs text-slate-500">Or search for a specific food term above to preview its signals.</p>
             </div>
           )}

           {activeNav === 'dashboard' && (<>
           {/* KPI Cards */}
           {(trends.length > 0 || activeSearch) && (
           <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
               <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                   <div className="text-slate-400 text-xs font-medium uppercase">{activeSearch ? 'Search Results' : 'Tracked Terms'}</div>
                   <div className="text-2xl font-bold text-white mt-1">{trends.length}</div>
                   <div className="text-xs text-emerald-400 mt-1">
                     {activeSearch ? `"${activeSearch}"` : 'Live'}{activeZip ? ` | ZIP ${activeZip}` : ''}
                   </div>
               </div>
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">High Probability Breakouts</div>
                  <div className="text-2xl font-bold text-emerald-400 mt-1">{trends.filter(t => t.breakoutProbability > 70).length}</div>
                  <div className="text-xs text-slate-500 mt-1">Probability &gt; 70%</div>
              </div>
               <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                   <div className="text-slate-400 text-xs font-medium uppercase">Avg Demand Gap</div>
                   <div className="text-2xl font-bold text-orange-400 mt-1">{trends.length > 0 ? Math.round(trends.reduce((a, t) => a + (t.gapScore ?? t.unmetDemandScore), 0) / trends.length) : 0}/100</div>
                   <div className="text-xs text-slate-500 mt-1">Regional Average</div>
               </div>
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">Your Website Traffic</div>
                  {(() => {
                    const trafficSignals = trends.flatMap(t => t.signals.filter(s => s.platform === 'OwnTraffic' && s.currentIntensity > 0));
                    if (trafficSignals.length === 0) return (
                      <><div className="text-2xl font-bold text-slate-500 mt-1">—</div>
                      <div className="text-xs text-slate-500 mt-1">GA4 connected but no matches</div></>
                    );
                    const avg = Math.round(trafficSignals.reduce((a, s) => a + s.currentIntensity, 0) / trafficSignals.length);
                    return (
                      <><div className="text-2xl font-bold text-violet-400 mt-1">{avg}/100</div>
                      <div className="text-xs text-slate-500 mt-1">{trafficSignals.length} term{trafficSignals.length > 1 ? 's' : ''} with GA4 traffic</div></>
                    );
                  })()}
              </div>
           </div>
           )}

           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Main Chart Area */}
               <div className="lg:col-span-2 space-y-6">
                   <div className="bg-slate-800/20 rounded-xl">
                     <Suspense fallback={<div className="p-6 text-slate-500 text-sm">Loading table...</div>}>
                       <OpportunityTable trends={trends} onSelectTrend={setSelectedTrend} />
                     </Suspense>
                   </div>
                  
                  {/* Featured Analysis */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {loading ? (
                        <div className="col-span-2 h-64 flex items-center justify-center bg-slate-800/20 rounded-xl border border-slate-700 border-dashed">
                          <div className="flex flex-col items-center gap-2 text-slate-500">
                            <Loader2 className="animate-spin" size={32} />
                            <span>Loading Live Signals...</span>
                          </div>
                        </div>
                      ) : (
                        <>
                          <Suspense fallback={<div className="h-[300px] rounded-lg border border-slate-700 bg-slate-800/50 flex items-center justify-center text-slate-500 text-sm">Loading propagation graph...</div>}>
                            <PropagationGraph trends={trends} />
                          </Suspense>
                          <Suspense fallback={<div className="h-[400px] rounded-lg border border-slate-700 bg-slate-800/50 flex items-center justify-center text-slate-500 text-sm">Loading map...</div>}>
                            <GeoMap trends={trends} />
                          </Suspense>
                        </>
                      )}
                  </div>
              </div>

              {/* Right Column / Feed */}
              <div className="space-y-4">
                 <div className="bg-slate-800/50 rounded-lg border border-slate-700 p-4">
                    <h3 className="text-sm font-medium text-slate-200 mb-3">Top Signals</h3>
                    <div className="space-y-3">
                        {trends
                          .flatMap(t => t.signals
                            .filter(s => s.velocity > 3)
                            .map(s => ({ term: t.term, platform: s.platform, velocity: s.velocity, intensity: s.currentIntensity }))
                          )
                          .sort((a, b) => b.velocity - a.velocity)
                          .slice(0, 5)
                          .map((item, i) => {
                            const colors: Record<string, string> = { TikTok: 'text-cyan-400', Reddit: 'text-orange-400', GoogleSearch: 'text-blue-400', Yelp: 'text-red-400', OwnSales: 'text-emerald-400', OwnTraffic: 'text-violet-400', Pinterest: 'text-pink-400' };
                            return (
                              <div key={i} className="flex gap-3 items-start border-b border-slate-700/50 pb-3 last:border-0 last:pb-0">
                                <div className={`text-xs font-bold ${colors[item.platform] || 'text-slate-400'} w-14 shrink-0`}>{item.platform.replace('GoogleSearch', 'Google')}</div>
                                <div>
                                  <p className="text-xs text-slate-300 leading-snug">{item.term}: intensity {item.intensity}, velocity +{item.velocity}</p>
                                </div>
                              </div>
                            );
                          })}
                        {trends.flatMap(t => t.signals.filter(s => s.velocity > 3)).length === 0 && (
                          <p className="text-xs text-slate-500">No high-velocity signals right now.</p>
                        )}
                    </div>
                 </div>

                 {/* GA4 Website Traffic Signals */}
                 {(() => {
                    const trafficTerms = trends.filter(t => t.signals.some(s => s.platform === 'OwnTraffic' && s.currentIntensity > 0));
                    if (trafficTerms.length === 0) return null;
                    return (
                      <div className="bg-violet-950/30 rounded-lg border border-violet-500/20 p-4">
                        <h3 className="text-sm font-medium text-violet-200 mb-2">Your GA4 Traffic</h3>
                        <div className="space-y-2">
                          {trafficTerms.slice(0, 5).map(t => {
                            const sig = t.signals.find(s => s.platform === 'OwnTraffic')!;
                            return (
                              <div key={t.id} className="flex justify-between text-xs">
                                <span className="text-violet-100/70">{t.term}</span>
                                <span className="text-violet-400 font-medium">{sig.currentIntensity} intensity{sig.velocity !== 0 ? `, ${sig.velocity > 0 ? '+' : ''}${sig.velocity} vel` : ''}</span>
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-violet-300/40 mt-2">Based on GA4 page views matching these terms</p>
                      </div>
                    );
                 })()}

                 {(() => {
                    const top = [...trends].sort((a, b) => b.breakoutProbability - a.breakoutProbability)[0];
                    if (!top || top.breakoutProbability < 30) return null;
                    return (
                      <div className="bg-gradient-to-br from-indigo-900/50 to-slate-800/50 rounded-lg border border-indigo-500/20 p-4">
                        <h3 className="text-sm font-medium text-indigo-200 mb-2">Predictive Insight</h3>
                        <p className="text-xs text-indigo-100/70 mb-2">
                          <strong>{top.term}</strong> has a {top.breakoutProbability}% breakout probability in {top.neighborhood}.
                          {top.predictedBreakoutWeek > 0 && <> Estimated breakout in ~{top.predictedBreakoutWeek} weeks.</>}
                          {' '}Demand gap score: {top.gapScore ?? top.unmetDemandScore}/100.
                        </p>
                      </div>
                    );
                 })()}
              </div>
           </div>
           </>)}

           {activeNav === 'geo' && (
             <div className="h-full">
               <h2 className="text-xl font-bold text-white mb-4">Geospatial View</h2>
                {loading ? (
                  <div className="h-96 flex items-center justify-center text-slate-500"><Loader2 className="animate-spin" size={32} /></div>
                ) : (
                  <Suspense fallback={<div className="h-96 flex items-center justify-center text-slate-500"><Loader2 className="animate-spin" size={32} /></div>}>
                    <GeoMap trends={trends} />
                  </Suspense>
                )}
              </div>
            )}

        </div>
      </main>

      {/* Detail Modal */}
      <Suspense fallback={null}>
        <TrendDetail trend={selectedTrend} onClose={() => setSelectedTrend(null)} />
      </Suspense>

    </div>
  );
};

export default App;

