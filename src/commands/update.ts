import { homeDir } from '../lib/home.js';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import pc from 'picocolors';
import * as output from '../lib/output.js';
import { cliVersion } from '../lib/version.js';

const currentVersion = cliVersion();

// Lazy: binding these at module load captures the home directory from the env
// as it was at import time, which defeats ONE_HOME (and every test that sets
// it). See the note in lib/home.ts.
const ONE_DIR = () => join(homeDir(), '.one');
const CACHE_PATH = () => join(ONE_DIR(), 'update-check.json');
const LOCK_PATH = () => join(ONE_DIR(), 'auto-update.lock');
const STATE_PATH = () => join(ONE_DIR(), 'auto-update-state.json');
const LOG_PATH = () => join(ONE_DIR(), 'auto-update.log');
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const AGE_GATE_MS = 30 * 60 * 1000; // 30 minutes — don't auto-install versions published less than 30min ago
/** After this a held lock is presumed dead and reclaimed. */
export const LOCK_TTL_MS = 10 * 60 * 1000;
/** Consecutive abandoned installs before we stop failing silently and say so. */
export const FAILED_UPDATE_NOTICE_THRESHOLD = 3;
/** ...and how often the notice repeats, so a 5-minute cron isn't spammed. */
export const FAILED_UPDATE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface RegistryInfo {
  version: string;
  publishedAt: string | null;
}

async function fetchLatestVersion(): Promise<string | null> {
  const info = await fetchLatestVersionInfo();
  return info?.version ?? null;
}

async function fetchLatestVersionInfo(): Promise<RegistryInfo | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@withone/cli');
    if (!res.ok) return null;
    const data = (await res.json()) as { 'dist-tags': { latest: string }; time?: Record<string, string> };
    const latest = data['dist-tags']?.latest;
    if (!latest) return null;
    return { version: latest, publishedAt: data.time?.[latest] ?? null };
  } catch {
    return null;
  }
}

function readCache(): { lastCheck: number; latestVersion: string; publishedAt?: string | null } | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH(), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(latestVersion: string, publishedAt?: string | null): void {
  try {
    mkdirSync(join(homeDir(), '.one'), { recursive: true });
    writeFileSync(CACHE_PATH(), JSON.stringify({ lastCheck: Date.now(), latestVersion, publishedAt }));
  } catch {
    // best-effort
  }
}

/** Always fetches fresh from npm (used by `one update`). */
export async function checkLatestVersion(): Promise<string | null> {
  const info = await fetchLatestVersionInfo();
  if (info) writeCache(info.version, info.publishedAt);
  return info?.version ?? null;
}

/** Returns cached latest version if checked within the interval, otherwise fetches and caches. */
export async function checkLatestVersionCached(): Promise<{ version: string; publishedAt: string | null } | null> {
  const cache = readCache();
  if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
    return { version: cache.latestVersion, publishedAt: cache.publishedAt ?? null };
  }
  const info = await fetchLatestVersionInfo();
  if (info) writeCache(info.version, info.publishedAt);
  return info;
}

export function getCurrentVersion(): string {
  return currentVersion;
}

// ── Spawning npm ─────────────────────────────────────────────────────
//
// Everything below exists because `spawn('npm', …)` resolves through PATH, and
// the runs that need updating most are the ones with the emptiest PATH.
// `one sync schedule` writes a crontab line; cron hands that job
// `PATH=/usr/bin:/bin`, where an nvm / Volta / Homebrew npm does not appear. The
// spawn then failed as "npm: command not found" — and because it ran under
// `shell: true`, the SHELL started fine and merely exited 127, so no 'error'
// event ever fired and the failure was invisible. A scheduled install stayed on
// v1.48.0 for two weeks, re-running that same doomed update every 5 minutes,
// while its owner's interactive installs tracked latest normally.

/**
 * Absolute path to the npm that ships alongside the running node.
 *
 * npm sits next to node in every standard layout (nvm, Volta, fnm, Homebrew,
 * the official installer, the Docker node images), so `process.execPath` is a
 * reliable anchor that does not care what PATH contains. Falls back to a bare
 * PATH lookup only when that sibling is genuinely absent.
 */
