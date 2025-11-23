import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Map, Activity, Search, Bell, Loader2, AlertCircle } from 'lucide-react';
import { trendService } from './services/trendService';
import { TrendEntity } from './types';
import { OpportunityTable } from './components/OpportunityTable';
import { TrendDetail } from './components/TrendDetail';
import { TrendTimeSeries, PropagationGraph, GeoMap } from './components/Visualizations';

const App = () => {
  const [trends, setTrends] = useState<TrendEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrend, setSelectedTrend] = useState<TrendEntity | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const loadData = async () => {
      try {
        const data = await trendService.getTrends();
        setTrends(data);
        setError(null);
      } catch (error) {
        console.error("Failed to fetch trends", error);
        setError("Failed to load trend data. Please check your connection or API keys.");
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  const filteredTrends = trends.filter(t => 
    t.term.toLowerCase().includes(searchTerm.toLowerCase()) || 
    t.category.toLowerCase().includes(searchTerm.toLowerCase())
  );

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
          <div className="flex items-center gap-3 px-4 py-3 bg-slate-800/50 text-white rounded-lg border border-slate-700 shadow-sm cursor-pointer">
            <LayoutDashboard size={18} />
            <span className="font-medium">Dashboard</span>
          </div>
          <div className="flex items-center gap-3 px-4 py-3 text-slate-400 hover:bg-slate-800/30 hover:text-slate-200 rounded-lg cursor-pointer transition-colors">
            <Map size={18} />
            <span className="font-medium">Geospatial</span>
          </div>
          <div className="flex items-center gap-3 px-4 py-3 text-slate-400 hover:bg-slate-800/30 hover:text-slate-200 rounded-lg cursor-pointer transition-colors">
            <Bell size={18} />
            <span className="font-medium">Alerts</span>
            <span className="ml-auto bg-red-500/20 text-red-400 text-xs py-0.5 px-2 rounded-full border border-red-500/20">{activeAlerts}</span>
          </div>
        </nav>

        <div className="p-4 border-t border-slate-800">
           <div className="bg-slate-900/50 p-3 rounded border border-slate-800">
              <div className="text-xs text-slate-500 uppercase font-bold mb-2">System Status</div>
              <div className="flex items-center gap-2 text-xs text-emerald-400">
                  <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></div>
                  Ingesting Reddit Stream
              </div>
              <div className="flex items-center gap-2 text-xs text-emerald-400 mt-1">
                  <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></div>
                  Google Trends Sync Active
              </div>
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

        {/* Dashboard Scroll Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
           
           {error && (
             <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-lg flex items-center gap-3">
                <AlertCircle size={20} />
                <span>{error}</span>
             </div>
           )}

           {/* KPI Cards */}
           <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">Total Monitored Entities</div>
                  <div className="text-2xl font-bold text-white mt-1">482</div>
                  <div className="text-xs text-emerald-400 mt-1">+12 this week</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">High Probability Breakouts</div>
                  <div className="text-2xl font-bold text-emerald-400 mt-1">14</div>
                  <div className="text-xs text-slate-500 mt-1">Probability &gt; 70%</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">Avg Unmet Demand</div>
                  <div className="text-2xl font-bold text-orange-400 mt-1">42/100</div>
                  <div className="text-xs text-slate-500 mt-1">Regional Average</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg">
                  <div className="text-slate-400 text-xs font-medium uppercase">Supply Gap</div>
                  <div className="text-2xl font-bold text-red-400 mt-1">High</div>
                  <div className="text-xs text-slate-500 mt-1">Northeast District</div>
              </div>
           </div>

           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Main Chart Area */}
              <div className="lg:col-span-2 space-y-6">
                  <div className="bg-slate-800/20 rounded-xl">
                     <OpportunityTable trends={filteredTrends} onSelectTrend={setSelectedTrend} />
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
                    <h3 className="text-sm font-medium text-slate-200 mb-3">Live Signal Feed</h3>
                    <div className="space-y-3">
                        {[
                            { platform: 'TikTok', text: 'Viral: "Mochi Donuts" +400% views in North Loop', time: '2m ago', color: 'text-cyan-400' },
                            { platform: 'Reddit', text: 'r/TwinCities: "Where to find good birria?" (15 comments)', time: '12m ago', color: 'text-orange-400' },
                            { platform: 'Google', text: 'Search spike: "Korean Corn Dogs near me"', time: '45m ago', color: 'text-blue-400' },
                            { platform: 'Yelp', text: 'New Review: "Finally a place serving Ube!"', time: '1h ago', color: 'text-red-400' },
                        ].map((item, i) => (
                            <div key={i} className="flex gap-3 items-start border-b border-slate-700/50 pb-3 last:border-0 last:pb-0">
                                <div className={`text-xs font-bold ${item.color} w-12 shrink-0`}>{item.platform}</div>
                                <div>
                                    <p className="text-xs text-slate-300 leading-snug">{item.text}</p>
                                    <span className="text-[10px] text-slate-500">{item.time}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                 </div>

                 <div className="bg-gradient-to-br from-indigo-900/50 to-slate-800/50 rounded-lg border border-indigo-500/20 p-4">
                    <h3 className="text-sm font-medium text-indigo-200 mb-2">Predictive Insight</h3>
                    <p className="text-xs text-indigo-100/70 mb-4">
                        Based on current graph velocity, <strong>Birria Tacos</strong> are projected to reach peak saturation in Northeast Minneapolis within 14 days. Consider menu diversification.
                    </p>
                    <button className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded transition-colors">
                        View Full Report
                    </button>
                 </div>
              </div>
           </div>

        </div>
      </main>

      {/* Detail Modal */}
      <TrendDetail trend={selectedTrend} onClose={() => setSelectedTrend(null)} />

    </div>
  );
};

export default App;