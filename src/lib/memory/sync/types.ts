export type PaginationType = 'cursor' | 'token' | 'offset' | 'id' | 'link' | 'none';

export interface PaginationConfig {
  type: PaginationType;
  /** Dot-path to the next page indicator in the response */
  nextPath?: string;
  /** Format: "{location}:{paramName}" where location is query or header */
  passAs?: string;
  /** For offset pagination: dot-path to total count in response */
  totalPath?: string;
  /** For id pagination: which field on the record is the ID */
  idField?: string;
  /** For id pagination: dot-path to has_more boolean in response */
  hasMorePath?: string;
}

export interface DateFilterConfig {
  param: string;
  format: 'iso8601' | 'unix' | 'date';
}

import type { ConnectionRef } from '../../types.js';

export interface SyncProfile {
  platform: string;
  model: string;
  /**
   * Literal connection key (e.g. "live::gmail::default::abc..."). Legacy form.
   * Prefer `connection: { platform, tag? }` so re-auth doesn't break the
   * profile — re-auth always mints a new key, and the literal form requires
   * a manual edit every time.
   *
   * Exactly one of `connectionKey` or `connection` must be set.
   */
  connectionKey?: string;
  /**
   * Late-bound connection reference, resolved at sync run/test/init time.
   * Survives re-auth: `one add gmail` mints a new key, and the next sync
   * picks it up automatically.
   *
   * Exactly one of `connectionKey` or `connection` must be set.
   */
  connection?: ConnectionRef;
  actionId: string;
  /**
   * Dot-path to the array of records in the API response. Use `""`, `"$"`,
   * or `"."` when the response *is* the array (e.g. HN's `/v0/topstories.json`
   * returns a bare `[123, 456, ...]`). Arrays of primitives are auto-wrapped
   * as `{ [idField]: String(value) }` so they fit the same insert pipeline
   * as object responses.
   */
  resultsPath: string;
  /** Which field on each record is the unique ID */
  idField: string;
  pagination: PaginationConfig;
  dateFilter?: DateFilterConfig;
  /** Page size per request (default: 100) */
  defaultLimit?: number;
  /** Query param name for page size (default: "limit") */
  limitParam?: string;
  /** Static path variables needed for the action */
  pathVars?: Record<string, string | number | boolean>;
  /** Additional static query params to include on every request */
  queryParams?: Record<string, unknown>;
  /** Request body for POST endpoints (pagination params merge into this) */
  body?: Record<string, unknown>;
  /** Where to send the limit param: "query" (default) or "body" */
  limitLocation?: 'query' | 'body';
  /**
   * Dot-path to a field that identifies this record across platforms — i.e.
   * "this record IS this entity". The value is extracted, lowercased, and
   * stored as a prefixed entry in the record's `keys[]` array (e.g.
   * `email:jane@acme.com`). `keys[]` drives upsert-merge and key uniqueness,
   * so records from Attio / HubSpot / Stripe about the same person collapse
   * into one memory row. Use a stable cross-platform identifier like an email
   * address, and make sure the path resolves to exactly ONE value per record —
   * a path that fans out is ambiguous (which entity is this row?) and is
   * dropped rather than merged into the wrong entity.
   *
   * Example: "properties.email", "email", "email_addresses[0].email_address"
   */
  identityKey?: string;
  /**
   * Cross-platform *participant associations* — "this record INVOLVES these
   * people" (issue #128). Use for records with N participants: a Gmail
   * thread's From/To/Cc, calendar attendees, meeting invitees — where a single
   * `identityKey` can't capture everyone. Each entry's `path` resolves via the
   * identity-path walker, with `[]` wildcards expanding to ONE key per array
   * element; each resolved value is lowercased/trimmed (email-prefixed values
   * get their address extracted out of `"Jane <jane@acme.com>"` headers and
   * comma-lists) and emitted as `${prefix}:${value}`. `prefix` is normalized
   * to lowercase and must match `[a-z0-9_]+`; entries with any other prefix
   * are skipped.
   *
   * These values land in the record's separate `identity_keys[]` column
   * (deduped), NOT in `keys[]`. That separation is the entire reason the field
   * exists: unlike `identityKey`, association keys never drive upsert-merge or
   * key uniqueness, so a 30-participant thread stays its own record instead of
   * collapsing into (or colliding with) 30 contact records. Query them with
   * `one mem find-by-key email:jane@acme.com`. Combine freely with
   * `identityKey`.
   *
   * Example:
   *   [{ "prefix": "email", "path": "attendees[].email" },
   *    { "prefix": "email", "path": "organizer.email" }]
   */
  identityKeys?: Array<{ prefix: string; path: string }>;
  /**
   * Dot-path field names to strip from each record before storing.
   * Supports array notation: "messages[].body" strips `body` from each
   * element of the `messages` array.
   *
   * Example: ["messages[].body", "messages[].attachments[].data", "payload.parts"]
   */
  exclude?: string[];
  /**
   * Transform records through a shell command or flow before storing.
   * The command receives a JSON array on stdin and must return a JSON array
   * on stdout. Runs in both phases: on each list page during Phase 1, and
   * on each enrichment batch (after merge, before UPDATE) during Phase 2,
   * so extracted columns stay consistent regardless of which phase produced
   * the data.
   *
   * Performance note: the transform is spawned once per batch, so a slow
   * transform combined with a low `enrich.delayMs` and high `enrich.concurrency`
   * can become throughput-bound.
   *
   * Examples:
   *   "node ./scripts/flatten-properties.js"
   *   "one flow execute transform-contacts"
   *   "jq '[.[] | {id, email: .properties.email}]'"
   */
  transform?: string;
  /**
   * Enrich each record by calling a detail endpoint after the list fetch.
   * Useful when the list endpoint returns lightweight records (e.g. just IDs)
   * and a second API call is needed for the full data.
   */
  enrich?: EnrichConfig;
  /**
   * Hook fired for each newly inserted record. Values:
   * - shell command string: record piped as JSON to stdin
   * - "log": append to `.one/sync/events/<platform>_<model>.jsonl`
   */
  onInsert?: string;
  /**
   * Hook fired for each updated record (id existed but data changed). Values:
   * - shell command string: record piped as JSON to stdin
   * - "log": append to `.one/sync/events/<platform>_<model>.jsonl`
   */
  onUpdate?: string;
  /**
   * Hook fired for any change (insert or update). Shorthand when you don't
   * need to distinguish between the two. Same value format as onInsert/onUpdate.
   */
  onChange?: string;
  /**
   * Unified-memory options. Only consulted when `sync run --to-memory` is
   * active. See docs/plans/unified-memory.md §9.1.
   */
  memory?: MemorySyncOptions;
}

