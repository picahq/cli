import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

let cached: string | null = null;

/**
 * The CLI's own version, read from package.json.
 *
 * Walks upward to find it rather than hardcoding a relative depth. The depth
 * differs between layouts: tsup bundles everything into `dist/index.js`, one
 * level below the package root, while the sources it was built from sit two
 * or three levels down (`src/lib/`, `src/commands/`). A fixed `'../package.json'`
 * is therefore correct in `dist/` and wrong in `src/` — which made
 * `src/commands/update.ts` throw MODULE_NOT_FOUND at import time, so anything
 * importing the command tree from source (including a test) died before it ran.
 * `src/lib/analytics.ts` had the same bug but swallowed it, silently reporting
 * every telemetry event as version `unknown` in dev.
 *
 * Mirrors the directory walk `builtin-profiles.ts` already uses to locate
 * `profiles/`.
 */
export function cliVersion(): string {
  if (cached !== null) return cached;

  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 1; i <= 4; i++) {
    const candidate = path.resolve(dir, ...Array(i).fill('..'), 'package.json');
    if (!existsSync(candidate)) continue;
    try {
      const version = (require(candidate) as { version?: string }).version;
      if (version) {
        cached = version;
        return cached;
      }
    } catch {
      // Unreadable or malformed — keep walking.
    }
  }

  cached = 'unknown';
  return cached;
}
