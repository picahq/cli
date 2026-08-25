import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';

import {
  recordCommand,
  flushUsageRollups,
  capture,
  drainQueue,
  flush,
  uuidFromInsertId,
  SEND_MAX_ATTEMPTS,
  QUEUE_MAX_AGE_MS,
} from './analytics.js';
import {
  appendUsageLog,
  readUsageLog,
  readAnalyticsQueue,
  writeAnalyticsQueue,
  claimUsageLog,
} from './config.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv } from '../test-support/home.js';

// These tests exercise the REAL rollup code against REAL files: HOME is
// sandboxed to a temp dir so all reads/writes land under <tmp>/.one (config.ts
// resolves home-rooted paths lazily, so flipping HOME is enough). Emitted
// rollups are read back from the actual on-disk analytics send-queue.

interface RollupEvent {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: {
    command_count: number;
    by_command: Record<string, number>;
    agent_count: number;
    human_count: number;
    window_start: string;
    window_end: string;
    $insert_id: string;
    authenticated: boolean;
  };
}

const WINDOW_MS = 5 * 60 * 1000;

/** Parse the analytics send-queue and return only the rollup events. */
function emittedRollups(): RollupEvent[] {
  return readAnalyticsQueue()
    .map((l) => JSON.parse(l) as RollupEvent)
    .filter((e) => e.event === 'CLI Usage Rollup');
}

/** One usage-log line with controllable timestamp / command / agent / identity. */
function logEntry(opts: { did: string; ts?: number; command?: string; agent?: boolean }): string {
  return JSON.stringify({
    ts: opts.ts ?? Date.now(),
    command: opts.command ?? 'actions execute',
    agent: opts.agent ?? false,
    did: opts.did,
  });
}

/** A minimal commander-like Command whose path() resolves to `pathStr`. */
function fakeCommand(pathStr: string): Command {
  let node = { name: () => 'one', parent: null } as unknown as Command;
  for (const part of pathStr.split(' ')) {
    node = { name: () => part, parent: node } as unknown as Command;
  }
  return node;
}

