import os from 'node:os';

/**
 * The user's home directory — the root of `~/.one`, the skill install dirs,
 * the knowledge cache, the memory databases, and the telemetry queue.
 *
 * Every home-rooted path in the CLI resolves through here rather than calling
 * `os.homedir()` directly, for two reasons:
 *
 * 1. **Testability.** `os.homedir()` is not overridable per-process in a
 *    portable way. On POSIX it follows `$HOME`; on Windows it reads
 *    `USERPROFILE` and ignores `HOME` entirely. Every test in this repo
 *    sandboxed only `HOME`, so on Windows the suite read and wrote the
 *    developer's REAL `~/.one` — polluting the live telemetry queue and the
 *    knowledge cache, and failing ~29 assertions against whatever config
 *    happened to be installed. `ONE_HOME` is one switch that works the same
 *    on every platform. See `withTempHome()` in test-support/home.ts.
 *
 * 2. **Relocatable state.** Containers, CI runners, and multi-tenant shells
 *    often want the CLI's state somewhere other than the account's home.
 *
 * ALWAYS resolved lazily, per call — never cached at module load. A
 * module-scope `const X = homeDir()` captures the value from the environment
 * as it was at import time, which silently defeats both use cases above.
 */
export function homeDir(): string {
  const override = process.env.ONE_HOME;
  if (override && override.trim() !== '') return override;
  return os.homedir();
}