export function resolveNpmBin(nodeExecPath: string = process.execPath): string {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const sibling = join(dirname(nodeExecPath), name);
    if (existsSync(sibling)) return sibling;
  } catch {
    // unreadable path — fall through to PATH
  }
  return name;
}

/**
 * The environment for a spawned npm, with node's own directory prepended to
 * PATH.
 *
 * Resolving npm absolutely is not sufficient on its own: the npm shim is a
 * shell script whose shebang is `#!/usr/bin/env node`, so a PATH without node
 * fails one layer further down and just as quietly.
 */
export function updateChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  nodeExecPath: string = process.execPath,
): NodeJS.ProcessEnv {
  const nodeDir = dirname(nodeExecPath);
  // Windows env vars are case-insensitive in process.env but NOT in the plain
  // object handed to spawn(): writing `PATH` next to an existing `Path` leaves
  // which one wins undefined. Reuse whatever key is already there.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const parts = (env[key] ?? '').split(delimiter).filter(Boolean);
  if (!parts.includes(nodeDir)) parts.unshift(nodeDir);
  return { ...env, [key]: parts.join(delimiter) };
}

export async function updateCommand(): Promise<void> {
  const s = output.createSpinner();
  s.start('Checking for updates...');

  const latestVersion = await checkLatestVersion();
  if (!latestVersion) {
    s.stop('');
    output.error('Failed to check for updates — could not reach npm registry');
  }

  if (currentVersion === latestVersion) {
    s.stop('Already up to date');
    if (output.isAgentMode()) {
      output.json({ current: currentVersion, latest: latestVersion, updated: false, message: 'Already up to date' });
    } else {
      console.log(`Already up to date (v${currentVersion})`);
    }
    return;
  }

  s.stop(`Update available: v${currentVersion} → v${latestVersion}`);
  console.log(`Updating @withone/cli: v${currentVersion} → v${latestVersion}...`);

  const npmBin = resolveNpmBin();
  const env = updateChildEnv();
  // An absolute npm path needs no shell; a bare `npm` is still PATH-resolved by
  // spawn itself. Windows is the exception — Node refuses to run a `.cmd`
  // without a shell — so quote the path for cmd.exe there.
  const useShell = process.platform === 'win32';
  const command = useShell ? `"${npmBin}"` : npmBin;

  // Clear npm cache for this package to avoid stale installs
  await new Promise<void>((resolve) => {
    const child = spawn(command, ['cache', 'clean', '--force'], { stdio: 'ignore', shell: useShell, env });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });

  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(command, ['install', '-g', `@withone/cli@${latestVersion}`, '--force'], {
      stdio: output.isAgentMode() ? 'pipe' : 'inherit',
      shell: useShell,
      env,
    });
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });

  if (code === 0) {
    clearAutoUpdateState();
    if (output.isAgentMode()) {
      output.json({ current: currentVersion, latest: latestVersion, updated: true, message: 'Updated successfully' });
    } else {
      console.log(`Successfully updated to v${latestVersion}`);
    }
  } else {
    output.error('Update failed — try running: npm install -g @withone/cli@latest');
  }
}

/** Returns true if `latest` is strictly newer than `current` (semver comparison). */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

/** Auto-update is opt-out via env var (any of these set to 1/true disables it). */
export function isAutoUpdateDisabled(): boolean {
  const v = process.env.ONE_NO_AUTO_UPDATE ?? process.env.ONE_DISABLE_AUTO_UPDATE;
  return v === '1' || v === 'true';
}

// ── Failure accounting ───────────────────────────────────────────────
//
// The install is detached and the parent exits first, so its exit code is
// usually unobservable from here. What IS observable on the next run is the
// lock it left behind: an abandoned lock plus a version that did not move means
// the install did not happen. Counting those is what turns a silent two-week
// freeze into a message.

