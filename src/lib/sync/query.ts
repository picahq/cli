import type Database from 'better-sqlite3';
import { openDatabase, tableExists, getTableColumns, sanitizeTableName } from './db.js';
import { getModelState } from './state.js';
import { parseCondition, splitConditions } from './where-parser.js';
import type { SyncQueryOptions } from './types.js';

const COMMON_DATE_COLUMNS = ['created_at', 'createdAt', 'created', 'date', 'timestamp', 'updated_at', 'updatedAt'];

/** Auto-detect the date column from table columns */
function detectDateColumn(columns: string[]): string | null {
  const matches = columns.filter(c => COMMON_DATE_COLUMNS.includes(c));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null; // Ambiguous
  return null;
}

/** Format time duration as human-readable */
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
  total: number;
  query: string;
  source: 'local';
  lastSync: string | null;
  syncAge: string | null;
}

/**
 * Execute a query against local synced data.
 */
export async function executeQuery(
  platform: string,
  model: string,
  options: SyncQueryOptions,
): Promise<QueryResult> {
  const db = await openDatabase(platform);

  try {
    if (!tableExists(db, model)) {
      throw new Error(`No synced data for ${platform}/${model}. Run 'one sync run ${platform} --models ${model}' first.`);
    }

    const columns = getTableColumns(db, model).map(c => c.name);
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    // Parse --where conditions (splits on commas outside quoted sections)
    if (options.where) {
      const conditions = splitConditions(options.where);
      for (const cond of conditions) {
        const parsed = parseCondition(cond);
        if (!columns.includes(parsed.field)) {
          throw new Error(`Column "${parsed.field}" not found. Available: ${columns.join(', ')}`);
        }
        whereClauses.push(`"${parsed.field}" ${parsed.operator} ?`);
        params.push(parsed.value);
      }
    }

    // Parse --after/--before date filters
    if (options.after || options.before) {
      let dateCol: string | undefined = options.dateField;
      if (!dateCol) {
        dateCol = detectDateColumn(columns) ?? undefined;
        if (!dateCol) {
          throw new Error(
            `Cannot auto-detect date column. Use --date-field to specify. ` +
            `Available columns: ${columns.join(', ')}`
          );
        }
      }
      if (!columns.includes(dateCol)) {
        throw new Error(`Date column "${dateCol}" not found. Available: ${columns.join(', ')}`);
      }
      if (options.after) {
        whereClauses.push(`"${dateCol}" >= ?`);
        params.push(options.after);
      }
      if (options.before) {
        whereClauses.push(`"${dateCol}" <= ?`);
        params.push(options.before);
      }
    }

    // Build SQL (sanitize model → table name to prevent injection from CLI arg)
    const table = sanitizeTableName(model);
    let sql = `SELECT * FROM "${table}"`;
    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    // Order
    if (options.orderBy) {
      if (!columns.includes(options.orderBy)) {
        throw new Error(`Order column "${options.orderBy}" not found. Available: ${columns.join(', ')}`);
      }
      const dir = (options.order || 'asc').toUpperCase();
      sql += ` ORDER BY "${options.orderBy}" ${dir}`;
    }

    // Limit
    const limit = options.limit ?? 50;
    sql += ` LIMIT ${limit}`;

    const results = db.prepare(sql).all(...params) as Record<string, unknown>[];

    // Parse JSON strings back to objects
    const parsed = results.map(row => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
          try { out[key] = JSON.parse(value); } catch { out[key] = value; }
        } else {
          out[key] = value;
        }
      }
      return out;
    });

    // Sync metadata
    const state = getModelState(platform, model);
    const lastSync = state?.lastSync ?? null;
    const syncAge = lastSync ? formatSyncAge(lastSync) : null;

    db.close();

    return {
      platform,
      model,
      results: parsed,
      total: parsed.length,
      query: sql,
      source: 'local',
      lastSync,
      syncAge,
    };
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Execute raw SQL against a platform's database.
 * Only SELECT statements are allowed.
 */
export async function executeRawSql(platform: string, sql: string): Promise<{ results: Record<string, unknown>[]; query: string }> {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SELECT')) {
    throw new Error('Only SELECT statements are allowed. Sync databases are read-only.');
  }
  // Block statements that can mutate state or exfiltrate data even when they
  // start with SELECT (e.g. CTEs containing INSERT, PRAGMA, ATTACH).
  const forbidden = /\b(PRAGMA|ATTACH|DETACH|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM)\b/;
  if (forbidden.test(upper)) {
    throw new Error('Only pure SELECT queries are allowed. PRAGMA/ATTACH/DDL/DML are blocked.');
  }

  const db = await openDatabase(platform);
  try {
    const results = db.prepare(trimmed).all() as Record<string, unknown>[];

    // Parse JSON strings back to objects
    const parsed = results.map(row => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
          try { out[key] = JSON.parse(value); } catch { out[key] = value; }
        } else {
          out[key] = value;
        }
      }
      return out;
    });

    db.close();
    return { results: parsed, query: trimmed };
  } catch (err) {
    db.close();
    throw err;
  }
}
