import axios from 'axios';

const META_API_BASE = process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com/v21.0';

type SupabaseClientLike = any;

export interface MetaConnection {
  accessToken: string;
  adAccountId: string | null;
  pageId: string | null;
  igUserId: string | null;
  scopes: string[];
  expiresAt?: string | null;
  source: 'env' | 'supabase' | 'env+supabase';
}

function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function normalizeAdAccountId(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.replace(/^act_/i, '');
}

async function loadSupabaseConnection(supabase?: SupabaseClientLike): Promise<any | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from('meta_connections')
      .select('*')
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

export async function resolveMetaConnection(supabase?: SupabaseClientLike): Promise<MetaConnection | null> {
  const envToken = String(process.env.FACEBOOK_ACCESS_TOKEN || '').trim();
  const envAd = normalizeAdAccountId(process.env.FACEBOOK_AD_ACCOUNT_ID);
  const envPage = String(process.env.FACEBOOK_PAGE_ID || '').trim() || null;
  const envIg = String(process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || process.env.INSTAGRAM_IG_USER_ID || '').trim() || null;
  const envScopes = parseScopes(process.env.META_SCOPES || '');

  const row = await loadSupabaseConnection(supabase);
  const dbToken = String(row?.access_token || '').trim();
  const dbAd = normalizeAdAccountId(row?.ad_account_id);
  const dbPage = String(row?.page_id || '').trim() || null;
  const dbIg = String(row?.ig_user_id || '').trim() || null;
  const dbScopes = parseScopes(row?.scopes || []);

  const accessToken = envToken || dbToken;
  if (!accessToken) return null;

  const source: MetaConnection['source'] = envToken && row
    ? 'env+supabase'
    : envToken
      ? 'env'
      : 'supabase';

  return {
    accessToken,
    adAccountId: envAd || dbAd,
    pageId: envPage || dbPage,
    igUserId: envIg || dbIg,
    scopes: envScopes.length ? envScopes : dbScopes,
    expiresAt: row?.expires_at || null,
    source,
  };
}

export async function metaGet<T = any>(path: string, accessToken: string, params: Record<string, any> = {}): Promise<T> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const { data } = await axios.get<T>(`${META_API_BASE}${normalizedPath}`, {
    params: {
      access_token: accessToken,
      ...params,
    },
    timeout: Number(process.env.EXTERNAL_TIMEOUT_MS || 8000),
  });
  return data;
}

export async function metaPost<T = any>(path: string, accessToken: string, params: Record<string, any> = {}): Promise<T> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const { data } = await axios.post<T>(`${META_API_BASE}${normalizedPath}`, null, {
    params: {
      access_token: accessToken,
      ...params,
    },
    timeout: Number(process.env.EXTERNAL_TIMEOUT_MS || 8000),
  });
  return data;
}

export async function resolveInstagramUserId(connection: MetaConnection): Promise<string | null> {
  if (connection.igUserId) return connection.igUserId;
  if (!connection.pageId) return null;
  try {
    const data: any = await metaGet(`/${connection.pageId}`, connection.accessToken, {
      fields: 'instagram_business_account{id}',
    });
    return String(data?.instagram_business_account?.id || '').trim() || null;
  } catch {
    return null;
  }
}

export async function inspectMetaToken(connection: MetaConnection): Promise<{
  ok: boolean;
  scopes: string[];
  expiresAt: number | null;
  appId: string | null;
}> {
  const appId = String(process.env.FACEBOOK_APP_ID || '').trim();
  const appSecret = String(process.env.FACEBOOK_APP_SECRET || '').trim();
  if (!appId || !appSecret) {
    return {
      ok: false,
      scopes: connection.scopes,
      expiresAt: null,
      appId: appId || null,
    };
  }

  try {
    const data: any = await metaGet('/debug_token', connection.accessToken, {
      input_token: connection.accessToken,
      access_token: `${appId}|${appSecret}`,
    });

    const tokenData = data?.data || {};
    return {
      ok: !!tokenData?.is_valid,
      scopes: parseScopes(tokenData?.scopes || tokenData?.granular_scopes || []),
      expiresAt: typeof tokenData?.expires_at === 'number' ? tokenData.expires_at : null,
      appId: String(tokenData?.app_id || appId),
    };
  } catch {
    return {
      ok: false,
      scopes: connection.scopes,
      expiresAt: null,
      appId: appId || null,
    };
  }
}

export function toISODate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function parseMetricNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n;
}

export function parseActionValue(actions: any[] | undefined, actionType: string): number {
  if (!Array.isArray(actions)) return 0;
  const found = actions.find((a) => String(a?.action_type || '').toLowerCase() === actionType.toLowerCase());
  if (!found) return 0;
  return parseMetricNumber(found.value);
}
