import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Built-in sync profiles that ship with the CLI. These are pre-validated
 * configurations for common platform models, so agents don't have to
 * rediscover pagination, resultsPath, etc. every time.
 *
 * Stored in /profiles/<platform>/<model>.json in the CLI package directory.
 */

export interface BuiltinProfile {
  description: string;
  platform: string;
  model: string;
  [key: string]: unknown;
}

/** Resolve the package's profiles directory. */
function getProfilesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);

  // Try multiple levels up — works for both src/ (3 levels) and dist/ (1 level)
  for (let i = 1; i <= 4; i++) {
    const candidate = path.resolve(thisDir, ...Array(i).fill('..'), 'profiles');
    if (fs.existsSync(candidate)) return candidate;
  }

  return '';
}

/**
 * Load a built-in profile for a specific platform/model.
 * Returns null if no built-in profile exists.
 */
export function loadBuiltinProfile(platform: string, model: string): BuiltinProfile | null {
  const dir = getProfilesDir();
  if (!dir) return null;

  const filePath = path.join(dir, platform, `${model}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as BuiltinProfile;
  } catch {
    return null;
  }
}

/**
 * List all built-in profiles, optionally filtered by platform.
 */
export function listBuiltinProfiles(platform?: string): BuiltinProfile[] {
  const dir = getProfilesDir();
  if (!dir) return [];

  const profiles: BuiltinProfile[] = [];

  try {
    const platforms = platform ? [platform] : fs.readdirSync(dir).filter(f => {
      try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch { return false; }
    });

    for (const plat of platforms) {
      const platDir = path.join(dir, plat);
      if (!fs.existsSync(platDir)) continue;

      const files = fs.readdirSync(platDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(platDir, file), 'utf-8');
          const profile = JSON.parse(raw) as BuiltinProfile;
          profiles.push(profile);
        } catch {
          // Skip malformed profiles
        }
      }
    }
  } catch {
    // Profiles dir not readable
  }

  return profiles;
}
