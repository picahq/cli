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

/**
 * Resolve the package's profiles directory.
 *
 * Exported so other call sites (e.g. `mem migrate`'s mtime-based heal
 * transparency check) can stat the profile file without re-implementing
 * the directory walk and falling out of sync with this loader. Returns
 * an empty string when the dir can't be located.
 */
export function getProfilesDir(): string {
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
 * Capability fields a built-in profile can gain in a CLI release.
 *
 * `sync run` resolves profiles with `readProfile()` alone — it never merges or
 * diffs against the shipped built-in. So when a release adds a field to a
 * built-in profile, every user who already ran `sync init` keeps their older
 * copy and silently gets none of it, forever, with no warning. That is how
 * identity keys (#129/#130) shipped and then reached nobody who had already
 * onboarded.
 *
 * Deliberately a curated list, not "every key the built-in has". A profile is
 * user-editable, and fields someone may have removed on purpose (`transform`,
 * `exclude`, `onChange`, …) must not nag. These five only ever add behaviour.
 */
const CAPABILITY_FIELDS = ['identityKeys', 'identityKey', 'enrich', 'dateFilter', 'memory'] as const;

/**
 * Capability fields the shipped built-in declares that the user's installed
 * profile is missing. Empty when there is no built-in, no installed profile,
 * or the installed copy is current.
 *
 * A direct field comparison rather than an mtime check: file mtimes are not
 * meaningful for an npm-installed package, where every file is stamped at
 * install time.
 */
export function findMissingBuiltinCapabilities(
  platform: string,
  model: string,
  installed: Record<string, unknown> | null | undefined,
): string[] {
  if (!installed) return [];
  const builtin = loadBuiltinProfile(platform, model);
  if (!builtin) return [];
  return CAPABILITY_FIELDS.filter(
    field => builtin[field] !== undefined && installed[field] === undefined,
  );
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