describe('CLI usage rollups', () => {
  let tmpDir: string;
  let originalCwd: string;
  const orig: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['HOME', 'CI', 'ONE_NO_TELEMETRY', 'ONE_DISABLE_TELEMETRY', 'DO_NOT_TRACK', 'ONE_SECRET']) {
      orig[k] = process.env[k];
    }
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-rollup-test-'));
    const home = path.join(tmpDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    setHomeTo(home);
    process.chdir(home); // isolate from any .onerc in the dev's cwd
    // Telemetry must be ENABLED to test the emit path.
    delete process.env.CI;
    delete process.env.ONE_NO_TELEMETRY;
    delete process.env.ONE_DISABLE_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    // Authenticated by default so the command-recording tests exercise the normal path.
    process.env.ONE_SECRET = 'sk_live_test_key';
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('never misses a user and keeps exact per-user counts', () => {
    const old = Date.now() - WINDOW_MS - 1000; // aged out → all batches are due
    const expected = new Map<string, number>();
    for (let u = 0; u < 50; u++) {
      const did = `user-${u}`;
      const n = (u % 13) + 1; // 1..13 commands each (covers light + heavier)
      for (let i = 0; i < n; i++) appendUsageLog(logEntry({ did, ts: old }));
      expected.set(did, n);
    }

    flushUsageRollups();

    const totals = new Map<string, number>();
    for (const r of emittedRollups()) {
      totals.set(r.distinct_id, (totals.get(r.distinct_id) ?? 0) + r.properties.command_count);
    }
    assert.equal(totals.size, expected.size, 'every user present, none extra');
    for (const [did, n] of expected) {
      assert.equal(totals.get(did), n, `user ${did} must have exact count ${n}`);
    }
    assert.equal(readUsageLog().length, 0, 'log fully drained');
  });

  it('aggregates a heavy burst into one exact rollup (no per-command flood)', () => {
    const did = 'whale';
    const N = 1234;
    for (let i = 0; i < N; i++) appendUsageLog(logEntry({ did, agent: true }));

    flushUsageRollups({ force: true });

    const rollups = emittedRollups();
    const total = rollups.reduce((s, r) => s + r.properties.command_count, 0);
    assert.equal(total, N, 'exact total preserved');
    assert.ok(rollups.length <= 3, `far fewer events than commands (got ${rollups.length})`);
    const byCmdTotal = rollups.reduce(
      (s, r) => s + Object.values(r.properties.by_command).reduce((a, b) => a + b, 0),
      0,
    );
    assert.equal(byCmdTotal, N, 'by_command sums to the exact total');
  });

  it('flushes once a batch hits the size cap, even without force', () => {
    const did = 'busy';
    for (let i = 0; i < 600; i++) appendUsageLog(logEntry({ did })); // > MAX_BATCH (500), recent ts
    flushUsageRollups();
    const r = emittedRollups();
    assert.equal(r.length, 1);
    assert.equal(r[0].properties.command_count, 600);
    assert.equal(readUsageLog().length, 0);
  });

  it('does NOT flush a fresh, small, current-user batch (real batching)', () => {
    const did = 'regular';
    for (let i = 0; i < 3; i++) appendUsageLog(logEntry({ did })); // recent
    flushUsageRollups();
    assert.equal(emittedRollups().length, 0, 'nothing emitted yet');
    assert.equal(readUsageLog().length, 3, 'kept for the next window');
  });

  it('flushes a batch once it ages past the window', () => {
    const did = 'regular';
    const old = Date.now() - WINDOW_MS - 1000;
    for (let i = 0; i < 3; i++) appendUsageLog(logEntry({ did, ts: old }));
    flushUsageRollups();
    const r = emittedRollups();
    assert.equal(r.length, 1);
    assert.equal(r[0].properties.command_count, 3);
    assert.equal(readUsageLog().length, 0);
  });

  it('records exact per-command and agent/human breakdown', () => {
    const did = 'mixed';
    const old = Date.now() - WINDOW_MS - 1000;
    appendUsageLog(logEntry({ did, ts: old, command: 'actions execute', agent: true }));
    appendUsageLog(logEntry({ did, ts: old, command: 'actions execute', agent: true }));
    appendUsageLog(logEntry({ did, ts: old, command: 'auth login', agent: false }));
    flushUsageRollups();
    const [r] = emittedRollups();
    assert.equal(r.properties.command_count, 3);
    assert.deepEqual(r.properties.by_command, { 'actions execute': 2, 'auth login': 1 });
    assert.equal(r.properties.agent_count, 2);
    assert.equal(r.properties.human_count, 1);
  });

  it('splits rollups by identity when a login happens mid-batch', () => {
    appendUsageLog(logEntry({ did: 'device-abc', command: 'auth login' }));
    appendUsageLog(logEntry({ did: 'user-123' }));
    appendUsageLog(logEntry({ did: 'user-123' }));
    // current identity = user-123 (last entry). The superseded device batch flushes
    // immediately; the current small/fresh batch is kept.
    flushUsageRollups();
    const r = emittedRollups();
    assert.equal(r.length, 1);
    assert.equal(r[0].distinct_id, 'device-abc');
    assert.equal(r[0].properties.command_count, 1);
    assert.equal(readUsageLog().length, 2, 'current identity batch kept');
  });

  it('recordCommand captures the very first command immediately (light user never missed)', () => {
    recordCommand(fakeCommand('actions execute'));
    const r = emittedRollups();
    assert.equal(r.length, 1, 'first command flushes immediately');
    assert.equal(r[0].properties.command_count, 1);
    assert.equal(r[0].properties.by_command['actions execute'], 1);
  });

  it('recordCommand batches later same-day commands instead of one-per-command', () => {
    recordCommand(fakeCommand('actions execute')); // first-touch → 1 event
    recordCommand(fakeCommand('actions execute')); // batched
    recordCommand(fakeCommand('auth login')); // batched
    assert.equal(emittedRollups().length, 1, 'only the first-touch event so far');
    assert.equal(readUsageLog().length, 2, 'commands 2–3 wait in the log');
  });

  it('emits nothing and drops the backlog when telemetry is disabled', () => {
    appendUsageLog(logEntry({ did: 'x' }));
    process.env.ONE_NO_TELEMETRY = '1';
    flushUsageRollups({ force: true });
    assert.equal(emittedRollups().length, 0);
    assert.equal(readUsageLog().length, 0, 'backlog dropped on opt-out');
  });

  // ── Fix 1: don't record unauthenticated auth-required commands ──────────────
  it('does NOT record an auth-required command when unauthenticated (no anon pollution)', () => {
    delete process.env.ONE_SECRET; // a CLI with no login and no API key
    recordCommand(fakeCommand('actions execute'));
    assert.equal(emittedRollups().length, 0, 'no rollup for unauthenticated actions execute');
    assert.equal(readUsageLog().length, 0, 'not even written to the local log');
  });

  it('still records pre-auth funnel commands when unauthenticated', () => {
    delete process.env.ONE_SECRET;
    recordCommand(fakeCommand('login')); // allowlisted pre-auth command
    const r = emittedRollups();
    assert.equal(r.length, 1, 'login is recorded even without auth');
    assert.equal(r[0].properties.authenticated, false, 'flagged as unauthenticated');
  });

  it('tags rollups with the authenticated flag', () => {
    recordCommand(fakeCommand('actions execute')); // ONE_SECRET set in beforeEach
    const r = emittedRollups();
    assert.equal(r.length, 1);
    assert.equal(r[0].properties.authenticated, true);
  });

  // ── Fix 2: deterministic insert_id so duplicate batches dedupe in PostHog ────
  it('gives identical batches the same $insert_id so PostHog dedupes duplicates', () => {
    const old = Date.now() - WINDOW_MS - 1000;
    const mk = () => logEntry({ did: 'whale', ts: old, command: 'actions execute', agent: true });
    for (let i = 0; i < 5; i++) appendUsageLog(mk());
    flushUsageRollups();
    for (let i = 0; i < 5; i++) appendUsageLog(mk()); // a byte-identical batch
    flushUsageRollups();
    const r = emittedRollups();
    assert.equal(r.length, 2, 'two identical batches were emitted');
    assert.ok(r[0].properties.$insert_id, 'rollup carries an insert id');
    assert.equal(r[0].properties.$insert_id, r[1].properties.$insert_id, 'identical content → same id (deduped on ingest)');
  });

  it('gives genuinely different batches different $insert_ids', () => {
    const old = Date.now() - WINDOW_MS - 1000;
    appendUsageLog(logEntry({ did: 'a', ts: old }));
    flushUsageRollups();
    appendUsageLog(logEntry({ did: 'b', ts: old }));
    flushUsageRollups();
    const r = emittedRollups();
    assert.equal(r.length, 2);
    assert.notEqual(r[0].properties.$insert_id, r[1].properties.$insert_id);
  });

  // ── Fix 3: atomic claim so concurrent processes can't double-emit a batch ───
  it('claimUsageLog hands a batch to exactly one caller (concurrency-safe flush)', () => {
    for (let i = 0; i < 3; i++) appendUsageLog(logEntry({ did: 'x' }));
    const first = claimUsageLog();
    const second = claimUsageLog();
    assert.equal(first?.length, 3, 'first claimant gets the whole batch');
    assert.equal(second, null, 'a concurrent second claimant gets nothing → cannot double-emit');
  });

  // ── Fix 4: rollups are billed at the anonymous rate ─────────────────────────
  it('rollups opt out of person processing and carry no $set', () => {
    const old = Date.now() - WINDOW_MS - 1000;
    appendUsageLog(logEntry({ did: 'whale', ts: old }));
    flushUsageRollups();
    const [r] = emittedRollups();
    const props = r.properties as Record<string, unknown>;
    assert.equal(props.$process_person_profile, false, 'rollup is an anonymous-rate event');
    assert.equal(props.$set, undefined, 'no person properties ride on a rollup');
  });
});

