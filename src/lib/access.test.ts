import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeConnectionAccess, formatAccess, resolveAllowedActions } from './access.js';
import type { ActionDetails, ResolvedAllowedAction } from './types.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv, type HomeEnvSnapshot } from '../test-support/home.js';

const granted: ResolvedAllowedAction[] = [
  { actionId: 'a1', title: 'Send Email', method: 'POST', platform: 'gmail' },
  { actionId: 'a2', title: 'List Messages', method: 'GET', platform: 'gmail' },
  { actionId: 'a3', title: 'Post Message', method: 'POST', platform: 'slack' },
];

describe('computeConnectionAccess', () => {
  it('reports full access for admin with no action allowlist', () => {
    assert.deepEqual(
      computeConnectionAccess('gmail', 'admin', ['*'], []),
      { policy: 'full' }
    );
  });

  it('reports the method set for a non-admin permission level', () => {
    assert.deepEqual(
      computeConnectionAccess('gmail', 'read', ['*'], []),
      { policy: 'methods', methods: ['GET'] }
    );
    assert.deepEqual(
      computeConnectionAccess('gmail', 'write', ['*'], []),
      { policy: 'methods', methods: ['GET', 'POST', 'PUT', 'PATCH'] }
    );
  });

  it('lets an action allowlist win over the permission level, scoped to the platform', () => {
    const access = computeConnectionAccess('gmail', 'admin', ['a1', 'a2', 'a3'], granted);
    assert.equal(access.policy, 'actions');
    assert.deepEqual(access.policy === 'actions' ? access.actions : null, [
      { actionId: 'a1', title: 'Send Email', method: 'POST' },
      { actionId: 'a2', title: 'List Messages', method: 'GET' },
    ]);
  });

  it('reports an empty action list for a platform the allowlist does not cover', () => {
    assert.deepEqual(
      computeConnectionAccess('shopify', 'admin', ['a1'], granted),
      { policy: 'actions', actions: [] }
    );
  });
});

describe('formatAccess', () => {
  it('renders each policy for the table', () => {
    assert.equal(formatAccess({ policy: 'full' }), 'full');
    assert.equal(formatAccess({ policy: 'methods', methods: ['GET', 'POST'] }), 'GET, POST');
    assert.equal(formatAccess({ policy: 'actions', actions: [] }), 'none');
  });

  it('truncates long action lists', () => {
    const actions = granted.map(({ actionId, title, method }) => ({ actionId, title, method }));
    assert.equal(
      formatAccess({ policy: 'actions', actions }),
      'Send Email (POST), List Messages (GET) +1 more'
    );
  });
});

// resolveAllowedActions goes through the on-disk knowledge cache, so sandbox
// $HOME to a temp dir instead of touching the developer's real ~/.one/.
describe('resolveAllowedActions', () => {
  let tmpDir: string;
  let originalHome: HomeEnvSnapshot;

  beforeEach(() => {
    originalHome = snapshotHomeEnv();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-access-test-'));
    setHomeTo(tmpDir);
  });

  afterEach(() => {
    restoreHomeEnv(originalHome);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function stubApi(byId: Record<string, Partial<ActionDetails> | Error>) {
    const calls: string[] = [];
    const api = {
      async getActionDetailsWithMeta(actionId: string) {
        calls.push(actionId);
        const entry = byId[actionId];
        if (!entry || entry instanceof Error) {
          throw entry ?? new Error(`Action with ID ${actionId} not found`);
        }
        return { data: entry as ActionDetails, etag: null, status: 200 };
      },
    };
    return { api, calls };
  }

  it('makes no API calls for an unrestricted allowlist', async () => {
    const { api, calls } = stubApi({});
    assert.deepEqual(await resolveAllowedActions(api, ['*']), []);
    assert.deepEqual(calls, []);
  });

  it('resolves ids to title, method, and owning platform', async () => {
    const { api } = stubApi({
      a1: { _id: 'a1', title: 'Send Email', method: 'POST', path: '/send', connectionPlatform: 'gmail' },
      a3: { _id: 'a3', title: 'Post Message', method: 'POST', path: '/post', connectionPlatform: 'slack' },
    });

    assert.deepEqual(await resolveAllowedActions(api, ['a1', 'a3']), [
      { actionId: 'a1', title: 'Send Email', method: 'POST', platform: 'gmail' },
      { actionId: 'a3', title: 'Post Message', method: 'POST', platform: 'slack' },
    ]);
  });

  it('skips ids that fail to resolve or carry no platform, keeping the rest', async () => {
    const { api } = stubApi({
      a1: { _id: 'a1', title: 'Send Email', method: 'POST', path: '/send', connectionPlatform: 'gmail' },
      a2: { _id: 'a2', title: 'Orphan', method: 'GET', path: '/x' }, // no connectionPlatform
      a3: new Error('404'),
    });

    const resolved = await resolveAllowedActions(api, ['a1', 'a2', 'a3']);
    assert.deepEqual(resolved.map(a => a.actionId), ['a1']);
  });

  it('serves repeat lookups from the knowledge cache', async () => {
    const { api, calls } = stubApi({
      a1: { _id: 'a1', title: 'Send Email', method: 'POST', path: '/send', connectionPlatform: 'gmail' },
    });

    await resolveAllowedActions(api, ['a1']);
    await resolveAllowedActions(api, ['a1']);
    assert.deepEqual(calls, ['a1'], 'second resolution should hit the cache, not the API');
  });
});
