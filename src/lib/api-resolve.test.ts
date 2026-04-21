import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OneApi } from './api.js';
import type { Connection } from './types.js';

const conn = (key: string, platform: string, tags?: string[]): Connection => ({
  id: key,
  key,
  platform,
  state: 'operational',
  tags,
});

describe('OneApi.resolveConnection', () => {
  const api = new OneApi('test-key', 'http://unused');

  it('resolves a single match by platform alone', async () => {
    const cache = [conn('k1', 'gmail', ['work@example.com'])];
    const result = await api.resolveConnection({ platform: 'gmail' }, cache);
    assert.equal(result.key, 'k1');
  });

  it('resolves the right one when tag is supplied', async () => {
    const cache = [
      conn('k1', 'gmail', ['work@example.com']),
      conn('k2', 'gmail', ['personal@example.com']),
    ];
    const result = await api.resolveConnection(
      { platform: 'gmail', tag: 'personal@example.com' },
      cache,
    );
    assert.equal(result.key, 'k2');
  });

  it('errors when no connection exists for the platform', async () => {
    const cache = [conn('k1', 'gmail')];
    await assert.rejects(
      api.resolveConnection({ platform: 'slack' }, cache),
      /No connection found for platform "slack"/,
    );
  });

  it('errors when multiple connections match without a tag', async () => {
    const cache = [
      conn('k1', 'gmail', ['work@example.com']),
      conn('k2', 'gmail', ['personal@example.com']),
    ];
    await assert.rejects(
      api.resolveConnection({ platform: 'gmail' }, cache),
      /Multiple "gmail" connections found .*Add a "tag" field/,
    );
  });

  it('errors when the tag does not match any connection, listing available tags', async () => {
    const cache = [
      conn('k1', 'gmail', ['work@example.com']),
      conn('k2', 'gmail', ['personal@example.com']),
    ];
    await assert.rejects(
      api.resolveConnection({ platform: 'gmail', tag: 'missing@example.com' }, cache),
      /No "gmail" connection has tag "missing@example\.com".*work@example\.com.*personal@example\.com/,
    );
  });

  it('matches platform case-insensitively', async () => {
    const cache = [conn('k1', 'Gmail')];
    const result = await api.resolveConnection({ platform: 'gmail' }, cache);
    assert.equal(result.key, 'k1');
  });
});
