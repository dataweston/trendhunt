import React, { useState, useEffect } from 'react';
import { Check, X, Loader2, Inbox, Sparkles } from 'lucide-react';
import { DiscoveryQueueItem } from '../types';

interface DiscoveryQueueProps {
  onApproved?: () => void; // callback to refresh trends after approval
}

export const DiscoveryQueue: React.FC<DiscoveryQueueProps> = ({ onApproved }) => {
  const [items, setItems] = useState<DiscoveryQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const fetchQueue = async () => {
    try {
      const res = await fetch('/api/queue?status=pending');
      if (res.ok) setItems(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchQueue(); }, []);

  const act = async (id: string, action: 'approve' | 'reject') => {
    setActing(id);
    try {
      const res = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      if (res.ok) {
        setItems(prev => prev.filter(i => i.id !== id));
        if (action === 'approve' && onApproved) onApproved();
      }
    } catch { /* ignore */ }
    setActing(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-slate-500">
        <Loader2 className="animate-spin mr-2" size={16} />
        Loading queue...
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-slate-500">
        <Inbox size={24} className="mb-2 opacity-50" />
        <span className="text-sm">No pending discoveries</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map(item => (
        <div
          key={item.id}
          className="flex items-center justify-between bg-slate-800/50 border border-slate-700 rounded-lg px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-amber-400 shrink-0" />
              <span className="text-sm text-white font-medium truncate">{item.term}</span>
            </div>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-[10px] text-slate-500">{item.source}</span>
              <span className="text-[10px] text-slate-600">
                Score: {item.initial_score}
              </span>
              <span className="text-[10px] text-slate-600">
                {new Date(item.created_at).toLocaleDateString()}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1 ml-3 shrink-0">
            <button
              onClick={() => act(item.id, 'approve')}
              disabled={acting === item.id}
              className="p-1.5 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
              title="Approve — add to tracked trends"
            >
              {acting === item.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            </button>
            <button
              onClick={() => act(item.id, 'reject')}
              disabled={acting === item.id}
              className="p-1.5 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              title="Reject"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