export interface AutoUpdateState {
  /** Consecutive abandoned installs. */
  failures: number;
  /** Why the last one is believed to have failed. */
  lastError?: string;
  /** When we last told the user, so the notice doesn't repeat every run. */
  lastNoticeAt?: number;
}

export function readAutoUpdateState(): AutoUpdateState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH(), 'utf8')) as Partial<AutoUpdateState>;
    return { ...parsed, failures: typeof parsed.failures === 'number' ? parsed.failures : 0 };
  } catch {
    return { failures: 0 };
  }
}

function writeAutoUpdateState(state: AutoUpdateState): void {
  try {
    mkdirSync(ONE_DIR(), { recursive: true });
    writeFileSync(STATE_PATH(), JSON.stringify(state), { mode: 0o600 });
  } catch { /* best-effort */ }
}

export function clearAutoUpdateState(): void {
  try { rmSync(STATE_PATH(), { force: true }); } catch { /* best-effort */ }
}

/**
 * Account for an install that claimed the lock and never released it.
 *
 * The version we are running — not the lock — is the source of truth. A
 * SUCCESSFUL install also abandons its lock (the parent exited before the
 * detached child could report), so only an attempt at a version we still have
 * not reached counts as a failure.
 */
export function reconcileAbandonedAttempt(lock: { targetVersion?: string }): void {
  const target = lock.targetVersion;
  if (!target) return; // nothing to judge it against
  if (!isNewerVersion(target, currentVersion)) {
    clearAutoUpdateState(); // we are running it (or past it) — the install landed
    return;
  }
  const state = readAutoUpdateState();
  writeAutoUpdateState({
    ...state,
    failures: state.failures + 1,
    lastError: `install of v${target} never completed (npm may not be on this environment's PATH)`,
  });
}

/** Warn only once failures are clearly systematic, and at most once a day. */
export function shouldWarnAboutFailedUpdates(state: AutoUpdateState, now: number = Date.now()): boolean {
  if (state.failures < FAILED_UPDATE_NOTICE_THRESHOLD) return false;
  if (state.lastNoticeAt && now - state.lastNoticeAt < FAILED_UPDATE_NOTICE_INTERVAL_MS) return false;
  return true;
}

/**
 * Tell the user their CLI is stuck. Always stderr — never stdout — so it cannot
 * corrupt `--agent` JSON or a piped command's output, and so a cron job that
 * redirects stdout to a log still surfaces it.
 */
function maybeWarnAboutFailedUpdates(targetVersion: string): void {
  const state = readAutoUpdateState();
  if (!shouldWarnAboutFailedUpdates(state)) return;
  writeAutoUpdateState({ ...state, lastNoticeAt: Date.now() });
  process.stderr.write(
    pc.yellow(
      `One CLI could not auto-update (v${currentVersion} → v${targetVersion}) after ${state.failures} attempts.\n`,
    ) +
      pc.dim(
        `Update manually with: npm install -g @withone/cli@latest\n` +
        `Details: ${LOG_PATH()}. Silence this with ONE_NO_AUTO_UPDATE=1.\n`,
      ),
  );
}

interface UpdateLockClaim {
  /** Whether this process may spawn an install. */
  acquired: boolean;
  /** A previous attempt's lock that had gone stale, if one was reclaimed. */
  abandoned: { targetVersion?: string } | null;
}

/**
 * Try to claim the single auto-update slot. `acquired` is true only if this
 * process may spawn an install. A held lock newer than LOCK_TTL_MS means an
 * install is already in flight, so we back off; an older lock is presumed dead
 * (a previous install crashed, hung, or never started) and is reclaimed and
 * reported as `abandoned`. The atomic `wx` write is the race guard between
 * concurrent invocations.
 */
