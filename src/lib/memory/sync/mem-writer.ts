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
  // `--embed` on `sync run` wins over the profile's memory.embed flag.
  // Lets users flip on embeddings for one run (e.g. backfilling after
  // a first sync done with embedOnSync: false) without editing the
  // profile. No override → profile's choice → config default.
  const embedFlag = opts.embedOverride ?? deriveEmbedFlag(profile);
  const searchablePaths = getSearchablePaths(profile);
  // Does this profile have anything to say about identity_keys at all? A
  // profile without `identityKeys` must send NULL (= "no opinion"), never `[]`
  // (= "clear"), or a sync of an unrelated model that happens to merge into the
  // same record would wipe association keys written by another profile's sync
  // or restored by `mem import`.
  const declaresIdentityKeys = (profile.identityKeys?.length ?? 0) > 0;
  // Enrich stamps this field on the merged record before writing it back
  // (enrich.ts sets `merged[tsField] = now`), so its presence is how the
  // writer tells the enriched shape from the list shape. See the
  // `preEnrichShape` comment below for why that distinction matters.
  const enrichTimestampField = profile.enrich?.timestampField ?? '_enriched_at';

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
    // keys[] = entity/merge identifiers (source key + singular identityKey).
    // identity_keys[] = participant associations (plural identityKeys, #128) —
    // a SEPARATE column that never triggers merge, so a Gmail thread carrying
    // many participant emails stays its own record. See schema.ts.
    const keys = [sourceKey, ...collectEntityKeys(record, profile)];

    // Three-state contract for identity_keys, mirrored by mem_upsert_by_keys
    // (schema.ts) — under `replace: true`, NULL keeps and non-NULL replaces:
    //   undefined → "I have no opinion, keep what's stored"
    //   []        → "I authoritatively resolved zero participants, clear it"
    //   [a, b]    → "these exactly"
    //
    // The pre-enrich shape is the whole reason the first state exists. A
    // profile like gmail/gmailThreads resolves its identity keys out of
    // fields that only enrichment fetches (`messages[].payload.headers[...]`)
    // while `threads.list` returns `{id, snippet, historyId}`. Phase 1 runs
    // unconditionally on every page of every run (runner.ts), so if it
    // reported `[]` here it would clear the column — and phase 2 could not
    // put it back, because enrich only visits rows with `_enriched_at IS
    // NULL`. Result: keys present after the first sync, gone after the
    // second. So while an enrich profile's record is still the list shape we
    // stay silent and let the enriched write be the authority.
    const preEnrichShape = !!profile.enrich && record[enrichTimestampField] == null;
    const identityKeys =
      !declaresIdentityKeys || preEnrichShape
        ? undefined
        : collectAssociationKeys(record, profile);

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
          identity_keys: identityKeys,
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

/**
 * Prefix heuristic for the SINGULAR `identityKey` — the path name decides the
 * namespace. Order matters and must not change: `email` is checked first, so
 * `emailDomain` derives `email:` (as it has since the feature shipped).
 * Re-prioritising would silently re-namespace every existing profile's keys
 * and break the merge they already perform.
 *
 * Exported so `sync test` / migrate never re-implement it (they used to, and
 * the copies drifted).
 */
export function deriveIdentityPrefix(dotPath: string): string {
  const lower = dotPath.toLowerCase();
  if (lower.includes('email')) return 'email';
  if (lower.includes('phone')) return 'phone';
  if (lower.includes('domain')) return 'domain';
  return 'id';
}

// Liberal email matcher — used to pull addresses out of mail-header values like
// `"Jane Smith <jane@acme.com>"` or comma-lists `"a@x.com, Bob <b@y.com>"` (#129).
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Turn one resolved raw value into zero or more normalized key values for the
 * given prefix. For `email` keys we extract every email address found in the
 * value (so display-name headers and comma-lists work, and already-clean
 * emails pass through unchanged). For every other prefix we lowercase/trim the
 * whole scalar value. Objects/arrays/empties yield nothing.
 *
 * `fallbackToScalar` makes email extraction ADDITIVE rather than replacing:
 * when the regex finds no address we fall back to the plain lowercase/trim
 * scalar. Only the singular `identityKey` sets it, and it has to — the prefix
 * is derived from the path name, so `identityKey: "emailDomain"` (`acme.com`),
 * `"email_id"` (`abc123`), or a non-RFC address (`josé@acme.com`,
 * `jane@localhost`) all get the `email` prefix while carrying no matchable
 * address. Without the fallback those profiles would silently stop emitting
 * the entity key they have always emitted. The plural `identityKeys` path
 * deliberately does NOT fall back: a `To:` header with no address must
 * contribute nothing rather than dump the whole header into `identity_keys[]`.
 */
