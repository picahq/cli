import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecords, isRootPath } from './extract.js';

test('isRootPath recognises all root sentinel values', () => {
  assert.equal(isRootPath(''), true);
  assert.equal(isRootPath('$'), true);
  assert.equal(isRootPath('.'), true);
  assert.equal(isRootPath(undefined), true);
  assert.equal(isRootPath(null), true);
  assert.equal(isRootPath('items'), false);
  assert.equal(isRootPath('data.records'), false);
});

test('extractRecords: dotted path on an object response (unchanged behaviour)', () => {
  const resp = { items: [{ id: 'a' }, { id: 'b' }] };
  const out = extractRecords(resp, 'items', 'id', 'attio/attioCompanies');
  assert.deepEqual(out.records, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(out.wrappedPrimitives, false);
});

test('extractRecords: root array of objects when resultsPath is empty', () => {
  const resp = [{ id: 1 }, { id: 2 }];
  const out = extractRecords(resp, '', 'id', 'foo/bar');
  assert.deepEqual(out.records, [{ id: 1 }, { id: 2 }]);
  assert.equal(out.wrappedPrimitives, false);
});

test('extractRecords: root array of objects when resultsPath is "$"', () => {
  const resp = [{ id: 1 }, { id: 2 }];
  const out = extractRecords(resp, '$', 'id', 'foo/bar');
  assert.deepEqual(out.records, [{ id: 1 }, { id: 2 }]);
});

test('extractRecords: root array of objects when resultsPath is "."', () => {
  const resp = [{ id: 1 }, { id: 2 }];
  const out = extractRecords(resp, '.', 'id', 'foo/bar');
  assert.deepEqual(out.records, [{ id: 1 }, { id: 2 }]);
});

test('extractRecords: primitive integers at the root are wrapped as { id: "<string>" }', () => {
  const resp = [9129911, 9129199, 9127761];
  const out = extractRecords(resp, '', 'id', 'hacker-news/topStories');
  assert.deepEqual(out.records, [
    { id: '9129911' },
    { id: '9129199' },
    { id: '9127761' },
  ]);
  assert.equal(out.wrappedPrimitives, true);
});

test('extractRecords: primitive strings at the root are wrapped and stringified', () => {
  const resp = ['alpha', 'beta'];
  const out = extractRecords(resp, '', 'slug', 'custom/tags');
  assert.deepEqual(out.records, [{ slug: 'alpha' }, { slug: 'beta' }]);
  assert.equal(out.wrappedPrimitives, true);
});

test('extractRecords: primitive booleans at the root are wrapped', () => {
  const resp = [true, false, true];
  const out = extractRecords(resp, '', 'v', 'flags/toggle');
  assert.deepEqual(out.records, [{ v: 'true' }, { v: 'false' }, { v: 'true' }]);
  assert.equal(out.wrappedPrimitives, true);
});

test('extractRecords: empty array returns empty records and wrappedPrimitives=false', () => {
  const out = extractRecords([], '', 'id', 'foo/bar');
  assert.deepEqual(out.records, []);
  assert.equal(out.wrappedPrimitives, false);
});

test('extractRecords: path-resolved primitive array is also wrapped', () => {
  // Some APIs return `{ ids: [1, 2, 3] }` — resultsPath = "ids" should
  // still benefit from primitive wrapping.
  const resp = { ids: [1, 2, 3] };
  const out = extractRecords(resp, 'ids', 'id', 'foo/bar');
  assert.deepEqual(out.records, [{ id: '1' }, { id: '2' }, { id: '3' }]);
  assert.equal(out.wrappedPrimitives, true);
});

test('extractRecords: non-array response throws with profile label and top-level type', () => {
  const resp = { message: 'nope', errors: [{ code: 42 }] };
  assert.throws(
    () => extractRecords(resp, 'items', 'id', 'foo/bar'),
    (err: Error) => {
      assert.match(err.message, /foo\/bar/);
      assert.match(err.message, /'items'/);
      assert.match(err.message, /object/);
      assert.match(err.message, /Top-level keys: \[message, errors\]/);
      return true;
    },
  );
});

test('extractRecords: root path on non-array response names <root>', () => {
  const resp = { oops: 'not an array' };
  assert.throws(
    () => extractRecords(resp, '', 'id', 'foo/bar'),
    (err: Error) => {
      assert.match(err.message, /<root>/);
      assert.match(err.message, /foo\/bar/);
      return true;
    },
  );
});

test('extractRecords: primitive nulls inside an otherwise-primitive array are dropped', () => {
  // Real-world fuzzy responses sometimes interleave nulls. Typeof null is
  // 'object', so the first element dictates wrapping. If a primitive leads,
  // nulls are skipped rather than wrapped as { id: "null" }.
  const resp = [1, null, 2, null, 3];
  const out = extractRecords(resp, '', 'id', 'foo/bar');
  assert.deepEqual(out.records, [{ id: '1' }, { id: '2' }, { id: '3' }]);
});
