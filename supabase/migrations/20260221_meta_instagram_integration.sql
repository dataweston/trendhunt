-- Meta + Instagram integration foundation
-- Adds connection storage, sync runs, ads insights, instagram snapshots,
-- ad draft lifecycle, and permanent AI analysis queue/report tables.

create table if not exists meta_connections (
  id uuid default uuid_generate_v4() primary key,
  workspace_key text default 'default' not null,
  status text default 'active' not null,
  ad_account_id text,
  page_id text,
  ig_user_id text,
  access_token text,
  token_type text default 'user',
  scopes text[],
  expires_at timestamp with time zone,
  metadata jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create unique index if not exists idx_meta_connections_workspace on meta_connections(workspace_key);
create index if not exists idx_meta_connections_status on meta_connections(status);

create table if not exists meta_sync_runs (
  id uuid default uuid_generate_v4() primary key,
  scope text not null,
  mode text not null,
  from_date date,
  to_date date,
  status text default 'running' not null,
  rows_synced integer default 0,
  cursor text,
  error text,
  metadata jsonb,
  started_at timestamp with time zone default timezone('utc'::text, now()) not null,
  completed_at timestamp with time zone
);
create index if not exists idx_meta_sync_runs_scope_started on meta_sync_runs(scope, started_at desc);

create table if not exists meta_ads_entities (
  id uuid default uuid_generate_v4() primary key,
  meta_account_id text not null,
  entity_level text not null,
  entity_id text not null,
  name text,
  status text,
  objective text,
  targeting jsonb,
  creative jsonb,
  raw jsonb,
  created_time timestamp with time zone,
  updated_time timestamp with time zone,
  inserted_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(meta_account_id, entity_level, entity_id)
);
create index if not exists idx_meta_ads_entities_level on meta_ads_entities(entity_level);
create index if not exists idx_meta_ads_entities_name on meta_ads_entities(name);

create table if not exists meta_ads_insights_daily (
  id uuid default uuid_generate_v4() primary key,
  sync_run_id uuid references meta_sync_runs(id) on delete set null,
  meta_account_id text not null,
  entity_level text not null,
  entity_id text not null,
  entity_name text,
  date_start date not null,
  date_stop date not null,
  spend numeric default 0,
  impressions integer default 0,
  reach integer default 0,
  clicks integer default 0,
  ctr numeric,
  cpc numeric,
  cpm numeric,
  outbound_clicks integer default 0,
  purchase_count integer default 0,
  add_to_cart_count integer default 0,
  initiate_checkout_count integer default 0,
  actions jsonb,
  action_values jsonb,
  raw jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(meta_account_id, entity_level, entity_id, date_start, date_stop)
);
create index if not exists idx_meta_ads_insights_date on meta_ads_insights_daily(date_start desc);
create index if not exists idx_meta_ads_insights_name on meta_ads_insights_daily(entity_name);

create table if not exists ig_media (
  id uuid default uuid_generate_v4() primary key,
  ig_user_id text not null,
  media_id text not null,
  caption text,
  media_type text,
  media_product_type text,
  permalink text,
  media_timestamp timestamp with time zone,
  like_count integer default 0,
  comments_count integer default 0,
  raw jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(ig_user_id, media_id)
);
create index if not exists idx_ig_media_user_ts on ig_media(ig_user_id, media_timestamp desc);

create table if not exists ig_media_insights_daily (
  id uuid default uuid_generate_v4() primary key,
  sync_run_id uuid references meta_sync_runs(id) on delete set null,
  ig_user_id text not null,
  media_id text not null,
  snapshot_date date not null,
  reach integer default 0,
  impressions integer default 0,
  views integer default 0,
  likes integer default 0,
  comments integer default 0,
  saves integer default 0,
  shares integer default 0,
  metrics jsonb,
  raw jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(ig_user_id, media_id, snapshot_date)
);
create index if not exists idx_ig_media_insights_date on ig_media_insights_daily(snapshot_date desc);

create table if not exists ig_account_insights_daily (
  id uuid default uuid_generate_v4() primary key,
  sync_run_id uuid references meta_sync_runs(id) on delete set null,
  ig_user_id text not null,
  snapshot_date date not null,
  reach integer default 0,
  impressions integer default 0,
  profile_views integer default 0,
  follows integer default 0,
  website_clicks integer default 0,
  metrics jsonb,
  raw jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(ig_user_id, snapshot_date)
);
create index if not exists idx_ig_account_insights_date on ig_account_insights_daily(snapshot_date desc);

create table if not exists ig_comments (
  id uuid default uuid_generate_v4() primary key,
  ig_user_id text,
  media_id text,
  comment_id text not null unique,
  parent_comment_id text,
  username text,
  text text,
  like_count integer default 0,
  comment_timestamp timestamp with time zone,
  hidden boolean default false,
  raw jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_ig_comments_media_ts on ig_comments(media_id, comment_timestamp desc);

create table if not exists ig_webhook_events (
  id uuid default uuid_generate_v4() primary key,
  event_hash text not null unique,
  object text,
  entry_id text,
  field text,
  value jsonb,
  status text default 'pending',
  received_at timestamp with time zone default timezone('utc'::text, now()) not null,
  processed_at timestamp with time zone
);
create index if not exists idx_ig_webhook_status on ig_webhook_events(status, received_at desc);

create table if not exists meta_ad_drafts (
  id uuid default uuid_generate_v4() primary key,
  trend_id uuid references trends(id) on delete set null,
  trend_term text not null,
  name text not null,
  objective text default 'OUTCOME_TRAFFIC',
  daily_budget numeric default 10,
  status text default 'draft' not null,
  campaign_payload jsonb,
  adset_payload jsonb,
  creative_payload jsonb,
  targeting_spec jsonb,
  audience_lists jsonb,
  analysis_report_id uuid,
  meta_campaign_id text,
  meta_adset_id text,
  meta_ad_id text,
  publish_error text,
  created_by text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_meta_ad_drafts_status_created on meta_ad_drafts(status, created_at desc);
create index if not exists idx_meta_ad_drafts_term on meta_ad_drafts(trend_term);

create table if not exists meta_analysis_queue (
  id uuid default uuid_generate_v4() primary key,
  direction text not null,
  source_type text not null,
  source_id text,
  trend_term text,
  payload jsonb not null,
  context jsonb,
  status text default 'pending' not null,
  attempts integer default 0,
  last_error text,
  report_id uuid,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  processed_at timestamp with time zone
);
create index if not exists idx_meta_analysis_queue_status on meta_analysis_queue(status, created_at);

create table if not exists meta_analysis_reports (
  id uuid default uuid_generate_v4() primary key,
  direction text not null,
  source_type text not null,
  source_id text,
  trend_term text,
  provider text,
  model text,
  summary text,
  scores jsonb,
  opportunities jsonb,
  risks jsonb,
  recommendations jsonb,
  next_actions jsonb,
  ga4_context jsonb,
  payload jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_meta_analysis_reports_source on meta_analysis_reports(source_type, created_at desc);
