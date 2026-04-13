import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { loadSqlite } from './sqlite-loader.js';

const DATA_DIR = path.join('.one', 'sync', 'data');

/**
 * List all platforms that have a local SQLite database.
 */
export function listSyncedPlatforms(): string[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => f.replace(/\.db$/, ''));
}

export async function openDatabase(platform: string): Promise<Database.Database> {
  const Database = await loadSqlite();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, `${platform}.db`);

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch {
    // Corrupted database — back up and start fresh
    const backupPath = dbPath + '.bak';
    if (fs.existsSync(dbPath)) {
      fs.renameSync(dbPath, backupPath);
      process.stderr.write(`Database corrupted, starting fresh. Backup saved at ${backupPath}\n`);
    }
    db = new Database(dbPath);
  }

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');
  db.pragma('foreign_keys = OFF');

  return db;
}

export function getDatabasePath(platform: string): string {
  return path.join(DATA_DIR, `${platform}.db`);
}

export function getDatabaseSize(platform: string): string {
  const dbPath = getDatabasePath(platform);
  if (!fs.existsSync(dbPath)) return '0 B';
  const stats = fs.statSync(dbPath);
  const bytes = stats.size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Detect SQLite column type from a JS value */
function detectColumnType(value: unknown): string {
  if (value === null || value === undefined) return 'TEXT';
  if (typeof value === 'string') return 'TEXT';
  if (typeof value === 'boolean') return 'INTEGER';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL';
  if (typeof value === 'object') return 'TEXT'; // JSON stringified
  return 'TEXT';
}

/** Sanitize a model name for use as a SQL table name */
export function sanitizeTableName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

interface ColumnInfo {
  name: string;
  type: string;
}

export function getTableColumns(db: Database.Database, model: string): ColumnInfo[] {
  const table = sanitizeTableName(model);
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>;
  return rows.map(r => ({ name: r.name, type: r.type }));
}

export function tableExists(db: Database.Database, model: string): boolean {
  const table = sanitizeTableName(model);
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { name: string } | undefined;
  return !!row;
}

/**
 * Create a table from the first record's structure.
 * Returns the list of columns created.
 */
export function ensureTable(
  db: Database.Database,
  model: string,
  firstRecord: Record<string, unknown>,
  idField: string,
): string[] {
  const table = sanitizeTableName(model);

  if (tableExists(db, model)) {
    return getTableColumns(db, model).map(c => c.name);
  }

  const columns: string[] = [];
  const colDefs: string[] = [];

  for (const [key, value] of Object.entries(firstRecord)) {
    const colType = detectColumnType(value);
    colDefs.push(`"${key}" ${colType}`);
    columns.push(key);
  }

  // Add _synced_at column
  if (!columns.includes('_synced_at')) {
    colDefs.push('"_synced_at" TEXT');
    columns.push('_synced_at');
  }

  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs.join(', ')})`);

  // Create unique index on idField
  const safeIdField = idField.replace(/"/g, '""');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_${table}_${sanitizeTableName(idField)}" ON "${table}" ("${safeIdField}")`);

  return columns;
}

/**
 * Rebuild the FTS5 index for a model.
 * Uses a standalone FTS table (not content-synced) to avoid rowid issues
 * with INSERT OR REPLACE upserts. Called after each sync run completes.
 */
export function rebuildFtsIndex(db: Database.Database, model: string): void {
  const table = sanitizeTableName(model);
  const ftsTable = `${table}_fts`;

  // Get TEXT columns (skip _synced_at and non-TEXT columns)
  const columns = getTableColumns(db, model);
  const textCols = columns
    .filter(c => c.type === 'TEXT' && c.name !== '_synced_at')
    .map(c => c.name);

  if (textCols.length === 0) return;

  const quotedCols = textCols.map(c => `"${c}"`).join(', ');

  // Drop old FTS table and triggers if they exist
  db.exec(`DROP TABLE IF EXISTS "${ftsTable}"`);
  db.exec(`DROP TRIGGER IF EXISTS "${table}_ai"`);
  db.exec(`DROP TRIGGER IF EXISTS "${table}_au"`);

  // Create standalone FTS table and populate from main table
  db.exec(`CREATE VIRTUAL TABLE "${ftsTable}" USING fts5(${quotedCols})`);
  db.exec(`INSERT INTO "${ftsTable}"(rowid, ${quotedCols}) SELECT rowid, ${quotedCols} FROM "${table}"`);
}

