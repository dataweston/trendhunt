import React from 'react';
import { TrendEntity } from '../types';
import { ArrowUpRight, AlertCircle, TrendingUp, MapPin } from 'lucide-react';

interface OpportunityTableProps {
  trends: TrendEntity[];
  onSelectTrend: (trend: TrendEntity) => void;
}

// ── Inline trend state badge ───────────────────────────────────────────────

const TrendStateBadge: React.FC<{ state?: string }> = ({ state }) => {
  if (!state || state === 'INSUFFICIENT_DATA') return null;

  const cfg: Record<string, { label: string; className: string; pulse?: boolean }> = {
    PRE_PEAK: { label: 'Entry Window', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', pulse: true },
    AT_PEAK: { label: 'Act Now', className: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
    POST_PEAK: { label: 'Saturating', className: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
  };

  const c = cfg[state];
  if (!c) return null;

  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${c.className}`}>
      {c.pulse && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {c.label}
    </span>
  );
};

// ── Three-line rationale ───────────────────────────────────────────────────

function buildRationale(trend: TrendEntity): string {
  const parts: string[] = [];

  const demand = trend.intentScore ?? trend.demandScore ?? 0;
  if (demand >= 70) parts.push(`High demand (${demand})`);
  else if (demand >= 40) parts.push(`Moderate demand (${demand})`);
  else parts.push(`Low demand (${demand})`);

  const avail = trend.availabilityScore ?? trend.supplyScore ?? 0;
  if (avail <= 20) parts.push('Thin supply');
  else if (avail <= 50) parts.push(`${avail} supply score`);
  else parts.push('Dense supply');

  if (trend.funnelData) {
    const { dropoffStage } = trend.funnelData;
    if (dropoffStage === 'no_page') parts.push('No page on your site');
    else if (dropoffStage === 'low_conversion') parts.push('Page converts poorly');
    else if (dropoffStage === 'healthy') parts.push('Funnel healthy');
  }

  return parts.join('. ') + '.';
}

// ── Main table ─────────────────────────────────────────────────────────────

export const OpportunityTable: React.FC<OpportunityTableProps> = ({ trends, onSelectTrend }) => {
  const getMainSignal = (trend: TrendEntity): string => {
    if (trend.signals.length === 0) return 'N/A';
    const topSignal = trend.signals.reduce((best, current) =>
      current.velocity > best.velocity ? current : best
    );
    return topSignal.platform;
  };

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
      <div className="p-4 border-b border-slate-700 flex justify-between items-center">
        <h3 className="text-lg font-medium text-slate-100">Top Unmet Opportunities</h3>
        <span className="px-2 py-1 bg-indigo-500/20 text-indigo-300 text-xs rounded-full border border-indigo-500/30">
          Live Feed
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left text-slate-300">
          <thead className="text-xs text-slate-400 uppercase bg-slate-900/50">
            <tr>
              <th className="px-6 py-3">Term</th>
              <th className="px-6 py-3">Location</th>
              <th className="px-6 py-3">Gap Score</th>
              <th className="px-6 py-3">Breakout Prob.</th>
              <th className="px-6 py-3">Confidence</th>
              <th className="px-6 py-3">SerpAPI</th>
              <th className="px-6 py-3">Main Signal</th>
              <th className="px-6 py-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {trends.map((trend) => {
              const gap = trend.gapScore ?? trend.unmetDemandScore;
              const confidence = trend.confidenceScore ?? 0;
              return (
              <tr 
                key={trend.id} 
                className="border-b border-slate-700 hover:bg-slate-700/30 transition-colors cursor-pointer"
                onClick={() => onSelectTrend(trend)}
              >
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2 font-medium text-white">
                    <TrendingUp size={16} className="text-emerald-400 shrink-0" />
                    <div>
                      <div className="flex items-center gap-2">
                        {trend.term}
                        <TrendStateBadge state={trend.trendState} />
                      </div>
                      {trend.trendState && trend.trendState !== 'INSUFFICIENT_DATA' && (
                        <div className="text-[10px] text-slate-500 font-normal mt-0.5">
                          {buildRationale(trend)}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                    <div className="flex items-center gap-1">
                        <MapPin size={14} className="text-slate-500" />
                        {trend.neighborhood}
                    </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-red-500" 
                        style={{ width: `${gap}%` }}
                      ></div>
                    </div>
                    <span className="text-red-400 font-bold">{gap}</span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className={`font-bold ${trend.breakoutProbability > 80 ? 'text-emerald-400' : 'text-yellow-400'}`}>
                    {trend.breakoutProbability}%
                  </span>
                </td>
                <td className="px-6 py-4 text-xs text-slate-300">{confidence}/100</td>
                <td className="px-6 py-4 text-xs text-emerald-300">{trend.serpapiShare ?? 0}%</td>
                <td className="px-6 py-4">
                    {getMainSignal(trend)}
                </td>
                <td className="px-6 py-4">
                  <button className="text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1">
                    Analyze <ArrowUpRight size={14} />
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
