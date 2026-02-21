import { TrendEntity } from '../types';
import { getAdminHeaders } from './adminAuth';

const API_URL = '/api/trends';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCacheKey(query: string, zip = ''): string {
  return `trendhunt_cache_${query || '__default__'}_${zip || '__all__'}`;
}

function readCache(query: string, zip = ''): TrendEntity[] | null {
  try {
    const key = getCacheKey(query, zip);
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL_MS) {
      sessionStorage.removeItem(key);
      return null;
    }
    return data as TrendEntity[];
  } catch {
    return null;
  }
}

function writeCache(query: string, zip: string, data: TrendEntity[]): void {
  try {
    const key = getCacheKey(query, zip);
    sessionStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
  } catch { /* storage full — ignore */ }
}

export const trendService = {
  getTrends: async (query = '', forceRefresh = false, zip = ''): Promise<TrendEntity[]> => {
    const q = query.trim();
    const z = zip.trim();

    // Return cached data if available and not force-refreshing
    if (!forceRefresh) {
      const cached = readCache(q, z);
      if (cached) return cached;
    }

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (z) params.set('zip', z);
    const url = params.toString() ? `${API_URL}?${params.toString()}` : API_URL;
    const response = await fetch(url, { headers: getAdminHeaders() });
    if (!response.ok) {
      throw new Error(`API ${response.status}: ${response.statusText}`);
    }
    const data: TrendEntity[] = await response.json();
    writeCache(q, z, data);
    return data;
  },

  getTrendById: async (id: string): Promise<TrendEntity | undefined> => {
    const trends = await trendService.getTrends();
    return trends.find(t => t.id === id);
  },

  clearCache: (): void => {
    try {
      const keys = Object.keys(sessionStorage).filter(k => k.startsWith('trendhunt_cache_'));
      keys.forEach(k => sessionStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};