/**
 * Add new columns to the table if a record has fields not yet in the schema.
 */
export function evolveSchema(db: Database.Database, model: string, record: Record<string, unknown>): void {
  const table = sanitizeTableName(model);
  const existingCols = new Set(getTableColumns(db, model).map(c => c.name));

  for (const [key, value] of Object.entries(record)) {
    if (!existingCols.has(key)) {
      const colType = detectColumnType(value);
      db.exec(`ALTER TABLE "${table}" ADD COLUMN "${key}" ${colType}`);
    }
  }
}

/**
 * Prepare a value for SQLite insertion.
 * Objects/arrays are JSON-stringified, booleans become 0/1.
 */
function prepareValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Upsert records into the table using INSERT OR REPLACE.
 * Runs in a transaction for performance.
 */
export function upsertRecords(
  db: Database.Database,
  model: string,
  records: Record<string, unknown>[],
  idField: string,
): number {
  if (records.length === 0) return 0;

  const table = sanitizeTableName(model);
  const now = new Date().toISOString();

  // Get all column names from the table
  const existingCols = getTableColumns(db, model).map(c => c.name);

  const insertMany = db.transaction((recs: Record<string, unknown>[]) => {
    let count = 0;
    for (const record of recs) {
      // Evolve schema for any new fields in this record
      const recordKeys = Object.keys(record);
      const newKeys = recordKeys.filter(k => !existingCols.includes(k));
      if (newKeys.length > 0) {
        for (const key of newKeys) {
          const colType = detectColumnType(record[key]);
          db.exec(`ALTER TABLE "${table}" ADD COLUMN "${key}" ${colType}`);
          existingCols.push(key);
        }
      }

      // Build the record with _synced_at
      const fullRecord: Record<string, unknown> = { ...record, _synced_at: now };
      const cols = Object.keys(fullRecord).filter(k => existingCols.includes(k) || k === '_synced_at');
      const quotedCols = cols.map(c => `"${c}"`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const values = cols.map(c => prepareValue(fullRecord[c]));

      // Use INSERT ... ON CONFLICT DO UPDATE instead of INSERT OR REPLACE.
      // REPLACE drops the entire row and re-inserts, which wipes columns
      // that aren't in the new data (e.g. _enriched_at from Phase 2).
      // ON CONFLICT DO UPDATE only touches the columns we're providing,
      // preserving any enrichment columns.
      const safeIdField = idField.replace(/"/g, '""');
      const updateCols = cols.filter(c => c !== idField)
        .map(c => `"${c}" = excluded."${c}"`)
        .join(', ');
      db.prepare(
        `INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders}) ` +
        `ON CONFLICT("${safeIdField}") DO UPDATE SET ${updateCols}`
      ).run(...values);
      count++;
    }
    return count;
  });

  return insertMany(records);
}

/**
 * Delete records from a table matching a WHERE clause.
 * Returns the number of rows deleted.
 */
export function deleteRecords(
  db: Database.Database,
  model: string,
  where: string,
  params: unknown[],
): number {
  const table = sanitizeTableName(model);
  const result = db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...params);
  return result.changes;
}

/**
 * Drop a model's data table and FTS table.
 */
export function dropTable(db: Database.Database, model: string): void {
  const table = sanitizeTableName(model);
  db.exec(`DROP TABLE IF EXISTS "${table}_fts"`);
  db.exec(`DROP TRIGGER IF EXISTS "${table}_ai"`);
  db.exec(`DROP TRIGGER IF EXISTS "${table}_au"`);
  db.exec(`DROP TABLE IF EXISTS "${table}"`);
}

/**
 * List all data tables in a platform's database.
 */
export function listTables(db: Database.Database): string[] {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
  return rows.map(r => r.name);
}

/**
 * Count records in a table.
 */
export function countRecords(db: Database.Database, model: string): number {
  const table = sanitizeTableName(model);
  if (!tableExists(db, model)) return 0;
  const row = db.prepare(`SELECT COUNT(*) as count FROM "${table}"`).get() as { count: number };
  return row.count;
}

/**
 * Delete the entire database file for a platform.
 */
export function deleteDatabase(platform: string): void {
  const dbPath = getDatabasePath(platform);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  // Also clean up WAL and SHM files
  if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
  if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
}
