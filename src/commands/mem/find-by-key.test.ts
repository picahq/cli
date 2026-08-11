import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { memFindByKeyCommand } from './records.js';
import { getBackend, resetBackendSingleton } from '../../lib/memory/runtime.js';
import { registerBackend } from '../../lib/memory/plugins.js';
import { pglitePlugin } from '../../lib/memory/plugins/pglite/index.js';
import { updateMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../../lib/memory/config.js';
import { writeConfig } from '../../lib/config.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv } from '../../test-support/home.js';

// #131: `one mem find-by-key <key> [<key2>]` — exercises the full command path
// (getBackend → findByKeys → group-by-type → agent JSON) against a real PGlite
// backend seeded with identity_keys.

/** Force --agent mode and capture the JSON the command writes to stdout. */
async function runAgent(fn: () => Promise<void>): Promise<any> {
  const prev = process.env.ONE_AGENT;
  process.env.ONE_AGENT = '1';
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => { buf += chunk; return true; };
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
    if (prev === undefined) delete process.env.ONE_AGENT; else process.env.ONE_AGENT = prev;
  }
  const lines = buf.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

describe('mem find-by-key command (#131)', () => {
  let tmpHome: string;

  before(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'find-by-key-test-'));
    setHomeTo(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.one'), { mode: 0o700 });
    writeConfig({ apiKey: 'sk_test_dummy', installedAgents: [], createdAt: new Date().toISOString() });
    registerBackend(pglitePlugin);
    // ':memory:' rather than a temp dir: the truncation case below seeds
    // >2000 rows and file-backed PGlite writes cost ~5ms each, which turned
    // one assertion into a ten-second test. Nothing here needs persistence.
    updateMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, backend: 'pglite', pglite: { dbPath: ':memory:' } });
    resetBackendSingleton();
    const backend = await getBackend();

    const now = new Date().toISOString();
    await backend.upsertByKeys({ type: 'attio/people', data: { name: 'Jane Smith' }, keys: ['attio/people:J1'], identity_keys: ['email:jane@acme.com'], sources: { 'attio/people:J1': { last_synced_at: now } } });
    await backend.upsertByKeys({ type: 'gmail/gmailThreads', data: { subject: 'Q2 pricing' }, keys: ['gmail/gmailThreads:T1'], identity_keys: ['email:jane@acme.com', 'email:bob@acme.com'], sources: { 'gmail/gmailThreads:T1': { last_synced_at: now } } });
    await backend.upsertByKeys({ type: 'gmail/gmailThreads', data: { subject: 'intro' }, keys: ['gmail/gmailThreads:T2'], identity_keys: ['email:jane@acme.com'], sources: { 'gmail/gmailThreads:T2': { last_synced_at: now } } });
  });

  after(async () => {
    const backend = await getBackend();
    await backend.close();
    resetBackendSingleton();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('groups records by type with counts (single key)', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:jane@acme.com', undefined, {}));
    assert.deepEqual(out.keys, ['email:jane@acme.com']);
    assert.equal(out.total, 3);
    assert.equal(out.byType['attio/people'].count, 1);
    assert.equal(out.byType['gmail/gmailThreads'].count, 2);
    assert.equal(out.byType['gmail/gmailThreads'].items.length, 2);
  });

  it('--type filters to one record type', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:jane@acme.com', undefined, { type: 'gmail/gmailThreads' }));
    assert.equal(out.total, 2);
    assert.deepEqual(Object.keys(out.byType), ['gmail/gmailThreads']);
  });

  it('two keys return the intersection', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:jane@acme.com', 'email:bob@acme.com', {}));
    assert.deepEqual(out.keys, ['email:jane@acme.com', 'email:bob@acme.com']);
    assert.equal(out.total, 1);
    assert.equal(out.byType['gmail/gmailThreads'].count, 1);
  });

  it('--limit caps items shown per type (count stays accurate)', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:jane@acme.com', undefined, { type: 'gmail/gmailThreads', limit: '1' }));
    assert.equal(out.byType['gmail/gmailThreads'].count, 2, 'true count preserved');
    assert.equal(out.byType['gmail/gmailThreads'].items.length, 1, 'items capped by --limit');
  });

  it('returns empty for an unknown key', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:nobody@nowhere.com', undefined, {}));
    assert.equal(out.total, 0);
    assert.deepEqual(out.byType, {});
  });

  // ─── query-key normalization ──────────────────────────────────────────────
  //
  // Identity values are lowercased + trimmed on write (`identityValuesFor` in
  // sync/mem-writer.ts) but the CLI arg went straight into an exact
  // array-containment match, so `find-by-key email:Jane@Acme.com` reported "no
  // records linked" while dozens of rows carried `email:jane@acme.com`.
  it('matches case-insensitively and echoes the NORMALIZED key', async () => {
    const out = await runAgent(() => memFindByKeyCommand('  EMAIL:Jane@Acme.COM ', undefined, {}));
    assert.equal(out.total, 3, 'same rows as the exact-case query');
    assert.deepEqual(out.keys, ['email:jane@acme.com'], 'agents see the key that actually matched');
  });

  it('normalizes BOTH positional keys, not just the first', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:JANE@acme.com', ' Email:BOB@Acme.com', {}));
    assert.deepEqual(out.keys, ['email:jane@acme.com', 'email:bob@acme.com']);
    assert.equal(out.total, 1);
  });

  it('falls back to the verbatim key for hand-written mixed-case keys', async () => {
    // `mem add --keys` / `mem key --add` store exactly what was typed, and a
    // custom profile prefix is interpolated verbatim too — so normalization
    // alone would make those rows unreachable. The retry only fires when the
    // normalized lookup found nothing AND normalization changed the input.
    const backend = await getBackend();
    await backend.upsertByKeys({
      type: 'manual/note',
      data: { note: 'hand keyed' },
      keys: ['Slack:U-MixedCase'],
      sources: { 'manual/note:M1': { last_synced_at: new Date().toISOString() } },
    });

    const out = await runAgent(() => memFindByKeyCommand('Slack:U-MixedCase', undefined, {}));
    assert.equal(out.total, 1, 'the verbatim retry is load-bearing');
    assert.deepEqual(out.keys, ['Slack:U-MixedCase'], 'echoes the form that actually matched');

    // A genuine miss still reports zero — the retry must not invent results.
    const miss = await runAgent(() => memFindByKeyCommand('Slack:U-NoSuchUser', undefined, {}));
    assert.equal(miss.total, 0);
  });

  // ─── the two columns are one search space ─────────────────────────────────
  it('intersects two keys even when they live in DIFFERENT columns', async () => {
    // The interesting shape for a cross-platform join: a contact whose own
    // email is an ENTITY key in keys[] and who is also a participant on
    // something, so one query term hits keys[] and the other identity_keys[].
    // The old doc claimed find-by-key only searched keys[]; the predicate is
    // containment over the UNION of both columns.
    const backend = await getBackend();
    const now = new Date().toISOString();
    await backend.upsertByKeys({
      type: 'attio/people',
      data: { name: 'Carol' },
      keys: ['attio/people:C1', 'email:carol@acme.com'],   // entity key
      identity_keys: ['email:dave@acme.com'],              // association
      sources: { 'attio/people:C1': { last_synced_at: now } },
    });
    // A decoy carrying only one of the two — must not appear.
    await backend.upsertByKeys({
      type: 'gmail/gmailThreads',
      data: { subject: 'dave only' },
      keys: ['gmail/gmailThreads:D1'],
      identity_keys: ['email:dave@acme.com'],
      sources: { 'gmail/gmailThreads:D1': { last_synced_at: now } },
    });

    const split = await runAgent(() => memFindByKeyCommand('email:carol@acme.com', 'email:dave@acme.com', {}));
    assert.equal(split.total, 1, 'the intersection spans keys[] + identity_keys[]');
    assert.equal(split.byType['attio/people'].count, 1);
    assert.equal(split.byType['gmail/gmailThreads'], undefined, 'the one-key decoy is excluded');

    // Order of the two positional args must not matter.
    const reversed = await runAgent(() => memFindByKeyCommand('email:dave@acme.com', 'email:carol@acme.com', {}));
    assert.equal(reversed.total, 1);
  });

  // ─── truncation signal ────────────────────────────────────────────────────
  //
  // Runs last: it seeds >FETCH_CAP rows, and every assertion above counts
  // records. Without a truncation flag a saturating type (gmail threads, where
  // every From/To/Cc contributes an identity key) silently ate the whole
  // budget and types sorting after it vanished with no signal at all, while
  // `total` and the human header both reported a wrong number as if it were
  // complete.
  it('flags truncation once the fetch cap is exceeded', async () => {
    const backend = await getBackend();
    const key = 'email:saturating@acme.com';

    const under = await runAgent(() => memFindByKeyCommand('email:jane@acme.com', undefined, {}));
    assert.equal(under.truncated, false, 'no false positive below the cap');
    assert.equal(under.fetchCap, 2000, 'the cap is reported so agents can reason about it');

    // One past the cap is enough to prove the boundary.
    for (let i = 0; i < under.fetchCap + 1; i++) {
      await backend.insert({
        type: 'bulk/threads',
        data: { i },
        keys: [`bulk/threads:B${i}`],
        identity_keys: [key],
      });
    }

    const out = await runAgent(() => memFindByKeyCommand(key, undefined, {}));
    assert.equal(out.truncated, true, 'more matches exist than were fetched');
    assert.equal(out.total, 2000, 'total is capped at the fetch cap, not the true count');
    assert.equal(out.byType['bulk/threads'].count, 2000);
    // `--type` is the documented escape hatch, and it filters in SQL BEFORE
    // the LIMIT — so it is what actually rescues a starved type.
    const filtered = await runAgent(() => memFindByKeyCommand(key, undefined, { type: 'bulk/threads' }));
    assert.equal(filtered.truncated, true);
    assert.deepEqual(Object.keys(filtered.byType), ['bulk/threads']);
  });
});
