/**
 * `one mem config get|set [key] [value]`
 *
 * Dot-path access against the memory config block. Secret fields are
 * redacted by default on `get` unless `--show-secrets` is passed.
 */

import * as output from '../../lib/output.js';
import {
  getMemoryConfigOrDefault,
  updateMemoryConfig,
  setOpenAiApiKey,
} from '../../lib/memory/index.js';
import { getOpenAiApiKey } from '../../lib/config.js';
import type { MemoryConfig } from '../../lib/memory/index.js';

const SECRET_PATHS = new Set([
  'embedding.apiKey',
  'postgres.connectionString',
]);

/**
 * Keys the user may type into `mem config set/get` that we transparently
 * redirect to the top-level config (see lib/config.ts). The OpenAI key is
 * a user credential, not a memory-subsystem setting, so it lives at the
 * same level as `apiKey`.
 */
const EMBEDDING_API_KEY_PATH = 'embedding.apiKey';

/**
 * Dot-paths accepted by `mem config set`. Unknown paths are rejected
 * with a hint pointing at the closest match — stops silent typos like
 * `mem config set embedOnSync true` (missing the `defaults.` prefix)
 * from writing a top-level key that nothing ever reads.
 */
const KNOWN_KEYS: readonly string[] = [
  'backend',
  'plugins',
  'embedding.provider',
  'embedding.apiKey', // redirected to config.openaiApiKey
  'embedding.model',
  'embedding.dimensions',
  'defaults.trackAccessOnSearch',
  'defaults.embedOnAdd',
  'defaults.embedOnSync',
  'embedded-postgres.dataDir',
  'embedded-postgres.port',
  'embedded-postgres.database',
  'postgres.connectionString',
];

function suggestKey(bad: string): string | null {
  // Tiny Levenshtein for the 11-key surface.
  const distance = (a: string, b: string): number => {
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  };
  let best: { key: string; d: number } | null = null;
  for (const k of KNOWN_KEYS) {
    const d = distance(bad.toLowerCase(), k.toLowerCase());
    if (!best || d < best.d) best = { key: k, d };
  }
  return best && best.d <= Math.max(3, Math.floor(bad.length / 3)) ? best.key : null;
}

function assertKnownSetKey(key: string): void {
  if (KNOWN_KEYS.includes(key)) return;
  const suggestion = suggestKey(key);
  const lines = [
    `Unknown config key "${key}". Known keys: ${KNOWN_KEYS.join(', ')}.`,
  ];
  if (suggestion) lines.push(`Did you mean \`${suggestion}\`?`);
  output.error(lines.join(' '));
}

interface ConfigFlags {
  showSecrets?: boolean;
}

