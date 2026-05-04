/**
 * Unified memory schema. Applied idempotently by `backend.ensureSchema()`.
 *
 * Four tables:
 *   - mem_records     user memories + synced rows (source tracking inlined as `sources` JSONB)
 *   - mem_links       typed graph edges (bidirectional traversal)
 *   - mem_sync_state  per (platform, model) cursor
 *   - mem_meta        schema version + internal config
 *
 * Split into logical sections so backends that need to partition statements
 * (e.g. running extensions + HNSW outside a transaction) can do so cleanly.
 * See docs/plans/unified-memory.md §4 for design rationale.
 */

export const SCHEMA_VERSION = '2.1.0';

// `pg_trgm` was in the original mem schema but nothing in the unified query
// layer uses it; dropped to keep optional-extension backends happy. Can be
// added back via an optional extension hook if fuzzy-match search lands.
//
// EXTENSIONS_SQL is intentionally empty — the only required extension is
// pgvector, and it's gated by `caps.vectorSearch` (see VECTOR_EXTENSION_SQL).
// Backends without pgvector apply the schema cleanly; semantic search and the
// embedding column are added separately when the capability is on.
export const EXTENSIONS_SQL = ``;

/**
 * Loaded after EXTENSIONS_SQL, only when `caps.vectorSearch` is true.
 * pgserve auto-installs vector on every database when configured with
 * `pgvector: true`, but we keep the explicit CREATE for backends where
 * the extension is available-but-not-yet-loaded.
 */
export const VECTOR_EXTENSION_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
`;

export const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS mem_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    type TEXT NOT NULL,
    data JSONB NOT NULL,
    tags TEXT[],
    keys TEXT[],

    sources JSONB NOT NULL DEFAULT '{}',

    searchable_text TEXT,
    searchable tsvector GENERATED ALWAYS AS (to_tsvector('english', COALESCE(searchable_text, ''))) STORED,

    content_hash TEXT,

    weight SMALLINT NOT NULL DEFAULT 5 CHECK (weight BETWEEN 1 AND 10),
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ,

    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mem_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id UUID NOT NULL REFERENCES mem_records(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES mem_records(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    bidirectional BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(from_id, to_id, relation)
);

CREATE TABLE IF NOT EXISTS mem_sync_state (
    platform TEXT NOT NULL,
    model TEXT NOT NULL,
    last_sync_at TIMESTAMPTZ,
    last_cursor JSONB,
    since TIMESTAMPTZ,
    total_records INTEGER NOT NULL DEFAULT 0,
    pages_processed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'syncing', 'failed')),
    last_error TEXT,
    PRIMARY KEY (platform, model)
);

CREATE TABLE IF NOT EXISTS mem_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/**
 * Add embedding columns to mem_records. Only applied when
 * `caps.vectorSearch` is true — backends without pgvector get an
 * embedding-column-free schema and skip the semantic codepaths in
 * CoreBackend (see line ~397: `caps.vectorSearch && embedding !== null`).
 *
 * `IF NOT EXISTS` makes this safe to re-apply on every boot.
 */
export const VECTOR_COLUMNS_SQL = `
ALTER TABLE mem_records ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE mem_records ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;
ALTER TABLE mem_records ADD COLUMN IF NOT EXISTS embedding_model TEXT;
`;

export const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_records_type         ON mem_records(type);
CREATE INDEX IF NOT EXISTS idx_records_status       ON mem_records(status);
CREATE INDEX IF NOT EXISTS idx_records_keys         ON mem_records USING GIN(keys);
CREATE INDEX IF NOT EXISTS idx_records_tags         ON mem_records USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_records_data         ON mem_records USING GIN(data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_records_sources      ON mem_records USING GIN(sources jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_records_searchable   ON mem_records USING GIN(searchable);
CREATE INDEX IF NOT EXISTS idx_records_relevance    ON mem_records(status, weight DESC, access_count DESC, last_accessed_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_records_content_hash ON mem_records(content_hash);

CREATE INDEX IF NOT EXISTS idx_links_from           ON mem_links(from_id);
CREATE INDEX IF NOT EXISTS idx_links_to             ON mem_links(to_id);
CREATE INDEX IF NOT EXISTS idx_links_relation       ON mem_links(relation);
CREATE INDEX IF NOT EXISTS idx_links_bidirectional  ON mem_links(bidirectional) WHERE bidirectional = true;
`;