function identityValuesFor(
  prefix: string,
  raw: unknown,
  opts: { fallbackToScalar?: boolean } = {},
): string[] {
  if (raw === null || raw === undefined || typeof raw === 'object') return [];
  const s = String(raw);
  if (prefix === 'email') {
    const found = (s.match(EMAIL_RE) ?? []).map(e => e.toLowerCase());
    if (found.length > 0 || !opts.fallbackToScalar) return found;
  }
  const v = s.toLowerCase().trim();
  return v ? [v] : [];
}

type PathToken =
  | { type: 'field'; name: string }
  | { type: 'index'; i: number }
  | { type: 'wild' }
  | { type: 'filter'; field: string; value: string };

/**
 * Tokenize an identity dot-path. Beyond plain fields it supports:
 *   `[]`            array wildcard (fan out over every element)
 *   `[0]`           numeric index
 *   `[name=From]`   equality filter — keep array elements whose `name` field
 *                   equals `From` (case-insensitive; quotes optional). Needed
 *                   for Gmail headers (#129): `payload.headers[name=From].value`.
 */
function tokenizeIdentityPath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  const re = /([^.[\]]+)|\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ type: 'field', name: m[1] });
    } else {
      const inner = m[2];
      if (inner === '') tokens.push({ type: 'wild' });
      else if (/^\d+$/.test(inner)) tokens.push({ type: 'index', i: Number(inner) });
      else {
        const eq = inner.indexOf('=');
        if (eq > 0) {
          const field = inner.slice(0, eq).trim();
          const value = inner.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
          tokens.push({ type: 'filter', field, value });
        }
        // Unknown bracket content is ignored (no match → no keys).
      }
    }
  }
  return tokens;
}

/**
 * Resolve an identity path against a record, returning a flat list of leaf
 * values. Walks a "frontier" of values so `[]` wildcards and `[name=From]`
 * filters fan out naturally. Superset of the plain dot-path / `[]` resolver.
 */
function resolveIdentityPath(root: unknown, path: string): unknown[] {
  let frontier: unknown[] = [root];
  for (const tok of tokenizeIdentityPath(path)) {
    const next: unknown[] = [];
    for (const cur of frontier) {
      if (cur === null || cur === undefined) continue;
      if (tok.type === 'field') {
        // A numeric segment reached with a dot (`ids.0`, `contact.emails.0.address`)
        // indexes into an array — `getByDotPath` has always done this, and this
        // resolver must stay a strict superset of it or profiles written against
        // the old dot-only syntax silently stop producing keys.
        if (Array.isArray(cur)) {
          if (/^\d+$/.test(tok.name)) next.push(cur[Number(tok.name)]);
        } else if (typeof cur === 'object') {
          next.push((cur as Record<string, unknown>)[tok.name]);
        }
      } else if (tok.type === 'index') {
        if (Array.isArray(cur)) next.push(cur[tok.i]);
      } else if (tok.type === 'wild') {
        if (Array.isArray(cur)) next.push(...cur);
      } else { // filter
        if (Array.isArray(cur)) {
          for (const el of cur) {
            if (el && typeof el === 'object' &&
                String((el as Record<string, unknown>)[tok.field] ?? '').toLowerCase() === tok.value.toLowerCase()) {
              next.push(el);
            }
          }
        }
      }
    }
    frontier = next;
  }
  return frontier;
}

/** Resolve one {prefix, path} entry to its (possibly many) prefixed keys. */
function keysForEntry(record: Record<string, unknown>, prefix: string, path: string): string[] {
  if (!prefix || !path) return [];
  const out: string[] = [];
  for (const raw of resolveIdentityPath(record, path)) {
    for (const value of identityValuesFor(prefix, raw)) out.push(`${prefix}:${value}`);
  }
  return out;
}

/**
 * A prefix is a key namespace, so it has to be literal: `find-by-key` and the
 * uniqueness trigger both compare `prefix:value` as plain text. Lowercase +
 * trim so `"Email"` and `" email "` land on the documented `email:` namespace,
 * and reject anything that isn't `[a-z0-9_]` (spaces / colons would make the
 * key unparseable, since `:` is the prefix separator).
 */
function normalizePrefix(prefix: string): string | null {
  const p = prefix.trim().toLowerCase();
  return /^[a-z0-9_]+$/.test(p) ? p : null;
}

