import type { OneApi } from '../../api.js';
import { ApiError } from '../../api.js';
import { resolveActionDetails } from '../../action-details.js';
import { isAgentMode } from '../../output.js';
import type { EnrichConfig, SyncProfile } from './types.js';
import type { ActionDetails } from '../../types.js';
import { writePageToMemory, resolveEntityIdentity } from './mem-writer.js';
import type Database from 'better-sqlite3';
import { transformRecords } from './transform.js';
import { fireHooks, type ChangeEvent } from './hooks.js';

/**
 * Phase 2 enrichment engine. Runs AFTER the list sync completes.
 *
 * Queries all rows where _enriched_at IS NULL (new or never-enriched),
 * calls a detail endpoint per record, merges the response, and writes it
 * back. Inherently resumable — if the process dies mid-enrichment,
 * re-running picks up where it left off.
 *
 * Rate limiting is first-class:
 * - Honors Retry-After headers from 429 responses
 * - Exponential backoff per record (2s → 4s → 8s)
 * - Configurable concurrency (default 5) with shared backoff: when ANY
 *   worker hits 429, ALL workers pause before the next batch
 * - Per-record retry up to 3 times before skipping
 */

const DEFAULT_CONCURRENCY = 5;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Interpolate {field} and {{field}} placeholders using the record's fields. */
function interpolate(template: string, record: Record<string, unknown>): string {
  return template.replace(/\{?\{(\w+(?:\.\w+)*)\}\}?/g, (_, path: string) => {
    const parts = path.split('.');
    let value: unknown = record;
    for (const part of parts) {
      if (typeof value !== 'object' || value === null) return '';
      value = (value as Record<string, unknown>)[part];
    }
    return value === null || value === undefined ? '' : String(value);
  });
}

function interpolateParams(
  template: Record<string, string | number | boolean> | undefined,
  record: Record<string, unknown>,
): Record<string, string | number | boolean> | undefined {
  if (!template) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(template)) {
    out[key] = typeof value === 'string' ? interpolate(value, record) : value;
  }
  return out;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function getByDotPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Strip fields from an object by dot-path. Supports array wildcard:
 *   "messages[].payload.parts[].body.data"  →  messages[*].payload.parts[*].body.data
 *   "messages.*.payload"                    →  messages[*].payload (also accepted)
 */
function stripExcludedFields(obj: Record<string, unknown>, paths: string[]): void {
  for (const path of paths) {
    stripOnePath(obj, path.replace(/\[\]/g, '.*').split('.'));
  }
}

function stripOnePath(obj: Record<string, unknown>, parts: string[]): void {
  if (parts.length === 0 || !obj || typeof obj !== 'object') return;
  const [current, ...rest] = parts;

  if (current === '*') {
    // Wildcard — iterate all values that are arrays or objects
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            stripOnePath(item as Record<string, unknown>, rest);
          }
        }
      }
    }
    return;
  }

  if (rest.length === 0) {
    delete obj[current];
    return;
  }

  const child = obj[current];
  if (Array.isArray(child) && rest[0] === '*') {
    // "messages.*.payload" → iterate array
    for (const item of child) {
      if (typeof item === 'object' && item !== null) {
        stripOnePath(item as Record<string, unknown>, rest.slice(1));
      }
    }
  } else if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
    stripOnePath(child as Record<string, unknown>, rest);
  }
}

/** Pick only specific fields from an object. */
function pickFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = getByDotPath(obj, field);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

export interface EnrichResult {
  enriched: number;
  skipped: number;
  rateLimited: number;
  total: number;
  duration: string;
}

