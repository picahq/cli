import type { OneApi } from '../api.js';
import { ApiError } from '../api.js';
import { getByDotPath } from '../dot-path.js';
import { isAgentMode } from '../output.js';
import type { SyncProfile, SyncRunResult, SyncRunOptions, ModelSyncState } from './types.js';
import { getNextPageParams, parsePassAs } from './pagination.js';
import { getModelState, updateModelState } from './state.js';
import { openDatabase, ensureTable, rebuildFtsIndex, evolveSchema, upsertRecords, tableExists, countRecords, deleteRecords, sanitizeTableName } from './db.js';
import { acquireSyncLock } from './lock.js';
import { classifyRecords, fireHooks, type ChangeEvent } from './hooks.js';
import { enrichPhase, type EnrichResult } from './enrich.js';
import { transformRecords } from './transform.js';
import { extractRecords } from './extract.js';
import { resolveProfileConnectionKey } from './profile.js';
import type Database from 'better-sqlite3';

const MAX_RETRIES_PER_PAGE = 3;
const DEFAULT_SINCE_DAYS = 90;

/** Check if an error is a retryable network-level failure (not an HTTP status). */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  // fetch() failures often have generic messages
  const msg = err.message.toLowerCase();
  return msg.includes('fetch failed') || msg.includes('network') || msg.includes('socket');
}

/** Truncate a string to maxLen chars, appending "…(truncated)" if clipped. */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…(truncated)';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Strip fields from a record by dot-path. Supports array notation:
 *   "messages[].body"  → for each element in record.messages, delete .body
 *   "payload.parts"    → delete record.payload.parts
 *   "data"             → delete record.data
 */
function stripFields(record: Record<string, unknown>, paths: string[]): void {
  for (const path of paths) {
    stripOnePath(record, path.split('.'));
  }
}

