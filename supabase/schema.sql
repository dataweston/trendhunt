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
  demand_score numeric,
  supply_score numeric,
  unmet_demand_score numeric,
  breakout_probability numeric,
  raw_signals jsonb -- Store the raw signal data (Reddit count, etc.) for debugging
);

-- Page Drafts: AI-generated product page content
create table if not exists page_drafts (
  id uuid default uuid_generate_v4() primary key,
  trend_id uuid references trends(id) on delete cascade,
  title text,
  subtitle text,
  description text,
  seo_meta text,
  keywords text[],
  suggested_price text,
  sanity_id text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

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
