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

/**
 * Pull a reasonable searchable text out of arbitrary JSON when a profile
 * hasn't specified one. Used by `mem add` and as the default fallback in
 * sync when a profile has no `memory.searchable` block.
 */
export function defaultSearchableText(data: Record<string, unknown>, maxLen = 4000): string {
  const parts: string[] = [];
  const walk = (value: unknown, depth = 0): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
      return;
    }
    if (depth > 4) return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1);
    }
  };
  walk(data);
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > maxLen ? joined.slice(0, maxLen) : joined;
}