function stripOnePath(obj: Record<string, unknown>, parts: string[]): void {
  if (parts.length === 0 || !obj || typeof obj !== 'object') return;

  const current = parts[0];
  const rest = parts.slice(1);

  // Array notation: "messages[]"
  if (current.endsWith('[]')) {
    const key = current.slice(0, -2);
    const arr = obj[key];
    if (Array.isArray(arr)) {
      if (rest.length === 0) {
        // "messages[]" with no further path — delete the array itself
        delete obj[key];
      } else {
        for (const item of arr) {
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
  if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
    stripOnePath(child as Record<string, unknown>, rest);
  }
}

/** Parse --since flag: "90d", "30d", "2026-01-01", etc. */
function parseSince(since: string): Date {
  const durationMatch = since.match(/^(\d+)([dhm])$/);
  if (durationMatch) {
    const amount = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2];
    const now = new Date();
    if (unit === 'd') now.setDate(now.getDate() - amount);
    else if (unit === 'h') now.setHours(now.getHours() - amount);
    else if (unit === 'm') now.setMonth(now.getMonth() - amount);
    return now;
  }
  return new Date(since);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds % 60).toFixed(0);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Execute a sync run for a single model.
 */
export async function syncModel(
  api: OneApi,
  profile: SyncProfile,
  options: SyncRunOptions,
): Promise<SyncRunResult> {
  const { platform, model } = profile;
  const startTime = Date.now();

  // Validate incompatible options
  if (options.fullRefresh && options.since) {
    throw new Error(
      '--full-refresh and --since cannot be used together. --full-refresh always fetches the whole collection.'
    );
  }

  // Resolve the connection key once up front. Profiles using the new
  // `connection: { platform, tag? }` form get a fresh lookup; profiles using
  // legacy `connectionKey` pass through unchanged. Done before the lock so a
  // missing/ambiguous connection fails fast without leaving stale state.
  const connectionKey = await resolveProfileConnectionKey(api, profile);

  // Acquire a cross-process lock so two concurrent syncs (e.g. cron tick +
  // manual run) don't race on the same table. Dry-run skips the lock since
  // it performs no writes. The lock handles stale-lock takeover (dead pid
  // or age > 30min) so a successful return means no live process holds it.
  const lock = options.dryRun ? null : acquireSyncLock(platform, model);

  // If the lock was free but state still says 'syncing', a previous run
  // crashed between "set syncing" and the cleanup paths. Lock is the source
  // of truth on concurrency — auto-recover the stale state rather than
  // forcing the user to pass --force or hand-edit the state file.
  const existingState = getModelState(platform, model);
  if (existingState?.status === 'syncing' && !options.dryRun && !isAgentMode()) {
    process.stderr.write(
      `Recovered from crashed previous sync of ${platform}/${model} ` +
      `(state was 'syncing', no live owner)\n`
    );
  }

  // Warn loudly when the profile has no dateFilter — every "incremental"
  // sync will actually re-pull the entire collection. The upserts still
  // work, but the user should know they're not saving API calls.
  if (!profile.dateFilter && !options.dryRun && !options.fullRefresh && !isAgentMode()) {
    process.stderr.write(
      `⚠ ${platform}/${model} profile has no dateFilter — this sync will fetch the entire collection every run. ` +
      `Add a dateFilter to the profile for true incremental sync, or accept the full-pull cost.\n`
    );
  }

  let db: Database.Database | null = null;
  let totalRecords = 0;
  let pagesProcessed = 0;
  let lastCursor: unknown = null;

  // Reset sync_state and release the lock if the process is killed mid-run
  // (SIGINT from Ctrl-C, SIGTERM from a process manager, cron job being
  // killed on laptop sleep). Without these handlers the state stays 'syncing'
  // forever and the filesystem lock lingers for STALE_MS.
  const signalCleanup = (signal: NodeJS.Signals): void => {
    try {
      updateModelState(platform, model, { status: 'failed', pagesProcessed, lastCursor });
    } catch { /* best-effort */ }
    try { if (lock) lock.release(); } catch { /* best-effort */ }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onSigint = (): void => signalCleanup('SIGINT');
  const onSigterm = (): void => signalCleanup('SIGTERM');
  if (!options.dryRun) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    updateModelState(platform, model, { status: 'syncing' });
  }
  // Track every id we saw across pages, for --full-refresh deletion reconciliation.
  const seenIds = new Set<string | number>();
  // Hook counters
  let hooksInserted = 0;
  let hooksUpdated = 0;
  const hasHooks = !!(profile.onInsert || profile.onUpdate || profile.onChange);
  // Enrich counters
  let enrichedTotal = 0;
  let enrichSkipped = 0;
  let enrichRateLimited = 0;

  try {
    db = await openDatabase(platform);

    // Determine the since date.
    // --full-refresh forces a complete pull: no dateFilter, no lastSync fallback.
    let sinceDate: Date | null = null;
    if (options.fullRefresh) {
      sinceDate = null;
    } else if (options.since) {
      sinceDate = parseSince(options.since);
    } else if (!options.force && existingState?.lastSync) {
      sinceDate = new Date(existingState.lastSync);
    } else {
      sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - DEFAULT_SINCE_DAYS);
    }

    // Build initial params (query or body depending on profile config)
    const queryParams: Record<string, unknown> = { ...profile.queryParams };
    const bodyParams: Record<string, unknown> = { ...profile.body };
    const pageSize = profile.defaultLimit ?? 100;
    const limitLocation = profile.limitLocation || 'query';
    // Resolve the limit param name. Precedence:
    //   1. Explicit profile.limitParam (including "" which means "no limit")
    //   2. If pagination type is "none", default to "" — don't inject a page
    //      size into a non-paginated request (strict APIs like Google reject it).
    //   3. Otherwise default to "limit".
    let limitParam: string;
    if (profile.limitParam !== undefined) {
      limitParam = profile.limitParam;
    } else if (profile.pagination.type === 'none') {
      limitParam = '';
    } else {
      limitParam = 'limit';
    }

    if (limitParam) {
      if (limitLocation === 'body') {
        bodyParams[limitParam] = pageSize;
      } else {
        queryParams[limitParam] = pageSize;
      }
    }

    // Apply date filter
    if (sinceDate && profile.dateFilter) {
      const { param, format } = profile.dateFilter;
      let dateValue: unknown;
      if (format === 'iso8601') {
        dateValue = sinceDate.toISOString();
      } else if (format === 'unix') {
        dateValue = Math.floor(sinceDate.getTime() / 1000);
      } else if (format === 'date') {
        dateValue = sinceDate.toISOString().split('T')[0];
      }
      if (dateValue !== undefined) {
        queryParams[param] = dateValue;
      }
    }

    // Get preloaded action details for efficiency
    const actionDetails = await api.getActionDetails(profile.actionId);

    // Hard block: sync never uses custom/composer actions. They run on a
    // small shared fleet that collapses under sync-scale load and often
    // expect filters in the body (see gmail get-threads). Passthrough +
    // local enrichment scales instead.
    if (actionDetails.tags?.includes('custom')) {
      throw new Error(
        `Sync does not support custom actions. Action ${profile.actionId} is tagged "custom". ` +
        `Use a passthrough action — run 'one actions search ${platform} "${model}"' to find one, ` +
        `or compose a flow that chains passthrough calls if the logic is complex.`
      );
    }

    const maxPages = options.maxPages ?? Infinity;
    let tableCreated = tableExists(db, model);

    // Pagination loop
    let currentPageQueryParams = { ...queryParams };
    let currentPageBodyParams = { ...bodyParams };
    let currentPageHeaders: Record<string, string> | undefined;
    let startPage = 0;

    // Resume from saved cursor if the previous run failed mid-sync.
    // Only applies when not forcing and the state has a cursor.
    if (
      !options.force &&
      !options.fullRefresh &&
      existingState?.status === 'failed' &&
      existingState.lastCursor != null &&
      profile.pagination.passAs
    ) {
      const { location, paramName } = parsePassAs(profile.pagination.passAs);
      if (location === 'header') {
        currentPageHeaders = { ...currentPageHeaders, [paramName]: String(existingState.lastCursor) };
      } else if (location === 'body') {
        currentPageBodyParams[paramName] = existingState.lastCursor;
      } else {
        currentPageQueryParams[paramName] = existingState.lastCursor;
      }
      startPage = existingState.pagesProcessed;
      if (!isAgentMode()) {
        process.stderr.write(
          `Resuming ${platform}/${model} from page ${startPage + 1} ` +
          `(cursor: ${String(existingState.lastCursor).slice(0, 40)})\n`
        );
      }
    }

    for (let page = startPage; page < maxPages + startPage; page++) {
      // Execute API request with retry logic
      let responseData: unknown;
      let retries = 0;

      while (true) {
        try {
          const hasBody = Object.keys(currentPageBodyParams).length > 0;
          const result = await api.executePassthroughRequest({
            platform,
            actionId: profile.actionId,
            connectionKey,
            pathVariables: profile.pathVars,
            queryParams: currentPageQueryParams,
            headers: currentPageHeaders,
            data: hasBody ? currentPageBodyParams : undefined,
          }, actionDetails);

          responseData = result.responseData;
          break;
        } catch (err) {
          if (err instanceof ApiError) {
            // Rate limited (429) or server error (5xx) — retry with backoff
            const isRateLimited = err.status === 429;
            const isServerError = err.status >= 500 && err.status <= 504;
            if ((isRateLimited || isServerError) && retries < MAX_RETRIES_PER_PAGE) {
              const retryAfter = isRateLimited
                ? (err.retryAfterSeconds ?? Math.min(30 * Math.pow(2, retries), 120))
                : Math.min(5 * Math.pow(2, retries), 30); // 5xx: 5s → 10s → 20s
              const label = isRateLimited ? 'Rate limited' : `Server error (${err.status})`;
              if (!isAgentMode()) {
                process.stderr.write(`  ${label}. Waiting ${retryAfter}s before retry (${retries + 1}/${MAX_RETRIES_PER_PAGE})...\n`);
              }
              await sleep(retryAfter * 1000);
              retries++;
              continue;
            }
            if (err.status === 401 || err.status === 403) {
              throw new Error(`Authentication failed. Connection key may be expired. Run 'one add ${platform}' to refresh.`);
            }
          }
          // Network errors (ECONNRESET, ETIMEDOUT, fetch failures) — retry with short backoff
          if (isNetworkError(err) && retries < MAX_RETRIES_PER_PAGE) {
            const backoff = Math.min(2 * Math.pow(2, retries), 16); // 2s → 4s → 8s
            if (!isAgentMode()) {
              process.stderr.write(`  Network error. Retrying in ${backoff}s (${retries + 1}/${MAX_RETRIES_PER_PAGE})...\n`);
            }
            await sleep(backoff * 1000);
            retries++;
            continue;
          }
          throw err;
        }
      }

      // Extract results. extractRecords also handles root-array responses
      // (e.g. the HN `topstories.json` endpoint returns a bare `[123, 456]`)
      // and arrays of primitives (wraps each as `{ [idField]: String(value) }`).
      const extraction = extractRecords(
        responseData,
        profile.resultsPath,
        profile.idField,
        `${platform}/${model}`,
      );
      const records = extraction.records;

      if (records.length === 0 && page === 0) {
        // Empty results on first page — not an error
        if (!isAgentMode()) {
          process.stderr.write(`No records found for ${model} with the given filters.\n`);
        }
        break;
      }

      if (records.length === 0) break;

      // Dry-run: show first page results and exit
      if (options.dryRun) {
        pagesProcessed = 1;
        totalRecords = records.length;
        db.close();
        return {
          model,
          recordsSynced: totalRecords,
          pagesProcessed,
          duration: formatDuration(Date.now() - startTime),
          status: 'dry-run',
        };
      }

      // Transform records through a shell command or flow if configured.
      if (profile.transform) {
        const transformed = await transformRecords(profile.transform, records as Record<string, unknown>[]);
        if (transformed) {
          records.length = 0;
          for (const r of transformed) (records as Record<string, unknown>[]).push(r);
        }
      }

      // Strip excluded fields (e.g. base64 attachments, large blobs).
      // MUST run before ensureTable so excluded columns are never created.
      if (profile.exclude && profile.exclude.length > 0) {
        for (const record of records as Record<string, unknown>[]) {
          stripFields(record, profile.exclude);
        }
      }

      // Extract cross-platform identity key if configured
      if (profile.identityKey) {
        for (const record of records as Record<string, unknown>[]) {
          const raw = getByDotPath(record, profile.identityKey);
          if (raw !== null && raw !== undefined) {
            (record as Record<string, unknown>)._identity = String(raw).toLowerCase().trim();
          }
        }
      }

      // Create table on first page with actual data — AFTER enrich/transform/exclude
      // so the table schema reflects the final record shape.
      if (!tableCreated) {
        const firstRecord = records[0] as Record<string, unknown>;
        ensureTable(db, model, firstRecord, profile.idField);
        tableCreated = true;
      }

      // Evolve schema if needed (check for new fields — after the full
      // pipeline: enrich, transform, exclude, and table creation)
      for (const record of records) {
        if (typeof record === 'object' && record !== null) {
          evolveSchema(db, model, record as Record<string, unknown>);
          break; // Only need to check one record per page for new columns
        }
      }

      // Track ids for --full-refresh reconciliation
      if (options.fullRefresh) {
        for (const rec of records as Record<string, unknown>[]) {
          const id = rec[profile.idField];
          if (typeof id === 'string' || typeof id === 'number') {
            seenIds.add(id);
          }
        }
      }

      // Classify records as insert vs update BEFORE upserting (for hooks)
      let inserts: Record<string, unknown>[] = [];
      let updates: Record<string, unknown>[] = [];
      if (hasHooks) {
        const classified = classifyRecords(
          db, model, records as Record<string, unknown>[], profile.idField, tableCreated,
        );
        inserts = classified.inserts;
        updates = classified.updates;
      }

      // Upsert records
      const inserted = upsertRecords(
        db,
        model,
        records as Record<string, unknown>[],
        profile.idField,
      );
      totalRecords += inserted;
      pagesProcessed++;

      // Fire hooks after each page (not at the end) so long syncs get real-time events
      if (hasHooks) {
        const now = new Date().toISOString();
        const buildEvents = (type: 'insert' | 'update', recs: Record<string, unknown>[]): ChangeEvent[] =>
          recs.map(record => ({ type, platform, model, record, timestamp: now }));

        const insertEvents = buildEvents('insert', inserts);
        const updateEvents = buildEvents('update', updates);
        hooksInserted += inserts.length;
        hooksUpdated += updates.length;

        // Fire onInsert hook
        if (inserts.length > 0 && (profile.onInsert || profile.onChange)) {
          await fireHooks(profile.onInsert || profile.onChange!, insertEvents);
        }
        // Fire onUpdate hook
        if (updates.length > 0 && (profile.onUpdate || profile.onChange)) {
          await fireHooks(profile.onUpdate || profile.onChange!, updateEvents);
        }
      }

      // Progress output
      if (!isAgentMode()) {
        process.stderr.write(`Syncing ${platform}/${model}... page ${pagesProcessed} (${totalRecords} records)\r`);
      }

      // Get next page params
      const nextParams = getNextPageParams(
        responseData,
        profile.pagination,
        page,
        pageSize,
        records,
      );

      // Save state after each page for crash recovery.
      // Capture the first value across query/body/header params as the cursor snapshot.
      const cursorBag =
        nextParams?.queryParams ?? nextParams?.bodyParams ?? nextParams?.headers;
      const cursorKeys = cursorBag ? Object.keys(cursorBag) : [];
      lastCursor = cursorKeys.length > 0 ? (cursorBag as Record<string, unknown>)[cursorKeys[0]] : null;
      updateModelState(platform, model, {
        totalRecords: countRecords(db, model),
        pagesProcessed,
        lastCursor,
        status: 'syncing',
      });

      if (!nextParams) break;

      // Apply next page params
      currentPageQueryParams = { ...queryParams, ...nextParams.queryParams };
      currentPageBodyParams = { ...bodyParams, ...nextParams.bodyParams };
      if (nextParams.headers) {
        currentPageHeaders = { ...currentPageHeaders, ...nextParams.headers };
      }
    }

    // --full-refresh: delete local rows whose ids weren't seen this run.
    // Only runs if we actually fetched pages (paranoia against wiping data
    // when the API returned an empty first page due to some transient issue).
    let deletedStale = 0;
    if (options.fullRefresh && pagesProcessed > 0 && tableCreated && seenIds.size > 0) {
      const safeTable = sanitizeTableName(model);
      const safeIdField = profile.idField.replace(/"/g, '""');
      // Chunk the NOT IN clause to stay under SQLite's variable limit (~999)
      const ids = Array.from(seenIds);
      const CHUNK = 500;
      const seenChunks: unknown[][] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        seenChunks.push(ids.slice(i, i + CHUNK));
      }

      // Build a temp table of seen ids and delete anything not in it
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS _seen_ids (id)`);
      db.exec(`DELETE FROM _seen_ids`);
      const insertStmt = db.prepare(`INSERT INTO _seen_ids (id) VALUES (?)`);
      const tx = db.transaction((batch: unknown[]) => {
        for (const id of batch) insertStmt.run(id as string | number);
      });
      for (const chunk of seenChunks) tx(chunk);

      const delResult = db.prepare(
        `DELETE FROM "${safeTable}" WHERE "${safeIdField}" NOT IN (SELECT id FROM _seen_ids)`
      ).run();
      deletedStale = delResult.changes;
      db.exec(`DROP TABLE IF EXISTS _seen_ids`);

      if (!isAgentMode() && deletedStale > 0) {
        process.stderr.write(`Removed ${deletedStale} stale record(s) no longer in source.\n`);
      }
    }

    // Rebuild FTS index after all list data is written
    if (pagesProcessed > 0 && tableCreated) {
      rebuildFtsIndex(db, model);
    }

    // Phase 1 done
    if (!isAgentMode() && pagesProcessed > 0) {
      process.stderr.write(`Syncing ${platform}/${model}... page ${pagesProcessed} (${totalRecords} records) done\n`);
    }

    // Phase 2: Enrich unenriched rows (runs after list sync completes).
    // Queries _enriched_at IS NULL so it's inherently resumable — if the
    // process dies mid-enrichment, re-running picks up where it left off.
    let enrichResult: EnrichResult | null = null;
    if (profile.enrich && tableCreated && !options.dryRun) {
      enrichResult = await enrichPhase(
        api, db, profile.enrich, model, profile.idField,
        connectionKey, platform,
        {
          transform: profile.transform,
          exclude: profile.exclude,
          identityKey: profile.identityKey,
          onInsert: profile.onInsert,
          onUpdate: profile.onUpdate,
          onChange: profile.onChange,
        },
      );
      enrichedTotal = enrichResult.enriched;
      enrichSkipped = enrichResult.skipped;
      enrichRateLimited = enrichResult.rateLimited;

      // Enrichment writes count as updates for hook metrics (the row already
      // existed in SQL from Phase 1 — enrichment just fills in detail fields).
      if (hasHooks && (profile.onUpdate || profile.onChange)) {
        hooksUpdated += enrichResult.enriched;
      }

      // Rebuild FTS after enrichment added new text content
      if (enrichResult.enriched > 0) {
        rebuildFtsIndex(db, model);
      }
    }

    const duration = formatDuration(Date.now() - startTime);
    const actualCount = countRecords(db, model);
    updateModelState(platform, model, {
      lastSync: new Date().toISOString(),
      totalRecords: actualCount,
      pagesProcessed,
      lastCursor: null,
      since: sinceDate?.toISOString() ?? null,
      status: 'idle',
    });

    db.close();
    if (lock) lock.release();
    return {
      model, recordsSynced: totalRecords, pagesProcessed, duration, status: 'complete', deletedStale,
      ...(hasHooks ? { hooksInserted, hooksUpdated } : {}),
      ...(profile.enrich ? { enriched: enrichedTotal, enrichSkipped, enrichRateLimited } : {}),
    };

  } catch (err) {
    // Save failed state
    const failedCount = db ? countRecords(db, model) : (existingState?.totalRecords ?? 0);
    updateModelState(platform, model, {
      status: 'failed',
      totalRecords: failedCount,
      pagesProcessed,
      lastCursor,
    });

    if (db) db.close();
    if (lock) lock.release();

    // Build a descriptive but bounded error. The raw err.message can be
    // multi-MB when a 5xx returns a full response body (e.g. Gmail threads
    // with base64 attachments). Truncate to 500 chars.
    const rawMsg = err instanceof Error ? err.message : String(err);
    const shortMsg = truncate(rawMsg, 500);

    if (pagesProcessed > 0) {
      const resumeErr = new Error(
        `Sync interrupted after page ${pagesProcessed} (${totalRecords} records). ` +
        `Run again to resume. Error: ${shortMsg}`
      );
      // Attach real counts so callers can report progress
      (resumeErr as any)._recordsSynced = totalRecords;
      (resumeErr as any)._pagesProcessed = pagesProcessed;
      throw resumeErr;
    }

    // Even on page-0 failure, attach any available counts
    const wrapped = new Error(shortMsg);
    (wrapped as any)._recordsSynced = totalRecords;
    (wrapped as any)._pagesProcessed = pagesProcessed;
    throw wrapped;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}
