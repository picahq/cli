/**
 * Process-local backend singleton + embedding orchestration.
 *
 * CLI commands call `getBackend()` which lazily loads + initializes the
 * configured backend (runs `ensureSchema` once per process). `addRecord()`
 * and `upsertRecord()` wrap the backend with embedding generation when
 * configured.
 */

import type { MemBackend, UpsertResult, UpsertOptions } from './backend.js';
import type { MemRecord, RecordInput } from './types.js';
import {
  DEFAULT_MEMORY_CONFIG,
  getMemoryConfig,
  getMemoryConfigOrDefault,
  updateMemoryConfig,
} from './config.js';
import { getOpenAiApiKey } from '../config.js';
import { loadBackendFromConfig } from './plugins.js';
import { embed, defaultSearchableText } from './embedding.js';
import { contentHash } from './canonical.js';

let cached: Promise<MemBackend> | null = null;

export async function getBackend(): Promise<MemBackend> {
  if (cached) return cached;

  // Auto-bootstrap on first use. Zero-config UX: humans and agents can call
  // `one mem add` / `one mem search` on a fresh install without running
  // `one mem init` first. Smart defaults: embedded-postgres backend + no
  // embed (unless an OpenAI key is already resolvable, in which case flip
  // to openai). Requires `one init` — the base One config must exist first.
  if (!getMemoryConfig()) {
    bootstrapMemoryDefaults();
  }

  const cfg = getMemoryConfigOrDefault();
  cached = (async () => {
    const backend = await loadBackendFromConfig(cfg);
    await backend.init();
    await backend.ensureSchema();
    return backend;
  })();
  return cached;
}

/**
 * Write a default memory block if none exists. Picks `openai` for the
 * embedding provider when an OpenAI key is already resolvable via env /
 * .onerc / config — matches user intent without a prompt. Otherwise stays
 * at `none` and the user can upgrade later via `mem config`.
 */
function bootstrapMemoryDefaults(): void {
  const hasOpenAiKey = !!getOpenAiApiKey();
  const next = {
    ...DEFAULT_MEMORY_CONFIG,
    embedding: {
      ...DEFAULT_MEMORY_CONFIG.embedding,
      provider: hasOpenAiKey ? 'openai' : 'none',
    },
  } as typeof DEFAULT_MEMORY_CONFIG;
  updateMemoryConfig(next);
  // One-line breadcrumb on stderr so humans know a file got created.
  // Stays out of JSON stdout so agent consumers aren't disrupted.
  if (process.stderr.isTTY) {
    process.stderr.write(
      `one mem: initialized ${hasOpenAiKey ? '(embeddings enabled)' : '(FTS only; set OpenAI key for semantic search)'}\n`,
    );
  }
}

/** Resets the singleton — used in tests. */
export function resetBackendSingleton(): void {
  cached = null;
}

/**
 * Best-effort backend shutdown. Called from the program's postAction
 * hook so a one-shot CLI command exits cleanly after the work is done.
 *
 * Why: node-pg's Pool defaults to `idleTimeoutMillis: 10000`. After
 * every CLI command, the still-idle pooled connection keeps the event
 * loop alive for that full 10s before the process can exit. End users
 * see `mem search` block for ~10s after the JSON has already printed.
 *
 * No-op when no backend was ever instantiated (no `mem`/`sync` command
 * ran, or the lookup failed before getBackend resolved). Errors are
 * swallowed — we're shutting down anyway, complaining isn't useful.
 */
export async function closeBackendIfCached(): Promise<void> {
  if (!cached) return;
  try {
    const backend = await cached;
    await backend.close();
  } catch {
    /* shutdown is best-effort */
  }
  cached = null;
}

// ─── Embedding-aware helpers ───────────────────────────────────────────────

export interface AddOptions {
  embed?: boolean;
  embeddingModel?: string;
  /**
   * Replace-semantics flag forwarded to `backend.upsertByKeys`. Sync
   * callers pass `true` so deleted source fields actually disappear from
   * memory; interactive callers leave it off so patches accumulate.
   */
  replace?: boolean;
  /**
   * Suppress the DERIVED `searchable_text` / `content_hash`, sending NULL so
   * the store's `COALESCE(p_…, r.…)` keeps whatever is already there.
   *
   * For a caller that can only see part of a record. Sync's phase-1 list write
   * is the case this exists for: it holds `{id, snippet}` while the stored row
   * holds the enriched thread body, so deriving text from what it can see
   * would overwrite the good FTS content with a thin summary. Without this
   * flag there is no way to opt out — `prepareRecord` always derives.
   *
   * Only meaningful with `replace: false`; under replace the store takes the
   * incoming value verbatim, NULL included. On a fresh INSERT there is nothing
   * to preserve, so the row lands with NULL searchable_text until the
   * authoritative writer fills it in (`mem admin reindex --searchable`
   * backfills if that never happens).
   */
  preserveDerived?: boolean;
}

