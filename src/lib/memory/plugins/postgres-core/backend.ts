/**
 * CoreBackend: shared MemBackend implementation over a `PgClient`.
 *
 * Both the PGlite and Postgres first-party plugins wrap this class with a
 * driver-specific client. The SQL is intentionally plain-ish Postgres (no
 * driver-specific extensions) so third-party plugins that wrap their own
 * Postgres-compatible engines can reuse it directly.
 *
 * See docs/plans/unified-memory.md §4 and §5 for the schema and contract
 * this implements.
 */

import type {
  MemBackend,
  BackendCapabilities,
  UpsertResult,
  UpsertOptions,
  RawSqlResult,
} from '../../backend.js';
import { validateReadOnlySql } from './sql-guard.js';
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
} from '../../types.js';
import {
  EXTENSIONS_SQL,
  TABLES_SQL,
  INDEXES_SQL,
  FUNCTIONS_SQL,
  VECTOR_EXTENSION_SQL,
  VECTOR_COLUMNS_SQL,
  VECTOR_FUNCTIONS_SQL,
  VECTOR_INDEX_SQL,
  HYBRID_SEARCH_SQL,
  SCHEMA_VERSION,
  getMetaInsertSQL,
} from '../../schema.js';
import {
  PgClient,
  vectorLiteral,
  jsonPathArray,
  hotColumnIndexName,
} from './client.js';

// Stable advisory-lock id for schema setup. Arbitrary 63-bit value; only
// requirement is that it's distinct from any other advisory lock the host
// app might use. Spells "ONEMEM__" loosely as ASCII bytes.
const SCHEMA_LOCK_ID = 7193095520723763200n.toString();

// ─── Row shape returned by Postgres ────────────────────────────────────────

