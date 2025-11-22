import { Platform, TrendEntity } from './types';

export const MOCK_TRENDS: TrendEntity[] = [
  {
    id: '1',
    term: 'Mochi Donuts',
    category: 'Bakery',
    region: 'Minneapolis–St Paul',
    neighborhood: 'North Loop',
    supplyScore: 15,
    demandScore: 88,
    unmetDemandScore: 73,
    breakoutProbability: 92,
    predictedBreakoutWeek: 4,
    signals: [
      {
        platform: Platform.TikTok,
        currentIntensity: 95,
        velocity: 12,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 20 + i * 6 + Math.random() * 10 }))
      },
      {
        platform: Platform.GoogleSearch,
        currentIntensity: 70,
        velocity: 8,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 10 + i * 4 + Math.random() * 5 }))
      },
      {
        platform: Platform.Reddit,
        currentIntensity: 65,
        velocity: 5,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 15 + i * 3 + Math.random() * 8 }))
      },
      {
        platform: Platform.Yelp,
        currentIntensity: 10,
        velocity: 1,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 5 + Math.random() * 2 }))
      }
    ]
  },
  {
    id: '2',
    term: 'Birria Tacos',
    category: 'Mexican',
    region: 'Minneapolis–St Paul',
    neighborhood: 'Northeast',
    supplyScore: 60,
    demandScore: 75,
    unmetDemandScore: 15,
    breakoutProbability: 30,
    predictedBreakoutWeek: 0,
    signals: [
      {
        platform: Platform.TikTok,
        currentIntensity: 40,
        velocity: -5,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 80 - i * 2 + Math.random() * 10 }))
      },
      {
        platform: Platform.GoogleSearch,
        currentIntensity: 75,
        velocity: 2,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 60 + i + Math.random() * 5 }))
      },
      {
        platform: Platform.Yelp,
        currentIntensity: 85,
        velocity: 4,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 40 + i * 3 }))
      }
    ]
  },
  {
    id: '3',
    term: 'Detroit-style Pizza',
    category: 'Pizza',
    region: 'Minneapolis–St Paul',
    neighborhood: 'Uptown',
    supplyScore: 25,
    demandScore: 65,
    unmetDemandScore: 40,
    breakoutProbability: 65,
    predictedBreakoutWeek: 8,
    signals: [
      {
        platform: Platform.Reddit,
        currentIntensity: 80,
        velocity: 15,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 10 + i * 5 }))
      },
      {
        platform: Platform.GoogleSearch,
        currentIntensity: 40,
        velocity: 10,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 10 + i * 2 }))
      }
    ]
  },
  {
    id: '4',
    term: 'Korean Corn Dogs',
    category: 'Street Food',
    region: 'Minneapolis–St Paul',
    neighborhood: 'Dinkytown',
    supplyScore: 40,
    demandScore: 85,
    unmetDemandScore: 45,
    breakoutProbability: 78,
    predictedBreakoutWeek: 3,
    signals: [
      {
        platform: Platform.TikTok,
        currentIntensity: 90,
        velocity: 20,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 20 + i * 7 }))
      }
    ]
  },
  {
    id: '5',
    term: 'Ube Lattes',
    category: 'Cafe',
    region: 'Minneapolis–St Paul',
    neighborhood: 'Powderhorn',
    supplyScore: 5,
    demandScore: 55,
    unmetDemandScore: 50,
    breakoutProbability: 55,
    predictedBreakoutWeek: 10,
    signals: [
      {
        platform: Platform.Pinterest,
        currentIntensity: 70,
        velocity: 8,
        history: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, value: 10 + i * 4 }))
      }
    ]
  }
];

export const PLATFORM_COLORS: Record<Platform, string> = {
  [Platform.Reddit]: '#FF4500',
  [Platform.TikTok]: '#00f2ea', // Cyan/Pink usually, simplified to Cyan for contrast
  [Platform.GoogleSearch]: '#4285F4',
  [Platform.Yelp]: '#FF1A1A',
  [Platform.DoorDash]: '#eb1700',
  [Platform.Pinterest]: '#E60023'
};