function dedupe(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * The ONE place the singular `identityKey` is turned into an identity. Every
 * caller that used to inline `String(getByDotPath(rec, identityKey)).toLowerCase().trim()`
 * (sync runner's `_identity`, enrich's `_identity`, `mem migrate`'s identity
 * pre-pass) goes through this, otherwise the same record gets `email:jane@acme.com` from
 * one code path and `email:jane smith <jane@acme.com>` from another and the
 * two never merge.
 *
 * `value` / `key` are only set when the path resolves to EXACTLY ONE candidate.
 * That guard is the whole point of the type: `keys[]` is the merge + uniqueness
 * column, so a path that fans out (a comma-list of addresses, an `emails[].v`
 * wildcard) would hand one record several entity identities. With sync's
 * `replace: true` that either overwrites another entity's row wholesale or
 * trips `unique_violation`. Ambiguous → emit nothing and let the profile
 * author fix the path (`values` is exposed so `sync test` can say so loudly).
 */
export interface EntityIdentity {
  /** Namespace derived from the path (`email` / `phone` / `domain` / `id`). */
  prefix: string;
  /** Every distinct normalized candidate the path resolved to. */
  values: string[];
  /** The single normalized value, or null when the path is empty/ambiguous. */
  value: string | null;
  /** `prefix:value` for `keys[]`, or null when the path is empty/ambiguous. */
  key: string | null;
}

export function resolveEntityIdentity(
  record: Record<string, unknown>,
  identityKey: string | undefined,
): EntityIdentity | null {
  if (!identityKey) return null;
  const prefix = deriveIdentityPrefix(identityKey);
  const values = dedupe(
    resolveIdentityPath(record, identityKey)
      .flatMap(raw => identityValuesFor(prefix, raw, { fallbackToScalar: true })),
  );
  const value = values.length === 1 ? values[0] : null;
  return { prefix, values, value, key: value ? `${prefix}:${value}` : null };
}

/**
 * Normalize a single already-resolved raw identity value the same way
 * `resolveEntityIdentity` would. For callers that read the value out-of-band
 * (e.g. `mem migrate`'s SQL pre-pass, which extracts the identity with a JSONB
 * expression instead of walking the record) and must land on the identical
 * string or the merge lookup misses.
 */
export function normalizeEntityIdentityValue(identityKey: string, raw: unknown): string | null {
  const values = dedupe(identityValuesFor(deriveIdentityPrefix(identityKey), raw, { fallbackToScalar: true }));
  return values.length === 1 ? values[0] : null;
}

/**
 * ENTITY keys — from a profile's singular `identityKey`. These mean "this
 * record IS this entity" and go into `keys[]`, where the store uses them to
 * merge cross-platform records for the same entity (Attio + HubSpot for the
 * same person). AT MOST ONE key: see `EntityIdentity` for why a fan-out path
 * must yield zero rather than several (or a first-match guess).
 */
export function collectEntityKeys(
  record: Record<string, unknown>,
  profile: Pick<SyncProfile, 'identityKey'>,
): string[] {
  const identity = resolveEntityIdentity(record, profile.identityKey);
  return identity?.key ? [identity.key] : [];
}

/**
 * ASSOCIATION keys — from a profile's plural `identityKeys` (#128). These mean
 * "this record INVOLVES these people" (thread participants, event attendees)
 * and go into the separate `identity_keys[]` column, which does NOT drive
 * merge/uniqueness — so a many-participant record keeps its own identity.
 * Each entry's `path` supports `[]` wildcard + `[name=From]` filter fan-out;
 * `email`-prefixed values are email-extracted (handles `"Jane <j@x.com>"` and
 * comma-lists). Prefixes are normalized (`"Email"` → `email`) and validated,
 * so an entry can't strand its keys in a namespace `mem find-by-key email:…`
 * will never look in. Deduped, first-seen order preserved.
 */
export function collectAssociationKeys(
  record: Record<string, unknown>,
  profile: Pick<SyncProfile, 'identityKeys'>,
): string[] {
  const out: string[] = [];
  for (const entry of profile.identityKeys ?? []) {
    if (!entry || !entry.path || !entry.prefix) continue;
    const prefix = normalizePrefix(entry.prefix);
    if (!prefix) continue; // unusable namespace — drop the entry rather than write garbage keys
    out.push(...keysForEntry(record, prefix, entry.path));
  }
  return dedupe(out);
}

/**
 * All cross-platform identity keys for a record (entity ∪ association),
 * deduped. Used by `sync test` previews and tests; the writer routes the two
 * kinds into their separate columns via the functions above.
 */
export function collectIdentityKeys(
  record: Record<string, unknown>,
  profile: Pick<SyncProfile, 'identityKey' | 'identityKeys'>,
): string[] {
  return dedupe([...collectEntityKeys(record, profile), ...collectAssociationKeys(record, profile)]);
}
