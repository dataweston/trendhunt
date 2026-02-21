-- Migration 007: Support for new premium signal raw counts stored alongside trend_history.
-- The raw_signals JSONB column already exists (from 20260221 alignment migration).
-- This migration adds a signal_raw_counts JSONB column to trends for the latest
-- raw counts (keyword volume, Yelp open competitor count, Reddit post counts)
-- so the dashboard can display them without re-querying history.

ALTER TABLE IF EXISTS trends
  ADD COLUMN IF NOT EXISTS signal_raw_counts JSONB;

-- Index for fast reads of latest raw counts per trend
CREATE INDEX IF NOT EXISTS idx_trends_signal_raw_counts
  ON trends USING gin(signal_raw_counts)
  WHERE signal_raw_counts IS NOT NULL;

-- Comment: signal_raw_counts shape:
-- {
--   "monthlySearches": 3600,       -- from Keyword Planner
--   "kwpCompetition": 50,          -- 0-100
--   "kwpCpcCents": 45,             -- avg CPC in cents
--   "yelpOpenCompetitors": 3,      -- from Yelp Fusion direct
--   "yelpTotalResults": 47,
--   "yelpAvgRating": 4.2,
--   "redditPostsLast7d": 8,        -- from Reddit volume tracker
--   "redditPostsLast30d": 23,
--   "redditQuestionPosts": 4,
--   "redditAccelerating": true,
--   "surgeScore": 71,              -- from trend-surge.ts
--   "surgeLabel": "Surging",
--   "surgeCorroborating": 4,
--   "updatedAt": "2026-02-21T..."
-- }
