import { TrendEntity } from '../types';

const API_URL = '/api/trends';

export const trendService = {
  getTrends: async (query = ''): Promise<TrendEntity[]> => {
    const q = query.trim();
    const url = q ? `${API_URL}?q=${encodeURIComponent(q)}` : API_URL;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`API ${response.status}: ${response.statusText}`);
    }
    return response.json();
  },

  getTrendById: async (id: string): Promise<TrendEntity | undefined> => {
    const trends = await trendService.getTrends();
    return trends.find(t => t.id === id);
  }
};
