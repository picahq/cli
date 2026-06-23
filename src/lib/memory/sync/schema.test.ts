import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferSyncSchema } from './schema.js';

// #106: infer field paths → types + example + presence from a sample of
// synced record `data` objects.

const byPath = (fields: ReturnType<typeof inferSyncSchema>) =>
  Object.fromEntries(fields.map(f => [f.path, f]));

describe('inferSyncSchema (#106)', () => {
  it('infers flat primitive fields with types and examples', () => {
    const f = byPath(inferSyncSchema([{ id: 'thread_abc', count: 5, open: true }]));
    assert.deepEqual(f.id.types, ['string']);
    assert.equal(f.id.example, 'thread_abc');
    assert.deepEqual(f.count.types, ['number']);
    assert.equal(f.count.example, 5);
    assert.deepEqual(f.open.types, ['boolean']);
    assert.equal(f.open.example, true);
  });

  it('walks nested objects with dotted paths', () => {
    const f = byPath(inferSyncSchema([{ meta: { score: 9, label: 'hot' } }]));
    assert.deepEqual(f.meta.types, ['object']);
    assert.equal(f.meta.example, undefined);          // containers have no example
    assert.deepEqual(f['meta.score'].types, ['number']);
    assert.equal(f['meta.score'].example, 9);
    assert.deepEqual(f['meta.label'].types, ['string']);
  });

  it('describes arrays of objects via [] element paths', () => {
    const f = byPath(inferSyncSchema([{ messages: [{ sender: 'a@b.com', subject: 'Hi' }] }]));
    assert.deepEqual(f.messages.types, ['array[object]']);
    assert.deepEqual(f['messages[].sender'].types, ['string']);
    assert.equal(f['messages[].sender'].example, 'a@b.com');
    assert.deepEqual(f['messages[].subject'].types, ['string']);
  });

  it('labels arrays of primitives by element type', () => {
    const f = byPath(inferSyncSchema([{ tags: ['urgent', 'billing'] }, { tags: [] }]));
    // first record: array[string]; second: empty → array[unknown]
    assert.deepEqual(f.tags.types, ['array[string]', 'array[unknown]']);
    assert.equal(f.tags.presence, 2);
  });

  it('aggregates mixed types and tracks presence across records', () => {
    const f = byPath(inferSyncSchema([
      { v: 1, only_in_first: 'x' },
      { v: 'two' },
      { v: 3 },
    ]));
    assert.deepEqual(f.v.types, ['number', 'string']); // sorted
    assert.equal(f.v.presence, 3);
    assert.equal(f.only_in_first.presence, 1);          // sparse field
  });

  it('handles null leaves and truncates long example strings', () => {
    const long = 'x'.repeat(100);
    const f = byPath(inferSyncSchema([{ empty: null, big: long }]));
    assert.deepEqual(f.empty.types, ['null']);
    assert.equal(f.empty.example, undefined);           // null is not captured as an example
    assert.equal((f.big.example as string).length, 58); // 57 + ellipsis
    assert.ok((f.big.example as string).endsWith('…'));
  });

  it('returns a path-sorted list and ignores non-object records', () => {
    const fields = inferSyncSchema([{ b: 1, a: 2 }, null as any, 'nope' as any]);
    assert.deepEqual(fields.map(f => f.path), ['a', 'b']);
  });
});
