import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { homeDir } from './home.js';
import { getProjectRoot } from './config.js';
import {
  withTempHome,
  setHomeTo,
  snapshotHomeEnv,
  restoreHomeEnv,
  assertHomeIsSandboxed,
  type HomeEnvSnapshot,
} from '../test-support/home.js';

// The bug these pin: every test sandboxed `process.env.HOME`, but the source
// resolved paths with `os.homedir()` — which follows $HOME on POSIX and reads
// USERPROFILE on Windows, ignoring HOME entirely. On Windows the suite read
// and wrote the developer's REAL ~/.one: it injected fabricated events into
// the live telemetry send-queue, wrote into the real knowledge cache, and
// failed ~29 assertions against whatever config was installed on the machine.

describe('homeDir', () => {
  let saved: HomeEnvSnapshot;
  beforeEach(() => { saved = snapshotHomeEnv(); });
  afterEach(() => { restoreHomeEnv(saved); });

  it('falls back to the OS home when ONE_HOME is unset', () => {
    delete process.env.ONE_HOME;
    assert.equal(homeDir(), os.homedir());
  });

  it('honours ONE_HOME', () => {
    process.env.ONE_HOME = path.join(os.tmpdir(), 'one-home-probe');
    assert.equal(homeDir(), path.join(os.tmpdir(), 'one-home-probe'));
  });

  it('overrides on every platform, unlike HOME', () => {
    // The whole point: setting HOME alone is a no-op on win32.
    const sandbox = path.join(os.tmpdir(), 'one-home-platform-probe');
    setHomeTo(sandbox);
    assert.equal(homeDir(), sandbox, 'ONE_HOME must win regardless of platform');
  });

  it('ignores an empty or whitespace ONE_HOME', () => {
    process.env.ONE_HOME = '';
    assert.equal(homeDir(), os.homedir());
    process.env.ONE_HOME = '   ';
    assert.equal(homeDir(), os.homedir());
  });

  it('resolves per call, never cached at module load', () => {
    const a = path.join(os.tmpdir(), 'one-home-a');
    const b = path.join(os.tmpdir(), 'one-home-b');
    process.env.ONE_HOME = a;
    assert.equal(homeDir(), a);
    process.env.ONE_HOME = b;
    assert.equal(homeDir(), b, 'a cached value would still report the first path');
  });
});

describe('getProjectRoot never escapes above $HOME', () => {
  let saved: HomeEnvSnapshot;
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    saved = snapshotHomeEnv();
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-home-walk-'));
  });
  afterEach(() => {
    process.chdir(cwd);
    restoreHomeEnv(saved);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('ignores a marker sitting above the home directory', () => {
    // Layout: <tmp>/.git        <- marker ABOVE home
    //         <tmp>/home        <- $HOME
    //         <tmp>/home/sub    <- cwd, no marker
    //
    // The walk used to skip $HOME itself but keep climbing, so it adopted the
    // marker above it. On Windows that meant reaching the developer's real
    // ~/.one, since os.tmpdir() lives inside the real home.
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    const home = path.join(tmp, 'home');
    const sub = path.join(home, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    setHomeTo(home);

    assert.equal(getProjectRoot(sub), sub, 'should fall back to cwd, not the marker above $HOME');
  });

  it('still finds a marker at or below the home directory', () => {
    const home = path.join(tmp, 'home');
    const repo = path.join(home, 'repo');
    const leaf = path.join(repo, 'src', 'deep');
    fs.mkdirSync(leaf, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    setHomeTo(home);

    assert.equal(getProjectRoot(leaf), repo);
  });

  it('is unaffected for a project outside the home directory', () => {
    // The walk never reaches $HOME in this case, so the new stop condition
    // must not change anything.
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    const repo = path.join(tmp, 'elsewhere', 'repo');
    const leaf = path.join(repo, 'sub');
    fs.mkdirSync(leaf, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    setHomeTo(home);

    assert.equal(getProjectRoot(leaf), repo);
  });
});

describe('withTempHome', () => {
  it('redirects the home directory and cleans up after itself', () => {
    const realHome = homeDir();
    const sandbox = withTempHome();

    sandbox.setup();
    const dir = sandbox.dir;
    assert.notEqual(homeDir(), realHome);
    assert.equal(homeDir(), dir);
    assert.ok(fs.existsSync(sandbox.oneDir), 'creates <sandbox>/.one');
    assertHomeIsSandboxed();

    sandbox.teardown();
    assert.equal(homeDir(), realHome, 'restores the previous home');
    assert.equal(fs.existsSync(dir), false, 'removes the temp dir');
  });

  it('restores env vars that were previously unset', () => {
    const before = process.env.ONE_HOME;
    delete process.env.ONE_HOME;

    const sandbox = withTempHome();
    sandbox.setup();
    assert.ok(process.env.ONE_HOME);
    sandbox.teardown();
    assert.equal('ONE_HOME' in process.env, false, 'must delete, not set to "undefined"');

    if (before !== undefined) process.env.ONE_HOME = before;
  });

  it('throws if dir is read before setup', () => {
    const sandbox = withTempHome();
    assert.throws(() => sandbox.dir, /setup\(\) has not run/);
  });
});

describe('assertHomeIsSandboxed', () => {
  let saved: HomeEnvSnapshot;
  beforeEach(() => { saved = snapshotHomeEnv(); });
  afterEach(() => { restoreHomeEnv(saved); });

  it('throws when ONE_HOME is unset', () => {
    delete process.env.ONE_HOME;
    assert.throws(() => assertHomeIsSandboxed(), /not sandboxed/);
  });

  it('throws when ONE_HOME points at the real home', () => {
    process.env.ONE_HOME = os.homedir();
    assert.throws(() => assertHomeIsSandboxed(), /real home/);
  });

  it('passes inside a sandbox', () => {
    process.env.ONE_HOME = path.join(os.tmpdir(), 'one-sandbox-probe');
    assert.doesNotThrow(() => assertHomeIsSandboxed());
  });
});
