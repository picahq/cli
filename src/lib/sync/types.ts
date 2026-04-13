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

export interface SyncProfile {
  platform: string;
  model: string;
  connectionKey: string;
  actionId: string;
  /** Dot-path to the array of records in the API response */
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
   * Dot-path to a field that identifies this record across platforms.
   * The value is extracted, lowercased, and stored as `_identity` on every
   * record. Use a stable cross-platform identifier like email address.
   *
   * Example: "properties.email", "email", "email_addresses[0].email_address"
   */
  identityKey?: string;
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
   * The command receives the page of records as a JSON array on stdin and
   * must return a JSON array on stdout. Runs after enrich, before upsert.
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

export interface SyncRunResult {
  model: string;
  recordsSynced: number;
  pagesProcessed: number;
  duration: string;
  status: 'complete' | 'failed' | 'dry-run';
  /** Rows removed by --full-refresh because they were no longer in the source. */
  deletedStale?: number;
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