/**
 * Derive the searchable text + content hash + embedding (if enabled) and
 * call `backend.insert`. Used by `one mem add` and by any code path that
 * wants to insert a "fresh" record without upsert semantics.
 */
export async function addRecord(input: RecordInput, opts: AddOptions = {}): Promise<MemRecord> {
  const backend = await getBackend();
  const { searchable_text, content_hash, embedding, embedding_model } = await prepareRecord(input, opts, 'add');

  // Merge derived fields into the insert payload, respecting caller overrides.
  const prepared: RecordInput & { embedding?: number[] | null; embedding_model?: string | null } = {
    ...input,
    searchable_text: input.searchable_text ?? searchable_text,
    content_hash: input.content_hash ?? content_hash,
    embedding,
    embedding_model,
  };
  return backend.insert(prepared);
}

/**
 * Update a record's `data` (shallow-merged, matching backend semantics)
 * and regenerate the derived `searchable_text` + `content_hash` from the
 * MERGED data — unless the caller passes an explicit `searchable_text`.
 *
 * Fixes the stale-searchable_text bug: `backend.update` on its own keeps
 * the old searchable_text, so `mem update` used to leave FTS pointing at
 * pre-edit content (and agent-authored records that were progressively
 * enriched via update never became findable on their new fields).
 *
 * Embedding refresh is left to `mem reindex`, but it self-heals: when the
 * regenerated text differs, `backend.update` nulls the row's embedding
 * bookkeeping so the next reindex re-embeds it (no expensive API call on
 * the edit itself). Note this uses `defaultSearchableText` even for synced
 * types whose profile declares a custom `memory.searchable` block — the
 * next sync run rewrites it from the profile paths, so it self-heals there
 * too; interactive edits to synced rows are rare anyway.
 */
export async function updateRecord(
  id: string,
  patch: Partial<RecordInput>,
): Promise<MemRecord | null> {
  const backend = await getBackend();
  const existing = (await backend.getById(id)) as MemRecord | null;
  if (!existing) return null;

  const mergedData = patch.data ? { ...existing.data, ...patch.data } : existing.data;

  // Only regenerate when data actually moves (or the caller supplied text).
  // A metadata-only patch (weight, tags) leaves searchable_text/hash alone.
  const dataChanged = patch.data !== undefined;
  const searchable_text =
    patch.searchable_text ?? (dataChanged ? defaultSearchableText(mergedData) : existing.searchable_text ?? undefined);
  const content_hash =
    patch.content_hash ?? (dataChanged ? contentHash(mergedData) : existing.content_hash ?? undefined);

  return backend.update(id, {
    ...patch,
    data: mergedData,
    searchable_text,
    content_hash,
  });
}

export async function upsertRecord(input: RecordInput, opts: AddOptions = {}): Promise<UpsertResult> {
  const backend = await getBackend();
  const { searchable_text, content_hash, embedding, embedding_model } = await prepareRecord(input, opts, 'sync');

  // `preserveDerived` sends NULL for the two derived columns so the store's
  // COALESCE keeps the richer value it already holds. The embedding is still
  // computed and passed: it is derived from the text this caller CAN see, and
  // an embedding is never worse than no embedding. See AddOptions.
  const prepared: RecordInput & { embedding?: number[] | null; embedding_model?: string | null } = {
    ...input,
    searchable_text: opts.preserveDerived ? undefined : (input.searchable_text ?? searchable_text),
    content_hash: opts.preserveDerived ? undefined : (input.content_hash ?? content_hash),
    embedding,
    embedding_model,
  };
  const backendOpts: UpsertOptions = { replace: opts.replace ?? false };
  return backend.upsertByKeys(prepared, backendOpts);
}

type PrepareContext = 'add' | 'sync';

interface PreparedFields {
  searchable_text: string;
  content_hash: string;
  embedding: number[] | null;
  embedding_model: string | null;
}

async function prepareRecord(
  input: RecordInput,
  opts: AddOptions,
  ctx: PrepareContext,
): Promise<PreparedFields> {
  const cfg = getMemoryConfigOrDefault();
  const searchable_text = input.searchable_text ?? defaultSearchableText(input.data);
  const content_hash = input.content_hash ?? contentHash(input.data);

  // Embedding gate. Precedence (highest first):
  //   explicit opts.embed → input.embed → config default for the context
  const wantEmbed =
    opts.embed ??
    input.embed ??
    (ctx === 'add' ? cfg.defaults.embedOnAdd : cfg.defaults.embedOnSync);

  if (!wantEmbed || cfg.embedding.provider === 'none' || !searchable_text) {
    return { searchable_text, content_hash, embedding: null, embedding_model: null };
  }

  const result = await embed(searchable_text, { model: opts.embeddingModel });
  if (!result) return { searchable_text, content_hash, embedding: null, embedding_model: null };
  return { searchable_text, content_hash, embedding: result.vector, embedding_model: result.model };
}
