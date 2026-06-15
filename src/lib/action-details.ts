/**
 * Cached action-details resolution — the shared preflight for `actions
 * knowledge`, `actions execute`, and `actions execute --parallel`.
 *
 * The knowledge cache stores the full `ActionDetails` object (method, path,
 * tags, ioSchema, knowledge), so any command that needs action metadata can
 * serve it from disk instead of paying a ~1s round trip to `/knowledge`.
 * In the standard agent flow (search → knowledge → execute) the knowledge
 * call warms the cache and execute becomes a single API round trip.
 *
 * Semantics (same as the knowledge command always had):
 *   - fresh cache entry → serve from disk, no network
 *   - stale entry with ETag → conditional fetch; 304 refreshes cachedAt
 *   - miss → fetch and cache
 *   - network failure with a (stale) entry on disk → serve stale, warn on stderr
 *   - `useCache: false` → always fetch fresh (still writes the cache)
 */

import type { OneApi } from './api.js';
import type { ActionDetails, CacheEntry } from './types.js';
import {
  knowledgeCachePath,
  readCache,
  writeCache,
  isFresh,
  getAge,
  formatAge,
  makeCacheEntry,
} from './cache.js';

export interface ResolvedActionDetails {
  details: ActionDetails;
  /** True when the details came from disk (fresh hit, 304, or stale fallback). */
  cacheHit: boolean;
  /** True only when a (stale) cache entry was served because the network failed. */
  stale: boolean;
  entry: CacheEntry<ActionDetails> | null;
}

/**
 * Cache entries written before v1.45 stored only `{knowledge, method}`.
 * Those can't drive execute (no path/ioSchema), so treat them as a miss —
 * they get refetched and rewritten in the full shape.
 */
export function isActionDetailsEntry(
  entry: CacheEntry<unknown> | null
): entry is CacheEntry<ActionDetails> {
  const data = entry?.data as Record<string, unknown> | undefined;
  return (
    !!data &&
    typeof data._id === 'string' &&
    typeof data.path === 'string' &&
    typeof data.method === 'string'
  );
}

export async function resolveActionDetails(
  api: Pick<OneApi, 'getActionDetailsWithMeta'>,
  actionId: string,
  opts: { useCache?: boolean; warn?: (msg: string) => void } = {}
): Promise<ResolvedActionDetails> {
  const useCache = opts.useCache !== false;
  // Default warning sink is stderr; callers that resolve many actions (e.g.
  // `execute --parallel`) pass a deduping sink so a shared stale action only
  // warns once instead of once per segment.
  const warn = opts.warn ?? ((m: string) => { process.stderr.write(m); });
  const cachePath = knowledgeCachePath(actionId);
  const raw = useCache ? readCache<unknown>(cachePath) : null;
  const cached = isActionDetailsEntry(raw) ? raw : null;

  if (cached && isFresh(cached)) {
    return { details: cached.data, cacheHit: true, stale: false, entry: cached };
  }

  try {
    const result = await api.getActionDetailsWithMeta(actionId, cached?.etag ?? undefined);

    if (result.status === 304 && cached) {
      cached.cachedAt = new Date().toISOString();
      writeCache(cachePath, cached);
      return { details: cached.data, cacheHit: true, stale: false, entry: cached };
    }

    const entry = makeCacheEntry(actionId, result.data, result.etag);
    writeCache(cachePath, entry);
    return { details: result.data, cacheHit: false, stale: false, entry };
  } catch (fetchError) {
    if (cached) {
      warn(
        `Warning: serving cached action details (network unavailable, cached ${formatAge(getAge(cached))} ago)\n`
      );
      return { details: cached.data, cacheHit: true, stale: true, entry: cached };
    }
    throw fetchError;
  }
}
