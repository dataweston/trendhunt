import { TrendEntity } from '../types';

const API_URL = '/api/trends';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCacheKey(query: string): string {
  return `trendhunt_cache_${query || '__default__'}`;
}

function readCache(query: string): TrendEntity[] | null {
  try {
    const key = getCacheKey(query);
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

function writeCache(query: string, data: TrendEntity[]): void {
  try {
    const key = getCacheKey(query);
    sessionStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
  } catch { /* storage full — ignore */ }
}

export const trendService = {
  getTrends: async (query = '', forceRefresh = false): Promise<TrendEntity[]> => {
    const q = query.trim();

    // Return cached data if available and not force-refreshing
    if (!forceRefresh) {
      const cached = readCache(q);
      if (cached) return cached;
    }

    const url = q ? `${API_URL}?q=${encodeURIComponent(q)}` : API_URL;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`API ${response.status}: ${response.statusText}`);
    }
    const data: TrendEntity[] = await response.json();
    writeCache(q, data);
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