/**
 * HNSW vector index. Created separately because some drivers require it
 * outside a transaction and because it's optional for backends that
 * advertise `vectorSearch: false`.
 */
export const VECTOR_INDEX_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_records_embedding') THEN
    CREATE INDEX idx_records_embedding
      ON mem_records USING HNSW(embedding vector_cosine_ops)
      WHERE embedding IS NOT NULL;
  END IF;
END $$;
`;

export const FUNCTIONS_SQL = `
-- Enforce global uniqueness of the "keys" array across records.
CREATE OR REPLACE FUNCTION mem_enforce_key_uniqueness()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    conflicting_id UUID;
BEGIN
    IF NEW.keys IS NULL THEN RETURN NEW; END IF;
    SELECT id INTO conflicting_id
    FROM mem_records
    WHERE keys && NEW.keys AND id != NEW.id
    LIMIT 1;
    IF conflicting_id IS NOT NULL THEN
        RAISE EXCEPTION 'Key conflict: one or more keys in % already exist on record %',
            NEW.keys, conflicting_id USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mem_enforce_key_uniqueness_trigger ON mem_records;
CREATE TRIGGER mem_enforce_key_uniqueness_trigger
BEFORE INSERT OR UPDATE ON mem_records
FOR EACH ROW EXECUTE FUNCTION mem_enforce_key_uniqueness();

-- Bump updated_at on write. searchable_text is owned by the caller (profile-driven).
CREATE OR REPLACE FUNCTION mem_records_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mem_records_touch_trigger ON mem_records;
CREATE TRIGGER mem_records_touch_trigger
BEFORE UPDATE ON mem_records
FOR EACH ROW EXECUTE FUNCTION mem_records_touch();

-- Relevance scoring (mirrors TS scoring.ts). See docs/plans/unified-memory.md §4.5.
CREATE OR REPLACE FUNCTION mem_calculate_relevance(
    p_weight INTEGER,
    p_access_count INTEGER,
    p_last_accessed_at TIMESTAMPTZ,
    p_created_at TIMESTAMPTZ,
    max_access_count INTEGER DEFAULT 100
) RETURNS FLOAT LANGUAGE plpgsql AS $$
DECLARE
    weight_score FLOAT;
    access_score FLOAT;
    recency_score FLOAT;
    days_since_access FLOAT;
BEGIN
    weight_score := (p_weight - 1) / 9.0;
    access_score := LEAST(p_access_count::FLOAT / max_access_count, 1.0);

    IF p_last_accessed_at IS NOT NULL THEN
        days_since_access := EXTRACT(EPOCH FROM (NOW() - p_last_accessed_at)) / 86400.0;
        recency_score := GREATEST(1.0 - (days_since_access / 30.0) * 0.9, 0.1);
    ELSE
        days_since_access := EXTRACT(EPOCH FROM (NOW() - p_created_at)) / 86400.0;
        recency_score := GREATEST(0.5 - (days_since_access / 60.0) * 0.4, 0.1);
    END IF;

    RETURN (weight_score * 0.4) + (access_score * 0.3) + (recency_score * 0.3);
END;
$$;

-- Access tracking for search results.
CREATE OR REPLACE FUNCTION mem_increment_access(record_ids UUID[])
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    UPDATE mem_records
    SET access_count = access_count + 1,
        last_accessed_at = NOW()
    WHERE id = ANY(record_ids);
END;
$$;

