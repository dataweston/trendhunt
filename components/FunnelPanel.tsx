import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { TermFunnel } from '../types';

interface FunnelPanelProps {
  funnel: TermFunnel;
}

export const FunnelPanel: React.FC<FunnelPanelProps> = ({ funnel }) => {
  const data = [
    { label: 'Site Searches', value: funnel.searchImpressions, color: '#6366f1' },
    { label: 'Page Views', value: funnel.pageViews, color: '#8b5cf6' },
    { label: 'Conversions', value: funnel.conversionEvents, color: '#10b981' },
  ];

  const stageLabels: Record<string, { text: string; color: string }> = {
    no_page: { text: 'No page exists for this term', color: 'text-red-400' },
    low_conversion: { text: 'Page exists but converts poorly', color: 'text-amber-400' },
    healthy: { text: 'Healthy funnel', color: 'text-emerald-400' },
    unknown: { text: 'Insufficient traffic data', color: 'text-slate-400' },
  };

  const stage = stageLabels[funnel.dropoffStage] ?? stageLabels.unknown;
  const cvrPct = (funnel.conversionRate * 100).toFixed(1);

  return (
    <div className="bg-slate-800/30 rounded-lg border border-slate-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-slate-300">Funnel Attribution</h3>
        <span className={`text-xs font-semibold ${stage.color}`}>{stage.text}</span>
      </div>

      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6 }}
              labelStyle={{ color: '#e2e8f0', fontSize: 11 }}
              itemStyle={{ color: '#94a3b8', fontSize: 11 }}
            />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-3 text-center">
        <div>
          <div className="text-lg font-bold text-indigo-400">{funnel.searchImpressions}</div>
          <div className="text-[10px] text-slate-500">site searches</div>
        </div>
        <div>
          <div className="text-lg font-bold text-violet-400">{funnel.pageViews}</div>
          <div className="text-[10px] text-slate-500">page views</div>
        </div>
        <div>
          <div className="text-lg font-bold text-emerald-400">{cvrPct}%</div>
          <div className="text-[10px] text-slate-500">CVR ({funnel.conversionEvents} conv.)</div>
        </div>
      </div>

      {funnel.geminiDiagnosis && (
        <div className="mt-3 p-3 bg-indigo-950/40 border border-indigo-500/20 rounded text-xs text-indigo-200 leading-relaxed">
          {funnel.geminiDiagnosis}
        </div>
      )}
    </div>
  );
};
