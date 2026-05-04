/**
 * MemBackend contract + plugin descriptor.
 *
 * Every DB backend (PGlite, Postgres, and any third-party plugin) implements
 * `MemBackend`. Plugins register a `MemBackendPlugin` factory with the
 * registry in `plugins.ts`; `loadBackendFromConfig()` picks the right one
 * based on config.
 *
 * See docs/plans/unified-memory.md §5 for the full rationale.
 */

import type {
  MemRecord,
  MemRecordWithLinks,
  LinkedRecord,
  SearchResult,
  ContextResult,
  RecordInput,
  ListOptions,
  SearchOptions,
  ContextOptions,
  LinkOptions,
  LinkedOptions,
  SourceRefInput,
  SyncStateRow,
  BackendStats,
  SourcesMap,
} from './types.js';

// ─── Capabilities ───────────────────────────────────────────────────────────

export interface BackendCapabilities {
  /** Supports a pgvector-style embedding column and ANN search. */
  vectorSearch: boolean;
  /** Supports a language-aware full-text index (tsvector / FTS5 / etc). */
  fullTextSearch: boolean;
  /** Supports partial expression indexes for hot columns. */
  partialIndexes: boolean;
  /** Supports efficient JSONB path queries (`data->>'field'`). */
  jsonPathQuery: boolean;
  /** Supports triggers (used for key-uniqueness + searchable_text). */
  triggers: boolean;
  /** Supports concurrent writers (e.g. Postgres yes, PGlite no). */
  concurrentWriters: boolean;
  /** Max embedding dimensions supported (or null for unbounded). */
  maxVectorDims: number | null;
  /**
   * Supports raw read-only SQL via `backend.raw(sql, params?)`. First-
   * party SQL backends (embedded-postgres, postgres) advertise true;
   * third-party plugins that only expose high-level methods set this false.
   */
  rawSql: boolean;
}

export interface RawSqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

// ─── Backend ────────────────────────────────────────────────────────────────

export interface UpsertResult {
  record: MemRecord;
  action: 'inserted' | 'updated';
}

export interface UpsertOptions {
  /**
   * When true, the existing record's `data` is REPLACED by the incoming
   * payload (fields present before but missing now disappear). When false
   * — the default — the existing record's `data` is shallow-merged with
   * the incoming payload, which is the right semantic for user-authored
   * memories but wrong for synced rows where memory should track the
   * source exactly. Sync callers pass `replace: true`; interactive
   * callers (mem add, mem update) leave it off.
   */
  replace?: boolean;
}

export interface MemBackend {
  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;
  ensureSchema(): Promise<void>;
  getSchemaVersion(): Promise<string | null>;

  // Records
  insert(row: RecordInput): Promise<MemRecord>;
  upsertByKeys(row: RecordInput, opts?: UpsertOptions): Promise<UpsertResult>;
  getById(id: string, opts?: { withLinks?: boolean }): Promise<MemRecord | MemRecordWithLinks | null>;
  update(id: string, patch: Partial<RecordInput>): Promise<MemRecord | null>;
  remove(id: string): Promise<boolean>;
  archive(id: string, reason?: string): Promise<boolean>;
  unarchive(id: string): Promise<boolean>;
  list(type: string, opts?: ListOptions): Promise<MemRecord[]>;
  /**
   * True record count for a type, honoring the same `status` filter as
   * `list`. Separate from `list(...).length` because that number is
   * capped by the caller's `limit`. Pagers + agents that rely on
   * knowing "how many total?" need this to be honest.
   */
  count(type: string, opts?: { status?: 'active' | 'archived' | 'all' }): Promise<number>;

  // Search
  search(q: string, opts: SearchOptions): Promise<SearchResult[]>;
  context(opts: ContextOptions): Promise<ContextResult[]>;
  trackAccess(ids: string[]): Promise<void>;

  // Graph
  link(fromId: string, toId: string, relation: string, opts?: LinkOptions): Promise<string>;
  unlink(fromId: string, toId: string, relation: string): Promise<boolean>;
  linked(id: string, opts?: LinkedOptions): Promise<LinkedRecord[]>;

  // Sources (inlined on the record; thin helpers over JSONB)
  addSource(recordId: string, ref: SourceRefInput): Promise<void>;
  removeSource(recordId: string, sourceKey: string): Promise<boolean>;
  findBySource(sourceKey: string): Promise<MemRecord | null>;
  listSources(recordId: string): Promise<SourcesMap>;

