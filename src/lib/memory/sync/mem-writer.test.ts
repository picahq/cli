import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writePageToMemory, extractSearchableFromPaths } from './mem-writer.js';
import type { SyncProfile } from './types.js';
import { updateMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../config.js';
import { writeConfig } from '../../config.js';
import { getBackend, resetBackendSingleton } from '../runtime.js';
import { registerBackend } from '../plugins.js';
import { pglitePlugin } from '../plugins/pglite/index.js';

/**
 * Exercises the dual-write helper end-to-end against a live PGlite. Proves
 * that sync pages land as mem_records with the correct keys[] (prefixed +
 * identity-derived), sources map entries, and tags.
 */
describe('sync mem-writer — dual-write into the unified memory store', () => {
  let tmpHome: string;
  let dbDir: string;

  before(async () => {
    // Isolate HOME so we never touch the user's real config file.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-writer-test-'));
    dbDir = path.join(tmpHome, 'mem.pglite');
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.one'), { mode: 0o700 });
    writeConfig({
      apiKey: 'sk_test_dummy',
      installedAgents: [],
      createdAt: new Date().toISOString(),
    });
    // PGlite is no longer registered as a product backend, but we still
    // use it as an in-memory fixture for unit tests. Register it
    // explicitly here so the writer's getBackend() path can resolve it.
    registerBackend(pglitePlugin);
    updateMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      backend: 'pglite',
      pglite: { dbPath: dbDir },
    });
    resetBackendSingleton();
    // Warm up the singleton so schema is applied before any writer call.
    await getBackend();
  });

  after(async () => {
    const backend = await getBackend();
    await backend.close();
    resetBackendSingleton();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const profile: SyncProfile = {
    platform: 'attio',
    model: 'people',
    connectionKey: 'live::attio::default::abc',
    actionId: 'conn_mod_def::xxx::yyy',
    resultsPath: 'data',
    idField: 'id',
    pagination: { type: 'cursor' },
    identityKey: 'email',
  };

  it('writes a page and lands records with prefixed keys + sources', async () => {
    const records = [
      { id: 'p1', name: 'Alice', email: 'alice@example.com' },
      { id: 'p2', name: 'Bob', email: 'Bob@Example.com' }, // casing differences
    ];

    const report = await writePageToMemory(profile, records);
    assert.equal(report.attempted, 2);
    assert.equal(report.inserted, 2);
    assert.equal(report.updated, 0);
    assert.equal(report.skipped, 0);

    const backend = await getBackend();

    // Look up each by its source key
    const alice = await backend.findBySource('attio/people:p1');
    assert.ok(alice, 'alice should be found by her source key');
    assert.deepEqual(alice!.data, { id: 'p1', name: 'Alice', email: 'alice@example.com' });
    assert.ok((alice!.keys ?? []).includes('attio/people:p1'));
    assert.ok((alice!.keys ?? []).includes('email:alice@example.com'));
    assert.ok(alice!.sources['attio/people:p1']);
    assert.ok((alice!.tags ?? []).includes('synced'));
    assert.ok((alice!.tags ?? []).includes('attio'));

    // Identity key is lowercased on the way in so Bob and bob merge naturally
    const bob = await backend.findBySource('attio/people:p2');
    assert.ok(bob, 'bob should be found by his source key');
    assert.ok((bob!.keys ?? []).includes('email:bob@example.com'));
  });

  it('re-running the same page updates (not inserts)', async () => {
    const records = [{ id: 'p1', name: 'Alice Updated', email: 'alice@example.com' }];
    const report = await writePageToMemory(profile, records);
    assert.equal(report.updated, 1);
    assert.equal(report.inserted, 0);

    const backend = await getBackend();
    const alice = await backend.findBySource('attio/people:p1');
    assert.ok(alice, 'alice should still exist after update');
    assert.equal(alice!.data.name, 'Alice Updated');
  });

  it('skips records with no id field and never crashes', async () => {
    const report = await writePageToMemory(profile, [
      { name: 'Missing id' }, // no `id`
      { id: '', name: 'Empty id' },
      { id: null as unknown as string, name: 'Null id' },
    ]);
    assert.equal(report.skipped, 3);
    assert.equal(report.inserted, 0);
  });

  it('strips sync-internal fields (leading underscore) from the landed payload', async () => {
    const report = await writePageToMemory(profile, [
      { id: 'p9', name: 'Carol', email: 'carol@example.com', _synced_at: '2026-04-01', _enriched_at: '2026-04-02' },
    ]);
    assert.equal(report.inserted, 1);
    const backend = await getBackend();
    const carol = await backend.findBySource('attio/people:p9');
    assert.ok(carol, 'carol should be found');
    assert.equal(carol!.data._synced_at, undefined);
    assert.equal(carol!.data._enriched_at, undefined);
  });

  // ─── #128 routing: which COLUMN each kind of key lands in ────────────────
  //
  // These guard the actual bug this branch exists to fix. Everything else
  // that touches identity keys tests either the pure helpers
  // (identity-keys.test.ts → collectIdentityKeys, the UNION used only by
  // `sync test` previews) or the SQL with hand-written arrays
  // (pglite.test.ts → upsertByKeys). Neither observes the WRITER's split, so
  // both of these mutations used to pass the whole suite green:
  //   1. `const keys = [sourceKey, ...collectIdentityKeys(record, profile)]`
  //      — the #128 bug verbatim: participants back in the MERGING keys[].
  //   2. `identity_keys: undefined` unconditionally — column never populated.
  // Assert at the writer boundary (write a page, read the row back) so the
  // routing itself is covered, not the helpers it happens to call.
  const threadProfile: SyncProfile = {
    platform: 'gmailtest',
    model: 'threads',
    connectionKey: 'live::gmail::default::abc',
    actionId: 'conn_mod_def::xxx::yyy',
    resultsPath: 'data',
    idField: 'id',
    pagination: { type: 'cursor' },
    // Plural = ASSOCIATIONS. No singular identityKey: a thread is not a person,
    // so it has no entity identity of its own.
    identityKeys: [{ prefix: 'email', path: 'participants[].email' }],
  };

  it('routes participants to identity_keys[] and keeps keys[] to the source key alone (#128)', async () => {
    const report = await writePageToMemory(threadProfile, [
      {
        id: 'T1',
        subject: 'Q2 pricing',
        participants: [{ email: 'Jane@Acme.com' }, { email: 'moe@withone.ai' }],
      },
    ]);
    assert.equal(report.inserted, 1);

    const backend = await getBackend();
    const thread = await backend.findBySource('gmailtest/threads:T1');
    assert.ok(thread, 'thread should be found by its source key');

    // (a) keys[] holds ONLY the source key. Any participant email here is the
    // #128 bug: keys[] drives both the uniqueness trigger and the upsert
    // overlap-merge, so a participant in it makes the thread collide with the
    // contact record for that person.
    assert.deepEqual(thread!.keys, ['gmailtest/threads:T1']);

    // (b) identity_keys[] holds both participants, normalized (lowercased).
    assert.deepEqual(
      (thread!.identity_keys ?? []).sort(),
      ['email:jane@acme.com', 'email:moe@withone.ai'].sort(),
    );
  });

  it('two threads sharing a participant stay DISTINCT records (#128)', async () => {
    await writePageToMemory(threadProfile, [
      { id: 'T2', subject: 'first', participants: [{ email: 'shared@acme.com' }, { email: 'a@x.com' }] },
      { id: 'T3', subject: 'second', participants: [{ email: 'shared@acme.com' }, { email: 'b@x.com' }] },
    ]);

    const backend = await getBackend();
    const t2 = await backend.findBySource('gmailtest/threads:T2');
    const t3 = await backend.findBySource('gmailtest/threads:T3');
    assert.ok(t2 && t3, 'both threads should exist');
    assert.notEqual(t2!.id, t3!.id, 'sharing a participant must NOT collapse the two threads');
    assert.equal(t2!.data.subject, 'first');
    assert.equal(t3!.data.subject, 'second');
    // Each keeps its own participant set — no cross-contamination from a merge.
    assert.ok((t2!.identity_keys ?? []).includes('email:a@x.com'));
    assert.ok(!(t2!.identity_keys ?? []).includes('email:b@x.com'));

    // And the shared participant joins them: find-by-key is the whole point.
    const joined = await backend.findByKeys(['email:shared@acme.com']);
    assert.equal(joined.length, 2, 'both threads reachable by the shared participant');
  });

  it('a thread does NOT merge into the contact that shares its participant (#128)', async () => {
    // `profile` (attio/people) puts the person's own email in keys[] via the
    // singular identityKey — the entity identity. The thread carries the same
    // address as an ASSOCIATION. Different columns → no merge.
    await writePageToMemory(profile, [{ id: 'p42', name: 'Dana', email: 'dana@acme.com' }]);
    await writePageToMemory(threadProfile, [
      { id: 'T4', subject: 'with dana', participants: [{ email: 'dana@acme.com' }] },
    ]);

    const backend = await getBackend();
    const dana = await backend.findBySource('attio/people:p42');
    const t4 = await backend.findBySource('gmailtest/threads:T4');
    assert.ok(dana && t4);
    assert.notEqual(t4!.id, dana!.id, 'thread must not collapse into the contact');
    assert.equal(t4!.type, 'gmailtest/threads', 'thread keeps its own type');
    assert.equal(dana!.type, 'attio/people');
    // The contact's entity key is in keys[]; the thread's association is not.
    assert.ok((dana!.keys ?? []).includes('email:dana@acme.com'));
    assert.ok(!(t4!.keys ?? []).includes('email:dana@acme.com'));
  });

  // ─── three-state identity_keys contract (NULL keeps / [] clears) ─────────
  //
  // Sync always writes with `replace: true`, so the writer's only way to say
  // "keep what's stored" is to send SQL NULL (`undefined`). Getting this wrong
  // is not cosmetic: the phase-1 (list-shape) write runs unconditionally on
  // every page of every run, so a writer that reported `[]` there wiped the
  // column on run 2 and enrich could never restore it (it only revisits
  // `_enriched_at IS NULL` rows).
  it('a profile with NO identityKeys never clears keys someone else wrote', async () => {
    const backend = await getBackend();
    // Stand in for `mem migrate --identity` / a hand-written `mem add`.
    await backend.upsertByKeys({
      type: 'attio/people',
      data: { name: 'Preserve Me' },
      keys: ['attio/people:p77'],
      identity_keys: ['email:preserve@acme.com'],
      sources: { 'attio/people:p77': { last_synced_at: new Date().toISOString() } },
    });

    // `profile` declares only the singular identityKey — no opinion on
    // associations, so it must send NULL rather than [].
    await writePageToMemory(profile, [{ id: 'p77', name: 'Preserve Me', email: 'preserve@acme.com' }]);

    const after = await backend.findBySource('attio/people:p77');
    assert.deepEqual(after!.identity_keys, ['email:preserve@acme.com'], 'must survive an unrelated sync');
  });

  it('an authoritative empty resolution CLEARS identity_keys (removed attendee)', async () => {
    await writePageToMemory(threadProfile, [
      { id: 'T5', subject: 'had two', participants: [{ email: 'x@acme.com' }, { email: 'y@acme.com' }] },
    ]);
    const backend = await getBackend();
    assert.equal((await backend.findBySource('gmailtest/threads:T5'))!.identity_keys?.length, 2);

    // y leaves the thread → the column must shrink, not union.
    await writePageToMemory(threadProfile, [
      { id: 'T5', subject: 'had two', participants: [{ email: 'x@acme.com' }] },
    ]);
    assert.deepEqual((await backend.findBySource('gmailtest/threads:T5'))!.identity_keys, ['email:x@acme.com']);

    // Everyone leaves → [] is authoritative "zero participants", so clear.
    await writePageToMemory(threadProfile, [{ id: 'T5', subject: 'had two', participants: [] }]);
    const cleared = (await backend.findBySource('gmailtest/threads:T5'))!.identity_keys ?? [];
    assert.deepEqual(cleared, [], 'an authoritative empty resolution clears the column');
  });

  it('an enrich profile stays silent on the pre-enrich (list) shape', async () => {
    // gmail/gmailThreads resolves its participants out of
    // `messages[].payload.headers[...]`, which only the enrich phase fetches —
    // `threads.list` returns `{id, snippet, historyId}`. Phase 1 must NOT
    // report `[]` for that shape or every run after the first wipes the column.
    const enrichProfile: SyncProfile = {
      ...threadProfile,
      model: 'enrichedThreads',
      enrich: { actionId: 'conn_mod_def::detail' },
    };
    const backend = await getBackend();

    // Phase 2 shape: carries the enrich timestamp → authoritative.
    await writePageToMemory(enrichProfile, [
      { id: 'E1', subject: 'enriched', participants: [{ email: 'e1@acme.com' }], _enriched_at: '2026-07-01' },
    ]);
    assert.deepEqual(
      (await backend.findBySource('gmailtest/enrichedThreads:E1'))!.identity_keys,
      ['email:e1@acme.com'],
    );

    // Run 2, phase 1: the list shape has no participants and no timestamp.
    // Pre-fix this wrote `[]` and destroyed the enriched associations.
    await writePageToMemory(enrichProfile, [{ id: 'E1', subject: 'enriched' }]);
    assert.deepEqual(
      (await backend.findBySource('gmailtest/enrichedThreads:E1'))!.identity_keys,
      ['email:e1@acme.com'],
      'the list-shape write must not clobber what enrichment resolved',
    );

    // A profile can rename the timestamp field; the writer must read the
    // profile's own override rather than hardcoding `_enriched_at`.
    const renamed: SyncProfile = {
      ...enrichProfile,
      model: 'renamedTs',
      enrich: { actionId: 'conn_mod_def::detail', timestampField: '_detail_at' },
    };
    await writePageToMemory(renamed, [
      { id: 'R1', participants: [{ email: 'r1@acme.com' }], _detail_at: '2026-07-01' },
    ]);
    assert.deepEqual(
      (await backend.findBySource('gmailtest/renamedTs:R1'))!.identity_keys,
      ['email:r1@acme.com'],
    );
    await writePageToMemory(renamed, [{ id: 'R1' }]);
    assert.deepEqual(
      (await backend.findBySource('gmailtest/renamedTs:R1'))!.identity_keys,
      ['email:r1@acme.com'],
      'the override field must gate the same way `_enriched_at` does',
    );
  });
});

describe('extractSearchableFromPaths — wildcard + numeric + plain paths', () => {
  it('resolves messages[].snippet across an array of objects', () => {
    const record = {
      id: 'thread-1',
      messages: [
        { snippet: 'Hello Moe', from: 'alice@x.com' },
        { snippet: 'Follow up later', from: 'bob@y.com' },
      ],
    };
    const result = extractSearchableFromPaths(record, ['messages[].snippet']);
    assert.ok(result.text.includes('Hello Moe'));
    assert.ok(result.text.includes('Follow up later'));
    assert.equal(result.paths[0].found, true);
  });

  it('resolves multiple wildcard paths and mixes with plain + numeric paths', () => {
    const record = {
      id: 'thread-1',
      subject: 'Project kickoff',
      messages: [
        { snippet: 'Hello', from: 'alice@x.com' },
        { snippet: 'Again', from: 'bob@y.com' },
      ],
      meta: { tags: ['urgent', 'sales'] },
      values: { name: [{ full_name: 'Alice' }] },
    };
    const result = extractSearchableFromPaths(record, [
      'id',
      'subject',
      'messages[].snippet',
      'messages[].from',
      'meta.tags',
      'values.name[0].full_name',
    ]);
    for (const expect of ['thread-1', 'Project kickoff', 'Hello', 'Again', 'alice@x.com', 'bob@y.com', 'urgent', 'sales', 'Alice']) {
      assert.ok(result.text.includes(expect), `missing "${expect}" in: ${result.text}`);
    }
    assert.ok(result.paths.every(p => p.found), `some paths empty: ${JSON.stringify(result.paths)}`);
  });

  it('handles nested wildcards (a[].b[].c) without crashing and flattens leaves', () => {
    const record = {
      threads: [
        { parts: [{ data: 'one' }, { data: 'two' }] },
        { parts: [{ data: 'three' }] },
      ],
    };
    const result = extractSearchableFromPaths(record, ['threads[].parts[].data']);
    assert.ok(result.text.includes('one'));
    assert.ok(result.text.includes('two'));
    assert.ok(result.text.includes('three'));
  });

  it('marks paths with no resolved values as found:false', () => {
    const record = { id: 't1', messages: [] };
    const result = extractSearchableFromPaths(record, ['messages[].snippet', 'missing_field']);
    assert.equal(result.paths[0].found, false);
    assert.equal(result.paths[1].found, false);
    assert.equal(result.text, '');
  });
});