-- Upsert by keys: merge (or replace) into the first record whose keys overlap, else insert new.
-- Returns the resulting record id + whether the operation was insert or update.
--
-- p_replace=FALSE (default): shallow-merge existing data with p_data. Right
--   semantics for user-authored memories that get progressively enriched.
-- p_replace=TRUE: REPLACE data with p_data. Right for synced rows — if the
--   source removed a field, it must disappear from memory too.
--
-- Upsert-by-keys is the self-heal primitive for --full-refresh reconcile:
-- if the upsert finds an archived row, the source re-surfaced it, so flip
-- status back to 'active' and clear archived_reason. Without this, rows
-- archived by a buggy reconcile would stay dead until manually un-archived.
-- Core (no-vector) variant of mem_upsert_by_keys. p_embedding and
-- p_embedding_model are accepted for source compatibility with the
-- vector variant but are ignored — the embedding column doesn't exist
-- in this schema. The vector variant (VECTOR_FUNCTIONS_SQL) overrides
-- this with CREATE OR REPLACE when caps.vectorSearch is true.
--
-- p_embedding is TEXT (not vector(1536)) so this function compiles on
-- backends without pgvector loaded. The vector variant uses the same
-- TEXT signature and casts to vector inside the body.
CREATE OR REPLACE FUNCTION mem_upsert_by_keys(
    p_type TEXT,
    p_data JSONB,
    p_tags TEXT[],
    p_keys TEXT[],
    p_sources JSONB,
    p_searchable_text TEXT,
    p_content_hash TEXT,
    p_weight INTEGER DEFAULT NULL,
    p_embedding TEXT DEFAULT NULL,
    p_embedding_model TEXT DEFAULT NULL,
    p_replace BOOLEAN DEFAULT FALSE
) RETURNS TABLE (id UUID, action TEXT) LANGUAGE plpgsql AS $$
DECLARE
    existing_id UUID;
    result_id UUID;
    result_action TEXT;
BEGIN
    -- Deterministic pick when more than one row's keys[] overlap p_keys
    -- (e.g. the incoming row identity-merges with an old Attio-id row AND
    -- a newer email-keyed row from a separate sync). Newest-updated wins;
    -- ties broken by id. Without ORDER BY, PG returns whichever row the
    -- planner happens to surface first, leaving the loser persisted with
    -- overlapping keys and breaking the keys-are-unique invariant.
    SELECT r.id INTO existing_id
    FROM mem_records r
    WHERE r.keys && p_keys
    ORDER BY r.updated_at DESC NULLS LAST, r.id ASC
    LIMIT 1;

    IF existing_id IS NOT NULL THEN
        -- p_replace=TRUE: this call is the new ground truth for the row's
        -- content (typical for sync runs where a field disappearing
        -- upstream must disappear in memory). Replace data, tags,
        -- searchable_text, content_hash with what the caller supplied.
        -- Keys still union (never lose a key — losing the identity key
        -- would orphan the row), and sources still merge (multi-source
        -- provenance is independent of any single source's payload).
        UPDATE mem_records r
        SET data = CASE WHEN p_replace THEN p_data ELSE r.data || p_data END,
            tags = CASE
                WHEN p_replace THEN COALESCE(p_tags, '{}'::text[])
                ELSE (SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(COALESCE(r.tags, '{}') || COALESCE(p_tags, '{}'))))
            END,
            keys = (SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(COALESCE(r.keys, '{}') || COALESCE(p_keys, '{}')))),
            sources = r.sources || COALESCE(p_sources, '{}'::jsonb),
            searchable_text = CASE
                WHEN p_replace THEN p_searchable_text
                ELSE COALESCE(p_searchable_text, r.searchable_text)
            END,
            content_hash = CASE
                WHEN p_replace THEN p_content_hash
                ELSE COALESCE(p_content_hash, r.content_hash)
            END,
            weight = COALESCE(p_weight, r.weight),
            status = 'active',
            archived_reason = NULL
        WHERE r.id = existing_id;

        result_id := existing_id;
        result_action := 'updated';
    ELSE
        INSERT INTO mem_records (
            type, data, tags, keys, sources, searchable_text, content_hash, weight
        ) VALUES (
            p_type,
            p_data,
            p_tags,
            p_keys,
            COALESCE(p_sources, '{}'::jsonb),
            p_searchable_text,
            p_content_hash,
            COALESCE(p_weight, 5)
        )
        RETURNING mem_records.id INTO result_id;
        result_action := 'inserted';
    END IF;

    RETURN QUERY SELECT result_id, result_action;
