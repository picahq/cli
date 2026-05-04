# Unified Memory: folding `mem` into the One CLI

**Status:** planned
**Branch:** `feat/unified-memory`
**Owner:** Moe
**Depends on:** n/a (absorbs `@withone/mem` into this repo)

---

## 1. Why

Today we run two systems that share 90% of their DNA:

- **`@withone/mem`** — Supabase/Postgres + pgvector + pg_trgm. Small, curated. Optional embeddings. User-written memories (notes, decisions, preferences).
- **`one sync`** — per-platform SQLite files under `.one/sync/data/`. Large-volume, API-synced rows from Gmail/Attio/Fathom/etc. FTS5, no embeddings, no identity resolution, no graph.

Keeping them separate is accidental complexity. It costs us: two schemas, two search surfaces, two upsert paths, two backup stories, two places for an agent to look before answering, and a constant "which DB has this?" mental tax.

**This plan collapses them into one subsystem living inside the `one` CLI.** No separate package. No two databases. One schema, one search, one identity graph. Sync becomes the most powerful writer of many into the unified store. Embeddings become optional, per-type, configurable at init time.

## 2. Goals & non-goals

### Goals

1. **One store.** Synced rows and user memories share a single schema, whatever backend holds it.
2. **Pluggable backends.** Not a hardcoded pick between two impls — a real plugin system. The CLI defines a `MemBackend` contract; anyone can add a new backend by shipping (or dropping in) a plugin. v1 ships two first-party plugins: PGlite (default, embedded Postgres, zero external deps) and Postgres (Supabase / self-hosted / Neon / any Postgres). SQLite, Turso, DuckDB, LibSQL — any of these land as a follow-up plugin without touching core.
3. **One CLI surface.** Everything lives under `one mem …`. Sync is a sub-verb (`one mem sync …`). `one sync …` is kept as a back-compat alias.
4. **Identity dedup built in.** `_identity` in sync profiles maps to `keys` in mem. First Attio sync creates a Person; first Gmail match merges into it. Each upstream origin lives as an entry in the record's `sources` JSONB map.
5. **Optional embeddings.** Set provider + OpenAI key at `one mem init` (or later via `one mem config`). Default off for synced rows, opt-in per type. FTS always works.
6. **Drop `@withone/mem`.** Absorb logic into the CLI. Final deprecation release of the npm package points at the CLI.
7. **All in one branch, tested hard.** This whole thing lands as a single coherent change on `feat/unified-memory`, not a phased rollout. We keep the branch alive, build it out, and hammer on it with a shared testing harness before merging.

### Non-goals

- Multi-tenant / team sync of the unified store (a shared Postgres backend handles team scenarios mechanically; no new tenancy code here).
- Replacing `one flow` / actions / platform logic — all unchanged.
- Changing sync profile format beyond adding a small `memory` section.

## 3. Architecture

```
                     ┌────────────────────────────────┐
                     │          one CLI binary         │
                     └──────────────┬──────────────────┘
                                    │
        ┌───────────────────────────┼──────────────────────────┐
        │                           │                          │
 ┌──────▼──────┐           ┌────────▼────────┐        ┌────────▼────────┐
 │  commands/  │           │ lib/memory/     │        │  other CLI      │
 │   mem.ts    │──calls──▶│  records.ts     │        │  (actions,      │
 │   mem/…     │           │  search.ts      │        │   flow, …)      │
 └─────────────┘           │  graph.ts       │        └─────────────────┘
                           │  refs.ts        │
                           │  scoring.ts     │
                           │  embedding.ts   │
                           │  schema.ts      │
                           │  backend.ts     │── the `MemBackend` contract
                           │  plugins.ts     │── plugin registry, loader, resolver
                           │  plugins/       │── first-party backend plugins
                           │   ├─ pglite/    │   (default; embedded Postgres)
                           │   └─ postgres/  │   (Supabase / self-hosted / Neon)
                           │  sync/          │── writes via records.upsertByKeys
                           │   ├─ runner.ts  │
                           │   ├─ profile.ts │
                           │   ├─ hooks.ts   │── in-process, no shell fork
                           │   └─ …          │
                           └─────────────────┘

                            External plugins (opt-in):
                              @withone/mem-turso
                              @withone/mem-sqlite
                              @withone/mem-duckdb
                              <your-org>/mem-<backend>
```

Key points:

- **Sync is a folder inside memory**, not a peer. Sync writes via `records.upsertByKeys` — the same entry point `mem add` uses. No special path.
- **Backends are plugins.** The CLI defines the `MemBackend` contract and a registry. First-party plugins ship in-tree (PGlite, Postgres). Third-party plugins are regular npm packages the CLI resolves at init time.
- **Hooks are in-process** function calls. No JSON-over-stdin shell forking. Faster, typed, easier to reason about.

## 4. Schema

One migration file (`lib/memory/schema.ts`) produces this in both PGlite and hosted Postgres.

Four tables total: `mem_records` (everything: user memories AND synced rows, with source tracking inlined as a JSONB map), `mem_links` (graph edges, kept separate for bidirectional traversal), `mem_sync_state` (per-platform cursor tracking), `mem_meta` (schema version + internal config). An optional fifth table (`mem_events`) is noted below but deferred.

### 4.1 Tables

