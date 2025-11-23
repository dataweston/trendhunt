import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
// @ts-ignore
import googleTrends from 'google-trends-api';
import { createClient } from '@supabase/supabase-js';

// --- Types (Duplicated to ensure standalone execution) ---
enum Platform {
  Reddit = 'Reddit',
  TikTok = 'TikTok',
  GoogleSearch = 'GoogleSearch',
  Yelp = 'Yelp',
  DoorDash = 'DoorDash',
  Pinterest = 'Pinterest',
  RedditPushshift = 'RedditPushshift',
  Wildchat = 'Wildchat'
}

interface SignalData {
  platform: Platform;
  history: { week: number; value: number }[];
  currentIntensity: number;
  velocity: number;
}

interface TrendEntity {
  id: string;
  term: string;
  category: string;
  region: string;
  neighborhood: string;
  signals: SignalData[];
  supplyScore: number;
  demandScore: number;
  unmetDemandScore: number;
  breakoutProbability: number;
  predictedBreakoutWeek: number;
}

// --- Constants ---
const TERMS_TO_TRACK = [
  { term: 'Birria Tacos', category: 'Mexican', neighborhood: 'Northeast' },
  { term: 'Mochi Donuts', category: 'Bakery', neighborhood: 'North Loop' },
  { term: 'Korean Corn Dogs', category: 'Street Food', neighborhood: 'Dinkytown' },
  { term: 'Detroit-style Pizza', category: 'Pizza', neighborhood: 'Uptown' },
  { term: 'Ube Lattes', category: 'Cafe', neighborhood: 'Powderhorn' }
];

const REGION = 'Minneapolis';
const YELP_API_KEY = process.env.YELP_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Initialize Supabase
const supabase = (SUPABASE_URL && SUPABASE_KEY) 
  ? createClient(SUPABASE_URL, SUPABASE_KEY) 
  : null;

// --- Scoring Logic ---
const calculateDemandScore = (signals: SignalData[]): number => {
  // Simplified scoring
  const demandSignals = signals.filter(s => s.platform !== Platform.Yelp);
  if (demandSignals.length === 0) return 0;
  const total = demandSignals.reduce((acc, s) => acc + s.currentIntensity, 0);
  return Math.min(100, Math.round(total / demandSignals.length));
};

const calculateSupplyScore = (signals: SignalData[]): number => {
  const supplySignal = signals.find(s => s.platform === Platform.Yelp);
  return supplySignal ? Math.min(100, supplySignal.currentIntensity) : 0;
};

const calculateUnmetDemandScore = (demand: number, supply: number): number => {
  return Math.max(0, Math.min(100, demand - (supply * 0.8)));
};

const calculateBreakoutProbability = (signals: SignalData[]): number => {
  const avgVelocity = signals.reduce((acc, s) => acc + s.velocity, 0) / signals.length;
  return Math.min(100, Math.max(0, 20 + avgVelocity * 5));
};

// --- Fetchers ---

async function fetchTikTokData(term: string): Promise<SignalData> {
  try {
    // PROXY STRATEGY: Since TikTok's official API is restrictive, we measure "Viral Spillover".
    // We search Reddit for posts containing TikTok links related to this term.
    // If people are sharing TikToks of "Birria Tacos" on Reddit, it's crossing platforms -> High Virality.
    const response = await axios.get(`https://www.reddit.com/search.json`, {
      params: { 
        q: `"${term}" site:tiktok.com`, 
        sort: 'new', 
        limit: 50 
      }
    });

    const posts = response.data.data.children;
    const count = posts.length;
    
    // Calculate velocity (posts in last 48h)
    const now = Date.now() / 1000;
    const recentPosts = posts.filter((p: any) => (now - p.data.created_utc) < 172800).length;

    // TikTok trends are explosive, so we weight recent activity heavily
    const intensity = Math.min(100, count * 5); 
    const velocity = recentPosts * 10; 

    return {
      platform: Platform.TikTok,
      currentIntensity: Math.round(intensity),
      velocity: Math.round(velocity),
      history: [] // Hard to get history without a database
    };
  } catch (error) {
    console.error(`TikTok proxy fetch failed for ${term}:`, error);
    return { platform: Platform.TikTok, currentIntensity: 0, velocity: 0, history: [] };
  }
}