export function acquireUpdateLock(targetVersion: string): UpdateLockClaim {
  try { mkdirSync(ONE_DIR(), { recursive: true }); } catch { /* best-effort */ }

  let abandoned: { targetVersion?: string } | null = null;
  try {
    const lock = JSON.parse(readFileSync(LOCK_PATH(), 'utf8')) as { startedAt?: number; targetVersion?: string };
    const startedAt = typeof lock.startedAt === 'number' ? lock.startedAt : 0;
    if (Date.now() - startedAt < LOCK_TTL_MS) {
      return { acquired: false, abandoned: null }; // a fresh install is already running
    }
    abandoned = { targetVersion: lock.targetVersion };
    rmSync(LOCK_PATH(), { force: true }); // stale — reclaim it
  } catch {
    // no lock (or unreadable) — fall through and try to create one
  }

  try {
    writeFileSync(
      LOCK_PATH(),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), targetVersion }),
      { flag: 'wx' }, // fail if another invocation created it first
    );
    return { acquired: true, abandoned };
  } catch {
    return { acquired: false, abandoned }; // lost the race to a concurrent invocation
  }
}

function releaseUpdateLock(): void {
  try { rmSync(LOCK_PATH(), { force: true }); } catch { /* best-effort */ }
}

/** Append-mode fd for the install log, or 'ignore' if it can't be opened. */
function installLogTarget(): number | 'ignore' {
  try {
    mkdirSync(ONE_DIR(), { recursive: true });
    return openSync(LOG_PATH(), 'a', 0o600);
  } catch {
    return 'ignore';
  }
}

/**
 * Auto-update: silently installs the latest version in the background.
 *
 * Spawns a single detached npm install so it doesn't block the current command.
 *
 *   - Opt-out: `ONE_NO_AUTO_UPDATE=1` disables it entirely.
 *   - Mutual exclusion: a lock file ensures at most one install runs at a time,
 *     so parallel agent invocations can't collide on npm's cache/prefix locks
 *     and wedge.
 *   - Self-healing: the lock carries a timestamp and is reclaimed after
 *     LOCK_TTL_MS, so a crashed or hung install can never block updates forever.
 *   - Reachable: npm is resolved next to `process.execPath` and node's own
 *     directory is prepended to the child's PATH, so a scheduled run with a
 *     bare cron PATH can still update itself (see resolveNpmBin).
 *   - Loud enough: an install that never lands is counted, logged to
 *     ~/.one/auto-update.log, and reported after FAILED_UPDATE_NOTICE_THRESHOLD
 *     consecutive failures instead of retrying invisibly forever.
 *
 * Respects a 30-minute age gate — won't install versions published less than 30min ago.
 */
export function autoUpdate(targetVersion: string, publishedAt: string | null): void {
  if (isAutoUpdateDisabled()) return;

  // Age gate: don't install versions published less than 30min ago
  if (publishedAt) {
    const age = Date.now() - new Date(publishedAt).getTime();
    if (age < AGE_GATE_MS) return;
  }

  // Only one install at a time across all concurrent invocations.
  const claim = acquireUpdateLock(targetVersion);
  if (claim.abandoned) {
    reconcileAbandonedAttempt(claim.abandoned);
    maybeWarnAboutFailedUpdates(targetVersion);
  }
  if (!claim.acquired) return;

  const npmBin = resolveNpmBin();
  const useShell = process.platform === 'win32';
  const log = installLogTarget();
  const child = spawn(
    useShell ? `"${npmBin}"` : npmBin,
    ['install', '-g', `@withone/cli@${targetVersion}`],
    {
      detached: true,
      // Keep npm's own diagnostics: when an install does fail, the reason is on
      // disk instead of nowhere.
      stdio: log === 'ignore' ? 'ignore' : ['ignore', log, log],
      shell: useShell,
      env: updateChildEnv(),
    },
  );
  if (log !== 'ignore') { try { closeSync(log); } catch { /* the child owns it now */ } }

  // The child usually outlives us, so these fire only when the command is still
  // winding down. When they do fire they settle the lock immediately instead of
  // leaving it for the TTL — and unlike the old code, a non-zero exit counts.
  child.on('error', (err) => {
    writeAutoUpdateState({ ...readAutoUpdateState(), lastError: err.message });
    releaseUpdateLock();
  });
  child.on('exit', (code) => {
    if (code === 0) clearAutoUpdateState();
    releaseUpdateLock();
  });
  child.unref();
}
