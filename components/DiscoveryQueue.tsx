import React, { useState, useEffect } from 'react';
import { Check, X, Loader2, Inbox, Sparkles, MapPin, Search } from 'lucide-react';
import { DiscoveryQueueItem } from '../types';
import { getAdminHeaders, getStoredAdminToken, setStoredAdminToken } from '../services/adminAuth';

interface DiscoveryQueueProps {
  onApproved?: () => void;
}

export const DiscoveryQueue: React.FC<DiscoveryQueueProps> = ({ onApproved }) => {
  const [items, setItems] = useState<DiscoveryQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [zipCode, setZipCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [adminTokenInput, setAdminTokenInput] = useState(() => getStoredAdminToken());
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const fetchQueue = async () => {
    setLoading(true);
    setAuthNotice(null);
    try {
      const res = await fetch('/api/queue?status=pending', { headers: getAdminHeaders() });
      if (res.status === 401) {
        setItems([]);
        setAuthNotice('Admin token required to view and manage the discovery queue.');
      } else if (res.ok) {
        setItems(await res.json());
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchQueue(); }, []);

  const scanZip = async () => {
    const zip = zipCode.trim();
    if (!/^\d{5}$/.test(zip)) { setScanResult('Enter a valid 5-digit zip code'); return; }
    setScanning(true);
    setScanResult(null);
    setAuthNotice(null);
    try {
      const res = await fetch(`/api/discover?manual=true&zip=${zip}`, { headers: getAdminHeaders() });
      const data = await res.json();
      if (res.ok) {
        const s = data.sources || {};
        const parts = [
          `${data.processed || 0} terms queued`,
          s.reddit_titles ? `${s.reddit_titles} Reddit posts` : null,
          s.nlp_extracted ? `${s.nlp_extracted} NLP extracted` : null,
          s.yelp_categories ? `${s.yelp_categories} Yelp categories` : null,
          s.rising ? `${s.rising} rising queries` : null,
          s.ga4_boosted_candidates ? `${s.ga4_boosted_candidates} GA4-prior boosts` : null,
        ].filter(Boolean);
        setScanResult(parts.join(' | '));
        if (data.debug?.extracted_terms?.length) {
          setScanResult(prev => `${prev}\nTerms: ${data.debug.extracted_terms.join(', ')}`);
        }
        await fetchQueue(); // refresh the queue
      } else if (res.status === 401) {
        setAuthNotice('Admin token required to run manual discovery.');
        setScanResult('Error: Unauthorized');
      } else {
        setScanResult(`Error: ${data.error || 'Scan failed'}`);
      }
    } catch (e) {
      setScanResult('Network error - check deployment');
    }
    setScanning(false);
  };

  const act = async (id: string, action: 'approve' | 'reject') => {
    setActing(id);
    try {
      const res = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAdminHeaders() },
        body: JSON.stringify({
          id,
          action,
          neighborhood: zipCode.trim() || 'Unknown',
          region: zipCode.trim() ? `ZIP ${zipCode.trim()}` : 'All Locations',
        }),
      });
      if (res.ok) {
        setItems(prev => prev.filter(i => i.id !== id));
        if (action === 'approve' && onApproved) onApproved();
      } else if (res.status === 401) {
        setAuthNotice('Admin token required for approve/reject actions.');
      }
    } catch { /* ignore */ }
    setActing(null);
  };

  const approveAll = async () => {
    for (const item of items) {
      await act(item.id, 'approve');
    }
  };

  const saveAdminToken = () => {
    setStoredAdminToken(adminTokenInput);
    setAuthNotice(adminTokenInput.trim() ? 'Admin token saved for this browser session.' : 'Admin token cleared.');
    fetchQueue();
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
        <h3 className="text-sm font-medium text-white mb-3">Admin Token</h3>
        <div className="flex gap-2">
          <input
            type="password"
            value={adminTokenInput}
            onChange={(e) => setAdminTokenInput(e.target.value)}
            placeholder="Enter admin token"
            className="flex-1 bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500/50 transition-all"
          />
          <button
            type="button"
            onClick={saveAdminToken}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Save
          </button>
        </div>
        {authNotice && <p className="text-xs text-slate-400 mt-2">{authNotice}</p>}
      </div>

      {/* Zip Code Scanner */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <MapPin size={16} className="text-emerald-400" />
          <h3 className="text-sm font-medium text-white">Scan a Zip Code</h3>
        </div>
        <p className="text-xs text-slate-400 mb-3">
          SerpAPI-first scan using Yelp and Google Trends for this ZIP, with Reddit enrichment and GA4 backtest priors to rank candidates before queuing.
        </p>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); scanZip(); }}>
          <input
            type="text"
            placeholder="10001"
            value={zipCode}
            onChange={(e) => setZipCode(e.target.value)}
            maxLength={5}
            className="w-28 bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500/50 transition-all"
          />
          <button
            type="submit"
            disabled={scanning}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            {scanning ? 'Scanning...' : 'Discover'}
          </button>
        </form>
        {scanResult && (
          <div className={`mt-3 text-xs p-2 rounded whitespace-pre-line ${scanResult.startsWith('Error') || scanResult.startsWith('Network') ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
            {scanResult}
          </div>
        )}
      </div>

      {/* Queue Items */}
      {loading ? (
        <div className="flex items-center justify-center py-8 text-slate-500">
          <Loader2 className="animate-spin mr-2" size={16} />
          Loading queue...
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-slate-500">
          <Inbox size={24} className="mb-2 opacity-50" />
          <span className="text-sm">No pending discoveries - try scanning a ZIP code above</span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-400">{items.length} pending term{items.length > 1 ? 's' : ''}</span>
            <button
              onClick={approveAll}
              className="text-xs text-emerald-400 hover:text-emerald-300 px-3 py-1 rounded border border-emerald-500/30 hover:border-emerald-500/50 transition-colors"
            >
              Approve All
            </button>
          </div>
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
                    title="Approve - add to tracked trends"
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
        </>
      )}
    </div>
  );
};
