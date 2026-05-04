/**
 * Unified memory types.
 *
 * These shapes are the contract both callers (CLI commands, sync runner) and
 * backend plugins agree on. See docs/plans/unified-memory.md §4 for the
 * schema this maps to, and §5 for the backend interface.
 */

// ─── Core record ────────────────────────────────────────────────────────────

export type RecordStatus = 'active' | 'archived';

export interface SourceEntry {
  /** Optional upstream URL (e.g. Attio person page, Gmail thread link). */
  url?: string | null;
  /** Arbitrary per-source metadata (labels, owner, synced_at, etc). */
  metadata?: Record<string, unknown>;
  /** Last time this source pushed an update into this record. */
  last_synced_at?: string;
}

/**
 * Map of `"<system>/<model>:<external_id>"` → per-source metadata.
 * The map key also appears in the record's `keys[]` so lookup-by-source
 * uses the GIN index on `keys`.
 */
export type SourcesMap = Record<string, SourceEntry>;

export interface MemRecord {
  id: string;
  type: string;
  data: Record<string, unknown>;
  tags?: string[];
  keys?: string[];
  sources: SourcesMap;

  searchable_text?: string | null;
  embedding?: number[] | null;
  embedded_at?: string | null;
  embedding_model?: string | null;

  content_hash?: string | null;

  weight: number;
  access_count: number;
  last_accessed_at?: string | null;

  status: RecordStatus;
  archived_reason?: string | null;

  created_at: string;
  updated_at: string;
}

export interface MemRecordWithLinks extends MemRecord {
  outgoing: LinkedRecord[];
  incoming: LinkedRecord[];
}

// ─── Links ──────────────────────────────────────────────────────────────────

export interface LinkedRecord {
  id: string;
  type: string;
  data: Record<string, unknown>;
  relation: string;
  bidirectional: boolean;
  metadata?: Record<string, unknown>;
}

// ─── Search & context ──────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  type: string;
  data: Record<string, unknown>;
  tags?: string[];
  fts_rank: number;
  semantic_rank: number;
  combined_score: number;
}

export interface ContextResult {
  id: string;
  type: string;
  data: Record<string, unknown>;
  tags?: string[];
  keys?: string[];
  weight: number;
  access_count: number;
  relevance_score: number;
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface RecordInput {
  type: string;
  data: Record<string, unknown>;
  tags?: string[];
  keys?: string[];
  sources?: SourcesMap;
  searchable_text?: string | null;
  content_hash?: string | null;
  weight?: number;
  /** Opt in/out of embedding regardless of config defaults. */
  embed?: boolean;
  /** Optional pre-computed embedding; takes precedence over generating one. */
  embedding?: number[] | null;
  embedding_model?: string | null;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  status?: RecordStatus;
}

export interface SearchOptions {
  limit?: number;
  type?: string;
  ftsWeight?: number;
  semanticWeight?: number;
  includeArchived?: boolean;
  trackAccess?: boolean;
  /** Provided by the caller when embeddings are enabled. */
  queryEmbedding?: number[] | null;
}

export interface ContextOptions {
  limit?: number;
  types?: string[];
}

export interface LinkOptions {
  bidirectional?: boolean;
  metadata?: Record<string, unknown>;
}

export interface LinkedOptions {
  relation?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
}

export interface SourceRefInput {
  /** Full source key: `"<system>/<model>:<external_id>"`. */
  sourceKey: string;
  url?: string | null;
  metadata?: Record<string, unknown>;
  last_synced_at?: string;
}

// ─── Sync state ─────────────────────────────────────────────────────────────

export interface SyncStateRow {
  platform: string;
  model: string;
  last_sync_at?: string | null;
  last_cursor?: unknown;
  since?: string | null;
  total_records: number;
  pages_processed: number;
  status: 'idle' | 'syncing' | 'failed';
  last_error?: string | null;
}

// ─── Diagnostics ───────────────────────────────────────────────────────────

export interface BackendStats {
  recordCount: number;
  activeCount: number;
  archivedCount: number;
  linkCount: number;
  embeddedCount: number;
  sizeBytes?: number;
  extra?: Record<string, unknown>;
}
