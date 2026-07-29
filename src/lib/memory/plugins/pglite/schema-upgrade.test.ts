/**
 * Schema paths no other test in this repo exercises: UPGRADING an existing
 * store, and the no-pgvector variant of the DDL.
 *
 * Every other backend test opens a fresh `:memory:` PGlite and applies the
 * current schema in one shot, so `ensureSchema()` only ever runs against a
 * blank slate. That is precisely why two shipped-schema bugs passed CI green:
 *
 *   - the 2.2.0 version collision (main's #171 and this branch both stamped
 *     2.2.0), which made `ensureSchema`'s version fast-path skip the
 *     identity_keys DDL forever on an already-stamped store; and
 *   - the stale `mem_upsert_by_keys` overload, because CREATE OR REPLACE
 *     cannot change a function's argument list — adding `p_identity_keys
 *     TEXT[] DEFAULT NULL` defined a SECOND function, and an 11-arg call then
 *     matched both and failed with 42725 "function ... is not unique".
 *
 * Neither is reachable from a fresh store. So these tests build a store, then
 * DEGRADE it back to a pre-#128 shape (drop the column, restamp the version,
 * reinstall the 11-arg function) and assert `ensureSchema()` heals it.
 *
 * Uses a raw PGlite handle rather than the plugin because it needs to run DDL,
 * and `backend.raw()` is deliberately read-only.
 *
 * The second suite covers the OTHER unreachable path: `mem_upsert_by_keys`
 * exists twice in schema.ts — a no-vector body in FUNCTIONS_SQL and a
 * vector-aware CREATE OR REPLACE of the same signature in
 * VECTOR_FUNCTIONS_SQL. Every backend the suite instantiates advertises
 * `vectorSearch: true`, so the vector body always wins and the no-vector one
 * has never been executed by a test — including its half of the identity_keys
 * three-state contract, which has to be edited in both places by hand.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CoreBackend } from '../postgres-core/index.js';
import type { PgClient, PgQueryResult } from '../postgres-core/index.js';
import type { BackendCapabilities } from '../../backend.js';
import { SCHEMA_VERSION } from '../../schema.js';

// Mirrors the plugin's CAPABILITIES so the DDL path under test is the exact
// one PGlite users get (vector columns + the vector-variant upsert function).
const CAPABILITIES: BackendCapabilities = {
  vectorSearch: true,
  fullTextSearch: true,
  partialIndexes: true,
  jsonPathQuery: true,
  triggers: true,
  concurrentWriters: false,
  maxVectorDims: 2000,
  rawSql: true,
};

interface PgliteInstance {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(text: string): Promise<Array<{ rows?: unknown[]; affectedRows?: number }>>;
  close(): Promise<void>;
}

/** Same params→query / no-params→exec routing the plugin's wrapClient does. */
function wrapClient(db: PgliteInstance): PgClient {
  async function run<T>(text: string, params?: unknown[]): Promise<PgQueryResult<T>> {
    if (params && params.length > 0) {
      const res = await db.query<T>(text, params);
      return { rows: res.rows, rowCount: res.affectedRows };
    }
    const results = await db.exec(text);
    const last = results.length > 0 ? results[results.length - 1] : undefined;
    return { rows: ((last?.rows as T[] | undefined) ?? []), rowCount: last?.affectedRows };
  }
  const client: PgClient = {
    query: run,
    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
      await run('BEGIN');
      try {
        const result = await fn(client);
        await run('COMMIT');
        return result;
      } catch (err) {
        try { await run('ROLLBACK'); } catch { /* swallow secondary error */ }
        throw err;
      }
    },
    async close(): Promise<void> { await db.close(); },
  };
  return client;
}

/**
 * The pre-#128 11-argument signature. Only the signature matters — the fix
 * under test is `DROP FUNCTION IF EXISTS mem_upsert_by_keys(<11 args>)` in
 * FUNCTIONS_SQL, and a stale entry in pg_proc breaks callers regardless of
 * what its body does. Body kept trivial so the test can't accidentally depend
 * on old behaviour.
 */
const OLD_11_ARG_FUNCTION = `
CREATE OR REPLACE FUNCTION mem_upsert_by_keys(
    p_type TEXT, p_data JSONB, p_tags TEXT[], p_keys TEXT[], p_sources JSONB,
    p_searchable_text TEXT, p_content_hash TEXT, p_weight INTEGER DEFAULT NULL,
    p_embedding TEXT DEFAULT NULL, p_embedding_model TEXT DEFAULT NULL,
    p_replace BOOLEAN DEFAULT FALSE
) RETURNS TABLE (id UUID, action TEXT) LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'stale pre-#128 mem_upsert_by_keys was called';
END;
$$;
`;

