/**
 * End-to-end integration test for the PGlite plugin.
 *
 * Spins up a fresh in-memory PGlite, applies the schema, and exercises the
 * core operations: insert, upsert-by-keys (merge semantics), getById,
 * search (FTS-only fallback because we don't pass an embedding), sources
 * map add/find, and graph link/linked.
 *
 * This is also the scaffold for the parity test harness described in
 * docs/plans/unified-memory.md §12 — once a Postgres client is available
 * in CI we can run the same assertions against it.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pglitePlugin } from './index.js';
import type { MemBackend } from '../../backend.js';

describe('PGlite plugin — live integration', () => {
  let backend: MemBackend;

  before(async () => {
    // Use in-memory PGlite so tests don't touch the filesystem.
    const parsed = pglitePlugin.parseConfig({ dbPath: ':memory:' });
    backend = pglitePlugin.create(parsed);
    await backend.init();
    await backend.ensureSchema();
  });

  after(async () => {
    await backend.close();
  });

  it('reports the schema version after ensureSchema', async () => {
    const v = await backend.getSchemaVersion();
    assert.equal(v, '2.2.0');
  });

  it('advertises capabilities the CoreBackend relies on', () => {
    const caps = backend.capabilities();
    assert.equal(caps.vectorSearch, true);
    assert.equal(caps.fullTextSearch, true);
    assert.equal(caps.triggers, true);
    assert.equal(caps.concurrentWriters, false);
  });

  it('inserts a user memory and reads it back', async () => {
    const rec = await backend.insert({
      type: 'note',
      data: { content: 'PGlite is actually delightful' },
      tags: ['test'],
      weight: 7,
    });
    assert.ok(rec.id);
    assert.equal(rec.type, 'note');
    assert.equal(rec.weight, 7);
    assert.deepEqual(rec.tags, ['test']);

    const roundtrip = await backend.getById(rec.id);
    assert.ok(roundtrip);
    assert.equal(roundtrip!.data.content, 'PGlite is actually delightful');
  });

  it('upsertByKeys merges into an existing record when keys overlap', async () => {
    const k = ['email:test@example.com'];

    const first = await backend.upsertByKeys({
      type: 'attio/people',
      data: { name: 'Test Person', company: 'Acme' },
      keys: k,
      sources: {
        'attio/people:abc': { url: 'https://attio/abc', last_synced_at: new Date().toISOString() },
      },
      tags: ['crm'],
    });
    assert.equal(first.action, 'inserted');

    const second = await backend.upsertByKeys({
      type: 'attio/people',
      data: { title: 'CEO' }, // merges into existing data
      keys: k,
      sources: {
        'gmail/threads:xyz': { url: 'https://mail/xyz', last_synced_at: new Date().toISOString() },
      },
      tags: ['email'], // unions with existing tags
    });
    assert.equal(second.action, 'updated');
    assert.equal(second.record.id, first.record.id);

    // Data merged
    assert.equal(second.record.data.name, 'Test Person');
    assert.equal(second.record.data.company, 'Acme');
    assert.equal(second.record.data.title, 'CEO');

    // Tags unioned (order-independent)
    const tags = new Set(second.record.tags ?? []);
    assert.ok(tags.has('crm'));
    assert.ok(tags.has('email'));

    // Sources now carry both entries
    const sources = second.record.sources;
    assert.ok(sources['attio/people:abc']);
    assert.ok(sources['gmail/threads:xyz']);
  });

  it('findBySource resolves a prefixed source key back to its record', async () => {
    const { record } = await backend.upsertByKeys({
      type: 'gmail/threads',
      data: { subject: 'Hello world' },
      keys: ['gmail/threads:unique-abc', 'email:someone@example.com'],
      sources: {
        'gmail/threads:unique-abc': { last_synced_at: new Date().toISOString() },
      },
    });

    const found = await backend.findBySource('gmail/threads:unique-abc');
    assert.ok(found);
    assert.equal(found!.id, record.id);
    assert.equal(found!.data.subject, 'Hello world');
  });

  it('addSource extends the sources map and keys array', async () => {
    const seed = await backend.insert({
      type: 'attio/people',
      data: { name: 'Extra' },
      keys: ['email:extra@example.com'],
    });

    await backend.addSource(seed.id, {
      sourceKey: 'attio/people:extra-123',
      url: 'https://attio/extra-123',
      metadata: { owner: 'moe' },
    });

    const after = (await backend.getById(seed.id)) as { sources: Record<string, unknown>; keys?: string[] };
    assert.ok(after.sources['attio/people:extra-123']);
    assert.ok((after.keys ?? []).includes('attio/people:extra-123'));
  });

  it('links records and traverses in both directions', async () => {
    const a = await backend.insert({
      type: 'note',
      data: { content: 'source record A' },
    });
    const b = await backend.insert({
      type: 'note',
      data: { content: 'target record B' },
    });

    await backend.link(a.id, b.id, 'related_to', { bidirectional: true });

    const outgoing = await backend.linked(a.id, { direction: 'outgoing' });
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0].id, b.id);

    const incomingOnB = await backend.linked(b.id, { direction: 'incoming' });
    assert.equal(incomingOnB.length, 1);
    assert.equal(incomingOnB[0].id, a.id);
  });

  it('full-text search finds records by content words', async () => {
    await backend.insert({
      type: 'note',
      data: { content: 'searchable haystack keyword' },
      searchable_text: 'searchable haystack keyword',
    });

    const results = await backend.search('haystack', {
      limit: 5,
      trackAccess: false,
    });
    assert.ok(results.length > 0);
    assert.ok(results.some(r => (r.data as Record<string, unknown>).content === 'searchable haystack keyword'));
  });

  it('context returns active records ranked by relevance', async () => {
    const results = await backend.context({ limit: 50 });
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.ok(r.relevance_score >= 0 && r.relevance_score <= 1);
    }
  });

  it('archive and unarchive flip status', async () => {
    const rec = await backend.insert({ type: 'note', data: { content: 'soft-deletable' } });
    assert.equal((await backend.getById(rec.id))?.status, 'active');

    const archived = await backend.archive(rec.id, 'user_archived');
    assert.equal(archived, true);
    assert.equal((await backend.getById(rec.id))?.status, 'archived');

    const unarchived = await backend.unarchive(rec.id);
    assert.equal(unarchived, true);
    assert.equal((await backend.getById(rec.id))?.status, 'active');
  });

  it('upsertByKeys resurrects archived rows (self-heal for reconcile damage)', async () => {
    // Simulates the scenario where a buggy --full-refresh reconcile
    // archived a valid row. Next --full-refresh re-pulls the source
    // and upserts — the row must flip back to 'active' so subsequent
    // search / list calls see it again. Without this, rows stay dead.
    const first = await backend.upsertByKeys({
      type: 'gmail/messages',
      data: { snippet: 'Important thread' },
      keys: ['gmail/messages:msg-resurrect'],
      sources: { 'gmail/messages:msg-resurrect': { last_synced_at: new Date().toISOString() } },
    });
    assert.equal(first.action, 'inserted');

    // Archive as if reconcile did it.
    const archived = await backend.archive(first.record.id, 'deleted_upstream');
    assert.equal(archived, true);
    assert.equal((await backend.getById(first.record.id))?.status, 'archived');

    // Re-upsert as if --full-refresh re-pulled the source.
    const second = await backend.upsertByKeys(
      {
        type: 'gmail/messages',
        data: { snippet: 'Important thread (updated)' },
        keys: ['gmail/messages:msg-resurrect'],
        sources: { 'gmail/messages:msg-resurrect': { last_synced_at: new Date().toISOString() } },
      },
      { replace: true },
    );
    assert.equal(second.action, 'updated');
    assert.equal(second.record.id, first.record.id);

    const healed = await backend.getById(first.record.id);
    assert.equal(healed?.status, 'active', 'upsertByKeys must un-archive on match');
    assert.equal(healed?.archived_reason, null, 'archived_reason must clear on resurrection');
  });

  it('updateKeys replaces the keys column and enforces active uniqueness', async () => {
    const a = await backend.insert({ type: 'person', data: { name: 'A' }, keys: ['email:a@x.com'] });
    const b = await backend.insert({ type: 'person', data: { name: 'B' }, keys: ['email:b@x.com'] });

    // Happy path: add a second key to A.
    const ok = await backend.updateKeys(a.id, ['email:a@x.com', 'phone:+1555']);
    assert.equal(ok.status, 'ok');
    assert.deepEqual(
      new Set((ok as { record: { keys: string[] } }).record.keys),
      new Set(['email:a@x.com', 'phone:+1555']),
    );

    // Conflict: try to give A one of B's keys — reports the key + owner.
    const conflict = await backend.updateKeys(a.id, ['email:b@x.com']);
    assert.equal(conflict.status, 'conflict');
    assert.equal((conflict as { key: string }).key, 'email:b@x.com');
    assert.equal((conflict as { recordId: string }).recordId, b.id);

    // not_found for an unknown id.
    const missing = await backend.updateKeys('00000000-0000-0000-0000-000000000000', ['email:z@x.com']);
    assert.equal(missing.status, 'not_found');
  });

  it('key uniqueness is scoped to active — an archived record frees its key', async () => {
    const first = await backend.insert({
      type: 'person', data: { name: 'Squatter' }, keys: ['email:reuse@x.com'],
    });
    // While active, a second active record can't claim the key.
    await assert.rejects(
      backend.insert({ type: 'person', data: { name: 'Dup' }, keys: ['email:reuse@x.com'] }),
      /already exist/i,
    );
    // Archive the first — its key is now reclaimable.
    await backend.archive(first.id, 'superseded');
    const second = await backend.insert({
      type: 'person', data: { name: 'Reclaimer' }, keys: ['email:reuse@x.com'],
    });
    assert.ok(second.id);

    // find-by-source prefers the ACTIVE owner over the archived one.
    const found = await backend.findBySource('email:reuse@x.com');
    assert.equal(found?.id, second.id);
    assert.equal(found?.status, 'active');
  });

  it('listForSearchableBackfill + updateSearchableText fills NULL rows', async () => {
    // Insert with an explicit NULL searchable_text (as an SDK/raw write might).
    const rec = await backend.insert({
      type: 'backfill-me',
      data: { name: 'Grace Hopper', title: 'Rear Admiral' },
      keys: ['email:grace@navy.mil'],
      searchable_text: null,
    });
    const before = await backend.getById(rec.id);
    assert.equal(before?.searchable_text, null);

    const rows = await backend.listForSearchableBackfill({ type: 'backfill-me', onlyNull: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, rec.id);

    await backend.updateSearchableText(rec.id, 'Grace Hopper Rear Admiral');
    const after = await backend.getById(rec.id);
    assert.equal(after?.searchable_text, 'Grace Hopper Rear Admiral');

    // Row is no longer returned by the NULL-only scan.
    const again = await backend.listForSearchableBackfill({ type: 'backfill-me', onlyNull: true });
    assert.equal(again.length, 0);
  });

  it('unarchive surfaces an actionable error when the key was reclaimed', async () => {
    const a = await backend.insert({
      type: 'person', data: { name: 'Original' }, keys: ['email:reclaim@x.com'],
    });
    await backend.archive(a.id, 'superseded');
    const b = await backend.insert({
      type: 'person', data: { name: 'Reclaimer' }, keys: ['email:reclaim@x.com'],
    });

    // Flipping A back to active would collide with B on the shared key —
    // must throw a message naming B, not a raw 23505.
    await assert.rejects(
      backend.unarchive(a.id),
      (err: unknown) =>
        err instanceof Error &&
        /reclaimed by active record/.test(err.message) &&
        err.message.includes(b.id),
    );
    // A stays archived; B stays active.
    assert.equal((await backend.getById(a.id))?.status, 'archived');
    assert.equal((await backend.getById(b.id))?.status, 'active');
  });

  it('update clears the stale embedding when searchable_text changes', async () => {
    const rec = await backend.insert({
      type: 'note', data: { content: 'original' }, searchable_text: 'original',
    });
    const vec = new Array(1536).fill(0.01);
    await backend.updateEmbedding(rec.id, vec, 'openai:test');
    assert.ok((await backend.getById(rec.id))?.embedded_at, 'precondition: embedded');

    // Text changes → embedding is invalidated so the next reindex re-embeds.
    const changed = await backend.update(rec.id, { data: { content: 'changed' }, searchable_text: 'changed' });
    assert.equal(changed?.embedded_at, null, 'embedding must clear when text changes');
    assert.equal(changed?.embedding_model, null);

    // Metadata-only edit (no text change) → embedding preserved.
    await backend.updateEmbedding(rec.id, vec, 'openai:test');
    const weighted = await backend.update(rec.id, { weight: 8 });
    assert.ok(weighted?.embedded_at, 'embedding preserved when text unchanged');
  });

  it('sync state round-trips', async () => {
    await backend.setSyncState({
      platform: 'attio',
      model: 'people',
      last_sync_at: new Date().toISOString(),
      last_cursor: { page: 3 },
      total_records: 42,
      pages_processed: 1,
      status: 'idle',
    });
    const state = await backend.getSyncState('attio', 'people');
    assert.ok(state);
    assert.equal(state!.total_records, 42);
    assert.equal(state!.status, 'idle');

    const all = await backend.listSyncStates();
    assert.ok(all.some(s => s.platform === 'attio' && s.model === 'people'));
  });

  it('stats reports accurate counts', async () => {
    const s = await backend.stats();
    assert.ok(s.recordCount > 0);
    assert.ok(s.activeCount >= 0);
    assert.equal(s.recordCount, s.activeCount + s.archivedCount);
  });
});
