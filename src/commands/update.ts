import { createRequire } from 'module';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as output from '../lib/output.js';

const require = createRequire(import.meta.url);
const { version: currentVersion } = require('../package.json');

const ONE_DIR = join(homedir(), '.one');
const CACHE_PATH = join(ONE_DIR, 'update-check.json');
const LOCK_PATH = join(ONE_DIR, 'auto-update.lock');
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const AGE_GATE_MS = 30 * 60 * 1000; // 30 minutes — don't auto-install versions published less than 30min ago
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes — after this a held lock is presumed dead and reclaimed

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
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(latestVersion: string, publishedAt?: string | null): void {
  try {
    mkdirSync(join(homedir(), '.one'), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ lastCheck: Date.now(), latestVersion, publishedAt }));
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

  // Clear npm cache for this package to avoid stale installs
  await new Promise<void>((resolve) => {
    const child = spawn('npm', ['cache', 'clean', '--force'], {
      stdio: 'ignore',
      shell: true,
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });

  const code = await new Promise<number | null>((resolve) => {
    const child = spawn('npm', ['install', '-g', `@withone/cli@${latestVersion}`, '--force'], {
      stdio: output.isAgentMode() ? 'pipe' : 'inherit',
      shell: true,
    });
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });

  if (code === 0) {
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

/**
 * Try to claim the single auto-update slot. Returns true only if this process
 * may spawn an install. A held lock newer than LOCK_TTL_MS means an install is
 * already in flight, so we back off; an older lock is presumed dead (a previous
 * install crashed or hung) and gets reclaimed. The atomic `wx` write is the race
 * guard between concurrent invocations.
 */
function acquireUpdateLock(targetVersion: string): boolean {
  try { mkdirSync(ONE_DIR, { recursive: true }); } catch { /* best-effort */ }

  try {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { startedAt?: number };
    const startedAt = typeof lock.startedAt === 'number' ? lock.startedAt : 0;
    if (Date.now() - startedAt < LOCK_TTL_MS) return false; // a fresh install is already running
    rmSync(LOCK_PATH, { force: true }); // stale — reclaim it
  } catch {
    // no lock (or unreadable) — fall through and try to create one
  }

  try {
    writeFileSync(
      LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), targetVersion }),
      { flag: 'wx' }, // fail if another invocation created it first
    );
    return true;
  } catch {
    return false; // lost the race to a concurrent invocation
  }
}

/**
 * Auto-update: silently installs the latest version in the background.
 *
 * Spawns a single detached `npm install -g` so it doesn't block the current
 * command. Hardened against the failure mode where concurrent invocations (an
 * agent running many `one` calls at once) each spawn their own global install
 * and deadlock on npm's cache/prefix locks, wedging and orphaning indefinitely:
 *
 *   - Opt-out: `ONE_NO_AUTO_UPDATE=1` disables it entirely.
 *   - Mutual exclusion: a lock file ensures at most one install runs at a time,
 *     so installs never collide and actually complete (~2s).
 *   - Self-healing: the lock carries a timestamp and is reclaimed after
 *     LOCK_TTL_MS, so a crashed/hung install can never block updates forever.
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
  if (!acquireUpdateLock(targetVersion)) return;

  const child = spawn('npm', ['install', '-g', `@withone/cli@${targetVersion}`], {
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.on('error', () => { try { rmSync(LOCK_PATH, { force: true }); } catch { /* best-effort */ } });
  child.unref();
}
