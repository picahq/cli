import { createRequire } from 'module';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as output from '../lib/output.js';

const require = createRequire(import.meta.url);
const { version: currentVersion } = require('../package.json');

const CACHE_PATH = join(homedir(), '.one', 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@withone/cli/latest');
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

function readCache(): { lastCheck: number; latestVersion: string } | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(latestVersion: string): void {
  try {
    mkdirSync(join(homedir(), '.one'), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ lastCheck: Date.now(), latestVersion }));
  } catch {
    // best-effort
  }
}

/** Always fetches fresh from npm (used by `one update`). */
export async function checkLatestVersion(): Promise<string | null> {
  const version = await fetchLatestVersion();
  if (version) writeCache(version);
  return version;
}

/** Returns cached latest version if checked within 24h, otherwise fetches and caches. */
export async function checkLatestVersionCached(): Promise<string | null> {
  const cache = readCache();
  if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
    return cache.latestVersion;
  }
  return checkLatestVersion();
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
    const child = spawn('npm', ['install', '-g', '@withone/cli@latest'], {
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
