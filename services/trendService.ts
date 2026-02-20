import { TrendEntity } from '../types';

const API_URL = '/api/trends';

export const trendService = {
  getTrends: async (): Promise<TrendEntity[]> => {
    const response = await fetch(API_URL);
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
