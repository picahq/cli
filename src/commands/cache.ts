import pc from 'picocolors';
import { getApiKey, getApiBase, getAccessControlFromAllSources } from '../lib/config.js';
import { OneApi, filterByPermissions, isActionAllowed } from '../lib/api.js';
import type { PermissionLevel, SearchCacheData } from '../lib/types.js';
import { printTable } from '../lib/table.js';
import * as output from '../lib/output.js';
import {
  listCacheEntries,
  clearAll,
  clearEntry,
  readCache,
  writeCache,
  isFresh,
  getAge,
  formatAge,
  makeCacheEntry,
  knowledgeCachePath,
} from '../lib/cache.js';

export async function cacheClearCommand(actionId?: string): Promise<void> {
  if (actionId) {
    const deleted = clearEntry(actionId);
    if (output.isAgentMode()) {
      output.json({ cleared: deleted, actionId });
      return;
    }
    if (deleted) {
      console.log(`Cleared cache for ${pc.cyan(actionId)}`);
    } else {
      console.log(`No cache entry found for ${pc.dim(actionId)}`);
    }
  } else {
    const count = clearAll();
    if (output.isAgentMode()) {
      output.json({ cleared: true, count });
      return;
    }
    console.log(`Cleared ${count} cached ${count === 1 ? 'entry' : 'entries'}`);
  }
}

export async function cacheListCommand(options: { expired?: boolean }): Promise<void> {
  const entries = listCacheEntries();

  const filtered = options.expired
    ? entries.filter((e) => !isFresh(e.entry))
    : entries;

  if (output.isAgentMode()) {
    output.json({
      entries: filtered.map((e) => ({
        type: e.type,
        key: e.entry.key,
        cachedAt: e.entry.cachedAt,
        age: formatAge(getAge(e.entry)),
        ttl: e.entry.ttl,
        fresh: isFresh(e.entry),
        etag: e.entry.etag,
        path: e.filePath,
      })),
    });
    return;
  }

  if (filtered.length === 0) {
    console.log(options.expired ? 'No expired cache entries' : 'No cached entries');
    return;
  }

  const rows = filtered.map((e) => ({
    type: e.type,
    key: e.entry.key,
    age: formatAge(getAge(e.entry)),
    status: isFresh(e.entry) ? pc.green('fresh') : pc.yellow('expired'),
  }));

  printTable(
    [
      { key: 'type', label: 'Type' },
      { key: 'key', label: 'Key' },
      { key: 'age', label: 'Age' },
      { key: 'status', label: 'Status' },
    ],
    rows
  );
}

export async function cacheUpdateAllCommand(): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('Not configured. Run `one init` first.');
  }

  const api = new OneApi(apiKey, getApiBase());
  const ac = getAccessControlFromAllSources();
  const permissions: PermissionLevel = ac.permissions || 'admin';
  const actionIds: string[] = ac.actionIds || ['*'];
  const entries = listCacheEntries();

  if (entries.length === 0) {
    if (output.isAgentMode()) {
      output.json({ updated: 0, failed: 0, entries: [] });
      return;
    }
    console.log('No cached entries to update');
    return;
  }

  const spinner = output.createSpinner();
  spinner.start(`Updating ${entries.length} cached ${entries.length === 1 ? 'entry' : 'entries'}...`);

  let updated = 0;
  let failed = 0;
  const errors: Array<{ key: string; error: string }> = [];

  for (const e of entries) {
    try {
      if (e.type === 'knowledge') {
        const result = await api.getActionDetailsWithMeta(e.entry.key);
        const newEntry = makeCacheEntry(e.entry.key, result.data, result.etag);
        writeCache(e.filePath, newEntry);
        updated++;
      } else {
        // Search entries record the request params (platform/query/searchType)
        // so we can re-run the exact search. Entries written before that change
        // lack them — fall back to a timestamp bump for those.
        const data = e.entry.data as SearchCacheData;
        if (data?.platform && data?.query) {
          const searchType = data.searchType ?? 'knowledge';
          const result = await api.searchActionsWithMeta(
            data.platform, data.query, searchType, e.entry.etag ?? undefined
          );
          if (result.status === 304) {
            // Unchanged — just refresh the timestamp.
            writeCache(e.filePath, { ...e.entry, cachedAt: new Date().toISOString() });
          } else {
            let actions = result.data;
            actions = filterByPermissions(actions, permissions);
            actions = actions.filter((a) => isActionAllowed(a.systemId, actionIds));
            const cleaned = actions.map((a) => ({
              actionId: a.systemId,
              title: a.title,
              method: a.method,
              path: a.path,
            }));
            writeCache(e.filePath, makeCacheEntry(
              e.entry.key,
              { actions: cleaned, platform: data.platform, query: data.query, searchType },
              result.etag
            ));
          }
        } else {
          // Legacy entry without request params — can't re-fetch; bump TTL only.
          writeCache(e.filePath, { ...e.entry, cachedAt: new Date().toISOString() });
        }
        updated++;
      }
    } catch (err) {
      failed++;
      errors.push({
        key: e.entry.key,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  spinner.stop(`Updated ${updated} ${updated === 1 ? 'entry' : 'entries'}${failed > 0 ? `, ${failed} failed` : ''}`);

  if (output.isAgentMode()) {
    output.json({ updated, failed, errors: errors.length > 0 ? errors : undefined });
    return;
  }

  if (errors.length > 0) {
    console.log();
    for (const e of errors) {
      console.log(`  ${pc.red('✗')} ${e.key}: ${pc.dim(e.error)}`);
    }
  }
}