async function fetchGooglePlacesData(term: string, location: string): Promise<SignalData> {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('No Google Maps API Key provided');
    return { platform: Platform.GoogleSearch, currentIntensity: 0, velocity: 0, history: [] };
  }

  try {
    // Using Google Places API (New) - Text Search
    // https://places.googleapis.com/v1/places:searchText
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      {
        textQuery: `${term} in ${location}`
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName'
        }
      }
    );

    const places = response.data.places || [];
    const count = places.length;
    
    // Normalize: 20 places = 100% saturation (Supply)
    // We use GoogleSearch platform enum here as a proxy for "Google Ecosystem Supply"
    // Ideally we would add a Platform.GooglePlaces enum
    const intensity = Math.min(100, count * 5);

    return {
      platform: Platform.GoogleSearch, // Re-using this for now, or add new enum
      currentIntensity: Math.round(intensity),
      velocity: 0,
      history: []
    };
  } catch (error) {
    console.error(`Google Places fetch failed for ${term}:`, error);
    return { platform: Platform.GoogleSearch, currentIntensity: 0, velocity: 0, history: [] };
  }
}

async function fetchYelpData(term: string, location: string): Promise<SignalData> {
  if (!YELP_API_KEY) {
    console.warn('No Yelp API Key provided');
    return { platform: Platform.Yelp, currentIntensity: 0, velocity: 0, history: [] };
  }

  try {
    const response = await axios.get('https://api.yelp.com/v3/businesses/search', {
      headers: { Authorization: `Bearer ${YELP_API_KEY}` },
      params: { term, location, limit: 50 }
    });

    const count = response.data.total || 0;
    // Normalize: Assume 50 results is "saturated" (100 intensity)
    const intensity = Math.min(100, (count / 50) * 100);

    return {
      platform: Platform.Yelp,
      currentIntensity: Math.round(intensity),
      velocity: 0, // Yelp doesn't give history easily without scraping
      history: []
    };
  } catch (error) {
    console.error(`Yelp fetch failed for ${term}:`, error);
    return { platform: Platform.Yelp, currentIntensity: 0, velocity: 0, history: [] };
  }
}

async function fetchRedditData(term: string): Promise<SignalData> {
  try {
    // Search specifically in a local subreddit if possible, or general
    // For this demo, we search globally but could restrict to r/Minneapolis
    const response = await axios.get(`https://www.reddit.com/search.json`, {
      params: { q: term, sort: 'new', limit: 25 }
    });

    const posts = response.data.data.children;
    const count = posts.length;
    
    // Calculate "velocity" by checking how many posts are from the last 24h
    const now = Date.now() / 1000;
    const recentPosts = posts.filter((p: any) => (now - p.data.created_utc) < 86400).length;
    
    // Normalize
    const intensity = Math.min(100, count * 4); // 25 posts = 100
    const velocity = recentPosts * 5; // Arbitrary scale

    return {
      platform: Platform.Reddit,
      currentIntensity: Math.round(intensity),
      velocity: Math.round(velocity),
      history: []
    };
  } catch (error) {
    console.error(`Reddit fetch failed for ${term}:`, error);
    return { platform: Platform.Reddit, currentIntensity: 0, velocity: 0, history: [] };
  }
}

