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

export async function upsertRecord(input: RecordInput, opts: AddOptions = {}): Promise<UpsertResult> {
  const backend = await getBackend();
  const { searchable_text, content_hash, embedding, embedding_model } = await prepareRecord(input, opts, 'sync');

  const prepared: RecordInput & { embedding?: number[] | null; embedding_model?: string | null } = {
    ...input,
    searchable_text: input.searchable_text ?? searchable_text,
    content_hash: input.content_hash ?? content_hash,
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
