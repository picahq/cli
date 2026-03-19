import { createRequire } from 'module';
import { spawn } from 'node:child_process';
import * as output from '../lib/output.js';

const require = createRequire(import.meta.url);
const { version: currentVersion } = require('../package.json');

export async function checkLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@withone/cli/latest');
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return null;
  }
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
