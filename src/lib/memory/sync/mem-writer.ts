/**
 * Optional write-through to the unified memory store.
 *
 * When `one sync run --to-memory` is passed, the runner invokes this for
 * each page of records. Writes go through `upsertRecord` (which handles
 * embedding gates, content_hash, searchable_text extraction) keyed by the
 * prefixed source id plus the profile's identity key (if set).
 *
 * This is additive: the SQLite store keeps working as it does today. Once
 * the dual-write has been verified in practice we can flip sync to write
 * exclusively to memory.
 */

import { upsertRecord } from '../runtime.js';
import type { SyncProfile } from './types.js';
import { getByDotPath } from '../../dot-path.js';

export interface MemWriteReport {
  attempted: number;
  inserted: number;
  updated: number;
  skipped: number;
  /**
   * Source keys (`<platform>/<model>:<id>`) that landed during this page.
   * Used by `--full-refresh` to reconcile against memory records whose
   * source didn't appear this run (those get archived).
   */
  sourceKeysSeen: string[];
  /**
   * Per-action record arrays so hook dispatch can fire `onInsert` vs
   * `onUpdate` without a second classify pass. Only populated when
   * `capturePerAction: true` is set — otherwise kept empty to avoid
   * the memory cost on large syncs with no hooks.
   */
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

/**
 * Resolve a path that may contain `[]` array-wildcards (e.g.
 * `messages[].snippet`, `messages[].payload.parts[].body.data`).
 *
 * - `a.b[].c`   → for each element of `a.b`, resolve `.c`
 * - `a[0].b`    → numeric index works (already supported by getByDotPath)
 * - `a.b`       → plain dot-path
 *
 * Returns a flat list of leaf values (strings / numbers / booleans);
 * caller decides how to fold them into searchable text.
 */
function resolveWildcardPath(root: unknown, path: string): unknown[] {
  // Split on `[]` boundaries keeping track of each segment. The segment
  // before the first `[]` is a regular dot-path; after each `[]` the
  // remainder is applied per-element, recursively.
  const segments = path.split('[]');
  if (segments.length === 1) {
    // No wildcard — delegate to the existing resolver.
    return [getByDotPath(root, path)];
  }

  const recurse = (value: unknown, idx: number): unknown[] => {
    if (value === null || value === undefined) return [];
    // `idx` points at the NEXT segment (to be applied after a `[]`).
    const segment = segments[idx];
    const head = segment.startsWith('.') ? segment.slice(1) : segment;

    if (idx === segments.length - 1) {
      // Last segment: apply to each array element (or the value directly
      // if there's no tail segment), return the leaves.
      if (!Array.isArray(value)) return [];
      if (head === '') return value; // path ends with `[]` — return all elements
      return value.map(el => getByDotPath(el, head));
    }

    // More segments remain → descend into the array and recurse.
    if (!Array.isArray(value)) return [];
    const results: unknown[] = [];
    for (const el of value) {
      const next = head === '' ? el : getByDotPath(el, head);
      results.push(...recurse(next, idx + 1));
    }
    return results;
  };

  // Apply the first segment normally (can itself be a dotted path), then
  // descend element-by-element through the remaining segments.
  const firstHead = segments[0];
  const firstValue = firstHead === '' ? root : getByDotPath(root, firstHead);
  return recurse(firstValue, 1);
}

/**
 * Build the embeddable / FTS text for a synced record from agent-declared
 * dot-paths. Resolves each path, keeps string/number/boolean leaves, flattens
 * arrays of strings, drops empties. Nested objects are intentionally NOT
 * walked — the agent must declare deeper paths if they want that content
 * (otherwise we're back to the "embed everything" noise problem).
 *
 * Paths support `[]` wildcards for array fan-out:
 *   values.name[0].full_name              (numeric index)
 *   messages[].snippet                    (wildcard over array)
 *   messages[].payload.parts[].body.data  (nested wildcards)
 *
 * Exported so `sync test --show-searchable` can preview the output without
 * running a real sync.
 */
export function extractSearchableFromPaths(
  record: Record<string, unknown>,
  paths: string[],
): { text: string; paths: Array<{ path: string; found: boolean; sample: string }> } {
  const parts: string[] = [];
  const perPath: Array<{ path: string; found: boolean; sample: string }> = [];

  for (const path of paths) {
    const values = resolveWildcardPath(record, path);
    const collected: string[] = [];

    const absorb = (v: unknown): void => {
      if (v === null || v === undefined) return;
      if (typeof v === 'string') {
        const t = v.trim();
        if (t) collected.push(t);
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        collected.push(String(v));
      } else if (Array.isArray(v)) {
        for (const inner of v) absorb(inner);
      }
      // Objects are not walked on purpose — declare deeper paths if needed.
    };

    for (const v of values) absorb(v);

    if (collected.length > 0) {
      parts.push(...collected);
      perPath.push({ path, found: true, sample: collected.join(' ').slice(0, 80) });
    } else {
      perPath.push({ path, found: false, sample: '' });
    }
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return { text, paths: perPath };
}

/**
 * Returns the declared searchable paths for a profile, or undefined when
 * nothing is configured (callers fall back to `defaultSearchableText`).
 */
export function getSearchablePaths(profile: SyncProfile): string[] | undefined {
  const paths = profile.memory?.searchable;
  if (!paths || !Array.isArray(paths) || paths.length === 0) return undefined;
  return paths;
}

export async function writePageToMemory(
  profile: SyncProfile,
  records: Array<Record<string, unknown>>,
  opts: { capturePerAction?: boolean; embedOverride?: boolean } = {},
): Promise<MemWriteReport> {
  const report: MemWriteReport = {
    attempted: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    sourceKeysSeen: [],
    inserts: [],
    updates: [],
  };
  const type = `${profile.platform}/${profile.model}`;
  const identityKey = profile.identityKey;
  // `--embed` on `sync run` wins over the profile's memory.embed flag.
  // Lets users flip on embeddings for one run (e.g. backfilling after
  // a first sync done with embedOnSync: false) without editing the
  // profile. No override → profile's choice → config default.
  const embedFlag = opts.embedOverride ?? deriveEmbedFlag(profile);
  const searchablePaths = getSearchablePaths(profile);

  for (const record of records) {
    report.attempted++;
    // Support dotted idField paths (e.g. "id.record_id") so profiles
    // against APIs whose ids live inside a nested object (Attio v2,
    // some Airtable shapes) don't silently collapse every record to
    // the same "[object Object]" key.
    const externalId = getByDotPath(record, profile.idField);
    if (externalId === undefined || externalId === null || externalId === '') {
      report.skipped++;
      continue;
    }
    // HARD GUARD against the object-stringification footgun. If we got
    // here with an object, sync test should have caught it — but skip
    // with a visible count so the caller sees something is off.
    if (typeof externalId === 'object') {
      report.skipped++;
      continue;
    }

    const sourceKey = `${type}:${String(externalId)}`;
    const keys = [sourceKey];

    if (identityKey) {
      const raw = getByDotPath(record, identityKey);
      if (raw !== null && raw !== undefined && raw !== '') {
        keys.push(`${deriveIdentityPrefix(identityKey)}:${String(raw).toLowerCase().trim()}`);
      }
    }

    // Strip sync-internal bookkeeping from the payload
    const data = { ...record };
    for (const k of Object.keys(data)) {
      if (k.startsWith('_')) delete data[k];
    }

    // When the profile declares searchable paths, extract directly so the
    // embedding + FTS text is clean. Otherwise let the runtime fall back
    // to `defaultSearchableText` which walks the whole record.
    const searchable_text = searchablePaths
      ? extractSearchableFromPaths(record, searchablePaths).text
      : undefined;

    try {
      const res = await upsertRecord(
        {
          type,
          data,
          keys,
          searchable_text,
          sources: {
            [sourceKey]: {
              last_synced_at: new Date().toISOString(),
              metadata: { source: profile.platform },
            },
          },
          tags: ['synced', profile.platform],
          embed: embedFlag,
        },
        // Sync must REPLACE: if a field vanished at the source (phone
        // number removed, Gmail thread archived) it must also vanish
        // from memory. The default merge behaviour is correct for
        // interactive `mem add` / `mem update`, wrong for sync.
        { embed: embedFlag, replace: true },
      );
      report.sourceKeysSeen.push(sourceKey);
      if (res.action === 'inserted') {
        report.inserted++;
        if (opts.capturePerAction) report.inserts.push(record);
      } else {
        report.updated++;
        if (opts.capturePerAction) report.updates.push(record);
      }
    } catch {
      report.skipped++;
    }
  }
  return report;
}

function deriveEmbedFlag(profile: SyncProfile): boolean {
  if (profile.memory && typeof profile.memory.embed === 'boolean') return profile.memory.embed;
  return false;
}

function deriveIdentityPrefix(dotPath: string): string {
  const lower = dotPath.toLowerCase();
  if (lower.includes('email')) return 'email';
  if (lower.includes('phone')) return 'phone';
  if (lower.includes('domain')) return 'domain';
  return 'id';
}