/**
 * Per-profile memory config layered on top of the global defaults. Lets
 * the agent opt into embedding per data type and, critically, declare
 * **which fields** make up the embeddable text — see `searchable`. Without
 * clean paths, the default extractor walks the whole JSON and produces
 * noisy embeddings that degrade semantic search.
 */
export interface MemorySyncOptions {
  /**
   * When true, synced records of this profile get embedded on write
   * (overrides `defaults.embedOnSync`). Requires an OpenAI key.
   */
  embed?: boolean;
  /**
   * Dot-paths into each record that carry the meaningful text to embed
   * and full-text-index. The agent declares these after inspecting a
   * sample with `sync test` — e.g. for Attio people:
   *
   *   ["values.name[0].full_name",
   *    "values.job_title[0].value",
   *    "values.description[0].value",
   *    "values.primary_location[0].locality",
   *    "values.email_addresses[0].email_address"]
   *
   * Each path is resolved with `getByDotPath`; string / number / boolean
   * leaves are concatenated with spaces, arrays of strings are flattened,
   * nested objects are NOT flattened (declare deeper paths instead).
   * Missing / empty values are silently skipped.
   *
   * Preview the result before enabling embeddings with:
   *   one sync test <platform>/<model> --show-searchable
   *
   * When omitted or empty, falls back to `defaultSearchableText` which
   * walks the whole record — correct but often noisy for hierarchical
   * APIs (Attio, HubSpot, Salesforce).
   */
  searchable?: string[];
}

export interface ModelSyncState {
  lastSync: string | null;
  lastCursor: unknown;
  totalRecords: number;
  pagesProcessed: number;
  since: string | null;
  status: 'idle' | 'syncing' | 'failed';
}

export type SyncState = Record<string, Record<string, ModelSyncState>>;

export interface SyncRunError {
  message: string;
  /** HTTP status code when the failure originated from an API response (e.g. 429, 401). */
  httpStatus?: number;
  /** Seconds until retry is safe, parsed from Retry-After (set when httpStatus is 429). */
  retryAfter?: number;
}

