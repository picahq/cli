import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveActionDetails, isActionDetailsEntry } from './action-details.js';
import { knowledgeCachePath } from './cache.js';
import type { ActionDetails, CacheEntry, ApiResponseWithMeta } from './types.js';

// HOME is sandboxed to a temp dir so cache reads/writes never touch the real
// ~/.one/cache — same pattern as config.test.ts (cache paths resolve lazily).

const ACTION_ID = 'conn_mod_def::TEST::action-details';

const FULL_DETAILS: ActionDetails = {
  _id: ACTION_ID,
  title: 'Test Action',
  path: '/v1/things/{{thingId}}',
  method: 'GET',
  knowledge: '# Test Action docs',
  ioSchema: {
    inputSchema: {
      properties: {
        path: { required: ['thingId'], properties: { thingId: { description: 'The thing' } } },
      },
    },
  },
};

function makeEntry(data: unknown, opts: { ageSeconds?: number; ttl?: number; etag?: string | null } = {}): CacheEntry<unknown> {
  const age = opts.ageSeconds ?? 0;
  return {
    key: ACTION_ID,
    etag: opts.etag === undefined ? 'etag-1' : opts.etag,
    cachedAt: new Date(Date.now() - age * 1000).toISOString(),
    ttl: opts.ttl ?? 3600,
    data,
  };
}

function writeEntry(entry: CacheEntry<unknown>): string {
  const p = knowledgeCachePath(ACTION_ID);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(entry));
  return p;
}

function readEntry(): CacheEntry<unknown> {
  return JSON.parse(fs.readFileSync(knowledgeCachePath(ACTION_ID), 'utf-8'));
}

interface StubCall { actionId: string; ifNoneMatch?: string }

function stubApi(responder: (call: StubCall) => ApiResponseWithMeta<ActionDetails>) {
  const calls: StubCall[] = [];
  return {
    calls,
    getActionDetailsWithMeta: async (actionId: string, ifNoneMatch?: string) => {
      const call = { actionId, ifNoneMatch };
      calls.push(call);
      return responder(call);
    },
  };
}

describe('resolveActionDetails', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-action-details-test-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('serves a fresh full-shape entry from disk without any API call', async () => {
    writeEntry(makeEntry(FULL_DETAILS));
    const api = stubApi(() => { throw new Error('should not be called'); });

    const result = await resolveActionDetails(api, ACTION_ID);

    assert.equal(api.calls.length, 0);
    assert.equal(result.cacheHit, true);
    assert.deepEqual(result.details, FULL_DETAILS);
  });

  it('treats a pre-v1.45 {knowledge, method} entry as a miss and rewrites it in full shape', async () => {
    writeEntry(makeEntry({ knowledge: 'old docs', method: 'GET' }));
    const api = stubApi(() => ({ data: FULL_DETAILS, etag: 'etag-2', status: 200 }));

    const result = await resolveActionDetails(api, ACTION_ID);

    assert.equal(api.calls.length, 1);
    // Old shape has no usable ETag semantics for us — must be a plain fetch
    assert.equal(api.calls[0].ifNoneMatch, undefined);
    assert.equal(result.cacheHit, false);
    assert.deepEqual(result.details, FULL_DETAILS);
    assert.equal(isActionDetailsEntry(readEntry() as CacheEntry<ActionDetails>), true);
  });

  it('revalidates a stale entry with its ETag and refreshes cachedAt on 304', async () => {
    writeEntry(makeEntry(FULL_DETAILS, { ageSeconds: 7200, ttl: 3600 }));
    const api = stubApi(() => ({ data: null as unknown as ActionDetails, etag: 'etag-1', status: 304 }));

    const result = await resolveActionDetails(api, ACTION_ID);

    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].ifNoneMatch, 'etag-1');
    assert.equal(result.cacheHit, true);
    assert.deepEqual(result.details, FULL_DETAILS);
    const ageMs = Date.now() - new Date(readEntry().cachedAt).getTime();
    assert.ok(ageMs < 60_000, 'cachedAt should be refreshed after a 304');
  });

  it('serves a stale entry when the network is unavailable', async () => {
    writeEntry(makeEntry(FULL_DETAILS, { ageSeconds: 7200, ttl: 3600 }));
    const api = stubApi(() => { throw new Error('network down'); });

    const result = await resolveActionDetails(api, ACTION_ID);

    assert.equal(result.cacheHit, true);
    assert.deepEqual(result.details, FULL_DETAILS);
  });

  it('fetches fresh with useCache:false but still writes the cache', async () => {
    writeEntry(makeEntry({ ...FULL_DETAILS, title: 'Stale Title' }));
    const api = stubApi(() => ({ data: FULL_DETAILS, etag: 'etag-3', status: 200 }));

    const result = await resolveActionDetails(api, ACTION_ID, { useCache: false });

    assert.equal(api.calls.length, 1);
    assert.equal(result.cacheHit, false);
    assert.equal(result.details.title, 'Test Action');
    assert.equal((readEntry().data as ActionDetails).title, 'Test Action');
    assert.equal(readEntry().etag, 'etag-3');
  });

  it('propagates the error on a miss when the fetch fails', async () => {
    const api = stubApi(() => { throw new Error('network down'); });
    await assert.rejects(() => resolveActionDetails(api, ACTION_ID), /network down/);
  });
});
