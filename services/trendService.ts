import { TrendEntity } from '../types';
import { MOCK_TRENDS } from '../constants';

// In development, this points to the local Vercel function if running via `vercel dev`
// In production, it points to the relative path /api/trends
const API_URL = '/api/trends';

/**
 * Service to fetch trend data.
 */
export const trendService = {
  /**
   * Fetches the list of trends from the data source.
   */
  getTrends: async (): Promise<TrendEntity[]> => {
    try {
      const response = await fetch(API_URL);
      if (!response.ok) {
        throw new Error(`API Error: ${response.statusText}`);
      }
      const data = await response.json();
      return data;
    } catch (error) {
      console.warn('Failed to fetch from live API, falling back to mock data:', error);
      // Fallback to mock data if API fails (e.g. if not running vercel dev)
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(MOCK_TRENDS);
        }, 800);
      });
    }
  },

  /**
   * Fetches a specific trend by ID.
   */
  getTrendById: async (id: string): Promise<TrendEntity | undefined> => {
    // For now, we just filter the list, but ideally we'd have an endpoint /api/trends/:id
    const trends = await trendService.getTrends();
    return trends.find(t => t.id === id);
  }
};