/**
 * Which of these records has phase 2 ALREADY enriched?
 *
 * The exact mirror of the `WHERE "<tsField>" IS NULL` query `enrichPhase`
 * runs below, and it lives here so the two halves of the `_enriched_at`
 * contract stay in one file.
 *
 * It exists because phase 1's memory write is unconditional — it runs for
 * every record on every page of every run — while phase 2 never revisits a
 * row whose timestamp is already stamped. So on run 2 the thin list shape
 * (`{id, snippet, historyId}` for gmail) would REPLACE the enriched payload
 * in memory (mem-writer sends `replace: true`), and nothing would ever put
 * the thread bodies back. Phase 1 asks this question first and then leaves
 * those records alone; see the call site in runner.ts for the rule.
 *
 * Returns STRINGIFIED ids so the caller can compare against whatever its
 * idField resolved to without caring about SQLite's INTEGER/TEXT affinity.
 *
 * Every failure mode degrades to an EMPTY set — i.e. to the historical
 * "write everything" behaviour — because a wrong answer here loses data in
 * one direction only: writing when we needn't is a no-op refresh, skipping
 * when we shouldn't leaves a record missing from memory. Deliberately
 * empty for: table not created yet (first page of the first run), the
 * timestamp column not added yet (phase 2 ALTERs it in on demand, so its
 * absence is the normal never-enriched state), an idField with no matching
 * SQLite column (a dotted idField — the flat SQLite mirror can't represent
 * one, so we can't answer and must not guess), and any SQL error at all.
 *
 * When `config.revisionField` is set, "enriched" narrows to "enriched AND
 * still current": a row whose incoming list record carries a revision value
 * that has moved past the one captured at its last enrichment is EXCLUDED
 * from the returned set, even though its timestamp is stamped — it's about
 * to be re-enriched by `enrichPhase`'s mirrored query, so phase 1 must not
 * treat it as stable and preserve a payload that is already stale.
 */
