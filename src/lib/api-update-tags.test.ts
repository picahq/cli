import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OneApi } from './api.js';

// #122: `one add --tag` tags a connection after the OAuth flow creates it.
// Lock the request contract against pica-v2/core's
// `PATCH /v1/vault/connections/{id}` (UpdateConnection { tags }).

describe('OneApi.updateConnectionTags (#122)', () => {
  let calls: Array<{ url: string; init: RequestInit }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('issues PATCH /vault/connections/{id} with a tags body', async () => {
    const api = new OneApi('sk_test_key', 'https://api.example.test/v1');
    await api.updateConnectionTags('conn-123', ['personal']);

    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://api.example.test/v1/vault/connections/conn-123');
    assert.equal(init.method, 'PATCH');
    assert.deepEqual(JSON.parse(init.body as string), { tags: ['personal'] });
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['x-one-secret'], 'sk_test_key');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('sends multiple tags verbatim (replaces the set)', async () => {
    const api = new OneApi('sk_test_key', 'https://api.example.test/v1');
    await api.updateConnectionTags('c1', ['work', 'eu']);
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { tags: ['work', 'eu'] });
  });

  it('propagates API errors (e.g. 403/404) to the caller', async () => {
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof globalThis.fetch;
    const api = new OneApi('sk_test_key', 'https://api.example.test/v1');
    await assert.rejects(() => api.updateConnectionTags('c1', ['x']));
  });
});
