-- Migration 003: Lead-lag detection columns.
-- Stores the social-vs-search cross-correlation result per trend_history row
-- and the current state on the trends table for fast dashboard reads.

ALTER TABLE trend_history ADD COLUMN IF NOT EXISTS trend_state          TEXT;
ALTER TABLE trend_history ADD COLUMN IF NOT EXISTS lead_lag_weeks       INTEGER;
ALTER TABLE trend_history ADD COLUMN IF NOT EXISTS lead_lag_correlation NUMERIC;

ALTER TABLE trends ADD COLUMN IF NOT EXISTS trend_state          TEXT;
ALTER TABLE trends ADD COLUMN IF NOT EXISTS trend_state_narrative TEXT;
ALTER TABLE trends ADD COLUMN IF NOT EXISTS lead_lag_weeks       INTEGER;
ALTER TABLE trends ADD COLUMN IF NOT EXISTS last_lead_lag_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_trends_trend_state ON trends(trend_state);
