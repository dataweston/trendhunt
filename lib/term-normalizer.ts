/**
 * Term Normalizer — shared across discover, trends, and ga4-backtest.
 *
 * Provides consistent term normalization and Jaccard-similarity fuzzy matching
 * so that "birria tacos", "birria taco", and "beef birria" resolve to the same
 * canonical term rather than being tracked as separate opportunities.
 *
 * Canonical term table is stored in Supabase `term_canonical` and loaded lazily.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Stopwords stripped before comparison (location-specific tokens + articles)
const MATCH_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'in', 'on', 'to', 'by', 'with',
  'minneapolis', 'saint', 'st', 'paul', 'mn', 'local', 'effort',
]);

// Similarity threshold for canonical matching (0.75 = 3 of 4 tokens must match)
const CANONICAL_SIMILARITY_THRESHOLD = 0.75;

export type CanonicalMap = Map<string, string>; // normalizedVariant → canonicalTerm

// ─── Core normalization ────────────────────────────────────────────────────

/**
 * Normalize a term to a stable key for comparison.
 * Lowercases, strips punctuation, removes stopwords, collapses whitespace.
 */
export function normalizeTermKey(term: string): string {
  const tokens = term
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token && !MATCH_STOPWORDS.has(token));
  return tokens.join(' ');
}

/**
 * Tokenize a normalized key into individual words.
 */
export function tokenizeKey(term: string): string[] {
  const key = normalizeTermKey(term);
  return key ? key.split(' ').filter(Boolean) : [];
}

/**
 * Jaccard token similarity between two terms (0–1).
 */
export function similarityScore(a: string, b: string): number {
  const ak = normalizeTermKey(a);
  const bk = normalizeTermKey(b);
  if (!ak || !bk) return 0;
  if (ak === bk) return 1;
  if (ak.includes(bk) || bk.includes(ak)) return 0.9;
  const aTokens = new Set(ak.split(' ').filter(Boolean));
  const bTokens = new Set(bk.split(' ').filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  const intersect = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union > 0 ? intersect / union : 0;
}

// ─── Canonical map ─────────────────────────────────────────────────────────

/**
 * Load canonical term map from Supabase.
 * Returns a map of normalizedVariant → canonicalTerm.
 * Empty map if Supabase unavailable or table empty.
 */
export async function loadCanonicalMap(supabase: SupabaseClient): Promise<CanonicalMap> {
  const map: CanonicalMap = new Map();
  try {
    const { data, error } = await supabase
      .from('term_canonical')
      .select('canonical, variants');
    if (error || !data) return map;
    for (const row of data) {
      const canonKey = normalizeTermKey(row.canonical);
      map.set(canonKey, row.canonical);
      for (const variant of (row.variants || [])) {
        map.set(normalizeTermKey(variant), row.canonical);
      }
    }
  } catch { /* table may not exist yet — return empty map */ }
  return map;
}

/**
 * Given a raw term and the canonical map, return the canonical form if one
 * exists within CANONICAL_SIMILARITY_THRESHOLD, otherwise return the raw term.
 */
export function resolveCanonical(term: string, map: CanonicalMap): string {
  if (map.size === 0) return term;
  const key = normalizeTermKey(term);

  // Exact key match
  if (map.has(key)) return map.get(key)!;

  // Fuzzy match against all canonical keys
  let bestScore = 0;
  let bestCanonical = term;
  for (const [variantKey, canonical] of map) {
    const score = similarityScore(key, variantKey);
    if (score > bestScore) {
      bestScore = score;
      bestCanonical = canonical;
    }
  }

  return bestScore >= CANONICAL_SIMILARITY_THRESHOLD ? bestCanonical : term;
}

// ─── Supabase write helpers ────────────────────────────────────────────────

/**
 * Register a new canonical term in the DB (idempotent — ignores conflict).
 */
export async function registerCanonical(
  supabase: SupabaseClient,
  canonical: string,
  variants: string[] = [],
): Promise<void> {
  try {
    await supabase
      .from('term_canonical')
      .upsert({ canonical, variants }, { onConflict: 'canonical' });
  } catch { /* best-effort */ }
}

/**
 * Add a variant to an existing canonical entry.
 */
export async function addVariant(
  supabase: SupabaseClient,
  canonical: string,
  variant: string,
): Promise<void> {
  try {
    const { data } = await supabase
      .from('term_canonical')
      .select('variants')
      .eq('canonical', canonical)
      .single();
    if (!data) return;
    const existing: string[] = data.variants || [];
    if (!existing.includes(variant)) {
      await supabase
        .from('term_canonical')
        .update({ variants: [...existing, variant] })
        .eq('canonical', canonical);
    }
  } catch { /* best-effort */ }
}

// ─── Convenience factory ───────────────────────────────────────────────────

/**
 * Build a SupabaseClient from env vars — used when caller doesn't already have one.
 */
export function makeSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  return url && key ? createClient(url, key) : null;
}
