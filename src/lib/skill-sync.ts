/**
 * Skill sync — keeps the user's installed skill files in lockstep with the
 * CLI version they're running.
 *
 * Background: `one init` copies the packaged `skills/one/` directory from the
 * npm package into `~/.agents/skills/one/` (the canonical location) and
 * symlinks per-agent paths (`~/.claude/skills/one`, `~/.codex/skills/one`,
 * etc.) to it. When the CLI self-updates via `autoUpdate()` in update.ts the
 * packaged skill content on disk gets newer — but the copies in
 * `~/.agents/skills/one/` stay frozen at whatever version was installed. The
 * user's agent then reads stale docs.
 *
 * Fix: stamp the canonical install dir with a `.one-cli-version` marker file
 * containing the installing CLI's version. On every command (via the
 * preAction hook), `syncSkillsIfStale` compares the marker to the current
 * version and, if they differ, recopies the packaged skill directory over
 * the canonical path. Symlinks don't need touching because they point at the
 * canonical dir. If no marker exists (pre-marker CLI versions) but the skill
 * is installed, a one-time catch-up sync runs. If the skill isn't installed
 * at all, this is a no-op — don't resurrect a skill the user opted out of.
 *
 * The steady-state cost is one tiny `readFileSync` + string compare. The
 * stale path copies ~50KB of markdown. Both sub-millisecond; fine to run
 * synchronously in preAction.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentVersion } from '../commands/update.js';

const CANONICAL_SKILL_DIR = '.agents/skills';
const VERSION_MARKER = '.one-cli-version';

export function getPackagedSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'skills', 'one');
}

export function getCanonicalSkillPath(): string {
  return path.join(os.homedir(), CANONICAL_SKILL_DIR, 'one');
}

function getVersionMarkerPath(): string {
  return path.join(getCanonicalSkillPath(), VERSION_MARKER);
}

export function isSkillInstalled(): boolean {
  return fs.existsSync(path.join(getCanonicalSkillPath(), 'SKILL.md'));
}

export function readInstalledSkillVersion(): string | null {
  try {
    return fs.readFileSync(getVersionMarkerPath(), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export function writeInstalledSkillVersion(version: string): void {
  try {
    fs.mkdirSync(getCanonicalSkillPath(), { recursive: true });
    fs.writeFileSync(getVersionMarkerPath(), `${version}\n`);
  } catch {
    // best-effort
  }
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export interface SyncResult {
  synced: boolean;
  reason?: 'not-installed' | 'up-to-date' | 'stale' | 'missing-marker' | 'forced' | 'source-missing' | 'error';
  from?: string | null;
  to?: string;
  error?: string;
}

/**
 * Sync packaged skills to the canonical install location if the marker is
 * missing or older than the current CLI version. Safe to call on every
 * command — returns { synced: false } quickly when nothing needs doing.
 */
export function syncSkillsIfStale(): SyncResult {
  // Never resurrect a skill the user opted out of at init time.
  if (!isSkillInstalled()) {
    return { synced: false, reason: 'not-installed' };
  }

  const current = getCurrentVersion();
  const installed = readInstalledSkillVersion();

  if (installed === current) {
    return { synced: false, reason: 'up-to-date', from: installed, to: current };
  }

  return performSync(current, installed === null ? 'missing-marker' : 'stale');
}

/**
 * Force a sync regardless of marker state. Used by `one config skills sync`.
 */
export function forceSyncSkills(): SyncResult {
  if (!isSkillInstalled()) {
    // For a forced sync we still require an existing install — we don't want
    // this command to do the job of `one init`, which picks agents + symlinks.
    return { synced: false, reason: 'not-installed' };
  }
  return performSync(getCurrentVersion(), 'forced');
}

function performSync(current: string, reason: SyncResult['reason']): SyncResult {
  const source = getPackagedSkillDir();
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    return { synced: false, reason: 'source-missing' };
  }

  const canonical = getCanonicalSkillPath();

  try {
    // Copy packaged files over the canonical path. We intentionally do NOT
    // rm-rf first — we overlay so symlinks/marker stay intact and any files
    // the user may have added (not recommended but possible) aren't lost.
    // Files that exist in source will be overwritten.
    copyDirSync(source, canonical);
    writeInstalledSkillVersion(current);
    return { synced: true, reason, from: readInstalledSkillVersion() ?? null, to: current };
  } catch (err) {
    return { synced: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SkillStatus {
  installed: boolean;
  canonicalPath: string;
  installedVersion: string | null;
  currentVersion: string;
  upToDate: boolean;
  markerExists: boolean;
}

export function getSkillStatus(): SkillStatus {
  const installed = isSkillInstalled();
  const installedVersion = readInstalledSkillVersion();
  const currentVersion = getCurrentVersion();
  return {
    installed,
    canonicalPath: getCanonicalSkillPath(),
    installedVersion,
    currentVersion,
    upToDate: installed && installedVersion === currentVersion,
    markerExists: installedVersion !== null,
  };
}