export function findEnrichedIds(
  db: Database.Database,
  model: string,
  idField: string,
  config: EnrichConfig,
  records: Array<Record<string, unknown>>,
  tableCreated: boolean,
): Set<string> {
  const enriched = new Set<string>();
  if (!tableCreated || records.length === 0) return enriched;

  const tsField = config.timestampField ?? '_enriched_at';
  const revisionField = config.revisionField;
  const revisionStampField = revisionField ? `${tsField}_rev` : undefined;
  const safeTable = model.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeIdField = idField.replace(/"/g, '""');
  const safeTsField = tsField.replace(/"/g, '""');

  try {
    const cols = (db.prepare(`PRAGMA table_info("${safeTable}")`).all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes(tsField) || !cols.includes(idField)) return enriched;
    const hasRevisionStamp = !!revisionStampField && cols.includes(revisionStampField);

    // `records` uses the flat top-level key, matching how `upsertRecords` and
    // `classifyRecords` address the SQLite mirror's id column.
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of records) {
      const id = r[idField];
      if (typeof id === 'string' || typeof id === 'number') byId.set(String(id), r);
    }
    if (byId.size === 0) return enriched;

    // Chunk the IN clause to stay under SQLite's variable limit, same as
    // classifyRecords.
    const ids = [...byId.keys()];
    const safeRevisionStampField = hasRevisionStamp ? revisionStampField!.replace(/"/g, '""') : undefined;
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT "${safeIdField}" AS id${hasRevisionStamp ? `, "${safeRevisionStampField}" AS rev` : ''} FROM "${safeTable}" ` +
        `WHERE "${safeTsField}" IS NOT NULL AND "${safeIdField}" IN (${placeholders})`
      ).all(...chunk) as Array<{ id: string | number; rev?: string | number | null }>;
      for (const row of rows) {
        const id = String(row.id);
        if (revisionField && hasRevisionStamp) {
          // Compare the INCOMING list record's revision (what phase 1 is
          // about to write) against the value frozen at last enrichment.
          // An incoming record missing the field can't prove staleness, so
          // it falls through to "still enriched" — same "can't answer, must
          // not guess" rule the rest of this function follows.
          const incomingRev = byId.get(id)?.[revisionField];
          if (incomingRev !== undefined && String(incomingRev) !== String(row.rev ?? '')) {
            continue; // due for re-enrichment — don't mark it stable
          }
        }
        enriched.add(id);
      }
    }
  } catch {
    // Corrupt mirror, renamed column, whatever — never crash a sync over an
    // optimisation. Fall back to writing every record, as we always did.
    return new Set();
  }

  return enriched;
}

/**
 * Profile-level hooks/transforms that must be applied to each enriched row
 * before it's written back to SQL. Mirrors the Phase 1 pipeline so that
 * rows produced by enrichment end up with the same columns, identity, and
 * event stream as rows written during list ingestion.
 */
export interface EnrichContext {
  /** profile.transform — runs on the merged batch after enrich, before upsert. */
  transform?: string;
  /** profile.exclude — dot-paths stripped from each merged record. */
  exclude?: string[];
  /** profile.identityKey — recomputes `_identity` from the merged record. */
  identityKey?: string;
  /** profile.onInsert — not used here: enriched rows always existed, so they're updates. */
  onInsert?: string;
  /** profile.onUpdate — fired per row after a successful enrichment UPDATE. */
  onUpdate?: string;
  /** profile.onChange — fallback hook fired when onUpdate isn't set. */
  onChange?: string;
  /**
   * Full profile, passed so enrich can mirror merged rows into the unified
   * memory store (mem-writer handles identity-key, sources, tags, embed,
   * searchable paths). Without this, memory holds the pre-enrich list
   * payload while SQLite gets the enriched detail — which defeats the
   * memory-primary story for profiles with an enrich block (Gmail, Fathom).
   */
  profile?: SyncProfile;
}

/**
 * Phase 2: Enrich unenriched (or STALE) rows in the local DB.
 *
 * Queries rows where the timestamp field IS NULL — never enriched — plus,
 * when `config.revisionField` is set, rows whose revision has moved past
 * the value captured at their last enrichment. Calls the detail endpoint
 * per record, merges the response back, and updates the row.
 *
 * By the time this runs, phase 1 (runner.ts) has already written this run's
 * list page into SQLite, so the revision column already holds the FRESH
 * live value — the comparison below reads it straight off the row.
 */
export async function enrichPhase(
  api: OneApi,
  db: Database.Database,
  config: EnrichConfig,
  model: string,
  idField: string,
  connectionKey: string,
  platform: string,
  ctx: EnrichContext = {},
): Promise<EnrichResult> {
  const startTime = Date.now();
  const tsField = config.timestampField ?? '_enriched_at';
  const revisionField = config.revisionField;
  const revisionStampField = revisionField ? `${tsField}_rev` : undefined;
  const safeTable = model.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeIdField = idField.replace(/"/g, '""');

  // Ensure the _enriched_at column (and, if configured, its revision-stamp
  // companion) exist.
  let cols = db.prepare(`PRAGMA table_info("${safeTable}")`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === tsField)) {
    db.exec(`ALTER TABLE "${safeTable}" ADD COLUMN "${tsField}" TEXT`);
  }
  if (revisionStampField && !cols.some(c => c.name === revisionStampField)) {
    db.exec(`ALTER TABLE "${safeTable}" ADD COLUMN "${revisionStampField}" TEXT`);
  }
  cols = db.prepare(`PRAGMA table_info("${safeTable}")`).all() as Array<{ name: string }>;

  // Only add the staleness branch when the revision column actually exists
  // in the mirror (i.e. the list phase has ever populated it) — same
  // "can't answer, don't guess" rule findEnrichedIds follows.
  const hasRevisionColumn = !!revisionField && cols.some(c => c.name === revisionField);
  let whereClause = `"${tsField}" IS NULL`;
  if (hasRevisionColumn && revisionStampField) {
    const safeRevisionField = revisionField!.replace(/"/g, '""');
    const safeRevisionStampField = revisionStampField.replace(/"/g, '""');
    whereClause += ` OR ("${safeRevisionField}" IS NOT NULL AND ` +
      `("${safeRevisionStampField}" IS NULL OR "${safeRevisionField}" != "${safeRevisionStampField}"))`;
  }

  // Get all unenriched-or-stale rows
  const unenriched = db.prepare(
    `SELECT * FROM "${safeTable}" WHERE ${whereClause}`
  ).all() as Record<string, unknown>[];

  const total = unenriched.length;
  if (total === 0) {
    return { enriched: 0, skipped: 0, rateLimited: 0, total: 0, duration: '0s' };
  }

  // Parse JSON strings back to objects for interpolation
  for (const row of unenriched) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try { row[key] = JSON.parse(value); } catch { /* keep as string */ }
      }
    }
  }

  // Preload the detail action once (cache-served when fresh)
  let detailAction: ActionDetails;
  try {
    detailAction = (await resolveActionDetails(api, config.actionId)).details;
  } catch (err) {
    throw new Error(
      `Enrich: could not load action ${config.actionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Hard block: enrich actions also must be passthrough. Custom actions
  // collapse under the per-row fan-out that enrichment performs.
  if (detailAction.tags?.includes('custom')) {
    throw new Error(
      `Enrich does not support custom actions. Action ${config.actionId} is tagged "custom". ` +
      `Use a passthrough detail endpoint — run 'one actions search ${platform} "<model> get"' to find one.`
    );
  }

  let concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  let enriched = 0;
  let skipped = 0;
  let rateLimited = 0;

  // Process in batches of `concurrency`
  for (let i = 0; i < unenriched.length; i += concurrency) {
    const batch = unenriched.slice(i, i + concurrency);

    if (!isAgentMode()) {
      process.stderr.write(`  Enriching ${platform}/${model}... ${i}/${total}\r`);
    }

    const results = await Promise.allSettled(
      batch.map(row => enrichSingleRow(api, detailAction, config, row, connectionKey, platform))
    );

    let batchHitRateLimit = false;
    const now = new Date().toISOString();

    // Step 1: collect successfully-enriched rows as merged records (no writes yet).
    // Accumulating the whole batch before writing lets us apply profile.transform
    // across the batch as a single subprocess invocation, matching Phase 1 semantics.
    type Pending = { merged: Record<string, unknown>; id: unknown };
    const pending: Pending[] = [];

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const row = batch[j];
      const id = row[idField];

      if (result.status === 'fulfilled' && result.value !== null) {
        let enrichedData = result.value;
        if (config.fields && config.fields.length > 0) {
          enrichedData = pickFields(enrichedData, config.fields);
        }
        if (config.exclude && config.exclude.length > 0) {
          stripExcludedFields(enrichedData, config.exclude);
        }
        const merged = config.merge !== false
          ? deepMerge(row, enrichedData)
          : { ...enrichedData, [idField]: id };
        merged[tsField] = now;
        // Freeze the revision this row was AT when we decided to enrich it —
        // read off `row` (this run's fresh list value, already written by
        // phase 1) before the detail merge can touch it. That's what the
        // next run's staleness check compares the live value against.
        if (revisionStampField) merged[revisionStampField] = row[revisionField!];
        pending.push({ merged, id });
      } else if (result.status === 'fulfilled' && result.value === null) {
        rateLimited++;
        skipped++;
        batchHitRateLimit = true;
      } else {
        skipped++;
      }
    }

    // Step 2: run profile.transform on the merged batch. The transform gets the
    // post-merge shape (list fields + enriched fields) so it can extract columns
    // from nested structures that only exist after enrichment (e.g. jq pulling
    // `subject` out of `messages[0].payload.headers`).
    let writes: Pending[] = pending;
    if (ctx.transform && pending.length > 0) {
      const transformed = await transformRecords(ctx.transform, pending.map(p => p.merged));
      if (transformed) {
        // Pair transformed records back to original ids by idField so the UPDATE
        // hits the right row even if the transform reorders or filters.
        const byId = new Map<unknown, Record<string, unknown>>();
        for (const r of transformed) byId.set(r[idField], r);
        writes = [];
        for (const p of pending) {
          const t = byId.get(p.id);
          if (!t) continue; // transform dropped this record — skip update, row stays unenriched
          // Re-assert tsField in case the transform omitted it; if we don't,
          // the row's _enriched_at stays NULL and the next run re-enriches.
          if (!t[tsField]) t[tsField] = now;
          // Same for the revision stamp — if the transform dropped it, the
          // next run can't tell this row was ever revision-checked and would
          // re-enrich it every time.
          if (revisionStampField && t[revisionStampField] === undefined) {
            t[revisionStampField] = p.merged[revisionStampField];
          }
          writes.push({ merged: t, id: p.id });
        }
      }
    }

    // Step 3: per-row profile-level exclude + identity, schema evolution, UPDATE.
    const hookEvents: ChangeEvent[] = [];
    const memoryBatch: Record<string, unknown>[] = [];
    for (const { merged, id } of writes) {
      if (ctx.exclude && ctx.exclude.length > 0) {
        stripExcludedFields(merged, ctx.exclude);
      }
      if (ctx.identityKey) {
        // Same resolver the sync runner and the memory writer use — enrichment
        // recomputes `_identity` from the merged record, and if it normalized
        // differently from the list phase the row's identity would flip on
        // every enrich pass.
        const identity = resolveEntityIdentity(merged, ctx.identityKey);
        if (identity?.value) {
          merged._identity = identity.value;
        }
      }

      const setClauses: string[] = [];
      const values: (string | number | null)[] = [];
      for (const [key, val] of Object.entries(merged)) {
        if (key === idField) continue;
        setClauses.push(`"${key}" = ?`);
        values.push(prepareValue(val));
      }
      values.push(prepareValue(id));

      if (setClauses.length > 0) {
        const existingCols = new Set((db.prepare(`PRAGMA table_info("${safeTable}")`).all() as Array<{ name: string }>).map(c => c.name));
        for (const [key, val] of Object.entries(merged)) {
          if (!existingCols.has(key)) {
            const colType = detectColumnType(val);
            db.exec(`ALTER TABLE "${safeTable}" ADD COLUMN "${key}" ${colType}`);
            existingCols.add(key);
          }
        }
        db.prepare(
          `UPDATE "${safeTable}" SET ${setClauses.join(', ')} WHERE "${safeIdField}" = ?`
        ).run(...values);
      }

      enriched++;
      memoryBatch.push(merged);

      // Enrichment writes are always "update" events — the row existed in SQL
      // before this phase ran (Phase 1 inserted it with _enriched_at NULL).
      if (ctx.onUpdate || ctx.onChange) {
        hookEvents.push({ type: 'update', platform, model, record: merged, timestamp: now });
      }
    }

    // Mirror the enriched batch into the unified memory store. Without this,
    // mem_records.data holds the pre-enrich list shape (ids + snippets) while
    // SQLite has the full thread bodies / meeting transcripts / etc. — which
    // defeats the point of enrich for memory-primary reads. Best-effort: if
    // the profile wasn't plumbed through, skip quietly.
    if (ctx.profile && memoryBatch.length > 0) {
      try {
        await writePageToMemory(ctx.profile, memoryBatch);
      } catch (err) {
        if (!isAgentMode()) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`  Enrich mem-write failed for ${memoryBatch.length} row(s): ${msg}\n`);
        }
      }
    }

    if (hookEvents.length > 0) {
      const hook = ctx.onUpdate || ctx.onChange;
      if (hook) await fireHooks(hook, hookEvents);
    }

    // Shared backoff: if ANY worker in this batch hit a rate limit,
    // pause ALL workers and reduce concurrency
    if (batchHitRateLimit) {
      concurrency = Math.max(1, Math.floor(concurrency / 2));
      if (!isAgentMode()) {
        process.stderr.write(`  Enrich: rate limited — reducing concurrency to ${concurrency}\n`);
      }
      await sleep(BASE_BACKOFF_MS * 4);
    } else if (i + concurrency < unenriched.length) {
      await sleep(config.delayMs ?? 200);
    }
  }

  if (!isAgentMode()) {
    process.stderr.write(`  Enriching ${platform}/${model}... ${enriched}/${total} done\n`);
  }

  const elapsed = Date.now() - startTime;
  const duration = elapsed < 1000 ? `${elapsed}ms`
    : elapsed < 60000 ? `${(elapsed / 1000).toFixed(1)}s`
    : `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`;

  return { enriched, skipped, rateLimited, total, duration };
}

/** Fetch detail data for a single row. Returns null if rate-limited after all retries. */
async function enrichSingleRow(
  api: OneApi,
  detailAction: ActionDetails,
  config: EnrichConfig,
  row: Record<string, unknown>,
  connectionKey: string,
  platform: string,
): Promise<Record<string, unknown> | null> {
  const pathVars = interpolateParams(config.pathVars, row);
  const queryParams = interpolateParams(config.queryParams, row);
  const body = config.body
    ? JSON.parse(interpolate(JSON.stringify(config.body), row))
    : undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await api.executePassthroughRequest({
        platform,
        actionId: config.actionId,
        connectionKey,
        pathVariables: pathVars,
        queryParams,
        data: body,
      }, detailAction);

      // Extract at resultsPath
      let detailData: Record<string, unknown>;
      if (config.resultsPath) {
        const extracted = getByDotPath(result.responseData, config.resultsPath);
        detailData = (typeof extracted === 'object' && extracted !== null && !Array.isArray(extracted))
          ? extracted as Record<string, unknown>
          : { _enriched: extracted };
      } else {
        detailData = (typeof result.responseData === 'object' && result.responseData !== null)
          ? result.responseData as Record<string, unknown>
          : {};
      }

      return detailData;
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const retryAfter = err.retryAfterSeconds ?? Math.min(BASE_BACKOFF_MS / 1000 * Math.pow(2, attempt), 60);
        await sleep(retryAfter * 1000);
        if (attempt === MAX_RETRIES - 1) return null; // signal rate-limited
        continue;
      }
      if (err instanceof ApiError && (err.status >= 500 && err.status <= 504)) {
        // Server error — retry with shorter backoff
        await sleep(Math.min(3 * Math.pow(2, attempt), 20) * 1000);
        if (attempt === MAX_RETRIES - 1) return null;
        continue;
      }
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        throw err; // Auth error — don't retry, bubble up
      }
      // Transient error — backoff and retry
      if (attempt === MAX_RETRIES - 1) return null;
      await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
    }
  }

  return null;
}

function prepareValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function detectColumnType(value: unknown): string {
  if (value === null || value === undefined) return 'TEXT';
  if (typeof value === 'string') return 'TEXT';
  if (typeof value === 'boolean') return 'INTEGER';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL';
  if (typeof value === 'object') return 'TEXT';
  return 'TEXT';
}
