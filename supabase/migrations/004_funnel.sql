-- Migration 004: Per-term funnel attribution table.
-- Populated daily by /api/ga4-funnel from GA4 data.
-- Enables distinguishing "no page exists" from "page exists but low conversion".

CREATE TABLE IF NOT EXISTS term_funnel (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term               TEXT NOT NULL,
  date               DATE NOT NULL DEFAULT CURRENT_DATE,
  search_impressions INTEGER DEFAULT 0,
  page_views         INTEGER DEFAULT 0,
  conversion_events  INTEGER DEFAULT 0,
  conversion_rate    NUMERIC DEFAULT 0,
  dropoff_stage      TEXT,   -- 'no_page' | 'low_conversion' | 'healthy' | 'unknown'
  gemini_diagnosis   TEXT,   -- Gemini one-sentence action recommendation
  updated_at         TIMESTAMPTZ DEFAULT now(),
  UNIQUE(term, date)
);

CREATE INDEX IF NOT EXISTS idx_term_funnel_term ON term_funnel(term, date DESC);