END;
$$;
`;

/**
 * Vector-aware overrides for mem_upsert_by_keys. Loaded after
 * VECTOR_COLUMNS_SQL adds the embedding columns. CREATE OR REPLACE
 * supersedes the no-vector variant defined in FUNCTIONS_SQL — same
 * signature, embedding-aware body. p_embedding is TEXT in both
 * variants (callers send '[0.1,0.2,...]' literals); the cast to
 * vector happens inside this body via `::vector`.
 */
export const VECTOR_FUNCTIONS_SQL = `
CREATE OR REPLACE FUNCTION mem_upsert_by_keys(
    p_type TEXT,
    p_data JSONB,
    p_tags TEXT[],
    p_keys TEXT[],
    p_sources JSONB,
    p_searchable_text TEXT,
    p_content_hash TEXT,
    p_weight INTEGER DEFAULT NULL,
    p_embedding TEXT DEFAULT NULL,
    p_embedding_model TEXT DEFAULT NULL,
    p_replace BOOLEAN DEFAULT FALSE
) RETURNS TABLE (id UUID, action TEXT) LANGUAGE plpgsql AS $$
DECLARE
    existing_id UUID;
    result_id UUID;
    result_action TEXT;
    v_embedding vector(1536);
BEGIN
    v_embedding := CASE WHEN p_embedding IS NOT NULL THEN p_embedding::vector ELSE NULL END;

    -- See no-vector variant for ORDER BY rationale (deterministic pick
    -- when multiple rows' keys overlap p_keys).
    SELECT r.id INTO existing_id
    FROM mem_records r
    WHERE r.keys && p_keys
    ORDER BY r.updated_at DESC NULLS LAST, r.id ASC
    LIMIT 1;

    IF existing_id IS NOT NULL THEN
        -- See no-vector variant for p_replace gating rationale (replace
        -- data, tags, searchable_text, content_hash; keys union, sources
        -- merge; embedding follows existing v_embedding logic).
        UPDATE mem_records r
        SET data = CASE WHEN p_replace THEN p_data ELSE r.data || p_data END,
            tags = CASE
                WHEN p_replace THEN COALESCE(p_tags, '{}'::text[])
                ELSE (SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(COALESCE(r.tags, '{}') || COALESCE(p_tags, '{}'))))
            END,
            keys = (SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(COALESCE(r.keys, '{}') || COALESCE(p_keys, '{}')))),
            sources = r.sources || COALESCE(p_sources, '{}'::jsonb),
            searchable_text = CASE
                WHEN p_replace THEN p_searchable_text
                ELSE COALESCE(p_searchable_text, r.searchable_text)
            END,
            content_hash = CASE
                WHEN p_replace THEN p_content_hash
                ELSE COALESCE(p_content_hash, r.content_hash)
            END,
            weight = COALESCE(p_weight, r.weight),
            embedding = COALESCE(v_embedding, r.embedding),
            embedded_at = CASE WHEN v_embedding IS NOT NULL THEN NOW() ELSE r.embedded_at END,
            embedding_model = COALESCE(p_embedding_model, r.embedding_model),
            status = 'active',
            archived_reason = NULL
        WHERE r.id = existing_id;

        result_id := existing_id;
        result_action := 'updated';
    ELSE
        INSERT INTO mem_records (
            type, data, tags, keys, sources, searchable_text, content_hash,
            weight, embedding, embedded_at, embedding_model
        ) VALUES (
            p_type,
            p_data,
            p_tags,
            p_keys,
            COALESCE(p_sources, '{}'::jsonb),
            p_searchable_text,
            p_content_hash,
            COALESCE(p_weight, 5),
            v_embedding,
            CASE WHEN v_embedding IS NOT NULL THEN NOW() ELSE NULL END,
            p_embedding_model
        )
        RETURNING mem_records.id INTO result_id;
        result_action := 'inserted';
    END IF;

    RETURN QUERY SELECT result_id, result_action;
