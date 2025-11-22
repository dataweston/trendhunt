import React from 'react';
import { TrendEntity } from '../types';
import { ArrowUpRight, AlertCircle, TrendingUp, MapPin } from 'lucide-react';

interface OpportunityTableProps {
  trends: TrendEntity[];
  onSelectTrend: (trend: TrendEntity) => void;
}

export const OpportunityTable: React.FC<OpportunityTableProps> = ({ trends, onSelectTrend }) => {
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
              <th className="px-6 py-3">Unmet Score</th>
              <th className="px-6 py-3">Breakout Prob.</th>
              <th className="px-6 py-3">Main Signal</th>
              <th className="px-6 py-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {trends.map((trend) => (
              <tr 
                key={trend.id} 
                className="border-b border-slate-700 hover:bg-slate-700/30 transition-colors cursor-pointer"
                onClick={() => onSelectTrend(trend)}
              >
                <td className="px-6 py-4 font-medium text-white flex items-center gap-2">
                   <TrendingUp size={16} className="text-emerald-400" />
                   {trend.term}
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
                        style={{ width: `${trend.unmetDemandScore}%` }}
                      ></div>
                    </div>
                    <span className="text-red-400 font-bold">{trend.unmetDemandScore}</span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className={`font-bold ${trend.breakoutProbability > 80 ? 'text-emerald-400' : 'text-yellow-400'}`}>
                    {trend.breakoutProbability}%
                  </span>
                </td>
                <td className="px-6 py-4">
                    {trend.signals.sort((a,b) => b.velocity - a.velocity)[0]?.platform || 'N/A'}
                </td>
                <td className="px-6 py-4">
                  <button className="text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1">
                    Analyze <ArrowUpRight size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
