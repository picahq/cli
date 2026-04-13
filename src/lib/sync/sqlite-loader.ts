import type DatabaseType from 'better-sqlite3';

/**
 * Lazy loader for better-sqlite3. The package is an optionalDependency so
 * users who never run `one sync ...` don't pay the native-build cost.
 *
 * Throws a clear, actionable error when the module isn't installed.
 */

type DatabaseConstructor = typeof DatabaseType;

let cached: DatabaseConstructor | null = null;

export async function loadSqlite(): Promise<DatabaseConstructor> {
  if (cached) return cached;
  try {
    // Use a computed specifier so bundlers/linters can't statically resolve it.
    const modName = 'better-sqlite3';
    const mod = (await import(modName)) as { default: DatabaseConstructor };
    cached = mod.default;
    return cached;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The local sync engine (better-sqlite3) is not installed.\n\n` +
      `Install it with:\n` +
      `  one sync install\n\n` +
      `Or manually:\n` +
      `  npm install -g better-sqlite3\n\n` +
      `Underlying error: ${detail}`
    );
  }
}

/** Check whether sqlite is installed without throwing. */
export async function isSqliteAvailable(): Promise<boolean> {
  try {
    await loadSqlite();
    return true;
  } catch {
    return false;
  }
}
