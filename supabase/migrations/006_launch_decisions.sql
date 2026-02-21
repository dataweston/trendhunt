-- Migration 006: Launch decisions and outcome tracking.
-- Created when a queue item is approved. Outcome evaluated after 30/60/90 days
-- via /api/evaluate-launches. Feeds into Module 8 weight calibration.

CREATE TABLE IF NOT EXISTS launch_decisions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term                      TEXT NOT NULL,
  trend_id                  UUID REFERENCES trends(id),
  launched_at               TIMESTAMPTZ DEFAULT now(),
  page_url                  TEXT,
  gap_score_at_launch       NUMERIC,
  intent_score_at_launch    NUMERIC,
  confidence_score_at_launch NUMERIC,
  trend_state_at_launch     TEXT,
  ga4_views_30d             INTEGER,
  ga4_views_60d             INTEGER,
  ga4_views_90d             INTEGER,
  ga4_conversions_90d       INTEGER,
  outcome                   TEXT DEFAULT 'pending',  -- 'hit' | 'miss' | 'pending'
  evaluated_at              TIMESTAMPTZ,
  notes                     TEXT,
  created_at                TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_launch_decisions_term    ON launch_decisions(term);
CREATE INDEX IF NOT EXISTS idx_launch_decisions_outcome ON launch_decisions(outcome, launched_at DESC);
