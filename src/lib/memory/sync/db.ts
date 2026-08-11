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

/**
 * Distinguish "the native driver cannot run in this process" from "the file on
 * disk is bad".
 *
 * better-sqlite3 loads its addon lazily *inside* the Database constructor, so
 * `await import('better-sqlite3')` succeeds under a mismatched Node and the ABI
 * error only surfaces at open time — where it is otherwise indistinguishable
 * from corruption. Rotating on one of these destroyed a healthy 747MB Gmail
 * sync database (#178).
 */
export function isDriverFault(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ERR_DLOPEN_FAILED') return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /NODE_MODULE_VERSION|compiled against a different Node\.js version|Could not locate the bindings file|invalid ELF header|wrong ELF class|symbol not found|image not found|not a valid Win32 application/i.test(msg);
}

/**
 * Ask SQLite whether the file is actually damaged, via a read-only probe so the
 * check itself can never mutate it. Returns true only when the database opens
 * *and* reports `ok` — a throw or any other verdict means "could not prove it
 * healthy", which is the conservative answer for a caller deciding whether to
 * discard user data.
 */
export function passesIntegrityCheck(
  Ctor: Awaited<ReturnType<typeof loadSqlite>>,
  dbPath: string,
): boolean {
  let probe: Database.Database | undefined;
  try {
    probe = new Ctor(dbPath, { readonly: true, fileMustExist: true });
    const result = probe.pragma('quick_check') as unknown;
    const first = Array.isArray(result) ? result[0] : result;
    const verdict = typeof first === 'string' ? first : (first as { quick_check?: string })?.quick_check;
    return verdict === 'ok';
  } catch {
    return false;
  } finally {
    try { probe?.close(); } catch { /* nothing to close */ }
  }
}

/**
 * Timestamped backup path. The old code rotated to a fixed `<db>.bak`, so a
 * second bad run overwrote the only surviving copy of the data — the reason
 * #178 was recoverable exactly once. Colons are illegal in Windows filenames,
 * hence the `:`/`.` substitution.
 */
export function backupPathFor(dbPath: string, now: Date = new Date()): string {
  return `${dbPath}.bak.${now.toISOString().replace(/[:.]/g, '-')}`;
}

export async function openDatabase(
  platform: string,
  opts: { readonly?: boolean } = {},
): Promise<Database.Database> {
  const Database = await loadSqlite();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, `${platform}.db`);

  // readonly=true is the migrate path: open the user's legacy file with
  // zero side effects — no header rewrites, no -wal/-shm siblings, no
  // corruption-recovery rename. `fileMustExist` keeps better-sqlite3
  // from creating an empty file at the path if the user pointed us at
  // a missing platform.
  if (opts.readonly) {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    // An environment fault is not a corrupt file. Never rotate on one. (#178)
    if (isDriverFault(err)) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new Error(
        `The local sync engine (better-sqlite3) could not load in this Node process.\n` +
        `Your database was NOT modified.\n\n` +
        `This usually means the CLI is running under a different Node than the one\n` +
        `better-sqlite3 was built for — currently node ${process.version} ` +
        `(NODE_MODULE_VERSION ${process.versions.modules}). ` +
        `\`one\` is a #!/usr/bin/env node shim, so a minimal PATH under cron, launchd,\n` +
        `or an agent runner can select a different interpreter than your shell does.\n\n` +
        `Rebuild it against this Node with:\n` +
        `  one sync install\n\n` +
        `Underlying error: ${detail}`
      );
    }

    // Nothing on disk to protect — the open failed for some other reason (bad
    // path, permissions, full disk). Surface it instead of masking it.
    if (!fs.existsSync(dbPath)) throw err;

    // Only discard a file SQLite itself reports as damaged. A healthy database
    // that merely failed to open (locked, read-only mount) must be left alone.
    if (passesIntegrityCheck(Database, dbPath)) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new Error(
        `Could not open ${dbPath}, but it passes SQLite's integrity check — ` +
        `so it is not corrupt and has been left untouched.\n\n` +
        `Underlying error: ${detail}`
      );
    }

    // Genuine corruption. Timestamp the backup so a repeat run cannot destroy
    // the previous one.
    const backupPath = backupPathFor(dbPath);
    fs.renameSync(dbPath, backupPath);
    process.stderr.write(
      `Database at ${dbPath} failed its integrity check. ` +
      `Backup saved at ${backupPath}, starting fresh.\n`
    );
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
