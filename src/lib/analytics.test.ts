import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';

import { recordCommand, flushUsageRollups } from './analytics.js';
import { appendUsageLog, readUsageLog, readAnalyticsQueue, claimUsageLog } from './config.js';

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
    process.env.HOME = home;
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
});
