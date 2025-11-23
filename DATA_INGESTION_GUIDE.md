# Data Ingestion Transition Guide

This guide outlines the steps to transition Trend Hunter from using mock data to ingesting real-time signals from Reddit, Google Trends, and Yelp.

## 1. Architecture Overview

**Current State:**
`constants.ts` (Mock Data) -> `trendService.ts` -> `App.tsx`

**Target State:**
`[Reddit/Google/Yelp APIs]` -> `Backend Proxy (Node.js)` -> `trendService.ts` -> `App.tsx`

## 2. Why a Backend Proxy?

Browser-based applications (like this Vite React app) cannot directly call many third-party APIs due to:
1.  **CORS (Cross-Origin Resource Sharing):** Browsers block requests to domains that don't explicitly allow them.
2.  **Secret Security:** Storing API keys (like Yelp Fusion API Key) in frontend code exposes them to the public.
3.  **Library Limitations:** The `google-trends-api` library is designed for Node.js and does not work in the browser.

## 3. Implementation Steps

### Phase A: Set up a Backend
You need a server environment. Options:
*   **Next.js API Routes:** If you migrate to Next.js.
*   **Express.js Server:** A simple Node.js server.
*   **Serverless Functions:** Vercel Functions, Netlify Functions, or AWS Lambda.

**Example Express Server (`server.js`):**
```javascript
const express = require('express');
const googleTrends = require('google-trends-api');
const axios = require('axios');
const app = express();

// Endpoint to get trends
app.get('/api/trends', async (req, res) => {
  // 1. Fetch data from sources
  // 2. Normalize data
  // 3. Return JSON
});

app.listen(3000);
```

### Phase B: Implement Connectors

#### 1. Reddit Connector
Reddit allows JSON access by appending `.json` to URLs.
*   **Endpoint:** `https://www.reddit.com/r/[subreddit]/search.json?q=[term]&sort=new`
*   **Data Extraction:** Parse `data.children[].data` for `title`, `score`, `num_comments`, `created_utc`.

#### 2. Google Trends Connector
Use the `google-trends-api` package in your backend.
```javascript
const googleTrends = require('google-trends-api');

googleTrends.interestOverTime({ keyword: 'Birria Tacos' })
  .then((results) => {
    // Parse results
  });
```

#### 3. Yelp Fusion Connector
Requires an API Key.
*   **Endpoint:** `https://api.yelp.com/v3/businesses/search`
*   **Headers:** `Authorization: Bearer YOUR_API_KEY`
*   **Query:** `term=Birria Tacos&location=Minneapolis`
*   **Metric:** Count the number of results to estimate "Supply".

### Phase C: Data Normalization
In your backend, you must transform the raw API responses into the `TrendEntity` format expected by the frontend.

**Mapping Logic:**
*   **Velocity:** Calculate the slope of mentions over the last 7 days.
*   **Intensity:** Normalize counts (e.g., 1000 upvotes = 100 intensity).

### Phase D: Update Frontend Service
Update `services/trendService.ts` to call your new backend.

```typescript
// services/trendService.ts
export const trendService = {
  getTrends: async (): Promise<TrendEntity[]> => {
    const response = await fetch('/api/trends'); // Calls your backend
    const data = await response.json();
    // The backend should return data already in TrendEntity format
    // OR you can map it here if the backend returns raw data
    return data;
  }
};
```

## 4. Immediate Next Steps
1.  Initialize a Node.js project for the backend (or add API routes if moving to a framework).
2.  Get API Keys for Yelp Fusion and Reddit (optional, but recommended for higher rate limits).
3.  Write a script to fetch data for *one* term (e.g., "Birria Tacos") and log the output to console to verify connectivity.