END;
$$;
`;

/**
 * Hybrid search: FTS via tsvector RRF-fused with semantic via pgvector cosine.
 * Kept in its own block so backends that advertise `vectorSearch: false` can
 * skip it entirely.
 */
export const HYBRID_SEARCH_SQL = `
CREATE OR REPLACE FUNCTION mem_hybrid_search(
    query_text TEXT,
    query_embedding vector(1536),
    match_count INT DEFAULT 10,
    filter_type TEXT DEFAULT NULL,
    full_text_weight FLOAT DEFAULT 0.3,
    semantic_weight FLOAT DEFAULT 0.7,
    rrf_k INT DEFAULT 50,
    include_archived BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
    id UUID,
    type TEXT,
    data JSONB,
    tags TEXT[],
    fts_rank FLOAT,
    semantic_rank FLOAT,
    combined_score FLOAT
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    WITH fts_results AS (
        SELECT r.id,
               ROW_NUMBER() OVER (ORDER BY ts_rank_cd(r.searchable, websearch_to_tsquery('english', query_text)) DESC) AS rank
        FROM mem_records r
        WHERE r.searchable @@ websearch_to_tsquery('english', query_text)
          AND (filter_type IS NULL OR r.type = filter_type)
          AND (include_archived OR r.status = 'active')
        LIMIT match_count * 2
    ),
    semantic_results AS (
        SELECT r.id,
               ROW_NUMBER() OVER (ORDER BY r.embedding <=> query_embedding) AS rank
        FROM mem_records r
        WHERE r.embedding IS NOT NULL
          AND (filter_type IS NULL OR r.type = filter_type)
          AND (include_archived OR r.status = 'active')
        ORDER BY r.embedding <=> query_embedding
        LIMIT match_count * 2
    ),
    combined AS (
        SELECT COALESCE(fts.id, sem.id) AS id,
               COALESCE(1.0 / (rrf_k + fts.rank), 0.0) AS fts_score,
               COALESCE(1.0 / (rrf_k + sem.rank), 0.0) AS sem_score
        FROM fts_results fts
        FULL OUTER JOIN semantic_results sem ON fts.id = sem.id
    )
    SELECT r.id,
           r.type,
           r.data,
           r.tags,
           c.fts_score::FLOAT AS fts_rank,
           c.sem_score::FLOAT AS semantic_rank,
           (c.fts_score * full_text_weight + c.sem_score * semantic_weight)::FLOAT AS combined_score
    FROM combined c
    JOIN mem_records r ON r.id = c.id
    ORDER BY (c.fts_score * full_text_weight + c.sem_score * semantic_weight) DESC
    LIMIT match_count;
END;
$$;
`;

export function getMetaInsertSQL(version: string): string {
  return `INSERT INTO mem_meta (key, value) VALUES ('version', '${version}')
          ON CONFLICT (key) DO UPDATE SET value = '${version}', updated_at = NOW();`;
}

/**
 * Full schema bundle for backends that can execute it in one shot.
 * Order matters: tables -> indexes -> core functions -> [vector
 * extension -> vector columns -> vector functions -> vector index ->
 * hybrid search] -> meta. The vector block is opt-in via `withVector`.
 */
export function getFullSchemaSQL(opts: { withVector: boolean } = { withVector: true }): string {
  const blocks = [
    EXTENSIONS_SQL,
    TABLES_SQL,
    INDEXES_SQL,
    FUNCTIONS_SQL,
  ];
  if (opts.withVector) {
    blocks.push(VECTOR_EXTENSION_SQL, VECTOR_COLUMNS_SQL, VECTOR_FUNCTIONS_SQL, VECTOR_INDEX_SQL, HYBRID_SEARCH_SQL);
  }
  blocks.push(getMetaInsertSQL(SCHEMA_VERSION));
  return blocks.filter(b => b.trim().length > 0).join('\n\n');
}
