-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Trends Table: Stores the entities we are tracking
create table if not exists trends (
  id uuid default uuid_generate_v4() primary key,
  term text not null unique,
  category text,
  region text,
  neighborhood text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  last_updated timestamp with time zone default timezone('utc'::text, now())
);

-- Trend History Table: Stores the daily/hourly scores for velocity calculation
create table if not exists trend_history (
  id uuid default uuid_generate_v4() primary key,
  trend_id uuid references trends(id) on delete cascade,
  timestamp timestamp with time zone default timezone('utc'::text, now()) not null,
  zip_code text,
  demand_score numeric,
  supply_score numeric,
  unmet_demand_score numeric,
  breakout_probability numeric,
  intent_score numeric,
  availability_score numeric,
  realization_score numeric,
  gap_score numeric,
  confidence_score numeric,
  serpapi_share numeric,
  evidence jsonb,
  raw_signals jsonb -- Store the raw signal data (Reddit count, etc.) for debugging
);
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

-- Page Drafts: AI-generated product page content
create table if not exists page_drafts (
  id uuid default uuid_generate_v4() primary key,
  trend_id uuid references trends(id) on delete cascade,
  trend_term text,
  title text,
  subtitle text,
  description text,
  seo_title text,
  seo_description text,
  seo_keywords text[],
  suggested_price numeric,
  status text default 'draft',
  sanity_id text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_page_drafts_trend_id on page_drafts(trend_id);

-- Backward-compatible columns for older deployments
alter table if exists page_drafts add column if not exists trend_term text;
alter table if exists page_drafts add column if not exists seo_title text;
alter table if exists page_drafts add column if not exists seo_description text;
alter table if exists page_drafts add column if not exists seo_keywords text[];
alter table if exists page_drafts add column if not exists status text default 'draft';

-- SerpAPI Cache: governor stores results here to avoid redundant calls
create table if not exists serp_cache (
  id uuid default uuid_generate_v4() primary key,
  cache_key text not null,
  engine text not null,
  query text,
  response jsonb,
  call_cost integer default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_serp_cache_key on serp_cache(cache_key);
create index if not exists idx_serp_cache_created on serp_cache(created_at);

-- Discovery Queue: Potential trends found by the agent, waiting for approval
create table if not exists discovery_queue (
  id uuid default uuid_generate_v4() primary key,
  term text not null,
  source text, -- e.g., "Reddit Rising", "Google Trends"
  initial_score numeric,
  status text default 'pending', -- pending, approved, rejected
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- GA4 Backtest Results: Stores analyzed terms from historical GA4 data
create table if not exists ga4_backtest_results (
  id uuid default uuid_generate_v4() primary key,
  term text not null,
  term_type text default 'nav_noise', -- food_concept | offer_type | nav_noise
  source text, -- 'path', 'title', 'search', 'organic', or combined
  raw_key text, -- original page path, title, or search term
  composite_score numeric,
  total_views integer,
  month_count integer,
  recent_monthly_avg numeric,
  older_monthly_avg numeric,
  growth_rate numeric, -- % change recent vs older
  linear_slope numeric,
  acceleration numeric,
  seasonality_index numeric,
  monthly_data jsonb, -- array of { yearMonth, views }
  status text default 'pending', -- pending, queued, dismissed
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table if exists ga4_backtest_results add column if not exists term_type text default 'nav_noise';
create index if not exists idx_ga4_backtest_score on ga4_backtest_results(composite_score desc);
create index if not exists idx_ga4_backtest_term on ga4_backtest_results(term);
create index if not exists idx_ga4_backtest_type on ga4_backtest_results(term_type);
