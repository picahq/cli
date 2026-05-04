import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateRelevance } from './scoring.js';

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const YEAR_AGO = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

describe('calculateRelevance', () => {
  it('scores higher when weight is higher (all else equal)', () => {
    const low = calculateRelevance({
      weight: 1, accessCount: 0, createdAt: YESTERDAY, lastAccessedAt: YESTERDAY,
    });
    const high = calculateRelevance({
      weight: 10, accessCount: 0, createdAt: YESTERDAY, lastAccessedAt: YESTERDAY,
    });
    assert.ok(high > low, `expected high>${low} but got ${high}`);
  });

  it('scores higher when more recently accessed', () => {
    const stale = calculateRelevance({
      weight: 5, accessCount: 0, createdAt: YEAR_AGO, lastAccessedAt: YEAR_AGO,
    });
    const fresh = calculateRelevance({
      weight: 5, accessCount: 0, createdAt: YEAR_AGO, lastAccessedAt: YESTERDAY,
    });
    assert.ok(fresh > stale, `fresh ${fresh} should exceed stale ${stale}`);
  });

  it('falls back to created_at when lastAccessedAt is absent', () => {
    const r = calculateRelevance({
      weight: 5, accessCount: 0, createdAt: YESTERDAY, lastAccessedAt: null,
    });
    assert.ok(r > 0 && r <= 1);
  });

  it('caps access contribution at maxAccessCount', () => {
    const capped = calculateRelevance({
      weight: 5, accessCount: 1_000_000, createdAt: YESTERDAY, lastAccessedAt: YESTERDAY, maxAccessCount: 100,
    });
    const atCap = calculateRelevance({
      weight: 5, accessCount: 100, createdAt: YESTERDAY, lastAccessedAt: YESTERDAY, maxAccessCount: 100,
    });
    assert.equal(capped, atCap);
  });

  it('returns values within [0, 1]', () => {
    for (const w of [1, 5, 10]) {
      for (const c of [0, 50, 200]) {
        const r = calculateRelevance({ weight: w, accessCount: c, createdAt: YESTERDAY });
        assert.ok(r >= 0 && r <= 1, `out of range: weight=${w}, access=${c}, r=${r}`);
      }
    }
  });
});
