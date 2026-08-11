import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';

import {
  clearEnrichmentStamps,
  invalidateStaleEnrichments,
  ENRICH_FINGERPRINT_COLUMN,
} from './enrich.js';
import type { EnrichConfig } from './types.js';

// Cover for #174: a record's detail endpoint was fetched exactly once, ever.
// Phase 2 selects `WHERE <tsField> IS NULL` and phase 1's upsert deliberately
// preserves the stamp, so nothing — including --full-refresh — ever re-fetched
// detail content. These pin the two paths that now clear it.
//
// better-sqlite3 is an optionalDependency and is often absent (it will not
// install under Node 24), so these drive a fake driver and assert the SQL and
// the guard decisions rather than SQLite's execution of them.

interface FakeOpts {
  /** table name -> column names. Omit a table to simulate "does not exist". */
  tables?: Record<string, string[]>;
  /** rows affected by the UPDATE. */
  changes?: number;
}

function fakeDb(opts: FakeOpts): { db: Database.Database; statements: string[] } {
  const statements: string[] = [];
  const tables = opts.tables ?? {};

  const db = {
    exec(sql: string) {
      statements.push(sql);
      const m = /ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)"/.exec(sql);
      if (m && tables[m[1]]) tables[m[1]].push(m[2]);
    },
    prepare(sql: string) {
      statements.push(sql);
      return {
        get: (arg?: string) =>
          sql.includes('sqlite_master') && arg && tables[arg] ? { name: arg } : undefined,
        all: () => {
          const m = /PRAGMA table_info\("([^"]+)"\)/.exec(sql);
          return m ? (tables[m[1]] ?? []).map(name => ({ name })) : [];
        },
        run: () => ({ changes: opts.changes ?? 0 }),
      };
    },
  };

  return { db: db as unknown as Database.Database, statements };
}

const updates = (statements: string[]) => statements.filter(s => s.trimStart().startsWith('UPDATE'));

describe('clearEnrichmentStamps — the --re-enrich escape hatch', () => {
  it('clears every stamp and reports the row count', () => {
    const { db, statements } = fakeDb({ tables: { threads: ['id', '_enriched_at'] }, changes: 42 });
    assert.equal(clearEnrichmentStamps(db, 'threads'), 42);

    const [sql] = updates(statements);
    assert.ok(sql, 'expected an UPDATE');
    assert.match(sql, /SET "_enriched_at" = NULL/);
    assert.match(sql, /WHERE "_enriched_at" IS NOT NULL/);
  });

  it('is a no-op when the table does not exist yet', () => {
    const { db, statements } = fakeDb({ tables: {}, changes: 99 });
    assert.equal(clearEnrichmentStamps(db, 'threads'), 0);
    assert.equal(updates(statements).length, 0);
  });

  it('is a no-op when nothing was ever enriched (no timestamp column)', () => {
    const { db, statements } = fakeDb({ tables: { threads: ['id'] }, changes: 99 });
    assert.equal(clearEnrichmentStamps(db, 'threads'), 0);
    assert.equal(updates(statements).length, 0);
  });

  it('honours a custom timestampField', () => {
    const { db, statements } = fakeDb({ tables: { meetings: ['id', '_detail_at'] }, changes: 3 });
    assert.equal(clearEnrichmentStamps(db, 'meetings', '_detail_at'), 3);
    assert.match(updates(statements)[0], /SET "_detail_at" = NULL/);
  });

  it('sanitizes the model name into the table name', () => {
    const { db, statements } = fakeDb({ tables: { gmail_threads: ['id', '_enriched_at'] }, changes: 1 });
    clearEnrichmentStamps(db, 'gmail-threads');
    assert.match(updates(statements)[0], /UPDATE "gmail_threads"/);
  });
});

describe('invalidateStaleEnrichments — fingerprint-driven re-enrich', () => {
  const config: EnrichConfig = { actionId: 'a', invalidateOn: 'historyId' } as EnrichConfig;

  it('does nothing when the profile declares no invalidateOn', () => {
    const { db, statements } = fakeDb({ tables: { threads: ['id', '_enriched_at'] }, changes: 5 });
    assert.equal(invalidateStaleEnrichments(db, 'threads', { actionId: 'a' } as EnrichConfig), 0);
    assert.equal(statements.length, 0, 'must not even inspect the table');
  });

  it('invalidates rows whose fingerprint moved, null-safely', () => {
    const { db, statements } = fakeDb({
      tables: { threads: ['id', '_enriched_at', 'historyId', ENRICH_FINGERPRINT_COLUMN] },
      changes: 7,
    });
    assert.equal(invalidateStaleEnrichments(db, 'threads', config), 7);

    const [sql] = updates(statements);
    assert.ok(sql, 'expected an UPDATE');
    assert.match(sql, /SET "_enriched_at" = NULL/);
    assert.match(sql, /IS NOT CAST\("historyId" AS TEXT\)/);
  });

  it('never invalidates rows that were never fingerprinted', () => {
    // The guard that stops an upgrade from re-enriching an entire table the
    // first time a profile adds invalidateOn.
    const { db, statements } = fakeDb({
      tables: { threads: ['id', '_enriched_at', 'historyId', ENRICH_FINGERPRINT_COLUMN] },
      changes: 7,
    });
    invalidateStaleEnrichments(db, 'threads', config);
    assert.match(updates(statements)[0], new RegExp(`"${ENRICH_FINGERPRINT_COLUMN}" IS NOT NULL`));
  });

  it('adds the bookkeeping column on first use and invalidates nothing that run', () => {
    const tables = { threads: ['id', '_enriched_at', 'historyId'] };
    const { db, statements } = fakeDb({ tables, changes: 999 });

    assert.equal(invalidateStaleEnrichments(db, 'threads', config), 0);
    assert.equal(updates(statements).length, 0, 'nothing could have been fingerprinted yet');
    assert.ok(
      statements.some(s => s.includes(`ADD COLUMN "${ENRICH_FINGERPRINT_COLUMN}"`)),
      'should create the fingerprint column so the next run can use it',
    );
    assert.ok(tables.threads.includes(ENRICH_FINGERPRINT_COLUMN));
  });

  it('is a no-op when the fingerprint source field is not a column', () => {
    // A profile naming a field the list endpoint does not return must degrade
    // to today's behaviour, not error and not invalidate everything.
    const { db, statements } = fakeDb({
      tables: { threads: ['id', '_enriched_at', ENRICH_FINGERPRINT_COLUMN] },
      changes: 5,
    });
    assert.equal(invalidateStaleEnrichments(db, 'threads', config), 0);
    assert.equal(updates(statements).length, 0);
  });

  it('is a no-op when the table does not exist', () => {
    const { db, statements } = fakeDb({ tables: {}, changes: 5 });
    assert.equal(invalidateStaleEnrichments(db, 'threads', config), 0);
    assert.equal(updates(statements).length, 0);
  });

  it('honours a custom timestampField', () => {
    const { db, statements } = fakeDb({
      tables: { meetings: ['id', '_detail_at', 'updated_at', ENRICH_FINGERPRINT_COLUMN] },
      changes: 2,
    });
    const cfg = { actionId: 'a', invalidateOn: 'updated_at', timestampField: '_detail_at' } as EnrichConfig;
    assert.equal(invalidateStaleEnrichments(db, 'meetings', cfg), 2);
    assert.match(updates(statements)[0], /SET "_detail_at" = NULL/);
  });
});