async function fetchGoogleTrendsData(term: string): Promise<SignalData> {
  try {
    // google-trends-api often fails in serverless due to bot detection, but let's try
    const results = await googleTrends.interestOverTime({ keyword: term });
    const data = JSON.parse(results);
    const timeline = data.default.timelineData;
    
    if (!timeline || timeline.length === 0) {
        return { platform: Platform.GoogleSearch, currentIntensity: 0, velocity: 0, history: [] };
    }

    const lastPoint = timeline[timeline.length - 1];
    const prevPoint = timeline[timeline.length - 2];
    
    const currentIntensity = lastPoint.value[0];
    const velocity = currentIntensity - (prevPoint ? prevPoint.value[0] : 0);

    return {
      platform: Platform.GoogleSearch,
      currentIntensity,
      velocity,
      history: timeline.slice(-12).map((t: any, i: number) => ({ week: i + 1, value: t.value[0] }))
    };
  } catch (error) {
    // console.error(`Google Trends fetch failed for ${term}:`, error);
    // Fallback to mock if it fails (common in dev)
    return { platform: Platform.GoogleSearch, currentIntensity: Math.random() * 100, velocity: 0, history: [] };
  }
}

async function fetchPinterestData(term: string): Promise<SignalData> {
  try {
    // PROXY STRATEGY: Search Reddit for Pinterest links.
    // Pinterest is a "Planning" signal (recipes, aesthetics).
    const response = await axios.get(`https://www.reddit.com/search.json`, {
      params: { 
        q: `"${term}" site:pinterest.com`, 
        sort: 'new', 
        limit: 25 
      }
    });

    const posts = response.data.data.children;
    const count = posts.length;
    
    // Pinterest content is "slow burn", so we don't weight velocity as high as TikTok
    const intensity = Math.min(100, count * 10); 

    return {
      platform: Platform.Pinterest,
      currentIntensity: Math.round(intensity),
      velocity: 0, // Pinterest is less about "breaking news" velocity
      history: []
    };
  } catch (error) {
    console.error(`Pinterest proxy fetch failed for ${term}:`, error);
    return { platform: Platform.Pinterest, currentIntensity: 0, velocity: 0, history: [] };
  }
}

async function fetchDeliveryData(term: string): Promise<SignalData> {
  try {
    // PROXY STRATEGY: Use Google Trends to check for "Delivery Intent".
    // We check how many people search for "[Term] delivery" or "[Term] DoorDash".
    // This is a strong signal of "Immediate Demand" vs just "General Interest".
    
    const deliveryTerm = `${term} delivery`;
    const results = await googleTrends.interestOverTime({ keyword: deliveryTerm });
    const data = JSON.parse(results);
    const timeline = data.default.timelineData;
    
    if (!timeline || timeline.length === 0) {
        return { platform: Platform.DoorDash, currentIntensity: 0, velocity: 0, history: [] };
    }

    const lastPoint = timeline[timeline.length - 1];
    const currentIntensity = lastPoint.value[0];

    return {
      platform: Platform.DoorDash, // Using DoorDash to represent all Delivery Apps
      currentIntensity,
      velocity: 0,
      history: timeline.slice(-12).map((t: any, i: number) => ({ week: i + 1, value: t.value[0] }))
    };
  } catch (error) {
    // console.error(`Delivery fetch failed for ${term}:`, error);
    return { platform: Platform.DoorDash, currentIntensity: 0, velocity: 0, history: [] };
  }
}

// --- Enterprise / Advanced Connectors ---

async function fetchPushshiftData(term: string): Promise<SignalData> {
  // Pushshift provides historical Reddit data. 
  // Note: Public API is restricted. Requires separate subscription/access usually.
  // This is a placeholder for the integration.
  return { platform: Platform.RedditPushshift, currentIntensity: 0, velocity: 0, history: [] };
}

