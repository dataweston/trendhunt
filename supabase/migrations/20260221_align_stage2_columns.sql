-- Stage 2 alignment migration for legacy deployments.
-- Adds missing trend_history columns required by current API writes
-- and adds ga4_backtest_results.term_type for backtest quality gating.

alter table if exists trend_history add column if not exists zip_code text;
alter table if exists trend_history add column if not exists demand_score numeric;
alter table if exists trend_history add column if not exists supply_score numeric;
alter table if exists trend_history add column if not exists unmet_demand_score numeric;
alter table if exists trend_history add column if not exists breakout_probability numeric;
alter table if exists trend_history add column if not exists intent_score numeric;
alter table if exists trend_history add column if not exists availability_score numeric;
alter table if exists trend_history add column if not exists realization_score numeric;
alter table if exists trend_history add column if not exists gap_score numeric;
alter table if exists trend_history add column if not exists confidence_score numeric;
alter table if exists trend_history add column if not exists serpapi_share numeric;
alter table if exists trend_history add column if not exists evidence jsonb;
alter table if exists trend_history add column if not exists raw_signals jsonb;

alter table if exists ga4_backtest_results
  add column if not exists term_type text default 'nav_noise';

create index if not exists idx_ga4_backtest_type on ga4_backtest_results(term_type);
