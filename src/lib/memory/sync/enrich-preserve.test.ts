import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writePageToMemory } from './mem-writer.js';
import { findEnrichedIds } from './enrich.js';
import { syncModel } from './runner.js';
import { openDatabase } from './db.js';
import { loadSqlite } from './sqlite-loader.js';
import type { SyncProfile } from './types.js';
import { updateMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../config.js';
import { writeConfig } from '../../config.js';
import { getBackend, resetBackendSingleton } from '../runtime.js';
import { registerBackend } from '../plugins.js';
import { pglitePlugin } from '../plugins/pglite/index.js';

/**
 * A PRE-ENRICH WRITE MAY CREATE AND REFRESH, BUT IT MUST NEVER DEGRADE.
 *
 * Sync has two phases for a profile that declares `enrich`. Phase 1 writes
 * every list-shape record from the API page into memory with `replace: true`;
 * phase 2 fetches the detail endpoint for rows `WHERE "_enriched_at" IS NULL`,
 * writes the MERGED record, and stamps the timestamp. Left unguarded those two
 * facts destroy data on the SECOND run: phase 1 replaces `data` with the thin
 * list shape (`{id, snippet, historyId}`) and phase 2 no longer revisits the
 * row, so the thread bodies / transcripts are gone and never come back.
 *
 * These tests pin the guard at all three levels — the SQL lookup that answers
 * "already enriched?", the writer contract that acts on it, and a real
 * two-run `syncModel` sequence that proves the whole thing composes.
 */

let sqliteAvailable = true;
try {
  await loadSqlite();
} catch {
  sqliteAvailable = false;
}

let tmpHome: string;
let originalCwd: string;
let workDir: string;

before(async () => {
  originalCwd = process.cwd();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-preserve-test-'));
  process.env.HOME = tmpHome;
  // Silences the runner's progress/warning writes to stderr.
  process.env.ONE_AGENT = '1';
  fs.mkdirSync(path.join(tmpHome, '.one'), { mode: 0o700 });
  writeConfig({
    apiKey: 'sk_test_dummy',
    installedAgents: [],
    createdAt: new Date().toISOString(),
  });
  registerBackend(pglitePlugin);
  updateMemoryConfig({
    ...DEFAULT_MEMORY_CONFIG,
    backend: 'pglite',
    pglite: { dbPath: path.join(tmpHome, 'mem.pglite') },
  });
  resetBackendSingleton();
  await getBackend();

  // The runner resolves `.one/sync/{data,state,locks}` relative to CWD, so
  // run the whole file from a scratch dir. node's test runner gives each test
  // FILE its own process, so this chdir can't leak into another suite.
  workDir = path.join(tmpHome, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  process.chdir(workDir);
});

after(async () => {
  process.chdir(originalCwd);
  const backend = await getBackend();
  await backend.close();
  resetBackendSingleton();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────────────────────
// 1. The writer contract
// ─────────────────────────────────────────────────────────────────────────

describe('writePageToMemory — alreadyEnrichedIds must not degrade the stored record', () => {
  const profile: SyncProfile = {
    platform: 'gmailpv',
    model: 'threads',
    connectionKey: 'live::gmailpv::default::abc',
    actionId: 'conn_mod_def::list',
    resultsPath: 'threads',
    idField: 'id',
    pagination: { type: 'none' },
    enrich: { actionId: 'conn_mod_def::detail' },
    memory: { searchable: ['messages[].snippet'] },
  };

  /** The fat shape phase 2 writes back (list fields + detail fields + stamp). */
  const enrichedRecord = (id: string) => ({
    id,
    snippet: `thin ${id}`,
    historyId: '111',
    messages: [{ id: `${id}-m1`, snippet: `FULL BODY of ${id}` }],
    _enriched_at: '2026-07-01T00:00:00.000Z',
  });
  /** The thin shape `threads.list` returns on every subsequent run. */
  const listRecord = (id: string) => ({ id, snippet: `thin ${id}`, historyId: '222' });

  it('keeps data AND searchable_text when the id is already enriched', async () => {
    const backend = await getBackend();
    await writePageToMemory(profile, [enrichedRecord('P1')]);
    const afterEnrich = await backend.findBySource('gmailpv/threads:P1');
    assert.equal((afterEnrich!.data as any).messages[0].snippet, 'FULL BODY of P1');
    assert.equal(afterEnrich!.searchable_text, 'FULL BODY of P1');

    // Run 2, phase 1. Pre-fix this replaced `data` with the list shape and
    // blanked searchable_text (the profile's paths resolve to nothing on the
    // thin shape), and phase 2 never revisits a stamped row to repair it.
    const report = await writePageToMemory(profile, [listRecord('P1')], {
      alreadyEnrichedIds: new Set(['P1']),
    });

    const after = await backend.findBySource('gmailpv/threads:P1');
    assert.equal(
      (after!.data as any).messages?.[0]?.snippet, 'FULL BODY of P1',
      'the enriched payload must survive the pre-enrich write',
    );
    assert.equal(
      after!.searchable_text, 'FULL BODY of P1',
      'searchable_text is the half `replace: false` alone would NOT have saved — COALESCE ' +
      'only skips NULL, and upsertRecord derives a text from the thin data unless ' +
      '`preserveDerived` suppresses it',
    );
    assert.equal(report.preserved, 1);
    assert.equal(report.attempted, 1);
    // The write DOES happen — it is merely non-authoritative. Skipping it
    // instead would strand any record whose memory row had been lost or
    // archived, because phase 2 will not revisit a stamped row either.
    assert.equal(report.updated, 1, 'the row is still upserted, just non-authoritatively');
  });

  it('RE-CREATES the record when the memory row is gone but the mirror says enriched', async () => {
    // The mirror is cwd-relative while the store lives under $HOME, so they
    // drift apart for ordinary reasons (backend switch, corruption recovery).
    // A skip-based guard would leave this record unreachable forever: phase 1
    // declines to write, phase 2 declines to revisit.
    const backend = await getBackend();
    // Never seeded into memory — but the mirror insists it is enriched.
    assert.equal(await backend.findBySource('gmailpv/threads:P9'), null, 'no row to begin with');

    await writePageToMemory(profile, [listRecord('P9')], { alreadyEnrichedIds: new Set(['P9']) });

    const revived = await backend.findBySource('gmailpv/threads:P9');
    assert.ok(revived, 'the record must come back rather than be stranded');
    assert.equal((revived!.data as any).id, 'P9');
  });

  it('UN-ARCHIVES an already-enriched row (the upsert self-heal must still run)', async () => {
    // schema.ts calls the unarchive-on-upsert the self-heal primitive for a
    // buggy --full-refresh reconcile. Skipping the write bypasses it and the
    // row stays dead permanently.
    const backend = await getBackend();
    await writePageToMemory(profile, [enrichedRecord('P8')]);
    const rec = await backend.findBySource('gmailpv/threads:P8');
    await backend.archive(rec!.id, 'reconcile');
    assert.equal((await backend.getById(rec!.id))!.status, 'archived');

    await writePageToMemory(profile, [listRecord('P8')], { alreadyEnrichedIds: new Set(['P8']) });

    assert.equal((await backend.getById(rec!.id))!.status, 'active', 'upsert must resurrect it');
    assert.equal(
      ((await backend.getById(rec!.id))!.data as any).messages?.[0]?.snippet, 'FULL BODY of P8',
      'and resurrecting it must not have thinned it',
    );
  });

  it('a preserved record is NOT counted as skipped (broken-idField warning)', async () => {
    // `skipped` means "the writer REJECTED this row" and drives the runner's
    // "most rows were rejected — likely a broken idField" warning. A healthy
    // enrich profile preserves 100% of its page on every run after the first,
    // so folding these into `skipped` would fire that warning forever.
    await writePageToMemory(profile, [enrichedRecord('P2')]);
    const report = await writePageToMemory(profile, [listRecord('P2')], {
      alreadyEnrichedIds: new Set(['P2']),
    });
    assert.equal(report.skipped, 0);
    assert.equal(report.preserved, 1);
  });

  it('a preserved record still reports its source key as SEEN', async () => {
    // `--full-refresh` archives every row whose source key didn't come back
    // this run (runner.ts reconcile). If the skip path dropped the key, a
    // full refresh would mass-archive exactly the enriched records the guard
    // exists to protect. See the end-to-end suite for the live proof.
    await writePageToMemory(profile, [enrichedRecord('P3')]);
    const report = await writePageToMemory(profile, [listRecord('P3')], {
      alreadyEnrichedIds: new Set(['P3']),
    });
    assert.deepEqual(report.sourceKeysSeen, ['gmailpv/threads:P3']);
  });

  it('a record NOT in the set is written exactly as before (must not over-skip)', async () => {
    const backend = await getBackend();
    // P4 has never been enriched, so phase 1 is the ONLY thing that will make
    // it exist and be searchable before phase 2 picks it up.
    const report = await writePageToMemory(profile, [listRecord('P4')], {
      alreadyEnrichedIds: new Set(['P1', 'P2', 'P3']),
    });
    assert.equal(report.preserved, 0);
    assert.equal(report.inserted, 1);
    const rec = await backend.findBySource('gmailpv/threads:P4');
    assert.equal((rec!.data as any).snippet, 'thin P4');
  });

  it('no alreadyEnrichedIds → the historical replace behaviour is untouched', async () => {
    // The fallback every failure mode of findEnrichedIds degrades to, and the
    // behaviour every non-enrich profile keeps.
    const backend = await getBackend();
    await writePageToMemory(profile, [enrichedRecord('P5')]);
    await writePageToMemory(profile, [listRecord('P5')]);
    const rec = await backend.findBySource('gmailpv/threads:P5');
    assert.equal(
      (rec!.data as any).messages, undefined,
      'without the signal the writer still replaces — the guard is opt-in, not implicit',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. The SQL lookup that produces the signal
// ─────────────────────────────────────────────────────────────────────────

describe('findEnrichedIds — the mirror of enrich\'s `WHERE ts IS NULL` query', () => {
  const enrich = { actionId: 'conn_mod_def::detail' };

  async function makeTable(model: string, cols: string, rows: Array<[string, string | null]>) {
    const db = await openDatabase('findenriched');
    db.exec(`DROP TABLE IF EXISTS "${model}"`);
    db.exec(`CREATE TABLE "${model}" (${cols})`);
    const stmt = db.prepare(`INSERT INTO "${model}" (id, "_enriched_at") VALUES (?, ?)`);
    for (const [id, ts] of rows) stmt.run(id, ts);
    return db;
  }

  it('returns only the ids whose timestamp is stamped', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await makeTable('t_basic', 'id TEXT, "_enriched_at" TEXT', [
      ['A', '2026-07-01T00:00:00.000Z'],
      ['B', null],
      ['C', '2026-07-01T00:00:00.000Z'],
    ]);
    const got = findEnrichedIds(db, 't_basic', 'id', enrich, [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }], true);
    assert.deepEqual([...got].sort(), ['A', 'C']);
    db.close();
  });

  it('honours a profile\'s custom timestampField', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await openDatabase('findenriched');
    db.exec(`DROP TABLE IF EXISTS t_custom`);
    db.exec(`CREATE TABLE t_custom (id TEXT, "_detail_at" TEXT, "_enriched_at" TEXT)`);
    db.prepare(`INSERT INTO t_custom (id, "_detail_at", "_enriched_at") VALUES (?, ?, ?)`).run('A', '2026-07-01', null);
    const got = findEnrichedIds(
      db, 't_custom', 'id',
      { actionId: 'x', timestampField: '_detail_at' },
      [{ id: 'A' }], true,
    );
    assert.deepEqual([...got], ['A'], 'must read the profile\'s field, not hardcode _enriched_at');
    db.close();
  });

  it('stringifies ids so INTEGER columns still match', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await openDatabase('findenriched');
    db.exec(`DROP TABLE IF EXISTS t_int`);
    db.exec(`CREATE TABLE t_int (id INTEGER, "_enriched_at" TEXT)`);
    db.prepare(`INSERT INTO t_int (id, "_enriched_at") VALUES (?, ?)`).run(7, '2026-07-01');
    const got = findEnrichedIds(db, 't_int', 'id', enrich, [{ id: 7 }], true);
    assert.deepEqual([...got], ['7'], 'writer compares String(externalId)');
    db.close();
  });

  // ── every failure mode degrades to "write everything" (current behaviour) ──

  it('empty when the table has not been created yet (first page of run 1)', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await makeTable('t_new', 'id TEXT, "_enriched_at" TEXT', []);
    assert.equal(findEnrichedIds(db, 't_new', 'id', enrich, [{ id: 'A' }], false).size, 0);
    db.close();
  });

  it('empty when the timestamp column does not exist yet', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    // Phase 2 ALTERs the column in on demand, so its absence is the normal
    // never-enriched state — not an error, and definitely not a reason to skip.
    const db = await openDatabase('findenriched');
    db.exec(`DROP TABLE IF EXISTS t_nots`);
    db.exec(`CREATE TABLE t_nots (id TEXT, snippet TEXT)`);
    db.prepare(`INSERT INTO t_nots (id, snippet) VALUES (?, ?)`).run('A', 'x');
    assert.equal(findEnrichedIds(db, 't_nots', 'id', enrich, [{ id: 'A' }], true).size, 0);
    db.close();
  });

  it('empty for a dotted idField (the flat SQLite mirror cannot answer)', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await makeTable('t_dotted', 'id TEXT, "_enriched_at" TEXT', [['A', '2026-07-01']]);
    const got = findEnrichedIds(db, 't_dotted', 'id.record_id', enrich, [{ id: { record_id: 'A' } }], true);
    assert.equal(got.size, 0, 'cannot answer → must not guess → write everything');
    db.close();
  });

  it('empty (never throws) when the table is missing entirely', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await openDatabase('findenriched');
    db.exec(`DROP TABLE IF EXISTS t_gone`);
    assert.doesNotThrow(() => findEnrichedIds(db, 't_gone', 'id', enrich, [{ id: 'A' }], true));
    assert.equal(findEnrichedIds(db, 't_gone', 'id', enrich, [{ id: 'A' }], true).size, 0);
    db.close();
  });

  it('empty for an empty page', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await makeTable('t_empty', 'id TEXT, "_enriched_at" TEXT', [['A', '2026-07-01']]);
    assert.equal(findEnrichedIds(db, 't_empty', 'id', enrich, [], true).size, 0);
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. The whole thing, through the real runner
// ─────────────────────────────────────────────────────────────────────────

describe('syncModel — a second run must not thin out the enriched memory record', () => {
  const LIST = 'conn_mod_def::list::e2e';
  const DETAIL = 'conn_mod_def::get::e2e';

  const actionDetails = (id: string, p: string) => ({
    _id: id, title: id, path: p, method: 'GET',
    tags: ['passthrough'], knowledge: '', connectionPlatform: 'gmaile2e',
  });

  function makeApi(state: { listIds: string[]; detailCalls: string[] }): any {
    return {
      async getActionDetailsWithMeta(actionId: string) {
        return {
          data: actionId === LIST ? actionDetails(LIST, '/threads') : actionDetails(DETAIL, '/threads/{{id}}'),
          etag: undefined,
          status: 200,
        };
      },
      async executePassthroughRequest(req: any) {
        if (req.actionId === LIST) {
          // What `threads.list` actually returns: no bodies, no participants.
          return {
            responseData: {
              threads: state.listIds.map(id => ({ id, snippet: `thin ${id}`, historyId: '111' })),
            },
          };
        }
        const id = req.pathVariables?.id as string;
        state.detailCalls.push(id);
        return {
          responseData: {
            id,
            historyId: '999',
            messages: [{
              id: `${id}-m1`,
              snippet: `FULL BODY of ${id}`,
              payload: { headers: [{ name: 'From', value: `Sender <s-${id}@acme.com>` }] },
            }],
          },
        };
      },
    };
  }

  const profile: SyncProfile = {
    platform: 'gmaile2e',
    model: 'threads',
    connectionKey: 'live::gmaile2e::default::abc',
    actionId: LIST,
    resultsPath: 'threads',
    idField: 'id',
    pagination: { type: 'none' },
    identityKeys: [{ prefix: 'email', path: 'messages[].payload.headers[name=From].value' }],
    memory: { searchable: ['messages[].snippet'] },
    enrich: { actionId: DETAIL, pathVars: { id: '{id}' }, concurrency: 2, delayMs: 0 },
  };

  async function stored(id: string) {
    const backend = await getBackend();
    return backend.findBySource(`gmaile2e/threads:${id}`);
  }

  it('run 1 enriches, run 2 preserves, and a new record still gets picked up', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const state = { listIds: ['T1', 'T2'], detailCalls: [] as string[] };
    const api = makeApi(state);

    // ── run 1: list write + enrich ──
    const r1 = await syncModel(api, profile, { toMemory: true });
    assert.equal(r1.enriched, 2);
    const t1 = await stored('T1');
    assert.equal((t1!.data as any).messages[0].snippet, 'FULL BODY of T1');
    assert.equal(t1!.searchable_text, 'FULL BODY of T1');
    assert.deepEqual(t1!.identity_keys, ['email:s-t1@acme.com']);

    // ── run 2: same page comes back; phase 2 will NOT revisit (ts stamped) ──
    state.detailCalls = [];
    const r2 = await syncModel(api, profile, { toMemory: true, force: true });
    assert.equal(r2.enriched, 0, 'enrich only visits ts IS NULL — it cannot repair a thinned row');
    assert.deepEqual(state.detailCalls, [], 'and it makes no detail calls to do so');

    const after = await stored('T1');
    assert.equal(
      (after!.data as any).messages?.[0]?.snippet, 'FULL BODY of T1',
      'run 2 must not replace the enriched payload with the list shape',
    );
    assert.equal(after!.searchable_text, 'FULL BODY of T1');
    // A field present in BOTH shapes takes the LIST value: it is the fresher
    // of the two (the enriched copy is frozen at run 1). Merging is what keeps
    // list fields live; only enrich-ONLY fields are protected from the thin write.
    assert.equal((after!.data as any).historyId, '111', 'list fields still refresh');

    // ── run 3: a brand new thread joins. It has never been enriched, so it
    // must be written by phase 1 AND enriched by phase 2 — the guard must not
    // freeze the collection. ──
    state.listIds = ['T1', 'T2', 'T3'];
    state.detailCalls = [];
    const r3 = await syncModel(api, profile, { toMemory: true, force: true });
    assert.equal(r3.enriched, 1);
    assert.deepEqual(state.detailCalls, ['T3'], 'only the new record costs a detail call');
    assert.equal(((await stored('T3'))!.data as any).messages[0].snippet, 'FULL BODY of T3');
    // …and the old ones are still fat.
    assert.equal(((await stored('T2'))!.data as any).messages[0].snippet, 'FULL BODY of T2');
  });

  it('--full-refresh does not archive the records phase 1 preserved', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    // Reconcile-by-absence archives every row whose source key didn't come
    // back this run. A skipped write that forgot to report its key as SEEN
    // would therefore archive the entire already-enriched collection — a
    // strictly worse bug than the one being fixed.
    //
    // The page MUST be mixed (T9 is brand new, T1-T3 are preserved). With an
    // all-preserved page the reconcile bails early on `seenSourceKeys.size
    // === 0` and the test passes even when the skip path drops its keys — a
    // mutation of exactly that line proved this test vacuous until T9 was
    // added.
    const state = { listIds: ['T1', 'T2', 'T3', 'T9'], detailCalls: [] as string[] };
    const backend = await getBackend();

    await syncModel(makeApi(state), profile, { toMemory: true, fullRefresh: true });

    assert.equal(await backend.count('gmaile2e/threads', { status: 'archived' }), 0);
    assert.equal(await backend.count('gmaile2e/threads', { status: 'active' }), 4);
    assert.equal(
      ((await stored('T1'))!.data as any).messages?.[0]?.snippet, 'FULL BODY of T1',
      'and the payload is still there afterwards',
    );
  });

  it('--no-memory: phase 1 writes nothing, and the enriched rows are untouched', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const backend = await getBackend();
    const before = await backend.count('gmaile2e/threads', { status: 'active' });
    // Everything in this page is already enriched, so phase 2 has no work and
    // the ONLY thing that could touch memory is phase 1 — which `--no-memory`
    // switches off before the guard is ever consulted.
    const state = { listIds: ['T1', 'T2', 'T3'], detailCalls: [] as string[] };
    await syncModel(makeApi(state), profile, { toMemory: false, force: true });
    assert.equal(await backend.count('gmaile2e/threads', { status: 'active' }), before);
    assert.equal(((await stored('T1'))!.data as any).messages?.[0]?.snippet, 'FULL BODY of T1');
  });

  it('a row that is IN sqlite but still unenriched keeps getting refreshed', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    // The other half of the rule: a pre-enrich write may CREATE AND REFRESH.
    // Over-skipping is the mirror-image data loss — a row that phase 2 never
    // manages to enrich (detail endpoint 404s, run killed mid-enrichment, a
    // transform that drops it) would be frozen out of memory forever, holding
    // whatever the first run happened to store. Only `_enriched_at IS NOT
    // NULL` may suppress the write; merely existing in the mirror may not.
    //
    // S2 is kept permanently unenriched by a transform that drops it once it
    // has detail fields — enrich.ts then leaves the row's timestamp NULL.
    // (Phase 1's records have no `messages`, so phase 1 passes through.)
    const dropS2AtEnrich =
      `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{` +
      `const r=JSON.parse(s);` +
      `process.stdout.write(JSON.stringify(r.filter(x=>!(x.messages&&x.id==="S2"))))})'`;

    const halfProfile: SyncProfile = {
      ...profile, platform: 'gmailhalf',
      connectionKey: 'live::gmailhalf::default::abc',
      transform: dropS2AtEnrich,
    };
    const halfApi = (snippet: string): any => ({
      async getActionDetailsWithMeta(actionId: string) {
        return {
          data: actionId === LIST ? actionDetails(LIST, '/threads') : actionDetails(DETAIL, '/t/{{id}}'),
          etag: undefined, status: 200,
        };
      },
      async executePassthroughRequest(req: any) {
        if (req.actionId === LIST) {
          return { responseData: { threads: ['S1', 'S2'].map(id => ({ id, snippet: `${snippet} ${id}` })) } };
        }
        const id = req.pathVariables?.id as string;
        return { responseData: { id, messages: [{ id: `${id}-m1`, snippet: `FULL BODY of ${id}` }] } };
      },
    });
    const backend = await getBackend();
    const half = (id: string) => backend.findBySource(`gmailhalf/threads:${id}`);

    await syncModel(halfApi('v1'), halfProfile, { toMemory: true });
    assert.equal(((await half('S1'))!.data as any).messages[0].snippet, 'FULL BODY of S1');
    assert.equal(((await half('S2'))!.data as any).messages, undefined, 'S2 never got enriched');
    assert.equal(((await half('S2'))!.data as any).snippet, 'v1 S2');

    // Run 2: the upstream snippet moved. S2 is in the mirror but unenriched,
    // so phase 1 owns it and must write the new value through.
    await syncModel(halfApi('v2'), halfProfile, { toMemory: true, force: true });
    assert.equal(
      ((await half('S2'))!.data as any).snippet, 'v2 S2',
      'an unenriched row must still be refreshed by phase 1',
    );
    assert.equal(
      ((await half('S1'))!.data as any).messages[0].snippet, 'FULL BODY of S1',
      'while its enriched neighbour on the same page is left alone',
    );
  });

  it('PRE-EXISTING GAP: --no-memory does not stop phase 2 mirroring into memory', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    // Documenting, not endorsing. The runner passes `profile` into the enrich
    // context unconditionally, and enrich.ts mirrors every merged batch into
    // memory whenever that profile is present — it never consults
    // `options.toMemory`. So a NEW record still lands in memory under
    // `--no-memory`. Untouched by this change (the guard only ever REMOVES
    // writes), and left alone on purpose so the fix stays scoped; pinned here
    // so it can't regress silently in either direction.
    const state = { listIds: ['T1', 'T2', 'T3', 'T4'], detailCalls: [] as string[] };
    await syncModel(makeApi(state), profile, { toMemory: false, force: true });
    const t4 = await stored('T4');
    assert.ok(t4, 'phase 2 wrote it despite --no-memory');
    assert.equal((t4!.data as any).messages[0].snippet, 'FULL BODY of T4');
  });
});