// ── Delivery: PostHog dedupes on `uuid`, and retries must be bounded ─────────
//
// Background: a CLI process aborts in-flight sends at exit. The request body
// has usually already left, so PostHog ingests the event, but the CLI never
// learns that and re-sends the whole backlog on the next run — and PostHog
// does NOT dedupe on `$insert_id`, only on `uuid`. One user produced 233 copies
// of each rollup this way.

interface QueuedLine {
  event: string;
  uuid?: string;
  timestamp: string;
  properties: Record<string, unknown> & { $insert_id?: string };
  attempts?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function queuedLines(): QueuedLine[] {
  return readAnalyticsQueue().map((l) => JSON.parse(l) as QueuedLine);
}

/** A fetch stub that records request bodies and resolves per `mode`. */
function stubFetch(mode: 'ok' | 'hang' | 'fail' | 'slow-ok') {
  const bodies: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      const done = () => resolve(new Response('', { status: 200 }));
      if (mode === 'ok') done();
      else if (mode === 'slow-ok') setTimeout(done, 40);
      else if (mode === 'fail') reject(new Error('network down'));
      // 'hang': resolve only via abort
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

describe('CLI analytics delivery', () => {
  let tmpDir: string;
  let originalCwd: string;
  const orig: Record<string, string | undefined> = {};
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    for (const k of ['HOME', 'CI', 'ONE_NO_TELEMETRY', 'ONE_DISABLE_TELEMETRY', 'DO_NOT_TRACK', 'ONE_SECRET']) {
      orig[k] = process.env[k];
    }
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-delivery-test-'));
    const home = path.join(tmpDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    setHomeTo(home);
    process.chdir(home);
    delete process.env.CI;
    delete process.env.ONE_NO_TELEMETRY;
    delete process.env.ONE_DISABLE_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    process.env.ONE_SECRET = 'sk_live_test_key';
  });

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    await flush(); // settle anything a test left in flight
    process.chdir(originalCwd);
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('uuidFromInsertId is deterministic and yields a valid v5-shaped UUID', () => {
    const a = uuidFromInsertId('abc123');
    assert.match(a, UUID_RE);
    assert.equal(a, uuidFromInsertId('abc123'), 'same input → same uuid');
    assert.notEqual(a, uuidFromInsertId('abc124'), 'different input → different uuid');
    const already = '123e4567-e89b-42d3-a456-426614174000';
    assert.equal(uuidFromInsertId(already), already, 'an id that already is a UUID is kept as is');
  });

  it('every queued event carries a uuid derived from its $insert_id', () => {
    capture('Something Happened', { $insert_id: 'content-hash-1' });
    capture('Other Thing');
    const [a, b] = queuedLines();
    assert.equal(a.uuid, uuidFromInsertId('content-hash-1'));
    assert.match(String(b.uuid), /^[0-9a-f-]{36}$/);
    assert.equal(b.uuid, uuidFromInsertId(String(b.properties.$insert_id)));
  });

  it('sends the uuid to PostHog so a re-sent copy dedupes on ingest', () => {
    const stub = stubFetch('ok');
    restoreFetch = stub.restore;
    capture('Something Happened', { $insert_id: 'content-hash-1' });
    drainQueue();
    assert.equal(stub.bodies.length, 1);
    assert.equal(stub.bodies[0].uuid, uuidFromInsertId('content-hash-1'));
    assert.equal((stub.bodies[0].properties as Record<string, unknown>).$insert_id, 'content-hash-1');
  });

  it('backfills a uuid for queue lines written by an older CLI', () => {
    const stub = stubFetch('ok');
    restoreFetch = stub.restore;
    writeAnalyticsQueue([
      JSON.stringify({
        event: 'CLI Usage Rollup',
        distinct_id: 'u',
        timestamp: new Date().toISOString(),
        properties: { $insert_id: 'legacy-hash' },
      }),
    ]);
    drainQueue();
    assert.equal(stub.bodies[0].uuid, uuidFromInsertId('legacy-hash'));
  });

  it('a delivered event leaves the queue after flush', async () => {
    const stub = stubFetch('ok');
    restoreFetch = stub.restore;
    capture('Something Happened');
    drainQueue();
    await flush();
    assert.equal(queuedLines().length, 0);
  });

  it('flush waits briefly for an in-flight send instead of aborting it', async () => {
    const stub = stubFetch('slow-ok'); // completes in ~40ms, well inside the grace period
    restoreFetch = stub.restore;
    capture('Something Happened');
    drainQueue();
    await flush();
    assert.equal(queuedLines().length, 0, 'delivered within the grace period → not retried');
  });

  it('counts an attempt each time an event is dispatched and drops it after the cap', async () => {
    const stub = stubFetch('hang'); // every attempt gets aborted at exit
    restoreFetch = stub.restore;
    capture('Something Happened');
    for (let run = 1; run <= SEND_MAX_ATTEMPTS; run++) {
      drainQueue();
      await flush();
      if (run < SEND_MAX_ATTEMPTS) {
        assert.equal(queuedLines().length, 1, `still queued after run ${run}`);
        assert.equal(queuedLines()[0].attempts, run, `attempts persisted after run ${run}`);
      }
    }
    assert.equal(queuedLines().length, 0, `dropped after ${SEND_MAX_ATTEMPTS} dispatches`);
    assert.equal(stub.bodies.length, SEND_MAX_ATTEMPTS, 'dispatched exactly the cap, never more');
    drainQueue();
    await flush();
    assert.equal(stub.bodies.length, SEND_MAX_ATTEMPTS, 'nothing left to re-send');
  });

  it('drops events older than the age cap without sending them', () => {
    const stub = stubFetch('ok');
    restoreFetch = stub.restore;
    writeAnalyticsQueue([
      JSON.stringify({
        event: 'CLI Usage Rollup',
        distinct_id: 'u',
        timestamp: new Date(Date.now() - QUEUE_MAX_AGE_MS - 60_000).toISOString(),
        properties: { $insert_id: 'stale' },
      }),
      JSON.stringify({
        event: 'CLI Usage Rollup',
        distinct_id: 'u',
        timestamp: new Date().toISOString(),
        properties: { $insert_id: 'fresh' },
      }),
    ]);
    drainQueue();
    assert.equal(stub.bodies.length, 1, 'only the fresh event is sent');
    assert.equal((stub.bodies[0].properties as Record<string, unknown>).$insert_id, 'fresh');
    assert.deepEqual(
      queuedLines().map((l) => l.properties.$insert_id),
      ['fresh'],
      'the stale event is gone from the queue',
    );
  });

  it('does not dispatch the same event twice within one run', () => {
    const stub = stubFetch('hang');
    restoreFetch = stub.restore;
    capture('Something Happened');
    drainQueue();
    drainQueue(); // e.g. a second drain at postAction
    assert.equal(stub.bodies.length, 1);
  });

  it('a failed send is retried on the next run (queue kept, attempt counted)', async () => {
    const stub = stubFetch('fail');
    restoreFetch = stub.restore;
    capture('Something Happened');
    drainQueue();
    await flush();
    assert.equal(queuedLines().length, 1);
    assert.equal(queuedLines()[0].attempts, 1);
  });
});
