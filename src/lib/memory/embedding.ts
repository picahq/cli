/**
 * Optional embedding provider.
 *
 * OpenAI is the only first-party provider. Callers pass a `provider` from
 * config; if `none` (or no API key) everything returns null and search
 * falls back to FTS. This module has no global state.
 */

import { getEmbeddingApiKey, getMemoryConfigOrDefault } from './config.js';

/**
 * Per-request timeout for the OpenAI embeddings call. `fetch()` has no
 * default timeout; when OpenAI (or something in between) accepts the TCP
 * connection but never responds, the call hangs indefinitely and
 * deadlocks the whole reindex/sync-with-embed run. 30s is comfortably
 * above p99 for the embeddings endpoint.
 */
const FETCH_TIMEOUT_MS = 30_000;

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

export interface EmbedOptions {
  /** Override the model from config (e.g. reindex under a new model). */
  model?: string;
}

export interface EmbedResult {
  vector: number[];
  model: string;
}

/**
 * Generate a single embedding. Returns null when embeddings are disabled
 * (provider = 'none' or no API key configured).
 */
export async function embed(text: string, opts: EmbedOptions = {}): Promise<EmbedResult | null> {
  const clean = text?.trim();
  if (!clean) return null;

  const cfg = getMemoryConfigOrDefault();
  if (cfg.embedding.provider !== 'openai') return null;

  const apiKey = getEmbeddingApiKey();
  if (!apiKey) return null;

  const model = opts.model ?? cfg.embedding.model;
  const dimensions = cfg.embedding.dimensions;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: clean.slice(0, 8000),
          dimensions,
        }),
      }, FETCH_TIMEOUT_MS);

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        const body = await res.text();
        throw new Error(`OpenAI embeddings ${res.status}: ${body}`);
      }

      const body = (await res.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      const vector = body.data[0]?.embedding;
      if (!vector || vector.length !== dimensions) {
        throw new Error(`Unexpected embedding shape (got length ${vector?.length})`);
      }
      return { vector, model: `openai:${model}` };
    } catch (err) {
      if (attempt === 2) {
        process.stderr.write(`[mem] embedding failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return null;
      }
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

/**
 * Batch embed multiple texts in a single API call. Order is preserved;
 * returns null for any text that produced no embedding, including the
 * provider-disabled case.
 */
export async function embedBatch(texts: string[], opts: EmbedOptions = {}): Promise<Array<EmbedResult | null>> {
  if (texts.length === 0) return [];
  const cfg = getMemoryConfigOrDefault();
  if (cfg.embedding.provider !== 'openai') return texts.map(() => null);
  const apiKey = getEmbeddingApiKey();
  if (!apiKey) return texts.map(() => null);

  const model = opts.model ?? cfg.embedding.model;
  const dimensions = cfg.embedding.dimensions;

  // Map empty/invalid inputs to nulls; skip them in the API call.
  const active: Array<{ index: number; input: string }> = [];
  texts.forEach((t, i) => {
    const clean = t?.trim();
    if (clean) active.push({ index: i, input: clean.slice(0, 8000) });
  });
  if (active.length === 0) return texts.map(() => null);

  const result: Array<EmbedResult | null> = texts.map(() => null);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: active.map(a => a.input),
          dimensions,
        }),
      }, FETCH_TIMEOUT_MS);
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        const body = await res.text();
        throw new Error(`OpenAI embeddings ${res.status}: ${body}`);
      }
      const body = (await res.json()) as {
        data: Array<{ index: number; embedding: number[] }>;
      };
      for (const item of body.data) {
        const slot = active[item.index];
        if (!slot) continue;
        result[slot.index] = { vector: item.embedding, model: `openai:${model}` };
      }
      return result;
    } catch (err) {
      if (attempt === 2) {
        process.stderr.write(`[mem] batch embedding failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return result;
      }
      await sleep(500 * (attempt + 1));
    }
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A value that's just a UUID / opaque id contributes nothing to FTS but
// dominates the leading tokens on Attio-shaped records (workspace / object
// / record ids come first in the JSON). Drop them.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Pure timestamps / dates (ISO 8601, with or without time, and the
// nanosecond form Attio emits: 2025-06-30T23:36:40.816000000Z).
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// Keys whose *values* are opaque ids / links / structural noise — skip the
// whole leaf regardless of what it holds. Matches `id`, `record_id`,
// `workspace_id`, `attio_url`, `avatar_url`, `*_ids`, bare `uuid`, etc.
const NOISE_KEY_RE = /(^|_)(id|ids|uuid|guid|url|href|link|avatar|photo|icon|hash|token|slug)$/i;
// Attio (and similar) structural wrappers — their values are enum-ish noise
// ("workspace-member", "personal-name", "text", timestamps) that bury the
// human fields. Drop the subtree.
const NOISE_KEY_EXACT = new Set([
  'attribute_type', 'actor_type', 'created_by_actor',
  'active_from', 'active_until', 'created_at', 'updated_at', 'last_synced_at',
]);
// Container keys carry no meaning themselves — descend but keep the PARENT
// key as context, so `values.job_title[0].value` is classified as
// "job_title", not the generic "value".
const CONTAINER_KEYS = new Set([
  'values', 'value', 'data', 'attributes', 'properties', 'items',
  'records', 'result', 'results', 'fields',
]);
// Human-meaningful fields that should lead the searchable text so FTS ranks
// on names / titles / emails instead of trailing metadata. Handles Attio's
// nested leaf keys (`full_name`, `email_address`, `job_title`) directly.
const PRIORITY_KEY_RE = /(^|_)(name|full_name|first_name|last_name|display_name|title|job_title|role|position|email|email_address|company|organization|org|description|bio|summary|headline|label|subject|content|body|text_content)$/i;

/**
 * Pull a reasonable searchable text out of arbitrary JSON when a profile
 * hasn't specified one. Used by `mem add`, by `mem reindex --searchable`,
 * and as the default fallback in sync when a profile has no
 * `memory.searchable` block.
 *
 * The walk is key-aware so it can (a) drop UUID / timestamp / opaque-id
 * noise that otherwise leads the text on synced records (Attio in
 * particular starts every record with workspace/object/record UUIDs and
 * timestamps), and (b) emit name / title / email-like fields FIRST so FTS
 * ranks on the fields humans actually search. Nested container keys
 * (`values`, `value`, …) pass their parent key down as context so Attio's
 * `values.name[0].full_name` / `values.job_title[0].value` shapes classify
 * correctly. Tokens are de-duplicated (order-preserving) — Attio repeats
 * the same name/actor many times across a record.
 */
export function defaultSearchableText(data: Record<string, unknown>, maxLen = 4000): string {
  const priority: string[] = [];
  const normal: string[] = [];

  const push = (key: string | undefined, text: string): void => {
    if (key && PRIORITY_KEY_RE.test(key)) priority.push(text);
    else normal.push(text);
  };

  const walk = (value: unknown, key: string | undefined, depth: number): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      const t = value.trim();
      if (!t) return;
      if (UUID_RE.test(t) || TIMESTAMP_RE.test(t)) return;
      if (key && NOISE_KEY_RE.test(key)) return;
      push(key, t);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      if (key && NOISE_KEY_RE.test(key)) return;
      push(key, String(value));
      return;
    }
    if (depth > 6) return;
    if (Array.isArray(value)) {
      // Array indices aren't meaningful keys — carry the parent key down.
      for (const v of value) walk(v, key, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const lower = k.toLowerCase();
        if (NOISE_KEY_EXACT.has(lower) || NOISE_KEY_RE.test(k)) continue;
        // Container keys keep the parent context; real keys become context.
        const nextKey = CONTAINER_KEYS.has(lower) ? key : k;
        walk(v, nextKey, depth + 1);
      }
    }
  };

  walk(data, undefined, 0);

  // Priority fields first, then everything else; de-dupe case-insensitively
  // while preserving first-seen order.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const t of [...priority, ...normal]) {
    const norm = t.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    ordered.push(t);
  }

  const joined = ordered.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > maxLen ? joined.slice(0, maxLen) : joined;
}
