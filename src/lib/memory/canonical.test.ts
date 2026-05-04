import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash } from './canonical.js';

describe('canonicalize', () => {
  it('sorts object keys recursively for stable output', () => {
    const a = canonicalize({ b: 2, a: { y: 1, x: 2 } });
    const b = canonicalize({ a: { x: 2, y: 1 }, b: 2 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"x":2,"y":1},"b":2}');
  });

  it('preserves array order (arrays are semantic in JSON)', () => {
    assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
  });

  it('passes primitives through unchanged', () => {
    assert.equal(canonicalize('foo'), '"foo"');
    assert.equal(canonicalize(42), '42');
    assert.equal(canonicalize(null), 'null');
  });

  it('handles nested arrays of objects', () => {
    const v = [{ b: 1, a: 2 }, { d: 3, c: 4 }];
    assert.equal(canonicalize(v), '[{"a":2,"b":1},{"c":4,"d":3}]');
  });
});

describe('contentHash', () => {
  it('is stable across key-order permutations', () => {
    const h1 = contentHash({ b: 'y', a: 'x' });
    const h2 = contentHash({ a: 'x', b: 'y' });
    assert.equal(h1, h2);
  });

  it('differs when content differs', () => {
    const h1 = contentHash({ a: 1 });
    const h2 = contentHash({ a: 2 });
    assert.notEqual(h1, h2);
  });

  it('produces sha256-length hex output', () => {
    const h = contentHash({ any: 'value' });
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});