export async function memConfigCommand(
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
  flags: ConfigFlags,
): Promise<void> {
  const act = action ?? 'get';

  if (act === 'get') {
    // Memory auto-inits on first mem-command use, so reads return the
    // default shape before an explicit init. We never block here.
    const cfg = getMemoryConfigOrDefault();
    // Splice the top-level OpenAI key into the memory.embedding view so
    // `mem config get embedding.apiKey` keeps working even though storage
    // moved up. This is a read-only projection — writes still redirect.
    const projected = projectEmbeddingApiKey(cfg);
    const view = flags.showSecrets ? projected : redactSecrets(projected);
    const result = key ? getPath(view as unknown as Record<string, unknown>, key) : view;
    if (output.isAgentMode()) {
      output.json({ config: result });
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (act === 'set') {
    if (!key) output.error('`set` requires a key (e.g. embedding.provider)');
    if (value === undefined) output.error('`set` requires a value');

    // Reject typos before they land as orphan top-level fields no code
    // will ever read (the previous behaviour silently wrote
    // `embedOnSync: true` when the user meant `defaults.embedOnSync`).
    assertKnownSetKey(key!);

    // `embedding.apiKey` is not stored in the memory block — it's a
    // top-level credential alongside config.apiKey. Redirect the write
    // and strip any stale value from the memory block.
    if (key === EMBEDDING_API_KEY_PATH) {
      const str = typeof value === 'string' ? value : String(value);
      setOpenAiApiKey(str);
      const cur = getMemoryConfigOrDefault();
      if (cur.embedding.apiKey !== undefined) {
        const cleaned = { ...cur, embedding: { ...cur.embedding } };
        delete cleaned.embedding.apiKey;
        updateMemoryConfig(cleaned);
      }
      const refreshed = projectEmbeddingApiKey(getMemoryConfigOrDefault());
      if (output.isAgentMode()) {
        output.json({ status: 'ok', storedAt: 'config.openaiApiKey', updated: redactSecrets(refreshed) });
      } else {
        console.log(JSON.stringify(redactSecrets(refreshed), null, 2));
      }
      return;
    }

    const current = getMemoryConfigOrDefault();
    const next = setPath({ ...current } as unknown as Record<string, unknown>, key, parseValue(value!));
    const updated = updateMemoryConfig(next as unknown as Partial<MemoryConfig>);
    if (output.isAgentMode()) {
      output.json({ status: 'ok', updated: redactSecrets(projectEmbeddingApiKey(updated)) });
    } else {
      console.log(JSON.stringify(redactSecrets(projectEmbeddingApiKey(updated)), null, 2));
    }
    return;
  }

  if (act === 'unset') {
    if (!key) output.error('`unset` requires a key');
    // NOTE: unset does NOT reject unknown keys. The whole reason this
    // command exists for stray keys is to clear orphans written by
    // earlier buggy set paths (the pre-validation `mem config set
    // embedOnSync true` that wrote a no-op top-level field). Blocking
    // them here would make the garbage impossible to remove without
    // editing ~/.one/config.json by hand.

    if (key === EMBEDDING_API_KEY_PATH) {
      // Clear from both locations so there's one clean state to observe.
      setOpenAiApiKey('');
      const cur = getMemoryConfigOrDefault();
      if (cur.embedding.apiKey !== undefined) {
        const cleaned = { ...cur, embedding: { ...cur.embedding } };
        delete cleaned.embedding.apiKey;
        updateMemoryConfig(cleaned);
      }
      const refreshed = projectEmbeddingApiKey(getMemoryConfigOrDefault());
      if (output.isAgentMode()) {
        output.json({ status: 'ok', updated: redactSecrets(refreshed) });
      } else {
        console.log(JSON.stringify(redactSecrets(refreshed), null, 2));
      }
      return;
    }

    const current = getMemoryConfigOrDefault();
    const next = unsetPath({ ...current } as unknown as Record<string, unknown>, key);
    // `replace: true` — persist exactly what `unsetPath` returned. The
    // default merge semantics would re-add the deleted key from the
    // on-disk copy, making unset a no-op for orphans.
    const updated = updateMemoryConfig(next as unknown as Partial<MemoryConfig>, { replace: true });
    if (output.isAgentMode()) {
      output.json({ status: 'ok', updated: redactSecrets(projectEmbeddingApiKey(updated)) });
    } else {
      console.log(JSON.stringify(redactSecrets(projectEmbeddingApiKey(updated)), null, 2));
    }
    return;
  }

  output.error(`Unknown action "${act}". Use get, set, or unset.`);
}

/**
 * Read-only view projection: splice the top-level OpenAI key into the
 * memory.embedding.apiKey slot so `mem config get` prints a unified view
 * even though storage lives at config.openaiApiKey. The input is never
 * mutated.
 */
function projectEmbeddingApiKey(cfg: MemoryConfig): MemoryConfig {
  const topLevelKey = getOpenAiApiKey();
  if (!topLevelKey) {
    // No top-level value. If the memory block has a stale legacy key,
    // surface it as-is so the user can see it and rotate.
    return cfg;
  }
  return {
    ...cfg,
    embedding: { ...cfg.embedding, apiKey: topLevelKey },
  };
}

function redactSecrets<T extends Record<string, unknown>>(cfg: T): T {
  const copy = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  for (const path of SECRET_PATHS) {
    const val = getPath(copy, path);
    if (typeof val === 'string' && val.length > 0) {
      setPath(copy, path, `${val.slice(0, 6)}…(redacted, use --show-secrets)`);
    }
  }
  return copy as T;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] == null || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function unsetPath(obj: Record<string, unknown>, path: string): Record<string, unknown> {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] == null || typeof cur[part] !== 'object') return obj;
    cur = cur[part] as Record<string, unknown>;
  }
  delete cur[parts[parts.length - 1]];
  return obj;
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { /* fall through as string */ }
  }
  return raw;
}
