/**
 * `one sync query <platform>/<model>` — reads from the unified memory
 * store now that synced rows live in `mem_records` (type = platform/model).
 *
 * Filters are applied in TypeScript over the record's `data` JSONB. This
 * is correct for small and medium stores; very large result sets will
 * want backend-side JSONB filters — deferred until the pain shows up.
 *
 * `executeRawSql` now returns a deprecation error pointing at the
 * `one mem` surface (hybrid search + JSONB indexes) since there's no
 * safe universal "raw SQL" that spans PGlite / Postgres / third-party
 * plugins without leaking backend specifics.
 */

import { getBackend } from '../runtime.js';
import { getModelState } from './state.js';
import { parseCondition, splitConditions, type ParsedCondition } from './where-parser.js';
import type { SyncQueryOptions } from './types.js';
import { getByDotPath } from '../../dot-path.js';

const COMMON_DATE_COLUMNS = ['created_at', 'createdAt', 'created', 'date', 'timestamp', 'updated_at', 'updatedAt'];

function detectDateColumn(sample: Record<string, unknown>): string | null {
  const matches = COMMON_DATE_COLUMNS.filter(c => c in sample);
  if (matches.length === 1) return matches[0];
  return null; // zero or ambiguous
}

function formatSyncAge(lastSync: string): string {
  const diffMs = Date.now() - new Date(lastSync).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export interface QueryResult {
  platform: string;
  model: string;
  results: Record<string, unknown>[];
  /** Number of rows returned on this page (== results.length). */
  returned: number;
  /**
   * Honest total for the filter. For `--where`-filtered queries this is
   * the count after filtering; for unfiltered queries it's the total
   * record count for the type. Pagers / progress meters MUST use this
   * instead of `results.length` — the two diverge past the first page.
   */
  total: number;
  /** Total record count for the type before --where filtering applies. */
  totalRecordsOfType: number;
  limit: number;
  query: string;
  source: 'local';
  lastSync: string | null;
  syncAge: string | null;
}

function matchesCondition(row: Record<string, unknown>, c: ParsedCondition): boolean {
  // Support dotted paths in --where (e.g. values.name[0].full_name) so
  // memory records with deeply nested payloads are filterable without
  // pre-flattening.
  const left = c.field.includes('.') || c.field.includes('[')
    ? getByDotPath(row, c.field)
    : row[c.field];
  const right = c.value;

  switch (c.operator) {
    case '=':
      return String(left) === right;
    case '!=':
      return String(left) !== right;
    case '>': return coerceNumber(left) > coerceNumber(right);
    case '<': return coerceNumber(left) < coerceNumber(right);
    case '>=': return coerceNumber(left) >= coerceNumber(right);
    case '<=': return coerceNumber(left) <= coerceNumber(right);
    case 'LIKE': {
      // SQL-ish LIKE: % is wildcard, case-insensitive.
      const pattern = right.replace(/[.*+?^${}()|[\]\\]/g, r => `\\${r}`).replace(/%/g, '.*');
      return new RegExp(`^${pattern}$`, 'i').test(String(left ?? ''));
    }
    default:
      return false;
  }
}

function coerceNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

function compareField(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Hard cap on what we pull back before filtering. JSONB scans in TS are
 * fine at this scale; beyond it we want backend-side filtering. */
const SCAN_CAP = 10_000;

export async function executeQuery(
  platform: string,
  model: string,
  options: SyncQueryOptions,
): Promise<QueryResult> {
  const backend = await getBackend();
  const type = `${platform}/${model}`;

  const [records, totalRecordsOfType] = await Promise.all([
    backend.list(type, { limit: SCAN_CAP, status: 'active' }),
    backend.count(type, { status: 'active' }),
  ]);
  if (records.length === 0) {
    return {
      platform,
      model,
      results: [],
      returned: 0,
      total: 0,
      totalRecordsOfType,
      limit: options.limit ?? 50,
      query: `memory.list(type="${type}")`,
      source: 'local',
      lastSync: null,
      syncAge: null,
    };
  }

  let rows = records.map(r => r.data as Record<string, unknown>);

  if (options.where) {
    const conditions = splitConditions(options.where).map(parseCondition);
    rows = rows.filter(row => conditions.every(c => matchesCondition(row, c)));
  }

  if (options.after || options.before) {
    const dateCol = options.dateField ?? detectDateColumn(rows[0] ?? {});
    if (!dateCol) {
      throw new Error(
        `Cannot auto-detect date column for ${type}. Pass --date-field to specify one of the record's timestamp fields.`
      );
    }
    if (options.after) {
      rows = rows.filter(r => String(r[dateCol] ?? '') >= options.after!);
    }
    if (options.before) {
      rows = rows.filter(r => String(r[dateCol] ?? '') <= options.before!);
    }
  }

  if (options.orderBy) {
    const key = options.orderBy;
    const asc = (options.order ?? 'asc').toLowerCase() !== 'desc';
    rows.sort((a, b) => (asc ? 1 : -1) * compareField(a[key], b[key]));
  }

  const limit = options.limit ?? 50;
  // Capture the post-filter total BEFORE truncating to the page.
  const totalAfterFilters = rows.length;
  rows = rows.slice(0, limit);

  const state = await getModelState(platform, model);
  const lastSync = state?.lastSync ?? null;
  const syncAge = lastSync ? formatSyncAge(lastSync) : null;

  return {
    platform,
    model,
    results: rows,
    returned: rows.length,
    total: totalAfterFilters,
    totalRecordsOfType,
    limit,
    query: `memory.list(type="${type}") + ${options.where ? 'where' : 'no-where'}`,
    source: 'local',
    lastSync,
    syncAge,
  };
}

/**
 * Raw SQL against synced data has no universal memory-side analog —
 * PGlite's syntax and third-party plugins diverge, and exposing a raw
 * query surface sidesteps key/search semantics. Point agents at the
 * memory commands, which work against every backend.
 */
export async function executeRawSql(
  _platform: string,
  _sql: string,
): Promise<{ results: Record<string, unknown>[]; query: string }> {
  throw new Error(
    '`sync sql` is not supported against the unified memory store. ' +
    'Use `one mem search "..." --type <platform>/<model>` for text search, ' +
    'or `one mem list <platform>/<model>` for raw listing. ' +
    'See `one mem --help` for the full surface.',
  );
}
