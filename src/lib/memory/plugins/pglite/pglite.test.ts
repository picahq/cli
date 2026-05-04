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
    assert.equal(v, '2.1.0');
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
