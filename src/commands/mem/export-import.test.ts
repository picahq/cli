import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { memExportCommand, memImportCommand } from './export.js';
import { getBackend, resetBackendSingleton } from '../../lib/memory/runtime.js';
import { registerBackend } from '../../lib/memory/plugins.js';
import { pglitePlugin } from '../../lib/memory/plugins/pglite/index.js';
import { updateMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../../lib/memory/config.js';
import { writeConfig } from '../../lib/config.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv } from '../../test-support/home.js';

/** Swallow the command's stdout report so the test output stays readable. */
async function quiet(fn: () => Promise<void>): Promise<void> {
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string) => boolean }).write = () => true;
  try { await fn(); } finally { (process.stdout as unknown as { write: typeof orig }).write = orig; }
}

/**
 * `mem export` → FRESH store → `mem import`, asserting identity_keys survive.
 *
 * The fresh-store half is the whole point. `mem import` rebuilds RecordInput
 * field-by-field, and a field it forgets is invisible when you re-import over
 * a store that still holds the record — mem_upsert_by_keys takes its union
 * branch and preserves what is already there. The loss only shows on the
 * INSERT path, which is exactly the flow export|import exists for: restoring
 * into a wiped store, or swapping backends (pglite → postgres). So this test
 * imports into a SEPARATE, EMPTY database and asserts every record is
 * `inserted`, not `updated`.
 */
describe('mem export → fresh store → mem import round-trip (#128)', () => {
  let tmpHome: string;
  let dumpFile: string;

  /** Point the memory config at a different PGlite dir and re-open. */
  const useStore = async (name: string) => {
    updateMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      backend: 'pglite',
      pglite: { dbPath: path.join(tmpHome, name) },
    });
    resetBackendSingleton();
    return getBackend();
  };

  before(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-export-import-test-'));
    dumpFile = path.join(tmpHome, 'dump.jsonl');
    setHomeTo(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.one'), { mode: 0o700 });
    writeConfig({ apiKey: 'sk_test_dummy', installedAgents: [], createdAt: new Date().toISOString() });
    registerBackend(pglitePlugin);
  });

  after(async () => {
    const backend = await getBackend();
    await backend.close();
    resetBackendSingleton();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('carries identity_keys through export and into an empty destination store', async () => {
    // ── Source store ──────────────────────────────────────────────────────
    const src = await useStore('source.pglite');
    const now = new Date().toISOString();
    await src.upsertByKeys({
      type: 'gmail/gmailThreads',
      data: { subject: 'Q2 pricing' },
      keys: ['gmail/gmailThreads:T1'],
      identity_keys: ['email:jane@acme.com', 'email:bob@acme.com'],
      sources: { 'gmail/gmailThreads:T1': { last_synced_at: now } },
    });
    await src.upsertByKeys({
      type: 'attio/people',
      data: { name: 'Jane Smith' },
      // A contact's own email is an ENTITY key (keys[]); its identity_keys
      // are the associations. Both columns must round-trip independently.
      keys: ['attio/people:J1', 'email:jane@acme.com'],
      identity_keys: ['email:jane@acme.com'],
      sources: { 'attio/people:J1': { last_synced_at: now } },
    });
    // A record with NO identity_keys must come back with none rather than [].
    await src.upsertByKeys({
      type: 'note',
      data: { content: 'plain note' },
      keys: ['note:N1'],
      sources: { 'note:N1': { last_synced_at: now } },
    });

    await quiet(() => memExportCommand(dumpFile));
    const lines = fs.readFileSync(dumpFile, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'all three records exported');
    // Export writes the whole row, so the column is in the dump — if this
    // fails the loss is on the export side, not the import side.
    assert.ok(
      lines.some(l => (JSON.parse(l) as { identity_keys?: string[] }).identity_keys?.includes('email:bob@acme.com')),
      'identity_keys present in the JSONL',
    );
    await src.close();

    // ── Destination store: a DIFFERENT, empty database ────────────────────
    const dest = await useStore('dest.pglite');
    assert.equal((await dest.stats()).recordCount, 0, 'precondition: destination is empty');

    await quiet(() => memImportCommand(dumpFile));
    assert.equal((await dest.stats()).recordCount, 3, 'every record inserted');

    const thread = await dest.findBySource('gmail/gmailThreads:T1');
    assert.ok(thread, 'thread restored');
    assert.deepEqual(
      (thread!.identity_keys ?? []).sort(),
      ['email:bob@acme.com', 'email:jane@acme.com'],
      'participant associations survive the insert path',
    );

    // The point of preserving the column: the cross-platform join still works
    // in the restored store.
    const joined = await dest.findByKeys(['email:jane@acme.com']);
    assert.equal(joined.length, 2, 'thread + contact both reachable by the shared key');
    assert.deepEqual(
      new Set(joined.map(r => r.type)),
      new Set(['gmail/gmailThreads', 'attio/people']),
    );

    // The plain note picked up no phantom keys.
    const note = await dest.findBySource('note:N1');
    assert.ok(!(note!.identity_keys ?? []).length, 'a record with no associations gains none');
  });

  it('re-importing the same dump is idempotent (updates, not duplicates)', async () => {
    const dest = await getBackend();
    await quiet(() => memImportCommand(dumpFile));
    assert.equal((await dest.stats()).recordCount, 3, 'no duplicates on a second import');
    const thread = await dest.findBySource('gmail/gmailThreads:T1');
    assert.deepEqual(
      (thread!.identity_keys ?? []).sort(),
      ['email:bob@acme.com', 'email:jane@acme.com'],
      'the update path must not drop them either',
    );
  });
});
