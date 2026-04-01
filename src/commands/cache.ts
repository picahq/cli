import pc from 'picocolors';
import { getApiKey, getApiBase } from '../lib/config.js';
import { OneApi } from '../lib/api.js';
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
import type { ActionKnowledgeResponse } from '../lib/types.js';

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
        const result = await api.getActionKnowledgeWithMeta(e.entry.key);
        const newEntry = makeCacheEntry(e.entry.key, result.data, result.etag);
        writeCache(e.filePath, newEntry);
        updated++;
      } else {
        // Search entries: re-fetch based on the cached key parts
        // Key format: platform_query_type
        // We can't perfectly reconstruct the original query, so just refresh TTL
        // by marking as freshly cached with existing data
        const refreshed = { ...e.entry, cachedAt: new Date().toISOString() };
        writeCache(e.filePath, refreshed);
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
