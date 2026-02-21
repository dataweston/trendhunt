-- Migration 001: Canonical term normalization table
-- Stores canonical food trend terms and their known variants so that
-- "birria tacos", "birria taco", "beef birria" all resolve to one term.

CREATE TABLE IF NOT EXISTS term_canonical (
  canonical   TEXT PRIMARY KEY,
  variants    TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_term_canonical_canonical ON term_canonical(canonical);