async function fetchWildchatData(term: string): Promise<SignalData> {
  try {
    // Query Hugging Face Datasets Server for the term in the WildChat dataset
    // This checks if users are asking LLMs about this food trend
    // Dataset: https://huggingface.co/datasets/allenai/WildChat-1M
    const response = await axios.get('https://datasets-server.huggingface.co/search', {
      params: {
        dataset: 'allenai/WildChat-1M',
        config: 'default',
        split: 'train',
        query: term,
        offset: 0,
        limit: 10
      }
    });

    // The search endpoint returns a list of rows. 
    // We use the number of matches as a proxy for "AI Curiosity"
    // Note: The free API has rate limits and might not return total count accurately.
    const rows = response.data.rows || [];
    const count = rows.length; 
    
    // Normalize: If we find matches in the top search results, it's relevant.
    const intensity = Math.min(100, count * 10); 

    return {
      platform: Platform.Wildchat,
      currentIntensity: intensity,
      velocity: 0, 
      history: []
    };
  } catch (error) {
    // console.error(`WildChat fetch failed for ${term}:`, error);
    return { platform: Platform.Wildchat, currentIntensity: 0, velocity: 0, history: [] };
  }
}

// --- Discovery Agent ---

async function discoverRelatedQueries() {
  if (!supabase) return;

  // We only check the first few terms to avoid rate limits
  const seedTerms = TERMS_TO_TRACK.slice(0, 2); 

  for (const item of seedTerms) {
    try {
      const results = await googleTrends.relatedQueries({ keyword: item.term });
      const data = JSON.parse(results);
      
      // Extract "Rising" queries (breakout trends)
      const rising = data.default.rankedList.find((l: any) => l.title === 'Rising');
      if (rising && rising.rankedKeyword) {
        for (const query of rising.rankedKeyword) {
          // query: { query: 'birria tacos recipe', value: 150, formattedValue: '+150%' }
          const term = query.query;
          const score = query.value; // % increase

          // Filter out the term itself
          if (term.toLowerCase().includes(item.term.toLowerCase())) continue;

          await queueDiscovery(term, `Google Trends Rising (via ${item.term})`, score);
        }
      }
    } catch (error) {
      // console.error(`Google Trends Related Queries failed for ${item.term}`);
    }
  }
}

async function queueDiscovery(term: string, source: string, score: number) {
  if (!supabase) return;

  // Check if exists in trends (already tracked)
  const { data: existingTrend } = await supabase
    .from('trends')
    .select('id')
    .eq('term', term)
    .maybeSingle();

  if (!existingTrend) {
    // Check if already in queue
    const { data: existingQueue } = await supabase
      .from('discovery_queue')
      .select('id')
      .eq('term', term)
      .maybeSingle();

    if (!existingQueue) {
        await supabase.from('discovery_queue').insert({
          term: term,
          source: source,
          initial_score: score,
          status: 'pending'
        });
        console.log(`Queued new discovery: ${term}`);
    }
  }
}

async function discoverYelpHotAndNew() {
  if (!YELP_API_KEY || !supabase) return;

  try {
    const response = await axios.get('https://api.yelp.com/v3/businesses/search', {
      headers: { Authorization: `Bearer ${YELP_API_KEY}` },
      params: { 
        location: REGION, 
        attributes: 'hot_and_new', 
        limit: 20,
        categories: 'food,restaurants'
      }
    });

    const businesses = response.data.businesses || [];
    
    for (const b of businesses) {
      // 1. Add the Business Category as a trend (e.g., "Hand Roll Bar")
      for (const cat of b.categories) {
        await queueDiscovery(cat.title, `Yelp Hot & New (Category)`, 50);
      }
      
      // 2. Add the Business Name itself if it's very unique? 
      // No, we track "Trends" (concepts), not specific restaurants usually.
      // But sometimes a specific dish is mentioned in reviews. 
      // For now, categories are the safest bet for "Trends".
    }
  } catch (error) {
    console.error('Yelp Discovery failed', error);
  }
}

