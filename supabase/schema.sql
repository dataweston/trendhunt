-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Trends Table: Stores the entities we are tracking
create table trends (
  id uuid default uuid_generate_v4() primary key,
  term text not null unique,
  category text,
  region text,
  neighborhood text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  last_updated timestamp with time zone default timezone('utc'::text, now())
);

-- Trend History Table: Stores the daily/hourly scores for velocity calculation
create table trend_history (
  id uuid default uuid_generate_v4() primary key,
  trend_id uuid references trends(id) on delete cascade,
  timestamp timestamp with time zone default timezone('utc'::text, now()) not null,
  demand_score numeric,
  supply_score numeric,
  unmet_demand_score numeric,
  breakout_probability numeric,
  raw_signals jsonb -- Store the raw signal data (Reddit count, etc.) for debugging
);

-- Discovery Queue: Potential trends found by the agent, waiting for approval
create table discovery_queue (
  id uuid default uuid_generate_v4() primary key,
  term text not null,
  source text, -- e.g., "Reddit Rising", "Google Trends"
  initial_score numeric,
  status text default 'pending', -- pending, approved, rejected
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
