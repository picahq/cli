import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { withTempHome, assertHomeIsSandboxed } from '../test-support/home.js';
import {
  resolveNpmBin,
  updateChildEnv,
  acquireUpdateLock,
  reconcileAbandonedAttempt,
  readAutoUpdateState,
  clearAutoUpdateState,
  shouldWarnAboutFailedUpdates,
  FAILED_UPDATE_NOTICE_THRESHOLD,
  FAILED_UPDATE_NOTICE_INTERVAL_MS,
  LOCK_TTL_MS,
} from './update.js';

// Regression suite for the failure that froze a scheduled install on v1.48.0
// for two weeks: `one sync schedule` writes a crontab line, cron runs it with
// PATH=/usr/bin:/bin, and the auto-updater's bare `spawn('npm', …, {shell:true})`
// died with "npm: command not found" — exit 127, which fires no 'error' event,
// so nothing was ever logged, retried differently, or surfaced. That install
// re-sent its telemetry queue every 5 minutes for 14 days (1.5M duplicate
// PostHog events) because the fix for THAT bug could never reach it either.

const home = withTempHome('one-cli-update-test-');

describe('resolveNpmBin', () => {
  beforeEach(() => home.setup());
  afterEach(() => home.teardown());

  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  it('resolves npm sitting next to the running node binary', () => {
    const binDir = path.join(home.dir, 'nvm', 'v20.19.0', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, npmName), '#!/usr/bin/env node\n');

    assert.equal(resolveNpmBin(path.join(binDir, 'node')), path.join(binDir, npmName));
  });

  it('returns an absolute path, so a cron PATH of /usr/bin:/bin cannot break it', () => {
    const binDir = path.join(home.dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, npmName), '');

    assert.equal(path.isAbsolute(resolveNpmBin(path.join(binDir, 'node'))), true);
  });

  it('falls back to a bare PATH lookup when node has no npm sibling', () => {
    const binDir = path.join(home.dir, 'lonely');
    fs.mkdirSync(binDir, { recursive: true });

    assert.equal(resolveNpmBin(path.join(binDir, 'node')), npmName);
  });
});

describe('updateChildEnv', () => {
  it("prepends node's own directory so npm's `env node` shebang resolves", () => {
    // Build the seed PATH with the platform delimiter — a hardcoded ':' is a
    // single opaque entry on Windows, where the separator is ';'.
    const cronPath = ['/usr/bin', '/bin'].join(path.delimiter);
    const env = updateChildEnv({ PATH: cronPath }, '/opt/nvm/v20/bin/node');

    assert.equal(env.PATH, ['/opt/nvm/v20/bin', '/usr/bin', '/bin'].join(path.delimiter));
  });

  it('does not duplicate a directory that is already on PATH', () => {
    const env = updateChildEnv({ PATH: `/opt/n/bin${path.delimiter}/usr/bin` }, '/opt/n/bin/node');

    assert.equal(env.PATH, `/opt/n/bin${path.delimiter}/usr/bin`);
  });

  it('handles a completely empty PATH (cron with no PATH set at all)', () => {
    const env = updateChildEnv({}, '/opt/n/bin/node');

    assert.equal(env.PATH, '/opt/n/bin');
  });

  it('reuses the existing key casing instead of adding a second PATH entry', () => {
    // Windows env vars are case-insensitive in process.env but NOT in the plain
    // object handed to spawn(): emitting both `Path` and `PATH` makes which one
    // wins undefined.
    // The node path stays platform-neutral: path.dirname only understands
    // backslashes when the suite itself runs on Windows.
    const env = updateChildEnv({ Path: '/system32' }, '/opt/n/bin/node');

    assert.equal(env.PATH, undefined);
    assert.equal(env.Path, `/opt/n/bin${path.delimiter}/system32`);
  });

  it('leaves the rest of the environment untouched', () => {
    const env = updateChildEnv({ PATH: '/usr/bin', ONE_API_KEY: 'sk_test_x' }, '/n/bin/node');

    assert.equal(env.ONE_API_KEY, 'sk_test_x');
  });
});