async function discoverAndQueueTrends() {
  if (!supabase) return;

  try {
    // 1. Yelp Hot & New (Local Supply Signals)
    await discoverYelpHotAndNew();

    // 2. Google Trends Related Queries (New)
    await discoverRelatedQueries();

    // 3. Source: Reddit Local Subs (Minneapolis, TwinCities)
    const subreddits = ['Minneapolis', 'TwinCities'];
    const keywords = ['food', 'eat', 'restaurant', 'drink', 'coffee', 'pizza', 'taco', 'burger', 'sushi', 'bakery', 'tried', 'best', 'opening', 'new'];
    
    const potentialTerms: { term: string; source: string; score: number }[] = [];

    for (const sub of subreddits) {
      try {
        const response = await axios.get(`https://www.reddit.com/r/${sub}/hot.json?limit=10`);
        const posts = response.data.data.children;

        for (const post of posts) {
          const title = post.data.title;
          const lowerTitle = title.toLowerCase();
          
          if (keywords.some(k => lowerTitle.includes(k))) {
             const term = title.length > 100 ? title.substring(0, 97) + '...' : title;
             potentialTerms.push({ term, source: `Reddit r/${sub}`, score: post.data.score });
          }
        }
      } catch (e) {
        console.error(`Failed to fetch from r/${sub}`, e);
      }
    }

    // 3. Insert into Supabase Discovery Queue
    for (const item of potentialTerms) {
      await queueDiscovery(item.term, item.source, item.score);
    }
  } catch (error) {
    console.error('Discovery Agent failed:', error);
  }
}

// --- Main Handler ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // Run Discovery Agent in background (awaiting to ensure completion in serverless)
    if (supabase) {
        await discoverAndQueueTrends();
    }

    const trends: TrendEntity[] = await Promise.all(TERMS_TO_TRACK.map(async (item, index) => {
      const [yelp, reddit, google, tiktok, pinterest, delivery, pushshift, wildchat, googlePlaces] = await Promise.all([
        fetchYelpData(item.term, REGION),
        fetchRedditData(item.term),
        fetchGoogleTrendsData(item.term),
        fetchTikTokData(item.term),
        fetchPinterestData(item.term),
        fetchDeliveryData(item.term),
        fetchPushshiftData(item.term),
        fetchWildchatData(item.term),
        fetchGooglePlacesData(item.term, REGION)
      ]);

      const signals = [yelp, reddit, google, tiktok, pinterest, delivery, pushshift, wildchat, googlePlaces];
      const demandScore = calculateDemandScore(signals);
      const supplyScore = calculateSupplyScore(signals);
      const unmetDemandScore = calculateUnmetDemandScore(demandScore, supplyScore);
      const breakoutProbability = calculateBreakoutProbability(signals);

      // --- Supabase Persistence ---
      if (supabase) {
        try {
          // 1. Upsert Trend Entity
          const { data: trendData, error: trendError } = await supabase
            .from('trends')
            .upsert({ 
              term: item.term,
              category: item.category,
              region: 'Minneapolis–St Paul',
              neighborhood: item.neighborhood,
              last_updated: new Date().toISOString()
            }, { onConflict: 'term' })
            .select()
            .single();

          if (trendError) {
             console.error('Supabase Trend Upsert Error:', trendError);
          } else if (trendData) {
             // 2. Insert History Record
             const { error: historyError } = await supabase
               .from('trend_history')
               .insert({
                 trend_id: trendData.id,
                 timestamp: new Date().toISOString(),
                 demand_score: demandScore,
                 supply_score: supplyScore,
                 unmet_demand_score: unmetDemandScore,
                 breakout_probability: breakoutProbability,
                 raw_signals: signals
               });
             
             if (historyError) console.error('Supabase History Insert Error:', historyError);
          }
        } catch (dbError) {
          console.error('Supabase Operation Failed:', dbError);
        }
      }

      return {
        id: String(index + 1), // In a real app, use the UUID from Supabase
        term: item.term,
        category: item.category,
        region: 'Minneapolis–St Paul',
        neighborhood: item.neighborhood,
        signals,
        supplyScore,
        demandScore,
        unmetDemandScore,
        breakoutProbability,
        predictedBreakoutWeek: Math.floor(Math.random() * 10) // Placeholder
      };
    }));

    res.status(200).json(trends);
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
}
