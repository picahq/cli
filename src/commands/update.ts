import { createRequire } from 'module';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as output from '../lib/output.js';

const require = createRequire(import.meta.url);
const { version: currentVersion } = require('../package.json');

const CACHE_PATH = join(homedir(), '.one', 'update-check.json');
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const AGE_GATE_MS = 30 * 60 * 1000; // 30 minutes — don't auto-install versions published less than 30min ago

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

  const code = await new Promise<number | null>((resolve) => {
    const child = spawn('npm', ['install', '-g', '@withone/cli@latest', '--force'], {
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

/**
 * Auto-update: silently installs the latest version in the background.
 * Spawns a detached npm install process so it doesn't block the current command.
 * Respects a 30-minute age gate — won't install versions published less than 30min ago.
 */
export function autoUpdate(targetVersion: string, publishedAt: string | null): void {
  // Age gate: don't install versions published less than 30min ago
  if (publishedAt) {
    const age = Date.now() - new Date(publishedAt).getTime();
    if (age < AGE_GATE_MS) return;
  }

  const child = spawn('npm', ['install', '-g', `@withone/cli@${targetVersion}`], {
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.unref();
}
