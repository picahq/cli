import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CacheEntry, CacheMeta } from './types.js';
import { getCacheTtl } from './config.js';

const CACHE_BASE = path.join(os.homedir(), '.one', 'cache');
const KNOWLEDGE_DIR = path.join(CACHE_BASE, 'knowledge');
const SEARCH_DIR = path.join(CACHE_BASE, 'search');

export function sanitizeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

export function knowledgeCachePath(actionId: string): string {
  return path.join(KNOWLEDGE_DIR, `${sanitizeFilename(actionId)}.json`);
}

export function searchCachePath(platform: string, query: string, type: string): string {
  const key = `${platform}_${sanitizeFilename(query)}_${type || 'knowledge'}`;
  return path.join(SEARCH_DIR, `${key}.json`);
}

export function readCache<T>(filePath: string): CacheEntry<T> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as CacheEntry<T>;
  } catch {
    return null;
  }
}

export function writeCache<T>(filePath: string, entry: CacheEntry<T>): void {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
  } catch {
    // Cache write failures should never crash the CLI
  }
}

export function isFresh(entry: CacheEntry): boolean {
  const cachedTime = new Date(entry.cachedAt).getTime();
  const now = Date.now();
  return now - cachedTime < entry.ttl * 1000;
}

export function getAge(entry: CacheEntry): number {
  return Math.floor((Date.now() - new Date(entry.cachedAt).getTime()) / 1000);
}

export function buildCacheMeta(entry: CacheEntry | null, hit: boolean): CacheMeta {
  if (!entry) {
    return { hit: false, age: 0, fresh: false };
  }
  return {
    hit,
    age: getAge(entry),
    fresh: isFresh(entry),
  };
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function listCacheEntries(): Array<{ type: 'knowledge' | 'search'; filePath: string; entry: CacheEntry }> {
  const entries: Array<{ type: 'knowledge' | 'search'; filePath: string; entry: CacheEntry }> = [];

  for (const [dir, type] of [[KNOWLEDGE_DIR, 'knowledge'], [SEARCH_DIR, 'search']] as const) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dir, file);
        const entry = readCache(filePath);
        if (entry) {
          entries.push({ type, filePath, entry });
        }
      }
    } catch {
      // Directory doesn't exist yet — no entries
    }
  }

  return entries;
}

export function clearAll(): number {
  let count = 0;
  for (const dir of [KNOWLEDGE_DIR, SEARCH_DIR]) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        fs.unlinkSync(path.join(dir, file));
        count++;
      }
      fs.rmdirSync(dir);
    } catch {
      // Directory doesn't exist — nothing to clear
    }
  }
  return count;
}

export function clearEntry(actionId: string): boolean {
  const filePath = knowledgeCachePath(actionId);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function makeCacheEntry<T>(key: string, data: T, etag: string | null): CacheEntry<T> {
  return {
    key,
    etag,
    cachedAt: new Date().toISOString(),
    ttl: getCacheTtl(),
    data,
  };
}
