-- Migration 002: Add source column to trend_history and indexes for cron-driven time series.
-- 'source' distinguishes cron-written rows (consistent daily intervals) from
-- user-session rows, allowing accurate velocity and breakout regression.

ALTER TABLE trend_history ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'user';

CREATE INDEX IF NOT EXISTS idx_trend_history_source   ON trend_history(source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trend_history_term_time ON trend_history(trend_id, timestamp DESC);