interface RecordRow {
  id: string;
  type: string;
  data: Record<string, unknown>;
  tags: string[] | null;
  keys: string[] | null;
  sources: SourcesMap;
  searchable_text: string | null;
  embedding: unknown;
  embedded_at: string | null;
  embedding_model: string | null;
  content_hash: string | null;
  weight: number;
  access_count: number;
  last_accessed_at: string | null;
  status: 'active' | 'archived';
  archived_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: RecordRow): MemRecord {
  return {
    id: row.id,
    type: row.type,
    data: row.data,
    tags: row.tags ?? undefined,
    keys: row.keys ?? undefined,
    sources: row.sources ?? {},
    searchable_text: row.searchable_text,
    embedded_at: row.embedded_at,
    embedding_model: row.embedding_model,
    content_hash: row.content_hash,
    weight: row.weight,
    access_count: row.access_count,
    last_accessed_at: row.last_accessed_at,
    status: row.status,
    archived_reason: row.archived_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── Backend ───────────────────────────────────────────────────────────────

export class CoreBackend implements MemBackend {
  constructor(
    private readonly client: PgClient,
    private readonly caps: BackendCapabilities,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────────────────

  async init(): Promise<void> {
    // Client owners are expected to open their connection before calling;
    // this is a no-op placeholder so consumers have a single well-known
    // lifecycle contract.
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ensureSchema(): Promise<void> {
    const caps = this.caps;
    // Apply in logical blocks so a backend without pgvector skips the
    // vector-specific DDL cleanly. The core blocks (tables, indexes,
    // functions) never reference the vector type — the embedding column
    // is added via VECTOR_COLUMNS_SQL only when the capability is on,
    // and the upsert function gets a vector-aware override (same
    // signature, p_embedding TEXT) from VECTOR_FUNCTIONS_SQL.
    //
    // Serialize concurrent CLI processes with a Postgres transaction-
    // scoped advisory lock. Without this, two processes hitting the
    // daemon at once race on `CREATE EXTENSION` / `CREATE OR REPLACE
    // FUNCTION`, producing `tuple concurrently updated` on pg_proc.
    //
    // Why xact_lock + transaction: the pg_advisory_lock variant is
    // session-scoped, but the underlying pool may check out a different
    // connection per query — so the lock would be acquired on conn A,
    // DDL would run on B/C/D, and the unlock could land on a totally
    // different connection (returning false), leaving the lock held by
    // conn A's session until that connection idle-times-out. Wrapping
    // the whole block in `client.transaction` pins it to a single
    // connection and `pg_advisory_xact_lock` auto-releases on commit/
    // rollback, so there's no path where the lock outlives the call.
    await this.client.transaction(async (tx) => {
      try {
        await tx.query(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_ID}::bigint)`);
      } catch {
        // Backends that don't implement advisory locks fall through —
        // the race is only observable across processes anyway, and
        // first-party plugins all support the function.
      }
      if (EXTENSIONS_SQL.trim()) await tx.query(EXTENSIONS_SQL);
      await tx.query(TABLES_SQL);
      await tx.query(INDEXES_SQL);
      await tx.query(FUNCTIONS_SQL);
      if (caps.vectorSearch) {
        await tx.query(VECTOR_EXTENSION_SQL);
        await tx.query(VECTOR_COLUMNS_SQL);
        await tx.query(VECTOR_FUNCTIONS_SQL);
        await tx.query(VECTOR_INDEX_SQL);
        await tx.query(HYBRID_SEARCH_SQL);
      }
      await tx.query(getMetaInsertSQL(SCHEMA_VERSION));
    });
  }

  async getSchemaVersion(): Promise<string | null> {
    const res = await this.client.query<{ value: string }>(
      `SELECT value FROM mem_meta WHERE key = 'version'`,
    );
    return res.rows[0]?.value ?? null;
  }

  // ── Records ──────────────────────────────────────────────────────────

  async insert(row: RecordInput): Promise<MemRecord> {
    const embedding = vectorLiteral(row.embedding ?? null);
    const sql = this.caps.vectorSearch
      ? `INSERT INTO mem_records
          (type, data, tags, keys, sources, searchable_text, content_hash, weight,
           embedding, embedded_at, embedding_model)
         VALUES ($1, $2::jsonb, $3::text[], $4::text[], $5::jsonb, $6, $7, $8,
                 $9::vector, CASE WHEN $9 IS NOT NULL THEN NOW() ELSE NULL END, $10)
         RETURNING *`
      : `INSERT INTO mem_records
          (type, data, tags, keys, sources, searchable_text, content_hash, weight)
         VALUES ($1, $2::jsonb, $3::text[], $4::text[], $5::jsonb, $6, $7, $8)
         RETURNING *`;
    const params = this.caps.vectorSearch
      ? [
          row.type,
          JSON.stringify(row.data),
          row.tags ?? null,
          row.keys ?? null,
          JSON.stringify(row.sources ?? {}),
          row.searchable_text ?? null,
          row.content_hash ?? null,
          row.weight ?? 5,
          embedding,
          row.embedding_model ?? null,
        ]
      : [
          row.type,
          JSON.stringify(row.data),
          row.tags ?? null,
          row.keys ?? null,
          JSON.stringify(row.sources ?? {}),
          row.searchable_text ?? null,
          row.content_hash ?? null,
          row.weight ?? 5,
        ];
    const res = await this.client.query<RecordRow>(sql, params);
    return toRecord(res.rows[0]);
  }

  async upsertByKeys(row: RecordInput, opts: UpsertOptions = {}): Promise<UpsertResult> {
    const embedding = vectorLiteral(row.embedding ?? null);
    const embeddingModel = row.embedding_model ?? null;

    const res = await this.client.query<{ id: string; action: 'inserted' | 'updated' }>(
      `SELECT id, action FROM mem_upsert_by_keys(
          $1::text, $2::jsonb, $3::text[], $4::text[], $5::jsonb, $6::text, $7::text,
          $8::integer, $9::text, $10::text, $11::boolean
       )`,
      [
        row.type,
        JSON.stringify(row.data),
        row.tags ?? null,
        row.keys ?? null,
        JSON.stringify(row.sources ?? {}),
        row.searchable_text ?? null,
        row.content_hash ?? null,
        row.weight ?? null,
        embedding,
        embeddingModel,
        opts.replace ?? false,
      ],
    );
    const { id, action } = res.rows[0];
    const record = await this.getById(id);
    if (!record) throw new Error(`upsertByKeys: record ${id} vanished mid-operation`);
    return { record: record as MemRecord, action };
  }

  async getById(id: string, opts: { withLinks?: boolean } = {}): Promise<MemRecord | MemRecordWithLinks | null> {
    const res = await this.client.query<RecordRow>(
      `SELECT * FROM mem_records WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    const rec = toRecord(row);
    if (!opts.withLinks) return rec;

    const outgoing = await this.linked(id, { direction: 'outgoing' });
    const incoming = await this.linked(id, { direction: 'incoming' });
    return { ...rec, outgoing, incoming };
  }

  async update(id: string, patch: Partial<RecordInput>): Promise<MemRecord | null> {
    const existing = (await this.getById(id)) as MemRecord | null;
    if (!existing) return null;

    const data = patch.data ? { ...existing.data, ...patch.data } : existing.data;
    const tags = patch.tags ?? existing.tags ?? null;
    const keys = patch.keys ?? existing.keys ?? null;
    const sources = patch.sources
      ? { ...existing.sources, ...patch.sources }
      : existing.sources;
    const searchable = patch.searchable_text ?? existing.searchable_text ?? null;
    const hash = patch.content_hash ?? existing.content_hash ?? null;
    const weight = patch.weight ?? existing.weight;

    const res = await this.client.query<RecordRow>(
      `UPDATE mem_records
         SET data = $2::jsonb,
             tags = $3::text[],
             keys = $4::text[],
             sources = $5::jsonb,
             searchable_text = $6,
             content_hash = $7,
             weight = $8
       WHERE id = $1
       RETURNING *`,
      [id, JSON.stringify(data), tags, keys, JSON.stringify(sources), searchable, hash, weight],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.client.query(`DELETE FROM mem_records WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async archive(id: string, reason?: string): Promise<boolean> {
    const res = await this.client.query(
      `UPDATE mem_records SET status = 'archived', archived_reason = $2
       WHERE id = $1 AND status = 'active'`,
      [id, reason ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async unarchive(id: string): Promise<boolean> {
    const res = await this.client.query(
      `UPDATE mem_records SET status = 'active', archived_reason = NULL
       WHERE id = $1 AND status = 'archived'`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async list(type: string, opts: ListOptions = {}): Promise<MemRecord[]> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const status = opts.status ?? 'active';
    const res = await this.client.query<RecordRow>(
      `SELECT * FROM mem_records
        WHERE type = $1 AND status = $2
        ORDER BY updated_at DESC
        LIMIT $3 OFFSET $4`,
      [type, status, limit, offset],
    );
    return res.rows.map(toRecord);
  }

  async count(type: string, opts: { status?: 'active' | 'archived' | 'all' } = {}): Promise<number> {
    const status = opts.status ?? 'active';
    if (status === 'all') {
      const res = await this.client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM mem_records WHERE type = $1`,
        [type],
      );
      return Number(res.rows[0]?.count ?? 0);
    }
    const res = await this.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM mem_records WHERE type = $1 AND status = $2`,
      [type, status],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async listForReindex(opts: {
    type?: string;
    targetEmbeddingModel?: string;
    includeAlreadyEmbedded?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<Array<{
    id: string;
    type: string;
    searchable_text: string | null;
    content_hash: string | null;
    embedding_model: string | null;
  }>> {
    // No vector capability → no embedding columns in the schema → no
    // rows can ever need (re)indexing. Short-circuit before touching
    // SQL that references missing columns.
    if (!this.caps.vectorSearch) return [];
    const limit = opts.limit ?? 1000;
    const offset = opts.offset ?? 0;
    const params: unknown[] = [];
    // Exclude empty searchable_text explicitly — not just NULL. Synced
    // rows can land with an empty string when memory.searchable paths
    // resolve to nothing (e.g. an Attio contact with no name / title /
    // description / email) and an empty string is an OpenAI-rejectable
    // input, so the loop would pull the same rows every iteration
    // forever. Exclude them from consideration, full stop.
    const clauses: string[] = [
      `status = 'active'`,
      `searchable_text IS NOT NULL`,
      `searchable_text <> ''`,
    ];

    if (opts.type) {
      params.push(opts.type);
      clauses.push(`type = $${params.length}`);
    }

    // Without `includeAlreadyEmbedded`, filter at the SQL layer so the
    // loop doesn't spin on already-done rows. The old code ordered by
    // updated_at DESC, which sorted the *most recently embedded* rows
    // to the top — backfill saw only skips and terminated early.
    if (!opts.includeAlreadyEmbedded) {
      if (opts.targetEmbeddingModel) {
        params.push(opts.targetEmbeddingModel);
        clauses.push(`(embedded_at IS NULL OR embedding_model IS DISTINCT FROM $${params.length})`);
      } else {
        clauses.push(`embedded_at IS NULL`);
      }
    }

    params.push(limit);
    params.push(offset);
    // Deterministic order — NULL embeddings first so the earliest-
    // needed rows drain first; model-mismatch rows follow. Using `id`
    // as the secondary sort keeps pagination stable even when many
    // rows share the same embedded_at timestamp (e.g. a batch update).
    const res = await this.client.query<{
      id: string;
      type: string;
      searchable_text: string | null;
      content_hash: string | null;
      embedding_model: string | null;
    }>(
      `SELECT id, type, searchable_text, content_hash, embedding_model
         FROM mem_records
        WHERE ${clauses.join(' AND ')}
        ORDER BY embedded_at ASC NULLS FIRST, id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.rows;
  }

  async updateEmbedding(id: string, vector: number[], model: string): Promise<void> {
    // No vector capability → silent no-op. Callers gate on
    // caps.vectorSearch already, but the defensive check keeps a
    // mistakenly invoked update from crashing on a missing column.
    if (!this.caps.vectorSearch) return;
    const literal = vectorLiteral(vector);
    if (literal === null) return;
    await this.client.query(
      `UPDATE mem_records
          SET embedding = $2::vector,
              embedding_model = $3,
              embedded_at = NOW()
        WHERE id = $1`,
      [id, literal, model],
    );
  }

  async listKeysByType(type: string): Promise<Array<{ id: string; keys: string[] }>> {
    const res = await this.client.query<{ id: string; keys: string[] }>(
      `SELECT id, keys FROM mem_records WHERE type = $1 AND status = 'active'`,
      [type],
    );
    return res.rows;
  }

  // ── Search ───────────────────────────────────────────────────────────

  async search(q: string, opts: SearchOptions): Promise<SearchResult[]> {
    const limit = opts.limit ?? 10;
    const type = opts.type ?? null;
    const includeArchived = opts.includeArchived ?? false;
    const ftsWeight = opts.ftsWeight ?? 0.3;
    const semanticWeight = opts.semanticWeight ?? 0.7;

    const embedding = vectorLiteral(opts.queryEmbedding ?? null);
    const canSemantic = this.caps.vectorSearch && embedding !== null;

    let rows: SearchResult[];
    if (canSemantic) {
      const res = await this.client.query<SearchResult>(
        `SELECT * FROM mem_hybrid_search($1, $2::vector, $3, $4, $5, $6, 50, $7)`,
        [q, embedding, limit, type, ftsWeight, semanticWeight, includeArchived],
      );
      rows = res.rows;
    } else {
      const res = await this.client.query<SearchResult>(
        `SELECT r.id,
                r.type,
                r.data,
                r.tags,
                ts_rank_cd(r.searchable, websearch_to_tsquery('english', $1))::float AS fts_rank,
                0.0::float AS semantic_rank,
                ts_rank_cd(r.searchable, websearch_to_tsquery('english', $1))::float AS combined_score
           FROM mem_records r
          WHERE r.searchable @@ websearch_to_tsquery('english', $1)
            AND ($2::text IS NULL OR r.type = $2)
            AND ($3 OR r.status = 'active')
          ORDER BY combined_score DESC
          LIMIT $4`,
        [q, type, includeArchived, limit],
      );
      rows = res.rows;
    }

    if (opts.trackAccess !== false && rows.length > 0) {
      await this.trackAccess(rows.map(r => r.id));
    }

    return rows;
  }

  async context(opts: ContextOptions): Promise<ContextResult[]> {
    const limit = opts.limit ?? 20;
    const types = opts.types ?? null;
    const res = await this.client.query<ContextResult>(
      `SELECT id, type, data, tags, keys, weight, access_count,
              mem_calculate_relevance(weight, access_count, last_accessed_at, created_at)::float AS relevance_score
         FROM mem_records
        WHERE status = 'active'
          AND ($1::text[] IS NULL OR type = ANY($1))
        ORDER BY relevance_score DESC
        LIMIT $2`,
      [types, limit],
    );
    return res.rows;
  }

  async trackAccess(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.query(`SELECT mem_increment_access($1::uuid[])`, [ids]);
  }

  // ── Graph ────────────────────────────────────────────────────────────

  async link(fromId: string, toId: string, relation: string, opts: LinkOptions = {}): Promise<string> {
    const bidirectional = opts.bidirectional ?? false;
    const metadata = opts.metadata ? JSON.stringify(opts.metadata) : null;
    const res = await this.client.query<{ id: string }>(
      `INSERT INTO mem_links (from_id, to_id, relation, bidirectional, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (from_id, to_id, relation) DO UPDATE
         SET bidirectional = EXCLUDED.bidirectional,
             metadata = COALESCE(EXCLUDED.metadata, mem_links.metadata)
       RETURNING id`,
      [fromId, toId, relation, bidirectional, metadata],
    );
    return res.rows[0].id;
  }

  async unlink(fromId: string, toId: string, relation: string): Promise<boolean> {
    const res = await this.client.query(
      `DELETE FROM mem_links WHERE from_id = $1 AND to_id = $2 AND relation = $3`,
      [fromId, toId, relation],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async linked(id: string, opts: LinkedOptions = {}): Promise<LinkedRecord[]> {
    const relation = opts.relation ?? null;
    const direction = opts.direction ?? 'outgoing';
    const includeOutgoing = direction === 'outgoing' || direction === 'both';
    const includeIncoming = direction === 'incoming' || direction === 'both';
    const includeBidiAsIncoming = direction === 'outgoing'; // bidi edges surface both ways by default

    const res = await this.client.query<LinkedRecord>(
      `SELECT r.id, r.type, r.data, l.relation, l.bidirectional, l.metadata
         FROM mem_links l
         JOIN mem_records r ON r.id = l.to_id
        WHERE l.from_id = $1
          AND ($2::text IS NULL OR l.relation = $2)
          AND $3::boolean
       UNION ALL
       SELECT r.id, r.type, r.data, l.relation, l.bidirectional, l.metadata
         FROM mem_links l
         JOIN mem_records r ON r.id = l.from_id
        WHERE l.to_id = $1
          AND ($2::text IS NULL OR l.relation = $2)
          AND ($4::boolean OR ($5::boolean AND l.bidirectional = true))`,
      [id, relation, includeOutgoing, includeIncoming, includeBidiAsIncoming],
    );
    return res.rows;
  }

  // ── Sources ──────────────────────────────────────────────────────────

  async addSource(recordId: string, ref: SourceRefInput): Promise<void> {
    const entry = {
      url: ref.url ?? null,
      metadata: ref.metadata ?? {},
      last_synced_at: ref.last_synced_at ?? new Date().toISOString(),
    };
    await this.client.query(
      `UPDATE mem_records
          SET sources = sources || jsonb_build_object($2::text, $3::jsonb),
              keys = (SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(COALESCE(keys, '{}') || ARRAY[$2::text])))
        WHERE id = $1`,
      [recordId, ref.sourceKey, JSON.stringify(entry)],
    );
  }

  async removeSource(recordId: string, sourceKey: string): Promise<boolean> {
    const res = await this.client.query(
      `UPDATE mem_records
          SET sources = sources - $2::text
        WHERE id = $1 AND sources ? $2`,
      [recordId, sourceKey],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async findBySource(sourceKey: string): Promise<MemRecord | null> {
    // sourceKey lives in keys[] (indexed GIN), so this is a fast lookup.
    const res = await this.client.query<RecordRow>(
      `SELECT * FROM mem_records WHERE $1 = ANY(keys) LIMIT 1`,
      [sourceKey],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async listSources(recordId: string): Promise<SourcesMap> {
    const res = await this.client.query<{ sources: SourcesMap }>(
      `SELECT sources FROM mem_records WHERE id = $1`,
      [recordId],
    );
    return res.rows[0]?.sources ?? {};
  }

  // ── Sync state ───────────────────────────────────────────────────────

  async getSyncState(platform: string, model: string): Promise<SyncStateRow | null> {
    const res = await this.client.query<SyncStateRow>(
      `SELECT * FROM mem_sync_state WHERE platform = $1 AND model = $2`,
      [platform, model],
    );
    return res.rows[0] ?? null;
  }

  async setSyncState(state: SyncStateRow): Promise<void> {
    await this.client.query(
      `INSERT INTO mem_sync_state (platform, model, last_sync_at, last_cursor, since,
                                   total_records, pages_processed, status, last_error)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
       ON CONFLICT (platform, model) DO UPDATE SET
         last_sync_at = EXCLUDED.last_sync_at,
         last_cursor = EXCLUDED.last_cursor,
         since = EXCLUDED.since,
         total_records = EXCLUDED.total_records,
         pages_processed = EXCLUDED.pages_processed,
         status = EXCLUDED.status,
         last_error = EXCLUDED.last_error`,
      [
        state.platform,
        state.model,
        state.last_sync_at ?? null,
        JSON.stringify(state.last_cursor ?? null),
        state.since ?? null,
        state.total_records,
        state.pages_processed,
        state.status,
        state.last_error ?? null,
      ],
    );
  }

  async listSyncStates(): Promise<SyncStateRow[]> {
    const res = await this.client.query<SyncStateRow>(
      `SELECT * FROM mem_sync_state ORDER BY platform, model`,
    );
    return res.rows;
  }

  async removeSyncState(platform: string, model?: string): Promise<void> {
    if (model) {
      await this.client.query(
        `DELETE FROM mem_sync_state WHERE platform = $1 AND model = $2`,
        [platform, model],
      );
    } else {
      await this.client.query(`DELETE FROM mem_sync_state WHERE platform = $1`, [platform]);
    }
  }

  // ── Raw read-only SQL ───────────────────────────────────────────────
  //
  // Exposed to users via `one mem sql` and `one sync sql` so they can run
  // joins / aggregates / JSONB paths that the high-level helpers can't.
  // The guard rejects anything that isn't SELECT / WITH / EXPLAIN before
  // the query reaches the client.

  async raw(sql: string, params?: unknown[]): Promise<RawSqlResult> {
    validateReadOnlySql(sql);
    const res = await this.client.query<Record<string, unknown>>(sql, params ?? []);
    // `columns` is the insertion order of the first row's keys. Good
    // enough for display; pg drivers don't surface a universal metadata
    // shape and we don't want to force one on third-party plugins.
    const columns = res.rows.length > 0 ? Object.keys(res.rows[0]) : [];
    return {
      columns,
      rows: res.rows,
      rowCount: res.rows.length,
    };
  }

  // ── Hot columns ──────────────────────────────────────────────────────

  async ensureHotColumn(type: string, jsonPath: string): Promise<void> {
    if (!this.caps.partialIndexes) return;
    const name = hotColumnIndexName(type, jsonPath);
    const pathArr = jsonPathArray(jsonPath);
    // Parameterized CREATE INDEX is not supported, so we inline the
    // validated-shape name + path. Safe: type and path go through slugging
    // and array-literal encoding.
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${name}
        ON mem_records ((data #>> '${pathArr}'::text[]))
        WHERE type = $1`,
      [type],
    );
  }

  async dropHotColumn(type: string, jsonPath: string): Promise<void> {
    const name = hotColumnIndexName(type, jsonPath);
    await this.client.query(`DROP INDEX IF EXISTS ${name}`);
  }

  // ── Maintenance ──────────────────────────────────────────────────────

  async vacuum(): Promise<void> {
    // VACUUM cannot run inside a transaction. Individual clients may need
    // to release any wrapping transaction before calling.
    await this.client.query(`VACUUM ANALYZE mem_records`);
    await this.client.query(`VACUUM ANALYZE mem_links`);
    await this.client.query(`VACUUM ANALYZE mem_sync_state`);
  }

  async stats(): Promise<BackendStats> {
    // The embedding column only exists when the backend advertises
    // vectorSearch — gate the embedded_count subquery so this works on
    // a no-vector schema too. Fixed at 0 when no vector capability.
    const embeddedCountSql = this.caps.vectorSearch
      ? `(SELECT COUNT(*) FROM mem_records WHERE embedding IS NOT NULL)`
      : `(SELECT 0)`;
    const res = await this.client.query<{
      record_count: string;
      active_count: string;
      archived_count: string;
      link_count: string;
      embedded_count: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM mem_records)                              AS record_count,
         (SELECT COUNT(*) FROM mem_records WHERE status = 'active')      AS active_count,
         (SELECT COUNT(*) FROM mem_records WHERE status = 'archived')    AS archived_count,
         (SELECT COUNT(*) FROM mem_links)                                AS link_count,
         ${embeddedCountSql}                                             AS embedded_count`,
    );
    const r = res.rows[0];
    return {
      recordCount: Number(r.record_count),
      activeCount: Number(r.active_count),
      archivedCount: Number(r.archived_count),
      linkCount: Number(r.link_count),
      embeddedCount: Number(r.embedded_count),
    };
  }

  capabilities(): BackendCapabilities {
    return this.caps;
  }
}
