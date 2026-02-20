import React, { useState, useEffect, useCallback } from 'react';
import { LayoutDashboard, Map, Activity, Search, Bell, Loader2, AlertCircle, Inbox } from 'lucide-react';
import { trendService } from './services/trendService';
import { TrendEntity } from './types';
import { OpportunityTable } from './components/OpportunityTable';
import { TrendDetail } from './components/TrendDetail';
import { TrendTimeSeries, PropagationGraph, GeoMap } from './components/Visualizations';
import { DiscoveryQueue } from './components/DiscoveryQueue';

const App = () => {
  const [trends, setTrends] = useState<TrendEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrend, setSelectedTrend] = useState<TrendEntity | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeNav, setActiveNav] = useState<'dashboard' | 'geo' | 'queue'>('dashboard');

  const loadData = useCallback(async (query = '') => {
    setLoading(true);
    try {
      const data = await trendService.getTrends(query);
      setTrends(data);
      setError(null);
    } catch (error) {
      console.error("Failed to fetch trends", error);
      setError("Failed to load trend data. Please check your connection or API keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => loadData(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [loadData, searchTerm]);

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
              <div className="relative w-full">
                 <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                 <input 
                    type="text" 
                    placeholder="Search terms, cuisines, or zip codes..." 
                    className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-full pl-10 pr-4 py-2 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 transition-all"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                 />
              </div>
           </div>
           <div className="flex items-center gap-4 ml-4">
              <div className="text-right hidden sm:block">
                  <div className="text-xs text-slate-400">Region</div>
                  <div className="text-sm font-medium text-white flex items-center gap-1 cursor-pointer hover:text-emerald-400">
                     Minneapolis–St Paul <span className="text-[10px] opacity-50">▼</span>
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
               <p className="text-sm text-slate-400 mb-6">Terms discovered automatically from Yelp, Google Trends, and Reddit. Approve to start tracking.</p>
               <DiscoveryQueue onApproved={loadData} />
             </div>
           )}

           {activeNav === 'dashboard' && error && (
             <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-lg flex items-center gap-3">
                <AlertCircle size={20} />
                <span>{error}</span>
             </div>
           )}

           {activeNav === 'dashboard' && (<>
           {/* KPI Cards */}
           <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">Tracked Terms</div>
                  <div className="text-2xl font-bold text-white mt-1">{trends.length}</div>
                  <div className="text-xs text-emerald-400 mt-1">Live</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">High Probability Breakouts</div>
                  <div className="text-2xl font-bold text-emerald-400 mt-1">{trends.filter(t => t.breakoutProbability > 70).length}</div>
                  <div className="text-xs text-slate-500 mt-1">Probability &gt; 70%</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">Avg Unmet Demand</div>
                  <div className="text-2xl font-bold text-orange-400 mt-1">{trends.length > 0 ? Math.round(trends.reduce((a, t) => a + t.unmetDemandScore, 0) / trends.length) : 0}/100</div>
                  <div className="text-xs text-slate-500 mt-1">Regional Average</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">Top Gap</div>
                  <div className="text-2xl font-bold text-red-400 mt-1">{trends.length > 0 ? [...trends].sort((a, b) => b.unmetDemandScore - a.unmetDemandScore)[0]?.neighborhood : '—'}</div>
                  <div className="text-xs text-slate-500 mt-1">{trends.length > 0 ? [...trends].sort((a, b) => b.unmetDemandScore - a.unmetDemandScore)[0]?.term : ''}</div>
              </div>
           </div>

           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Main Chart Area */}
              <div className="lg:col-span-2 space-y-6">
                  <div className="bg-slate-800/20 rounded-xl">
                     <OpportunityTable trends={trends} onSelectTrend={setSelectedTrend} />
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
                          <PropagationGraph trends={trends} />
                          <GeoMap trends={trends} />
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

                 {(() => {
                    const top = [...trends].sort((a, b) => b.breakoutProbability - a.breakoutProbability)[0];
                    if (!top || top.breakoutProbability < 30) return null;
                    return (
                      <div className="bg-gradient-to-br from-indigo-900/50 to-slate-800/50 rounded-lg border border-indigo-500/20 p-4">
                        <h3 className="text-sm font-medium text-indigo-200 mb-2">Predictive Insight</h3>
                        <p className="text-xs text-indigo-100/70 mb-2">
                          <strong>{top.term}</strong> has a {top.breakoutProbability}% breakout probability in {top.neighborhood}.
                          {top.predictedBreakoutWeek > 0 && <> Estimated breakout in ~{top.predictedBreakoutWeek} weeks.</>}
                          {' '}Unmet demand score: {top.unmetDemandScore}/100.
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
                 <GeoMap trends={trends} />
               )}
             </div>
           )}

        </div>
      </main>

      {/* Detail Modal */}
      <TrendDetail trend={selectedTrend} onClose={() => setSelectedTrend(null)} />

    </div>
  );
};

export default App;
