import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
 * `enrich.revisionField` — the fix for task 0000852d (the Gmail sync mirror's
 * frozen label data). Without it, `enrichPhase` only ever visits a row
 * `WHERE "_enriched_at" IS NULL`, which is permanently false after the first
 * enrichment — so a thread's `labels` / `is_unread` / `messages` freeze at
 * whatever they were the moment it was first seen, forever, even though the
 * live thread keeps changing underneath.
 *
 * With `revisionField` set to a value the list phase refreshes for free every
 * run (Gmail's `threads.list` returns `historyId`, which Gmail bumps on ANY
 * mutation to the thread), a row is also re-enriched whenever that field has
 * moved past what was captured at its last enrichment. These tests pin the
 * three levels the frozen-data bug lived at: the SQL lookup that decides
 * "stable vs. stale" for phase 1's write, `enrichPhase`'s own query, and the
 * whole thing composed through a real two-run `syncModel` sequence.
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-revision-test-'));
  process.env.HOME = tmpHome;
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
// 1. findEnrichedIds — a stamped row is only "stable" while its revision
//    matches what was captured at last enrichment.
// ─────────────────────────────────────────────────────────────────────────

describe('findEnrichedIds — with config.revisionField', () => {
  const enrich = { actionId: 'conn_mod_def::detail', revisionField: 'historyId' };

  async function makeTable(
    model: string,
    rows: Array<{ id: string; ts: string | null; historyId: string | null; rev: string | null }>,
  ) {
    const db = await openDatabase('findenriched-rev');
    db.exec(`DROP TABLE IF EXISTS "${model}"`);
    db.exec(`CREATE TABLE "${model}" (id TEXT, "historyId" TEXT, "_enriched_at" TEXT, "_enriched_at_rev" TEXT)`);
    const stmt = db.prepare(
      `INSERT INTO "${model}" (id, "historyId", "_enriched_at", "_enriched_at_rev") VALUES (?, ?, ?, ?)`
    );
    for (const r of rows) stmt.run(r.id, r.historyId, r.ts, r.rev);
    return db;
  }

  it('a stamped row whose incoming historyId matches its stamp stays "enriched"', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await makeTable('t_stable', [
      { id: 'A', historyId: '999', ts: '2026-08-01', rev: '111' },
    ]);
    // Incoming list record carries the SAME historyId the row had when it
    // was last enriched (frozen in "_enriched_at_rev").
    const got = findEnrichedIds(db, 't_stable', 'id', enrich, [{ id: 'A', historyId: '111' }], true);
    assert.deepEqual([...got], ['A']);
    db.close();
  });

  it('a stamped row whose incoming historyId has moved is EXCLUDED (due for re-enrich)', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await makeTable('t_stale', [
      { id: 'A', historyId: '999', ts: '2026-08-01', rev: '111' },
    ]);
    // Thread changed upstream — a new message, or a label flip — so
    // threads.list now reports a newer historyId than what we captured.
    const got = findEnrichedIds(db, 't_stale', 'id', enrich, [{ id: 'A', historyId: '222' }], true);
    assert.equal(got.size, 0, 'must not be reported as stable — it is about to be re-enriched');
    db.close();
  });

  it('a row with no revision stamp yet (pre-fix data) is treated as stale, not stable', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    // Rows enriched before revisionField existed have _enriched_at set but
    // no _enriched_at_rev — the one-time backfill cost documented in the PR.
    const db = await makeTable('t_nostamp', [
      { id: 'A', historyId: '999', ts: '2026-08-01', rev: null },
    ]);
    const got = findEnrichedIds(db, 't_nostamp', 'id', enrich, [{ id: 'A', historyId: '999' }], true);
    assert.equal(got.size, 0, 'no captured revision to compare against — cannot prove stability, so re-enrich');
    db.close();
  });

  it('an incoming record missing the revision field falls back to "stable" (cannot prove staleness)', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await makeTable('t_missing', [
      { id: 'A', historyId: '111', ts: '2026-08-01', rev: '111' },
    ]);
    const got = findEnrichedIds(db, 't_missing', 'id', enrich, [{ id: 'A' }], true);
    assert.deepEqual([...got], ['A'], 'same "can\'t answer, don\'t guess" rule as the rest of this function');
    db.close();
  });

  it('without revisionField configured, behaviour is untouched (ts-only)', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const db = await makeTable('t_notset', [
      { id: 'A', historyId: '999', ts: '2026-08-01', rev: null },
    ]);
    const got = findEnrichedIds(
      db, 't_notset', 'id', { actionId: 'x' }, [{ id: 'A', historyId: '000' }], true,
    );
    assert.deepEqual([...got], ['A'], 'no revisionField → historyId drift is irrelevant, stays stable');
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. syncModel end-to-end — the actual bug: a label flip must be picked up.
// ─────────────────────────────────────────────────────────────────────────

describe('syncModel — enrich.revisionField re-enriches a thread whose historyId moved', () => {
  const LIST = 'conn_mod_def::list::rev';
  const DETAIL = 'conn_mod_def::get::rev';

  const actionDetails = (id: string, p: string) => ({
    _id: id, title: id, path: p, method: 'GET',
    tags: ['passthrough'], knowledge: '', connectionPlatform: 'gmailrev',
  });

  function makeApi(state: {
    historyId: string;
    labelIds: string[];
    detailCalls: string[];
  }): any {
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
          // threads.list: id + historyId only, exactly like real Gmail.
          return {
            responseData: {
              threads: [{ id: 'T1', snippet: 'hi', historyId: state.historyId }],
            },
          };
        }
        state.detailCalls.push(req.pathVariables?.id as string);
        return {
          responseData: {
            id: 'T1',
            historyId: state.historyId,
            messages: [{ id: 'T1-m1', labelIds: state.labelIds }],
          },
        };
      },
    };
  }

  const profile: SyncProfile = {
    platform: 'gmailrev',
    model: 'threads',
    connectionKey: 'live::gmailrev::default::abc',
    actionId: LIST,
    resultsPath: 'threads',
    idField: 'id',
    pagination: { type: 'none' },
    memory: { searchable: ['messages[].snippet'] },
    enrich: { actionId: DETAIL, pathVars: { id: '{id}' }, concurrency: 2, delayMs: 0, revisionField: 'historyId' },
  };

  async function stored(id: string) {
    const backend = await getBackend();
    return backend.findBySource(`gmailrev/threads:${id}`);
  }

  it('unread flips to read upstream (historyId bumps) → the mirror catches up without a manual re-enrich', async (t) => {
    if (!sqliteAvailable) return t.skip('better-sqlite3 unavailable');
    const state = { historyId: '100', labelIds: ['UNREAD', 'INBOX'], detailCalls: [] as string[] };

    // Run 1: first sight, always enriched.
    const r1 = await syncModel(makeApi(state), profile, { toMemory: true });
    assert.equal(r1.enriched, 1);
    assert.deepEqual((((await stored('T1'))!.data as any).messages[0]).labelIds, ['UNREAD', 'INBOX']);

    // Run 2: nothing changed upstream — same historyId. Must NOT re-enrich.
    state.detailCalls = [];
    const r2 = await syncModel(makeApi(state), profile, { toMemory: true, force: true });
    assert.equal(r2.enriched, 0, 'historyId unchanged — the row is still current');
    assert.deepEqual(state.detailCalls, []);

    // Run 3: Moe reads the thread in Gmail. historyId bumps upstream and the
    // label set drops UNREAD — exactly the scenario that produced the false
    // bug report (mirror said unread, live Gmail said read).
    state.historyId = '101';
    state.labelIds = ['INBOX'];
    state.detailCalls = [];
    const r3 = await syncModel(makeApi(state), profile, { toMemory: true, force: true });
    assert.equal(r3.enriched, 1, 'historyId moved — must re-enrich even though _enriched_at was already stamped');
    assert.deepEqual(state.detailCalls, ['T1']);
    assert.deepEqual(
      (((await stored('T1'))!.data as any).messages[0]).labelIds, ['INBOX'],
      'the mirror must reflect the read state, not the frozen first-sight snapshot',
    );

    // Run 4: stable again at the new historyId — no more calls.
    state.detailCalls = [];
    const r4 = await syncModel(makeApi(state), profile, { toMemory: true, force: true });
    assert.equal(r4.enriched, 0, 'settles back into stable once the revision stamp catches up');
  });
});