```sql
-- Extensions (no-op on PGlite if already compiled in)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =============================================================================
-- RECORDS — user memories + synced rows, one flat table
-- =============================================================================
CREATE TABLE mem_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Typing & identity
    type TEXT NOT NULL,                      -- 'note' | 'decision' | 'attio/people' | 'gmail/threads' | ...
    data JSONB NOT NULL,                     -- full record payload
    tags TEXT[],
    keys TEXT[],                             -- globally unique, prefixed (see 4.3)

    -- Source tracking — map keyed by prefixed external id (= one of `keys`)
    -- Shape: { "<system>/<model>:<external_id>": { url?, metadata?, last_synced_at } }
    -- Synced records have ≥1 entry; user memories have `{}`.
    -- Lookup by source uses the GIN index on `keys`; per-source metadata lives here.
    sources JSONB NOT NULL DEFAULT '{}',

    -- Search surfaces
    searchable_text TEXT,                    -- profile-extracted text (see 4.4)
    searchable tsvector GENERATED ALWAYS AS (to_tsvector('english', COALESCE(searchable_text, ''))) STORED,
    embedding vector(1536),                  -- nullable; only set when embedded
    embedded_at TIMESTAMPTZ,
    embedding_model TEXT,                    -- 'openai:text-embedding-3-small'

    -- Change detection
    content_hash TEXT,                       -- sha256 of canonical(data)

    -- Relevance
    weight SMALLINT NOT NULL DEFAULT 5 CHECK (weight BETWEEN 1 AND 10),
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ,

    -- Lifecycle
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    archived_reason TEXT,                    -- 'deleted_upstream' | 'user_archived' | 'superseded' | NULL

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- LINKS — typed graph edges (kept as a separate table for bidirectional traversal)
-- =============================================================================
CREATE TABLE mem_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id UUID NOT NULL REFERENCES mem_records(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES mem_records(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    bidirectional BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(from_id, to_id, relation)
);

-- =============================================================================
-- SYNC STATE — per (platform, model) cursor; replaces .one/sync/sync_state.json
-- =============================================================================
CREATE TABLE mem_sync_state (
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

-- =============================================================================
-- META — schema version, internal config
-- =============================================================================
CREATE TABLE mem_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Optional v2 addition (not shipped in v1): `mem_events` for audit/replay of inserts, updates, archives, embeds, accesses.

### 4.2 Indexes

```sql
-- Base
CREATE INDEX idx_records_type               ON mem_records(type);
CREATE INDEX idx_records_status             ON mem_records(status);
CREATE INDEX idx_records_keys               ON mem_records USING GIN(keys);
CREATE INDEX idx_records_tags               ON mem_records USING GIN(tags);
CREATE INDEX idx_records_data               ON mem_records USING GIN(data jsonb_path_ops);
CREATE INDEX idx_records_sources            ON mem_records USING GIN(sources jsonb_path_ops);
CREATE INDEX idx_records_searchable         ON mem_records USING GIN(searchable);
CREATE INDEX idx_records_embedding          ON mem_records USING HNSW(embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
CREATE INDEX idx_records_relevance          ON mem_records(status, weight DESC, access_count DESC, last_accessed_at DESC NULLS LAST);
CREATE INDEX idx_records_content_hash       ON mem_records(content_hash);

-- Per-type "hot column" indexes, created from profile `hotColumns` declarations:
--   CREATE INDEX ON mem_records ((data->>'email')) WHERE type = 'attio/people';
--   CREATE INDEX ON mem_records ((data->>'subject')) WHERE type = 'gmail/threads';
-- See §7 and §9 for how profiles declare these.
```

### 4.3 `keys` semantics

`keys` is globally unique (enforced via a `BEFORE INSERT/UPDATE` trigger). Every key is **prefixed** so conflicts are impossible and the key is self-describing:

- Type-scoped platform IDs: `attio/people:abc123`, `gmail/threads:19x…`
- Cross-platform identities: `email:moe@integrationos.com`, `domain:acme.com`

A record carries the keys that identify **itself**. When we want to relate two records (a Gmail thread sent from Moe), we create a `mem_links` edge, not a shared key.

**Dedup rule:** `upsertByKeys(keys, …)` — if any provided key already exists on a record, merge into that record (union `tags` + `keys`, deep-merge `data`, preserve relevance counters, write external_ref). Otherwise insert new.

### 4.4 Searchable text extraction

Today's mem uses `string_agg` across every JSONB value. That's fine for a 3-field note, catastrophic for a 40KB Gmail body.

v1 introduces **profile-driven extraction**:

```json
// attio/people profile
"searchable": ["name", "email_addresses[0].email_address", "job_title", "company.name"]

// or a template
"searchable": "{{name}} ({{job_title}} at {{company.name}}) — {{email_addresses[0].email_address}}"
```

Default when a type has no profile (`note`, `decision`, etc.): concatenate top-level string values, capped at 4KB. Same as today's default for user memories.

### 4.5 Relevance & scoring

Unchanged from `@withone/mem`: `weight(40%) + access(30%) + recency(30%)`. Ports directly. Lives in `lib/memory/scoring.ts` and as a Postgres function `mem_calculate_relevance`.

### 4.6 Hybrid search

Unchanged behavior: FTS (tsvector + pg_trgm) RRF-fused with pgvector cosine. If embeddings are off (no provider configured), falls back to FTS only. Ported to `lib/memory/search.ts` and `mem_hybrid_search` SQL function.

**New:** `mem search` bumps `access_count` + `last_accessed_at` on the rows it returns (default on). `--no-track` opts out. `mem get` and `mem sync query` do **not** track (bulk paths shouldn't inflate relevance).

## 5. Plugin system for backends

Backends are plugins. The CLI defines a `MemBackend` contract, a `MemBackendPlugin` factory, and a registry. First-party plugins ship in-tree. Third-party plugins are plain npm packages declared in config and resolved at init.

### 5.1 The `MemBackend` contract

```ts
// lib/memory/backend.ts
export interface MemBackend {
  // Connection lifecycle
  init(): Promise<void>;
  close(): Promise<void>;
  ensureSchema(): Promise<void>;             // idempotent migrations; records version in mem_meta
  getSchemaVersion(): Promise<string | null>;

  // Record CRUD
  insert(row: RecordInput): Promise<Record>;
  upsertByKeys(row: RecordInput): Promise<{ record: Record; action: 'inserted' | 'updated' }>;
  getById(id: string, opts?: { withLinks?: boolean }): Promise<Record | RecordWithLinks | null>;
  update(id: string, patch: Partial<RecordInput>): Promise<Record | null>;
  remove(id: string): Promise<boolean>;
  archive(id: string, reason?: string): Promise<boolean>;
  list(type: string, opts?: ListOptions): Promise<Record[]>;

  // Search
  search(q: string, opts: SearchOptions): Promise<SearchResult[]>;
  context(opts: ContextOptions): Promise<ContextResult[]>;
  trackAccess(ids: string[]): Promise<void>;

  // Graph
  link(fromId: string, toId: string, relation: string, opts?: LinkOptions): Promise<string>;
  unlink(fromId: string, toId: string, relation: string): Promise<boolean>;
  linked(id: string, opts?: LinkedOptions): Promise<LinkedRecord[]>;

  // Sources (inlined on the record as a JSONB map; these are thin helpers)
  addSource(recordId: string, ref: SourceRefInput): Promise<void>;
  removeSource(recordId: string, sourceKey: string): Promise<boolean>;
  findBySource(sourceKey: string): Promise<Record | null>;    // sourceKey = "<system>/<model>:<external_id>"
  listSources(recordId: string): Promise<Record['sources']>;

  // Sync state
  getSyncState(platform: string, model: string): Promise<SyncState | null>;
  setSyncState(state: SyncState): Promise<void>;
  listSyncStates(): Promise<SyncState[]>;

  // Hot columns (profile-driven)
  ensureHotColumn(type: string, jsonPath: string): Promise<void>;
  dropHotColumn(type: string, jsonPath: string): Promise<void>;

  // Maintenance (diagnostics hooks)
  vacuum(): Promise<void>;
  stats(): Promise<BackendStats>;            // row counts, size, index health, etc.

  // Optional capability advertisement (see §5.4)
  capabilities(): BackendCapabilities;
}
```

### 5.2 Plugin factory

Every backend is wrapped in a plugin descriptor. Plugins are pure data + a factory function; they do not assume any specific DB driver.

```ts
// lib/memory/backend.ts
export interface MemBackendPlugin {
  /** Unique backend name, lowercase, used in config (e.g. "pglite", "postgres", "turso"). */
  name: string;

  /** Short description shown in `one mem init` picker and `one mem config`. */
  description: string;

  /** Semver of the plugin's own implementation (independent of schema). */
  version: string;

  /** Schema migrations this plugin understands. Must include base schema version. */
  schemaVersion: string;

  /**
   * Validates the `memory` config block this plugin will consume.
   * Returns a parsed/normalized config the factory will receive.
   */
  parseConfig(raw: unknown): ParsedBackendConfig;

  /**
   * Interactive prompts for `one mem init`. Returns the config object the
   * user selected. Optional — plugins that have zero runtime config can omit.
   */
  promptInit?(): Promise<ParsedBackendConfig>;

  /**
   * Create a backend instance from parsed config.
   * The returned backend is not yet connected; caller runs `init()` + `ensureSchema()`.
   */
  create(config: ParsedBackendConfig): MemBackend;

  /** Capabilities this plugin advertises (see §5.4). */
  capabilities: BackendCapabilities;
}
```

### 5.3 Registry + resolution

```ts
// lib/memory/plugins.ts
const registry = new Map<string, MemBackendPlugin>();

export function registerBackend(plugin: MemBackendPlugin): void;
export function getBackend(name: string): MemBackendPlugin;
export function listBackends(): MemBackendPlugin[];

/**
 * Resolve the active backend from config. Loads first-party plugins
 * synchronously; third-party plugins are dynamically imported from the
 * list declared in `memory.plugins`.
 */
export async function loadBackendFromConfig(cfg: MemoryConfig): Promise<MemBackend>;
```

**First-party plugins** are imported statically in `lib/memory/plugins.ts`:

```ts
import { pglitePlugin } from './plugins/pglite/index.js';
import { postgresPlugin } from './plugins/postgres/index.js';

registerBackend(pglitePlugin);
registerBackend(postgresPlugin);
```

**Third-party plugins** are declared in config and dynamically imported:

```jsonc
// ~/.one/config.json
{
  "memory": {
    "backend": "turso",
    "plugins": ["@withone/mem-turso"],   // installed separately via npm
    "turso": { "url": "libsql://…", "authToken": "…" }
  }
}
```

At init, the CLI runs:

```ts
for (const spec of cfg.plugins ?? []) {
  const mod = await import(spec);
  const plugin = mod.default as MemBackendPlugin;
  registerBackend(plugin);
}
const plugin = getBackend(cfg.backend);
const backend = plugin.create(plugin.parseConfig(cfg[cfg.backend]));
```

If a declared plugin can't be resolved, `one mem doctor` prints a precise error: which plugin, which package, `npm i <pkg>` suggestion. No silent fallback.

### 5.4 Capabilities

Not every backend can do everything. The contract is shaped so **required methods** work for every plugin, and **optional features** are advertised via capabilities the CLI can check before calling them.

```ts
export interface BackendCapabilities {
  /** Supports the pgvector-style `embedding` column and ANN search. */
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
}
```

Search and embedding code checks capabilities:

```ts
if (backend.capabilities().vectorSearch && embeddingProvider) {
  return hybridSearch(q);
} else {
  return ftsSearch(q);     // graceful degradation
}
```

This is what lets a lightweight backend (say, a pure-SQLite plugin without sqlite-vec) still work — it declares `vectorSearch: false`, search falls through to FTS, nothing crashes.

### 5.5 First-party plugins shipped in v1

- **`pglite`** — default. Uses `@electric-sql/pglite` with `vector` + `pg_trgm` extensions. Capabilities: all true except `concurrentWriters`. Stores at `~/.one/mem.pglite/` (global) or `.one/mem.pglite/` (project scope).
- **`postgres`** — Supabase / Neon / self-hosted. Uses `pg` with a connection string. Capabilities: all true. Config: `connectionString`, optional `schema` (default `public`).

Both share >90% of their code via a shared `lib/memory/plugins/postgres-core/` module that owns the SQL (schema, functions, queries). `pglite` and `postgres` plugins are thin adapters over that core, differing only in how they establish a connection and run queries.

### 5.6 Writing a new backend plugin

The plugin contract is public — users can write one without touching the CLI source. A plugin is an npm package that default-exports a `MemBackendPlugin`:

```ts
// packages/mem-turso/src/index.ts
import type { MemBackendPlugin } from '@withone/one/memory';
import { TursoBackend } from './backend.js';

const plugin: MemBackendPlugin = {
  name: 'turso',
  description: 'Turso / libSQL backend',
  version: '0.1.0',
  schemaVersion: '2.0.0',
  parseConfig: (raw) => { /* zod validate */ },
  promptInit: async () => { /* prompts.ts */ },
  create: (config) => new TursoBackend(config),
  capabilities: {
    vectorSearch: false,
    fullTextSearch: true,
    partialIndexes: false,
    jsonPathQuery: true,
    triggers: true,
    concurrentWriters: true,
    maxVectorDims: null,
  },
};
export default plugin;
```

Users install and declare it:

```bash
npm i @withone/mem-turso
one mem config set memory.plugins '["@withone/mem-turso"]'
one mem init --backend turso
```

Docs in `docs/memory/writing-a-backend-plugin.md` will cover: required SQL semantics, how to pass the parity test suite, and the capability matrix.

## 6. CLI surface

All memory operations live under `one mem`. Sync is a sub-verb.

```
one mem init                        Interactive setup: backend, path, embedding provider + key
one mem config get|set <k> [v]      Inspect / mutate memory config
one mem migrate                     Import legacy .one/sync/data/*.db files into unified store

# Records
one mem add <type> '<json>' [--tags ...] [--keys ...] [--weight N] [--embed|--no-embed]
one mem get <id> [--links]
one mem update <id> '<json-patch>'
one mem archive <id> [--reason <text>]
one mem weight <id> <N>
one mem flush <id>
one mem list <type> [--limit N]

# Search
one mem search "<q>" [--type <t>] [--deep] [--no-track] [--limit N]
one mem context [-n 20] [--types <t1,t2,...>]

# Graph
one mem link <from-id> <to-id> <relation> [--bi] [--meta '<json>']
one mem unlink <from-id> <to-id> <relation>
one mem linked <id> [--relation <r>] [--direction outgoing|incoming|both]

# Sources
one mem sources <id>                         # list sources for a record
one mem find-by-source <system>/<model>:<external-id>

# Sync (writes into the unified store)
one mem sync run <platform> [--models a,b] [--since 30d] [--full-refresh]
one mem sync list [<platform>]               Freshness, record counts, last run, next scheduled
one mem sync query <type> [--where …] [--after …] [--limit N] [--order-by …]
one mem sync search "<q>" [--type …]         FTS-only shortcut (no embeddings, fast path)
one mem sync profile list|show|edit|init     Profile management (same as today)
one mem sync schedule add|list|remove        Cron registration for recurring syncs

# Admin / diagnostics
one mem doctor                        Schema version check, index health, connection test
one mem vacuum                        Maintenance (PGlite: VACUUM; Postgres: ANALYZE/REINDEX suggestions)
one mem export [--type <t>] [--out <file>]   JSON export for backup / migration
one mem import <file>                        JSON import
```

**Back-compat aliases** (tombstoned after one release):

- `one sync <x>` → `one mem sync <x>` (prints a one-line deprecation notice)
- `npx mem <x>` (via the final `@withone/mem` release) → prints "use `one mem`" and exits 1

## 7. Config & secrets

OpenAI / embedding secrets live in the existing `~/.one/config.json` file (mode 0600), next to `ONE_SECRET`. Same file, same permissions, same scope resolution (project > global), same env var override pattern.

### 7.1 Config shape addition

```jsonc
{
  "apiKey": "sk_live_…",
  "apiBase": "…",
  "memory": {
    "backend": "pglite",              // name of a registered backend plugin
    "plugins": [],                    // npm specs for third-party backend plugins to dynamically import
    "pglite": {                       // per-backend config, keyed by plugin name
      "dbPath": "~/.one/mem.pglite"
    },
    "postgres": {
      "connectionString": null,       // env var override: MEM_DATABASE_URL
      "schema": "public"
    },
    "embedding": {
      "provider": "openai",           // "openai" | "none"
      "apiKey": "sk-…",               // env var override: OPENAI_API_KEY
      "model": "text-embedding-3-small",
      "dimensions": 1536
    },
    "defaults": {
      "trackAccessOnSearch": true,
      "embedOnAdd": true,             // for user-initiated `mem add`
      "embedOnSync": false            // synced rows only embed if profile opts in
    }
  }
}
```

Per-backend config is keyed by the plugin's `name`. That way new plugins compose into the same config file without format changes — a user adding `@withone/mem-turso` just drops in a `"turso": { … }` block.

### 7.2 Precedence

Same chain as `ONE_SECRET` today:

1. Environment variable (`OPENAI_API_KEY`, `MEM_DATABASE_URL`, …)
2. `.onerc` in project root
3. Project config (`~/.one/projects/<slug>/config.json`)
4. Global config (`~/.one/config.json`)

`lib/config.ts` gains helpers: `getMemoryConfig()`, `getEmbeddingApiKey()`, `getMemoryBackend()`, `updateMemoryConfig(...)`. Writes go through the existing `writeConfig()` so permissions (0600) are preserved.

### 7.3 `one mem init` flow

Interactive prompts:

```
? Where should memory live?
  ❯ Local (PGlite at ~/.one/mem.pglite)              ← default
    Postgres (self-hosted or Supabase)

? Enable embeddings (semantic search)? (y/N)
  ⓘ  Embeddings use OpenAI's API. FTS works without them.
    If yes:
      ? OpenAI API key: [hidden input]
      ✓ Stored in ~/.one/config.json (mode 0600)
      ? Embed by default when I run `one mem add`? (Y/n)
      ? Embed synced records by default? (y/N)

? Run a connectivity check? (Y/n)
  → Opening PGlite, applying schema, running a round-trip test…
  ✓ Memory ready. 0 records.
```

Non-interactive form (for CI / scripts):

```
one mem init --backend pglite --embedding openai --openai-key $OPENAI_API_KEY --yes
```

## 8. Embedding policy

### 8.1 Three levers

- **Provider.** `openai` or `none`. If `none`, embedding column stays NULL, search falls back to FTS. No degradation in functionality, only in conceptual-match quality.
- **Per-type default.** Sync profile can declare `"embed": true` for types worth spending tokens on (`attio/people`, `attio/companies`, `fathom/meetings`). Default `false` for every other type.
- **Per-call override.** `mem add --embed` / `--no-embed`. `mem sync run <platform> --embed` forces embedding for this run regardless of profile.

### 8.2 Lifecycle

- Embedding is generated on insert/update **only if** `content_hash` changed.
- `embedded_at` + `embedding_model` track when and with what. When you rev models (e.g. switch to `text-embedding-3-large`), `one mem reindex --model text-embedding-3-large` re-embeds everything. Old embeddings are replaced atomically.
- Rate limiting: batch 100 records per OpenAI call. Retries with backoff on 429s.
- Cost visibility: `one mem doctor` shows estimated tokens used in the last 30 days and average embedding cost per record.

### 8.3 When to skip

- `content_hash` unchanged → skip (covers the common "resync produced identical row" case).
- Record has `embed: false` tag → skip regardless of profile default.
- Profile says `embed: false` and no `--embed` override → skip.
- Provider is `none` → skip (always).

## 9. Sync integration

Existing sync code in `src/lib/sync/` moves to `src/lib/memory/sync/` with minimal logic changes. The only real change: `upsertRecords(db, model, rows, idField)` becomes:

```ts
const sourceKey = `${platform}/${model}:${row[idField]}`;

await records.upsertByKeys({
  type: `${platform}/${model}`,
  data: sanitized(row),
  keys: [
    sourceKey,
    ...(row._identity ? [`${profile.identityKeyPrefix ?? 'id'}:${row._identity}`] : []),
    ...(profile.extraKeys ?? []).map(k => resolveKeyTemplate(k, row)),
  ],
  tags: profile.tags ?? [],
  searchable_text: extractSearchable(row, profile.searchable),
  content_hash: sha256(canonical(row)),
  sources: {
    [sourceKey]: {
      url: profile.externalUrlTemplate ? resolveTemplate(profile.externalUrlTemplate, row) : null,
      metadata: { synced_at: new Date().toISOString() },
      last_synced_at: new Date().toISOString(),
    },
  },
  embed: profile.embed ?? false,
});
```

### 9.1 Profile additions

Existing sync profile format gains a small `memory` section (all optional):

```jsonc
{
  // …all existing fields unchanged…
  "identityKey": "email_addresses[0].email_address",   // already exists → becomes a mem key
  "memory": {
    "identityKeyPrefix": "email",                      // key becomes "email:moe@…"
    "extraKeys": ["domain:{{company.domain}}"],        // additional keys
    "tags": ["crm", "person"],
    "searchable": ["name", "email_addresses[0].email_address", "job_title"],
    "hotColumns": ["email_addresses[0].email_address", "company.domain"],
    "externalUrlTemplate": "https://app.attio.com/withone/person/{id}",
    "embed": true,                                     // embed every record of this type
    "weight": 6                                        // default weight for records of this type
  }
}
```

Missing `memory` block → sane defaults (no extra keys, no embedding, no hot columns, tags = []).

### 9.2 Hot columns pipeline

`one mem sync profile apply <platform>/<model>` reads the profile's `hotColumns` and ensures:

```sql
CREATE INDEX IF NOT EXISTS idx_records_<type>_<path>
  ON mem_records ((data #>> '{a,b,c}'))
  WHERE type = '<platform>/<model>';
```

Runs on profile change or `apply`. Dropping a hot column drops the index. Idempotent.

### 9.3 Hooks

Today's `onInsert` / `onUpdate` / `onChange` profile hooks stay. But they now run **in-process**: the runner imports a small registry of built-in hook actions:

- `"log"` — append to `.one/memory/events/<platform>_<model>.jsonl` (unchanged)
- `"mem-link <relation> <target-key>"` — auto-create a `mem_links` edge
- `"mem-weight <N>"` — set weight on the newly-written record
- `"mem-tag <tag1,tag2>"` — add tags
- Shell command (legacy path, still supported) — fork + JSON pipe, as today

### 9.4 Sync state

Moves from `.one/sync/sync_state.json` to `mem_sync_state` table. Freshness check becomes a SQL query; `one mem sync list` reads the table.

## 10. Migration plan

### 10.1 Data migration

`one mem migrate` is idempotent and reads:

- Every `.db` in `.one/sync/data/` (legacy per-platform SQLite).
- Every profile in `.one/sync/profiles/`.
- The existing `.one/sync/sync_state.json`.

For each legacy table `<platform>` / `<model>`:

1. Open the SQLite file.
2. For each row: apply the same mapping §9 does for fresh syncs (keys, sources, searchable_text, content_hash, tags).
3. `records.upsertByKeys(...)` into the new backend. If the row already exists (re-run migration), content_hash makes it a no-op.
4. Record progress (rows seen, rows written, rows skipped) to stderr.

After success, legacy files are left in place (not deleted). The user removes them when satisfied via `one mem migrate --cleanup`.

### 10.2 Consumer migration

The CEO repo and any caller that shells out to `npx mem` or `one sync` needs rewrites. Do this in a coordinated PR after the CLI ships:

- `CLAUDE.md` (root + `/Users/moe/CEO/CLAUDE.md`): `npx mem` → `one mem`, `one sync` → `one mem sync` (or leave alias).
- `.claude/skills/**/SKILL.md`: same sweep.
- `.one/flows/*.json`: any step that shells out to `npx mem` → `one mem`.

### 10.3 `@withone/mem` package deprecation

1. Ship one final release of `@withone/mem` (v2.0.0) whose:
   - README says "merged into the `one` CLI — install with `npm i -g @withone/one`, use `one mem`."
   - `index.ts` logs a `console.warn` deprecation on import.
   - Exports still work for one minor cycle so existing installs don't explode.
2. `/Users/moe/projects/opensource/mem` repo gets an archive notice.
3. Skip unpublishing — leave old versions available so lockfiles don't break.

## 11. Delivery — single branch, all-in-one

Everything ships on `feat/unified-memory` as one coherent change. The branch stays alive until the test suite is green against every shipped plugin and the CEO repo has been sweep-tested end-to-end. No phased rollout to `main`; we merge once.

### 11.1 Work checklist (not a sequence — items can parallelize)

**Scaffolding**
- [ ] Add `@electric-sql/pglite` and `pg` to `package.json`.
- [ ] Create `src/lib/memory/` tree per §3.
- [ ] Register `one mem` command with stub subcommands so the CLI surface exists early.

**Core + schema**
- [ ] `schema.ts` — full DDL (§4) as a single migration, version stamped in `mem_meta`.
- [ ] `records.ts` — insert, upsertByKeys (with key-merge semantics), get, update, remove, archive, list.
- [ ] `search.ts` — hybrid (RRF) + FTS fallback when embeddings absent or `capabilities().vectorSearch = false`.
- [ ] `graph.ts` — link, unlink, linked (respecting `bidirectional`).
- [ ] `sources.ts` — addSource, removeSource, findBySource, listSources (helpers over the inlined `sources` JSONB column).
- [ ] `scoring.ts` — relevance (weight/access/recency) as a TS helper AND a Postgres function.
- [ ] `embedding.ts` — OpenAI provider, batch, retry, content-hash gate, skip on NULL provider.
- [ ] `canonical.ts` — deterministic JSON canonicalization + sha256 for `content_hash`.

**Plugin system**
- [ ] `backend.ts` — `MemBackend`, `MemBackendPlugin`, `BackendCapabilities` types.
- [ ] `plugins.ts` — registry, loader, `loadBackendFromConfig`.
- [ ] `plugins/postgres-core/` — shared SQL/query layer (90% of both first-party plugins).
- [ ] `plugins/pglite/` — PGlite adapter (default backend). Cold-start < 200ms.
- [ ] `plugins/postgres/` — node-pg adapter; Supabase / Neon / self-hosted.

**Config + init**
- [ ] Extend `lib/config.ts` with a `memory` section (§7). Preserve mode 0600, scope resolution, env-var precedence.
- [ ] `lib/config.ts` → `getEmbeddingApiKey()` reads `OPENAI_API_KEY` env → `.onerc` → project → global.
- [ ] `one mem init` — interactive prompts and non-interactive flags (§7.3).
- [ ] `one mem config get|set` — typed paths; redact secret values on `get` by default, `--show-secrets` to reveal.

**CLI surface** (§6)
- [ ] `one mem add|get|update|archive|weight|flush|list`.
- [ ] `one mem search` (`--deep`, `--no-track`, `--type`, `--limit`).
- [ ] `one mem context`.
- [ ] `one mem link|unlink|linked`.
- [ ] `one mem refs|find-by-ref`.
- [ ] `--agent` JSON output on every command.

**Sync absorbed**
- [ ] Move `src/lib/sync/` → `src/lib/memory/sync/`.
- [ ] Rewrite `runner.ts` to call `records.upsertByKeys` instead of sqlite upsert.
- [ ] Add `memory: {}` block to profile schema + parser + validator (§9.1).
- [ ] Rewrite hooks (`onInsert/onUpdate/onChange`) to run in-process with a registry of built-in actions; keep shell-fork legacy path.
- [ ] `hotColumns` apply/drop wired into `one mem sync profile apply`.
- [ ] Move sync state from `.one/sync/sync_state.json` to `mem_sync_state`.
- [ ] `one mem sync run|list|query|search|profile|schedule` commands.

**Migration + back-compat**
- [ ] `one mem migrate` — idempotent import of legacy `.one/sync/data/*.db`.
- [ ] `one mem migrate --cleanup` — removes legacy files (explicit confirmation required).
- [ ] `one sync …` → alias of `one mem sync …` with a one-line deprecation notice.
- [ ] `one mem export`/`import` — JSON round-trip for backup.

**Diagnostics + polish**
- [ ] `one mem doctor` — schema version, index health, plugin resolution, embedding cost estimate.
- [ ] `one mem vacuum` — delegates to `backend.vacuum()`.
- [ ] `one mem reindex [--model <m>]` — re-embed all rows under a new embedding model.
- [ ] Shell completion updates.
- [ ] README + `one mem --help` text pass.

**External rollout** (post-merge, tracked here for completeness)
- [ ] Publish `@withone/mem` 2.0.0 deprecation release pointing at the CLI.
- [ ] Archive `/Users/moe/projects/opensource/mem`.
- [ ] Sweep `CLAUDE.md` and `.claude/skills/**` in the CEO repo (`npx mem` → `one mem`).
- [ ] Changelog + blog post.

## 12. Testing strategy

Testing is load-bearing for this merge; Moe is pairing on this. The goal is that the branch gets beat up harder than anything else in the CLI before it hits `main`.

### 12.1 Harness: one suite, every backend

The cornerstone is a **plugin parity suite**: one set of tests, runs against every registered backend in CI, asserts identical observable behavior. This is the gate that prevents backend drift and also serves as the compliance test for future third-party plugins.

```
test/memory/
  parity/                          # runs against EVERY backend in the matrix
    records.test.ts
    search.test.ts
    graph.test.ts
    refs.test.ts
    sync-state.test.ts
    keys-uniqueness.test.ts
    hot-columns.test.ts
    embeddings.test.ts             # skipped on backends with vectorSearch:false
    concurrency.test.ts            # skipped on backends with concurrentWriters:false
  specific/
    pglite/                        # plugin-only tests (e.g. cold-start perf, file layout)
    postgres/                      # plugin-only tests (e.g. Supabase RLS, schema option)
  migration/
    legacy-import.test.ts          # reads fixtures under test/fixtures/legacy-sync/
    idempotency.test.ts
    cleanup-safety.test.ts
  sync/
    runner-attio.test.ts           # MSW fixtures
    runner-gmail.test.ts
    hooks-inprocess.test.ts
  integration/
    init-flow.test.ts              # full `one mem init --backend pglite --yes`
    end-to-end.test.ts             # init → add → sync → search → context → archive
  fixtures/
    legacy-sync/                   # canned .one/sync/data/*.db files
    profiles/                      # canned sync profiles
    responses/                     # canned API responses for MSW
```

Parity test runner:

```ts
// test/memory/parity/_runner.ts
const matrix = [
  { name: 'pglite',   factory: () => spawnFreshPglite() },
  { name: 'postgres', factory: () => spawnFreshPostgres(), skip: !process.env.PG_TEST_URL },
];

for (const { name, factory, skip } of matrix) {
  describe.skipIf(skip)(`[${name}] records`, () => {
    let backend: MemBackend;
    beforeEach(async () => { backend = await factory(); });
    afterEach(async () => { await backend.close(); });
    // ... record tests
  });
}
```

### 12.2 Categories

1. **Unit tests** — pure functions (canonical hash, searchable-text extraction, key-prefix parsing, profile validation). In-memory, fast, no DB.
2. **Parity tests** — every backend method, against every plugin in the matrix. Fresh DB per test (PGlite in-memory; Postgres via per-test schema). Target: same assertions pass on both, bit-for-bit where observable.
3. **Plugin-specific tests** — capabilities unique to a backend (PGlite cold-start, Postgres RLS, Supabase ws connection). Live in `test/memory/specific/<plugin>/`.
4. **Migration tests** — fixture `.one/sync/data/*.db` files from a snapshot of the CEO repo's real sync output. `one mem migrate` must be idempotent, produce deterministic IDs where externally-referenced, and never lose rows.
5. **Sync integration tests** — MSW mocks the Attio / Gmail / Fathom endpoints; run `one mem sync run` against them; assert row counts, key prefixes, `sources` map shape, hot-column indexes, hook firings.
6. **End-to-end tests** — shell out to the built CLI (`node dist/cli.js mem …`) in a temp dir, walk through `init → add → sync → search → context → archive → export → migrate`, assert filesystem + DB state at each step.
7. **Performance smoke tests** — not pass/fail, but report: PGlite cold-start ms, 10k-row insert throughput, search latency at 100k rows, embedding batch throughput. Track in a results file; regressions surface in PR review.

### 12.3 Environments

- **Local default** — PGlite only. `pnpm test` works with no external deps.
- **Full matrix** — requires `PG_TEST_URL` pointing at a local Postgres (docker-compose file included); `pnpm test:matrix` runs both.
- **CI** — GitHub Actions spins Postgres as a service container; runs the full matrix on every push to the branch.
- **Nightly on branch** — full matrix + performance smoke, output posted to a branch-scoped results file for trending.

### 12.4 How Moe is pairing

Moe runs a "destructive exploration" pass against the branch that the automated suite can't cover well:

- Real syncs against his actual Attio / Gmail / Fathom connections on a disposable `~/.one/mem.pglite` DB.
- Kill -9 the CLI mid-sync; confirm `mem_sync_state.status` consistency on recovery.
- Re-run `one mem migrate` over already-migrated state; confirm no duplication.
- Point the Postgres backend at a staging Supabase; run the same e2e tests.
- Write one third-party plugin stub (could be a toy SQLite-without-vec adapter) and run the parity suite against it to prove the plugin contract actually works for outsiders.
- Red-team the config/secrets precedence (env var > .onerc > project > global), especially around the OpenAI key.

Every finding from that pass becomes a test case we add to the suite before merging. Branch doesn't merge until Moe explicitly signs off.

### 12.5 Exit criteria

Branch is mergeable when **all** are true:

1. Parity suite green against PGlite and Postgres.
2. Migration tests green on the CEO repo's real data snapshot.
3. Every CLI command has at least one e2e test.
4. A hand-written third-party plugin stub passes the plugin contract (proves the plugin system works).
5. `one mem doctor` returns all-green on a fresh install on Moe's machine.
6. All `npx mem` call sites in the CEO repo + skills have been swept and tested against the new CLI.
7. Moe signs off.

## 13. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| PGlite startup cost on every CLI invocation | Keep DB warm via daemon mode later; for now, PGlite cold-start is ~150ms which is acceptable |
| Embedding cost balloons if synced records accidentally embed | Default `embed: false` at every level except explicit profile opt-in; `mem doctor` flags surprising token usage |
| Large JSONB blobs (Gmail bodies) bloat the store | Sync profile `exclude` already strips big fields; TOAST handles the rest in Postgres |
| JSONB queries slower than native columns on very large types | `hotColumns` partial expression indexes land parity for the filtered paths |
| Users with legacy `.one/sync/data` and unsaved state | Migration is idempotent and non-destructive; `--cleanup` requires explicit confirmation |
| Secret leak if users commit `~/.one/config.json` | Already mode 0600 and outside project tree. `.onerc` example in docs shows env-var pattern for CI |
| Schema evolution (we'll want new columns eventually) | `mem_meta` tracks schema version; backend `ensureSchema` runs additive migrations automatically |

## 14. Open questions (non-blocking)

- Should `one mem` become the *only* memory surface, or preserve a lightweight `one remember "X"` shortcut for users? Defer; easy to add.
- Daemon mode (`one memd`) for long-running agents that want ms-level access? Future work.
- SQLite / Turso / DuckDB plugins — not blocking v1; anyone can publish these as separate npm packages against the plugin contract shipped on this branch.
- Cross-user / team memory via a shared Postgres backend — works today mechanically, needs multi-tenant primitives (row-level scope) before we encourage it. Track separately.
- Plugin capability discovery UX — should `one mem doctor` warn when a plugin's capabilities are weaker than what the user's profiles expect (e.g. profile declares `embed: true` but backend has `vectorSearch: false`)? Probably yes; adds to the doctor checklist.

## 15. Success criteria

1. A fresh `one mem init` sets up PGlite + optional embeddings in < 60 seconds, no external services required.
2. `one mem sync run attio` produces the same observable behavior as today's `one sync run attio`, but stores into the unified DB.
3. `one mem search "moe katib"` returns a single merged record whose `sources` map has entries for Attio + Gmail + Fathom, not three separate rows.
4. `.one/sync/data/` is empty after `one mem migrate --cleanup`.
5. `@withone/mem` is deprecated on npm, archived on GitHub.
6. CEO repo's `CLAUDE.md` references `one mem` exclusively.