  // Sync state
  getSyncState(platform: string, model: string): Promise<SyncStateRow | null>;
  setSyncState(state: SyncStateRow): Promise<void>;
  listSyncStates(): Promise<SyncStateRow[]>;
  /**
   * Delete the row for a (platform, model) pair. When `model` is omitted,
   * drops every row for that platform. Used by `sync remove`.
   */
  removeSyncState(platform: string, model?: string): Promise<void>;

  /**
   * Execute a read-only SQL query. Only present when `capabilities().
   * rawSql === true`. Backends MUST validate that the query is read-only
   * before executing (SELECT / WITH / EXPLAIN only; no DDL/DML). The
   * `one mem sql` / `one sync sql` commands go through this method.
   */
  raw?(sql: string, params?: unknown[]): Promise<RawSqlResult>;

  /**
   * Lean reindex scan — returns rows that NEED embedding work, ordered
   * so NULL-embedded rows come first. Skips the JSONB `data` buffer
   * entirely (only id / type / searchable_text / content_hash /
   * embedding_model are pulled), critical on PGlite where reading a
   * large `data` column at scale has hit WASM memory-access corruption.
   *
   * Filter semantics — rows are returned when, in order:
   *   - `searchable_text` is not null (nothing to embed)
   *   - `embedded_at` is null (never embedded) OR
   *     `embedding_model` is not `targetEmbeddingModel` (wrong model)
   * Unless `includeAlreadyEmbedded: true` (the `--force` path).
   *
   * Order: NULL embeddings first by `id` ascending, then model-
   * mismatched rows. Deterministic so paginated runs don't re-see
   * the same rows after each batch bumps their `updated_at`.
   */
  listForReindex(opts?: {
    type?: string;
    targetEmbeddingModel?: string;
    includeAlreadyEmbedded?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<Array<{
    id: string;
    type: string;
    searchable_text: string | null;
    content_hash: string | null;
    embedding_model: string | null;
  }>>;

  /**
   * Lean reconcile scan — returns `{id, keys[]}` for every active
   * record of `type`. Used by `--full-refresh` to compute the set of
   * rows whose source didn't appear this run and archive them. Does
   * NOT read `data` / `searchable_text` / `embedding`; the whole point
   * is staying narrow enough to avoid the PGlite WASM readback issue
   * that blows up on large per-row JSONB.
   */
  listKeysByType(type: string): Promise<Array<{ id: string; keys: string[] }>>;

  /**
   * Update ONLY the embedding + embedding_model + embedded_at columns
   * on a single record. Separate from `update()` because the reindex
   * path doesn't need (or want) to round-trip the full JSONB `data`
   * buffer that `update` requires.
   */
  updateEmbedding(id: string, vector: number[], model: string): Promise<void>;

  // Hot columns (profile-driven partial expression indexes)
  ensureHotColumn(type: string, jsonPath: string): Promise<void>;
  dropHotColumn(type: string, jsonPath: string): Promise<void>;

  // Maintenance
  vacuum(): Promise<void>;
  stats(): Promise<BackendStats>;

  // Capability advertisement
  capabilities(): BackendCapabilities;
}

// ─── Plugin descriptor ──────────────────────────────────────────────────────

/**
 * The result of a plugin's `parseConfig(raw)`. Plugins define their own
 * shape; the loader treats this as an opaque value passed back to `create()`.
 */
export type ParsedBackendConfig = Record<string, unknown>;

export interface MemBackendPlugin {
  /** Unique backend name, lowercase, used as the `memory.backend` config value. */
  name: string;

  /** Short description shown in `one mem init` picker and `one mem config`. */
  description: string;

  /** Semver of the plugin implementation (independent of schema). */
  version: string;

  /** Schema version this plugin understands. Must include base schema version. */
  schemaVersion: string;

  /** Capabilities this plugin advertises (see above). */
  capabilities: BackendCapabilities;

  /**
   * Validate + normalize the backend-specific config block.
   * Throws on invalid config with a descriptive message.
   */
  parseConfig(raw: unknown): ParsedBackendConfig;

  /**
   * Interactive prompts for `one mem init`.
   * Optional — plugins that have zero runtime config can omit.
   */
  promptInit?(): Promise<ParsedBackendConfig>;

  /**
   * Create a backend instance from parsed config.
   * The returned backend is not yet connected; caller runs `init()` + `ensureSchema()`.
   */
  create(config: ParsedBackendConfig): MemBackend;
}
