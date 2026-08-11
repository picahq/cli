import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Sandbox every home-rooted path the CLI touches, for the duration of a test.
 *
 * Why this exists: tests used to set `process.env.HOME` and assume that was
 * enough. It is not. `os.homedir()` follows `$HOME` on POSIX but reads
 * `USERPROFILE` on Windows and ignores `HOME` entirely — so on Windows the
 * whole suite silently read and wrote the developer's REAL `~/.one`. That
 * polluted the live telemetry send-queue with fabricated events, wrote into
 * the real knowledge cache, and failed ~29 assertions against whatever config
 * happened to be installed on the machine.
 *
 * Anything that reads the home directory through `homeDir()` (lib/home.ts —
 * which is everything in `src/`) is redirected by `ONE_HOME` alone. `HOME` and
 * `USERPROFILE` are set too, so that any dependency reaching for them directly
 * lands in the sandbox rather than the real profile.
 *
 * Usage:
 *
 *   const home = withTempHome();
 *   beforeEach(() => home.setup());
 *   afterEach(() => home.teardown());
 *
 * `home.dir` is the sandbox root; `~/.one` inside it is `home.oneDir`.
 */
export interface TempHome {
  /** Sandbox root. Only valid between setup() and teardown(). */
  readonly dir: string;
  /** `<dir>/.one` — created for you by setup(). */
  readonly oneDir: string;
  setup(): void;
  teardown(): void;
}

const VARS = ['ONE_HOME', 'HOME', 'USERPROFILE'] as const;

/**
 * The real home, captured at module load — before any sandbox has moved it.
 *
 * `assertHomeIsSandboxed()` cannot ask `os.homedir()` for this: setHomeTo()
 * also sets `USERPROFILE`, which is exactly what `os.homedir()` reads on
 * Windows, so once a sandbox is active `os.homedir()` returns the sandbox and
 * the guard would compare a value against itself. node:test runs each test
 * file in its own process, so this module is imported before that file's
 * hooks run.
 */
const REAL_HOME = os.homedir();

export function withTempHome(prefix = 'one-cli-test-'): TempHome {
  let dir = '';
  const saved: Partial<Record<(typeof VARS)[number], string | undefined>> = {};

  return {
    get dir() {
      if (!dir) throw new Error('withTempHome: setup() has not run');
      return dir;
    },
    get oneDir() {
      return path.join(this.dir, '.one');
    },

    setup() {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      fs.mkdirSync(path.join(dir, '.one'), { recursive: true });
      for (const v of VARS) {
        saved[v] = process.env[v];
        process.env[v] = dir;
      }
    },

    teardown() {
      for (const v of VARS) {
        if (saved[v] === undefined) delete process.env[v];
        else process.env[v] = saved[v];
      }
      // Best-effort: a leaked sqlite/pg handle can hold a file open on Windows.
      // A stale temp dir is harmless; failing teardown would mask the real
      // assertion failure.
      if (dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ }
      }
      dir = '';
    },
  };
}

export type HomeEnvSnapshot = Partial<Record<(typeof VARS)[number], string | undefined>>;

/**
 * Point every home-related env var at `dir`.
 *
 * For suites that build their own temp directory and need control over its
 * layout. Pair with snapshotHomeEnv() / restoreHomeEnv(). Prefer
 * withTempHome() when you just need "somewhere private".
 */
export function setHomeTo(dir: string): void {
  for (const v of VARS) process.env[v] = dir;
}

/** Capture the current home env vars so restoreHomeEnv() can put them back. */
export function snapshotHomeEnv(): HomeEnvSnapshot {
  const snap: HomeEnvSnapshot = {};
  for (const v of VARS) snap[v] = process.env[v];
  return snap;
}

/** Restore what snapshotHomeEnv() captured, including unsetting vars. */
export function restoreHomeEnv(snap: HomeEnvSnapshot): void {
  for (const v of VARS) {
    if (snap[v] === undefined) delete process.env[v];
    else process.env[v] = snap[v];
  }
}

/**
 * Guard for tests that must never touch the real home directory.
 *
 * Call at the top of a test body. Throws if the sandbox is not active — which
 * is the failure mode that made the original bug invisible: the tests passed
 * on macOS and quietly wrote to the real `~/.one` on Windows, so nobody
 * noticed until a 747MB database and a production telemetry queue were
 * involved.
 */
export function assertHomeIsSandboxed(): void {
  const override = process.env.ONE_HOME;
  if (!override || override.trim() === '') {
    throw new Error(
      'Test is not sandboxed: ONE_HOME is unset, so this would read/write the real ~/.one. ' +
      'Wrap the suite in withTempHome().',
    );
  }
  if (override === REAL_HOME) {
    throw new Error(`Test is not sandboxed: ONE_HOME points at the real home (${override}).`);
  }
}