describe('schema upgrade — ensureSchema heals a pre-#128 store', () => {
  let db: PgliteInstance;
  let client: PgClient;
  let backend: CoreBackend;

  const sql = async <T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> =>
    (await client.query<T>(text, params)).rows;

  /** How many mem_upsert_by_keys overloads pg_proc currently holds. */
  const overloadCount = async (): Promise<number> => {
    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_proc WHERE proname = 'mem_upsert_by_keys'`,
    );
    return Number(rows[0].n);
  };

  /** Column presence via information_schema, i.e. what a DBA would check. */
  const hasIdentityKeysColumn = async (): Promise<boolean> => {
    const rows = await sql(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'mem_records' AND column_name = 'identity_keys'`,
    );
    return rows.length === 1;
  };

  before(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite/vector').catch(() => ({ vector: undefined }));
    db = (await PGlite.create({ extensions: vector ? { vector } : undefined })) as unknown as PgliteInstance;
    client = wrapClient(db);
    backend = new CoreBackend(client, CAPABILITIES);
    await backend.init();
  });

  after(async () => {
    await backend.close();
  });

  /**
   * Rebuild a healthy current-schema store before each case, then let the case
   * degrade it however it likes. Cheaper and clearer than one long sequence
   * where each assertion depends on the previous case's damage.
   */
  beforeEach(async () => {
    await sql(`DROP TABLE IF EXISTS mem_records, mem_links, mem_sync_state, mem_meta CASCADE`);
    await sql(`DROP FUNCTION IF EXISTS mem_upsert_by_keys(
      TEXT, JSONB, TEXT[], TEXT[], JSONB, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN)`);
    await sql(`DROP FUNCTION IF EXISTS mem_upsert_by_keys(
      TEXT, JSONB, TEXT[], TEXT[], JSONB, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN, TEXT[])`);
    await backend.ensureSchema();
  });

  it('a fresh store stamps the current version and exposes exactly one upsert overload', async () => {
    assert.equal(await backend.getSchemaVersion(), SCHEMA_VERSION);
    assert.equal(await hasIdentityKeysColumn(), true);
    assert.equal(await overloadCount(), 1, 'a fresh store must not carry a stale signature');
  });

  it('restores identity_keys when an OLD version stamp gated it away', async () => {
    // The ordinary upgrade: a store last touched by a build that predates
    // identity_keys. Seed a row first so we prove the ALTER is additive and
    // does not take the data with it.
    const seeded = await backend.insert({ type: 'note', data: { content: 'pre-upgrade row' } });

    await sql(`ALTER TABLE mem_records DROP COLUMN identity_keys`);
    await sql(`UPDATE mem_meta SET value = '2.1.0' WHERE key = 'version'`);
    assert.equal(await hasIdentityKeysColumn(), false, 'precondition: degraded to pre-#128');

    await backend.ensureSchema();

    assert.equal(await hasIdentityKeysColumn(), true, 'ALTER ... ADD COLUMN IF NOT EXISTS must run');
    assert.equal(await backend.getSchemaVersion(), SCHEMA_VERSION, 'version restamped');
    assert.ok(await backend.getById(seeded.id), 'existing rows survive the upgrade');
  });

  it('restores identity_keys even when the version stamp already reads CURRENT', async () => {
    // The 2.2.0 collision in miniature. Version equality alone must not gate
    // additive DDL: a forgotten bump — or two branches picking the same
    // literal — leaves the stamp looking current while the column is missing,
    // and the old fast path then skipped the DDL forever and failed at query
    // time instead. The fast path now also probes for the column itself.
    await sql(`ALTER TABLE mem_records DROP COLUMN identity_keys`);
    assert.equal(await backend.getSchemaVersion(), SCHEMA_VERSION, 'precondition: stamp still current');
    assert.equal(await hasIdentityKeysColumn(), false, 'precondition: column gone');

    await backend.ensureSchema();

    assert.equal(await hasIdentityKeysColumn(), true, 'a matching version stamp must not gate the DDL');
  });

  it('drops the stale 11-arg mem_upsert_by_keys instead of leaving both overloads', async () => {
    // CREATE OR REPLACE cannot narrow/widen an argument list, so an upgraded
    // store held both. Because the 12-arg version's trailing param is
    // defaultable, an 11-arg call matched BOTH → 42725 "is not unique".
    await sql(OLD_11_ARG_FUNCTION);
    assert.equal(await overloadCount(), 2, 'precondition: both signatures installed');

    // Sanity: with both present, an 11-arg call is genuinely ambiguous. This is
    // the failure users hit, and it is what the DROP exists to prevent.
    await assert.rejects(
      sql(`SELECT * FROM mem_upsert_by_keys($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        ['note', { a: 1 }, null, ['probe:ambiguous'], {}, null, null, null, null, null, false]),
      /not unique/i,
      'precondition: the ambiguity is real',
    );

    await sql(`UPDATE mem_meta SET value = '2.1.0' WHERE key = 'version'`);
    await backend.ensureSchema();

    assert.equal(await overloadCount(), 1, 'exactly one signature must survive');
    // And the survivor is the NEW one: it accepts a 12th argument, and (since
    // vectorSearch is on) it is the vector-aware body from VECTOR_FUNCTIONS_SQL
    // rather than the no-vector variant FUNCTIONS_SQL defines first.
    const args = await sql<{ args: string }>(
      `SELECT pg_get_function_arguments(oid) AS args FROM pg_proc WHERE proname = 'mem_upsert_by_keys'`,
    );
    assert.match(args[0].args, /p_identity_keys/, 'the surviving signature is the identity_keys-aware one');
  });

  it('insert and upsertByKeys with identity keys both work after the upgrade', async () => {
    // The end-to-end point of all of the above: after healing, the two write
    // paths that touch the new column must round-trip it.
    await sql(`ALTER TABLE mem_records DROP COLUMN identity_keys`);
    await sql(OLD_11_ARG_FUNCTION);
    await sql(`UPDATE mem_meta SET value = '2.1.0' WHERE key = 'version'`);

    await backend.ensureSchema();

    const inserted = await backend.insert({
      type: 'gmail/gmailThreads',
      data: { subject: 'after upgrade' },
      keys: ['gmail/gmailThreads:U1'],
      identity_keys: ['email:jane@acme.com', 'email:bob@acme.com'],
    });
    assert.deepEqual(
      (inserted.identity_keys ?? []).sort(),
      ['email:bob@acme.com', 'email:jane@acme.com'],
    );

    const upserted = await backend.upsertByKeys({
      type: 'attio/people',
      data: { name: 'Jane' },
      keys: ['attio/people:U2'],
      identity_keys: ['email:jane@acme.com'],
      sources: { 'attio/people:U2': { last_synced_at: new Date().toISOString() } },
    });
    assert.equal(upserted.action, 'inserted');
    assert.deepEqual(upserted.record.identity_keys, ['email:jane@acme.com']);

    // The GIN index the query path relies on is recreated too, and the shared
    // participant now joins the two records across types.
    const found = await backend.findByKeys(['email:jane@acme.com']);
    assert.equal(found.length, 2, 'find-by-key works against the healed column');
  });
});

describe('no-pgvector schema variant — the FUNCTIONS_SQL upsert body', () => {
  let db: PgliteInstance;
  let client: PgClient;
  let backend: CoreBackend;

  before(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    // No `vector` extension and vectorSearch: false — this is the shape a
    // hosted Postgres without pgvector gets.
    db = (await PGlite.create()) as unknown as PgliteInstance;
    client = wrapClient(db);
    backend = new CoreBackend(client, { ...CAPABILITIES, vectorSearch: false, maxVectorDims: 0 });
    await backend.init();
    await backend.ensureSchema();
  });

  after(async () => {
    await backend.close();
  });

  it('applies cleanly without the embedding columns', async () => {
    const rows = (await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'mem_records' AND column_name IN ('embedding', 'embedded_at', 'embedding_model')`,
    )).rows;
    assert.equal(Number(rows[0].n), 0, 'no vector columns when the capability is off');
    // …but identity_keys is core, not vector-gated.
    const idk = (await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'mem_records' AND column_name = 'identity_keys'`,
    )).rows;
    assert.equal(idk.length, 1);
  });

  it('honours the same identity_keys three-state contract as the vector body', async () => {
    // The two function bodies are maintained by hand and drift silently; this
    // asserts the no-vector one implements NULL=keep / []=clear / [a,b]=replace
    // exactly like the vector one (asserted in pglite.test.ts).
    const seed = {
      type: 'google-calendar/events',
      keys: ['google-calendar/events:NV1'],
      sources: { 'google-calendar/events:NV1': { last_synced_at: new Date().toISOString() } },
    };
    await backend.upsertByKeys(
      { ...seed, data: { summary: 'standup' }, identity_keys: ['email:a@acme.com', 'email:b@acme.com'] },
      { replace: true },
    );

    const kept = await backend.upsertByKeys({ ...seed, data: { summary: 'renamed' } }, { replace: true });
    assert.equal(kept.record.data.summary, 'renamed');
    assert.deepEqual((kept.record.identity_keys ?? []).sort(), ['email:a@acme.com', 'email:b@acme.com'], 'NULL keeps');

    const cleared = await backend.upsertByKeys({ ...seed, data: {}, identity_keys: [] }, { replace: true });
    assert.deepEqual(cleared.record.identity_keys ?? [], [], '[] clears');

    const merged = await backend.upsertByKeys({ ...seed, data: {}, identity_keys: ['email:c@acme.com'] });
    assert.deepEqual(merged.record.identity_keys, ['email:c@acme.com'], 'merge unions onto the cleared column');
  });

  it('identity_keys still do not drive the merge without pgvector', async () => {
    const now = new Date().toISOString();
    const contact = await backend.upsertByKeys({
      type: 'attio/people', data: { name: 'Jane' }, keys: ['attio/people:NVJ'],
      identity_keys: ['email:jane@acme.com'], sources: { 'attio/people:NVJ': { last_synced_at: now } },
    });
    const thread = await backend.upsertByKeys({
      type: 'gmail/gmailThreads', data: { subject: 'hi' }, keys: ['gmail/gmailThreads:NVT'],
      identity_keys: ['email:jane@acme.com'], sources: { 'gmail/gmailThreads:NVT': { last_synced_at: now } },
    });
    assert.notEqual(thread.record.id, contact.record.id);
    assert.equal((await backend.findByKeys(['email:jane@acme.com'])).length, 2);
  });
});
