-- Migration 005: Business fit score on discovery_queue.
-- Gemini-assigned score (0-100) indicating how well a discovered trend
-- fits the Local Effort business format and price point.

ALTER TABLE discovery_queue ADD COLUMN IF NOT EXISTS business_fit_score     NUMERIC;
ALTER TABLE discovery_queue ADD COLUMN IF NOT EXISTS business_fit_rationale TEXT;