describe('auto-update failure accounting', () => {
  beforeEach(() => {
    home.setup();
    assertHomeIsSandboxed();
  });
  afterEach(() => home.teardown());

  const lockPath = () => path.join(home.oneDir, 'auto-update.lock');

  it('reports a stale lock as an abandoned attempt so the caller can react', () => {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 1, startedAt: Date.now() - LOCK_TTL_MS - 1000, targetVersion: '9.9.9' }),
    );

    const claim = acquireUpdateLock('9.9.9');

    assert.equal(claim.acquired, true);
    assert.deepEqual(claim.abandoned, { targetVersion: '9.9.9' });
  });

  it('does not report a fresh lock as abandoned — an install is genuinely running', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 1, startedAt: Date.now(), targetVersion: '9.9.9' }));

    const claim = acquireUpdateLock('9.9.9');

    assert.equal(claim.acquired, false);
    assert.equal(claim.abandoned, null);
  });

  it('counts an abandoned install as a failure while we are still on the old version', () => {
    reconcileAbandonedAttempt({ targetVersion: '99.0.0' });

    const state = readAutoUpdateState();
    assert.equal(state.failures, 1);
    assert.match(state.lastError ?? '', /99\.0\.0/);
  });

  it('accumulates across runs — this is what silently repeated for two weeks', () => {
    reconcileAbandonedAttempt({ targetVersion: '99.0.0' });
    reconcileAbandonedAttempt({ targetVersion: '99.0.0' });
    reconcileAbandonedAttempt({ targetVersion: '99.0.0' });

    assert.equal(readAutoUpdateState().failures, 3);
  });

  it('treats an abandoned attempt as success once we are running that version', () => {
    // The parent exits before the detached child reports, so a SUCCESSFUL
    // install also leaves its lock behind. Version, not the lock, is the truth.
    reconcileAbandonedAttempt({ targetVersion: '99.0.0' });
    reconcileAbandonedAttempt({ targetVersion: '0.0.1' }); // older than us → we are past it

    assert.equal(readAutoUpdateState().failures, 0);
  });

  it('ignores a lock with no recorded target version', () => {
    reconcileAbandonedAttempt({});

    assert.equal(readAutoUpdateState().failures, 0);
  });

  it('starts from zero when no state file exists', () => {
    assert.deepEqual(readAutoUpdateState(), { failures: 0 });
  });

  it('survives a corrupt state file rather than throwing mid-command', () => {
    fs.writeFileSync(path.join(home.oneDir, 'auto-update-state.json'), '{not json');

    assert.deepEqual(readAutoUpdateState(), { failures: 0 });
  });

  it('clears the state on a successful install', () => {
    reconcileAbandonedAttempt({ targetVersion: '99.0.0' });
    clearAutoUpdateState();

    assert.equal(readAutoUpdateState().failures, 0);
  });
});

describe('shouldWarnAboutFailedUpdates', () => {
  const now = 1_700_000_000_000;

  it('stays quiet below the threshold — one flaky install is not news', () => {
    assert.equal(shouldWarnAboutFailedUpdates({ failures: FAILED_UPDATE_NOTICE_THRESHOLD - 1 }, now), false);
  });

  it('warns once the failures are clearly systematic', () => {
    assert.equal(shouldWarnAboutFailedUpdates({ failures: FAILED_UPDATE_NOTICE_THRESHOLD }, now), true);
  });

  it('does not repeat within the notice interval — cron runs every 5 minutes', () => {
    const state = { failures: 50, lastNoticeAt: now - 60_000 };

    assert.equal(shouldWarnAboutFailedUpdates(state, now), false);
  });

  it('repeats once the interval has elapsed, so a frozen install keeps nagging', () => {
    const state = { failures: 50, lastNoticeAt: now - FAILED_UPDATE_NOTICE_INTERVAL_MS - 1 };

    assert.equal(shouldWarnAboutFailedUpdates(state, now), true);
  });
});

describe('spawning npm under a cron-like environment', () => {
  // The end-to-end proof. cron gives a job PATH=/usr/bin:/bin; the old code's
  // bare `spawn('npm', …, {shell: true})` could not see an nvm/Volta/Homebrew
  // npm there and exited 127 with no 'error' event. Skipped only on the exotic
  // layouts where node genuinely ships without an npm sibling.
  const CRON_ENV = { PATH: '/usr/bin:/bin' };
  const hasSibling = path.isAbsolute(resolveNpmBin());

  const spawnVersion = (cmd: string, env: NodeJS.ProcessEnv, shell: boolean) =>
    new Promise<{ code: number | null; sawErrorEvent: boolean }>((resolve) => {
      const child = spawn(cmd, ['--version'], { env, shell, stdio: 'ignore' });
      let sawErrorEvent = false;
      child.on('error', () => { sawErrorEvent = true; });
      child.on('close', (code) => resolve({ code, sawErrorEvent }));
    });

  it('reproduces the original failure: bare `npm` is invisible to cron', { skip: !hasSibling }, async () => {
    const { code, sawErrorEvent } = await spawnVersion('npm', CRON_ENV, true);

    assert.notEqual(code, 0);
    // The heart of the silence: the SHELL ran fine and merely exited non-zero,
    // so the only handler the old code had never fired.
    assert.equal(sawErrorEvent, false);
  });

  it('succeeds with the resolved binary and patched PATH', { skip: !hasSibling }, async () => {
    const { code } = await spawnVersion(
      resolveNpmBin(),
      updateChildEnv(CRON_ENV),
      process.platform === 'win32',
    );

    assert.equal(code, 0);
  });
});
