import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findPlatform, findSimilarPlatforms } from './platforms.js';
import type { Platform } from './types.js';

function plat(slug: string, name = slug): Platform {
  return {
    id: 1,
    name,
    key: slug,
    platform: slug,
    category: 'Other',
  };
}

describe('findPlatform', () => {
  const catalog = [plat('gmail', 'Gmail'), plat('google-calendar', 'Google Calendar')];

  it('matches slug case-insensitively', () => {
    assert.equal(findPlatform(catalog, 'Gmail')?.platform, 'gmail');
    assert.equal(findPlatform(catalog, 'gmail')?.platform, 'gmail');
  });

  it('matches display name', () => {
    assert.equal(findPlatform(catalog, 'Google Calendar')?.platform, 'google-calendar');
  });

  it('returns null for a misspelling', () => {
    assert.equal(findPlatform(catalog, 'bogus-platform-xyz'), null);
  });
});

describe('findSimilarPlatforms', () => {
  const catalog = [plat('gmail', 'Gmail'), plat('google-calendar', 'Google Calendar'), plat('slack', 'Slack')];

  it('ranks a close slug above unrelated ones', () => {
    const similar = findSimilarPlatforms(catalog, 'gmai');
    assert.ok(similar.length > 0);
    assert.equal(similar[0].platform, 'gmail');
  });
});