export interface SyncRunResult {
  model: string;
  recordsSynced: number;
  pagesProcessed: number;
  duration: string;
  status: 'complete' | 'failed' | 'dry-run';
  /** Populated when status is "failed" — structured error context for programmatic handling. */
  error?: SyncRunError;
  /** Rows removed by --full-refresh because they were no longer in the source. */
  deletedStale?: number;
  /** Whether --full-refresh actually ran reconcile (skipped on truncated pagination). */
  reconcileSkipped?: boolean;
  /**
   * Counts of memory rows for this type after the sync. Surfaces silent
   * damage — if active is low and archived is high, reconcile destroyed
   * data on a prior run and the store needs healing (upsert-by-keys
   * self-heals to active on the next --full-refresh).
   */
  statusCounts?: { active: number; archived: number };
  /** Count of records that triggered onInsert/onChange hooks. */
  hooksInserted?: number;
  /** Count of records that triggered onUpdate/onChange hooks. */
  hooksUpdated?: number;
  /** Count of records successfully enriched via the detail endpoint. */
  enriched?: number;
  /** Count of records skipped during enrichment (errors/auth). */
  enrichSkipped?: number;
  /** Count of records that hit rate limits during enrichment. */
  enrichRateLimited?: number;
}

export interface SyncRunOptions {
  models?: string[];
  since?: string;
  force?: boolean;
  maxPages?: number;
  dryRun?: boolean;
  /**
   * Do a full-refresh sync: fetch ALL records (no since filter) and at the
   * end delete any local rows whose ids weren't seen in this run. Only safe
   * when pulling the whole collection. Cannot be combined with --since.
   */
  fullRefresh?: boolean;
  /**
   * Additionally write each page through to the unified memory store
   * (mem_records) via upsertByKeys. The SQLite store continues to receive
   * writes; this is a dual-write opt-in until the memory-primary path is
   * proven on real data. See docs/plans/unified-memory.md §9.
   */
  toMemory?: boolean;
  /**
   * Per-run override for `memory.embed`. Wins over the profile flag and
   * the config default. Used by `sync run --embed` when backfilling
   * embeddings for data that was first synced with embedOnSync: false —
   * flip on once without editing the profile. `--no-embed` sets false.
   */
  embed?: boolean;
  /**
   * Clear every enrichment stamp before phase 2, forcing the detail endpoint
   * to be re-fetched for all records of the model.
   *
   * The manual escape hatch for profiles with no `enrich.invalidateOn`
   * fingerprint (or when the detail shape itself changed). Expensive — one
   * detail call per record — so it is opt-in per run, never implied by
   * `--full-refresh`. (#174)
   */
  reEnrich?: boolean;
}

export interface SyncQueryOptions {
  where?: string;
  after?: string;
  before?: string;
  limit?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
  refresh?: boolean;
  refreshForce?: boolean;
  dateField?: string;
}

export interface ParsedPassAs {
  location: 'query' | 'header' | 'body';
  paramName: string;
}

export interface EnrichConfig {
  /** The action ID for the detail/get-one endpoint. */
  actionId: string;
  /** Path variables — supports {field} and {{field}} interpolation from the synced record. */
  pathVars?: Record<string, string | number | boolean>;
  /** Query parameters — supports {field} and {{field}} interpolation. */
  queryParams?: Record<string, string | number | boolean>;
  /** Request body with {field}/{{field}} interpolation (for POST detail endpoints). */
  body?: Record<string, unknown>;
  /** Dot-path to extract the detail data from the response (default: whole response). */
  resultsPath?: string;
  /** Specific fields to extract from the enriched response. If omitted, merge all top-level fields. */
  fields?: string[];
  /** Fields to exclude from the enriched response before merging (e.g. strip base64 attachments).
   *  Supports array wildcard notation: "messages[].payload.parts[].body.data" */
  exclude?: string[];
  /** Deep-merge detail into list record (default: true). Set false to replace. */
  merge?: boolean;
  /** Max concurrent enrich requests (default: 5). Lower = safer for rate limits. */
  concurrency?: number;
  /** Delay in ms between batches of detail requests (default: 200). */
  delayMs?: number;
  /** Column name for enrichment timestamp (default: "_enriched_at"). */
  timestampField?: string;
  /**
   * Name of a list-endpoint field that acts as a change fingerprint for the
   * detail payload — e.g. `historyId` for Gmail threads, `updated_at` for
   * Fathom meetings.
   *
   * When set, the value seen at enrich time is recorded alongside the
   * timestamp. On the next sync, any row whose fingerprint has moved has its
   * enrichment stamp cleared, so phase 2 re-fetches the detail endpoint for
   * exactly the records that actually changed upstream — and nothing else.
   *
   * Additive by design: rows enriched before a fingerprint was recorded are
   * never auto-invalidated (that would re-enrich the entire table on the first
   * run after upgrading). They pick up a fingerprint the next time they are
   * enriched for any other reason, including `--re-enrich`. Profiles with no
   * sensible fingerprint field simply omit this and keep today's
   * enrich-exactly-once behaviour. (#174)
   */
  invalidateOn?: string;
}

export interface DiscoveredModel {
  name: string;
  displayName: string;
  listAction: {
    actionId: string;
    path: string;
    method: string;
  };
}
