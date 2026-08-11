import type { OneApi } from '../../api.js';
import { ApiError } from '../../api.js';
import type { ActionDetails } from '../../types.js';
import { getByDotPath } from '../../dot-path.js';
import { getNextPageParams } from './pagination.js';
import type { SyncProfile } from './types.js';
import { extractRecords, isRootPath } from './extract.js';
import { resolveProfileConnectionKey } from './profile.js';
import { collectIdentityKeys, resolveEntityIdentity } from './mem-writer.js';
import { enrichOneForPreview } from './enrich.js';

export interface SyncTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SyncTestReport {
  platform: string;
  model: string;
  ok: boolean;
  checks: SyncTestCheck[];
  sample?: Record<string, unknown>;
  /**
   * First N records from the fetched page. `sample` is still the first
   * one (kept for back-compat); `samples` lets callers check how
   * consistently a `memory.searchable` path resolves across real data
   * instead of guessing from a single row.
   */
  samples?: Array<Record<string, unknown>>;
  detectedColumns?: Array<{ name: string; type: string }>;
  paginationPreview?: Record<string, unknown>;
  /** Fields that sync test auto-fixed from the real response (e.g. resultsPath). */
  autoFixed?: Record<string, string>;
  /**
   * Resolved cross-platform identity keys across the sampled records (#128):
   * how many keys each sampled record produced, and a few example values. Only
   * present when the profile declares `identityKey` and/or `identityKeys`.
   */
  identityKeysPreview?: {
    perRecord: number[];
    sampleKeys: string[];
    /**
     * Sample values where the SINGULAR `identityKey` resolved to more than one
     * candidate. Such a record gets NO entity key at all — a singular key means
     * "this record IS this entity", so a fan-out has no safe answer (picking
     * the first would merge two different people's records together). Surfaced
     * here because the alternative is a profile that silently stops merging.
     */
    entityFanOut?: { count: number; sampleValues: string[] };
    /**
     * True when the profile enriches and its participant paths therefore
     * cannot resolve on list-shape samples. Distinguishes "your paths are
     * wrong" from "these resolve one phase later".
     */
    resolvesAfterEnrich?: boolean;
    /**
     * True when these counts came from a REAL enriched record — `sync test`
     * spent one detail call so the author sees what actually resolves, rather
     * than zero keys plus a promise that they'll appear later. (#129)
     */
    previewedAfterEnrich?: boolean;
  };
}

/** How many records --show-searchable averages over when reporting hit rates. */
export const SEARCHABLE_SAMPLE_SIZE = 5;

/**
 * Preview the cross-platform identity keys (#128) a profile resolves, so an
 * author can see what a real sync would write without running one. Returns
 * undefined when the profile declares no identity config at all.
 *
 * Beyond the counts, this surfaces the two ways the resolution can look wrong
 * to a human but be correct (or vice versa):
 *   - `entityFanOut` — a SINGULAR `identityKey` that resolved to several
 *     candidates. Those records get NO merge key, because "this record IS this
 *     entity" has no safe answer when the path yields two entities. Silent
 *     otherwise: the profile syncs fine and just stops merging forever.
 *   - `resolvesAfterEnrich` — the profile enriches, so its participant paths
 *     read fields absent from these list-shape samples. Zero keys here is
 *     expected, and telling the author to "check the paths" would be wrong.
 *
 * Exported (rather than inlined into testSyncProfile) so both branches can be
 * tested without standing up an API client.
 */
export function buildIdentityKeysPreview(
  samples: Record<string, unknown>[],
  profile: Pick<SyncProfile, 'identityKey' | 'identityKeys' | 'enrich'>,
): SyncTestReport['identityKeysPreview'] {
  if (!profile.identityKey && !(profile.identityKeys && profile.identityKeys.length > 0)) return undefined;

  const perRecord: number[] = [];
  const sampleKeys = new Set<string>();
  const fanOutValues = new Set<string>();
  let fanOutCount = 0;

  for (const rec of samples) {
    const keys = collectIdentityKeys(rec, profile);
    perRecord.push(keys.length);
    for (const k of keys) {
      if (sampleKeys.size < 8) sampleKeys.add(k);
    }
    const identity = resolveEntityIdentity(rec, profile.identityKey);
    if (identity && identity.values.length > 1) {
      fanOutCount++;
      for (const v of identity.values) {
        if (fanOutValues.size < 4) fanOutValues.add(`${identity.prefix}:${v}`);
      }
    }
  }

  return {
    perRecord,
    sampleKeys: [...sampleKeys],
    ...(fanOutCount > 0 ? { entityFanOut: { count: fanOutCount, sampleValues: [...fanOutValues] } } : {}),
    ...(profile.enrich && (profile.identityKeys?.length ?? 0) > 0 ? { resolvesAfterEnrich: true } : {}),
  };
}

function detectColumnType(value: unknown): string {
  if (value === null || value === undefined) return 'TEXT';
  if (typeof value === 'string') return 'TEXT';
  if (typeof value === 'boolean') return 'INTEGER';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL';
  if (typeof value === 'object') return 'TEXT (JSON)';
  return 'TEXT';
}

/**
 * Validate a sync profile by fetching one page and checking shape.
 * Does not write to the database.
 */
export async function testSyncProfile(api: OneApi, profile: SyncProfile): Promise<SyncTestReport> {
  const checks: SyncTestCheck[] = [];
  const report: SyncTestReport = {
    platform: profile.platform,
    model: profile.model,
    ok: false,
    checks,
  };

  // Build initial params exactly like the runner does
  const queryParams: Record<string, unknown> = { ...profile.queryParams };
  const bodyParams: Record<string, unknown> = { ...profile.body };
  const pageSize = profile.defaultLimit ?? 10;
  const limitLocation = profile.limitLocation || 'query';
  let limitParam: string;
  if (profile.limitParam !== undefined) {
    limitParam = profile.limitParam;
  } else if (profile.pagination.type === 'none') {
    limitParam = '';
  } else {
    limitParam = 'limit';
  }
  if (limitParam) {
    if (limitLocation === 'body') bodyParams[limitParam] = pageSize;
    else queryParams[limitParam] = pageSize;
  }

  // Check 0: the connection ref resolves to a current connection key.
  // Done before the action check so a missing/ambiguous connection surfaces
  // as a clear ref problem rather than a downstream HTTP error.
  let connectionKey: string;
  try {
    connectionKey = await resolveProfileConnectionKey(api, profile);
    checks.push({ name: 'connection resolves', ok: true });
  } catch (err) {
    checks.push({
      name: 'connection resolves',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  // Check 1: the action resolves
  let actionDetails: ActionDetails | undefined;
  try {
    actionDetails = await api.getActionDetails(profile.actionId);
    checks.push({ name: 'action resolves', ok: true });
  } catch (err) {
    checks.push({
      name: 'action resolves',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  // Hard block: sync never uses custom/composer actions (see runner.ts).
  // Catch it here too so `sync test` and `sync init` auto-validation fail
  // fast with the same guidance, instead of letting the user reach `sync run`
  // before discovering the profile is unsupported.
  if (actionDetails.tags?.includes('custom')) {
    checks.push({
      name: 'action is passthrough (not custom)',
      ok: false,
      detail:
        `Action ${profile.actionId} is tagged "custom". Sync only supports passthrough actions. ` +
        `Run 'one actions search ${profile.platform} "${profile.model}"' to find one.`,
    });
    return report;
  }

  // Check 2: single-page fetch succeeds
  let responseData: unknown;
  try {
    const result = await api.executePassthroughRequest({
      platform: profile.platform,
      actionId: profile.actionId,
      connectionKey,
      pathVariables: profile.pathVars,
      queryParams,
      data: Object.keys(bodyParams).length > 0 ? bodyParams : undefined,
    }, actionDetails);
    responseData = result.responseData;
    checks.push({ name: 'single-page fetch', ok: true });
  } catch (err) {
    const detail =
      err instanceof ApiError
        ? `HTTP ${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    checks.push({ name: 'single-page fetch', ok: false, detail });
    return report;
  }

  // Check 3: resultsPath resolves to an array.
  // If the profile still has FILL_IN (or the path fails), auto-discover by
  // scanning top-level response keys for the first array — the agent shouldn't
  // have to guess this when we have the real response sitting right here.
  // Root-array responses (e.g. HN topstories) are also supported: if the
  // response itself is an array, treat resultsPath as root.
  let resolvedResultsPath = profile.resultsPath;
  const rawCandidate: unknown = isRootPath(resolvedResultsPath)
    ? responseData
    : getByDotPath(responseData, resolvedResultsPath);
  let records: unknown[] | null = Array.isArray(rawCandidate) ? rawCandidate : null;

  if (records === null) {
    if (Array.isArray(responseData)) {
      // Auto-discover root array — profile had a stale path but response is
      // a bare array.
      resolvedResultsPath = '';
      records = responseData;
      report.autoFixed = report.autoFixed ?? {};
      report.autoFixed.resultsPath = '';
      checks.push({
        name: `resultsPath auto-discovered → <root>`,
        ok: true,
        detail: `Response is a root-level array — profile had "${profile.resultsPath}"`,
      });
    } else if (typeof responseData === 'object' && responseData !== null) {
      // Auto-discover: find the first top-level key whose value is an array
      const topObj = responseData as Record<string, unknown>;
      const arrayKey = Object.keys(topObj).find(k => Array.isArray(topObj[k]));
      if (arrayKey) {
        resolvedResultsPath = arrayKey;
        records = topObj[arrayKey] as unknown[];
        report.autoFixed = report.autoFixed ?? {};
        report.autoFixed.resultsPath = arrayKey;
        checks.push({
          name: `resultsPath auto-discovered → "${arrayKey}"`,
          ok: true,
          detail: `Profile had "${profile.resultsPath}" which didn't resolve; found "${arrayKey}" in response`,
        });
      }
    }
  }

  if (records === null) {
    const topKeys =
      typeof responseData === 'object' && responseData !== null ? Object.keys(responseData as object) : [];
    checks.push({
      name: `resultsPath "${resolvedResultsPath}" → array`,
      ok: false,
      detail: `Not an array. Response keys: [${topKeys.join(', ')}]`,
    });
    return report;
  }

  // Wrap primitive arrays (e.g. HN's array of integers) so the sample/column
  // preview matches what the runner will actually insert.
  let wrappedPrimitives = false;
  if (records.length > 0 && typeof records[0] !== 'object') {
    const idField = profile.idField || 'id';
    const wrapped: Record<string, unknown>[] = [];
    for (const v of records) {
      if (typeof v === 'object') continue;
      wrapped.push({ [idField]: String(v) });
    }
    records = wrapped;
    wrappedPrimitives = true;
  }

  const pathLabel = isRootPath(resolvedResultsPath) ? '<root>' : `"${resolvedResultsPath}"`;
  checks.push({
    name: `resultsPath ${pathLabel} → array`,
    ok: true,
    detail: wrappedPrimitives
      ? `${(records as unknown[]).length} primitive records (wrapped as { ${profile.idField || 'id'}: value })`
      : `${(records as unknown[]).length} records`,
  });

  if (records.length === 0) {
    checks.push({ name: 'sample record available', ok: false, detail: 'empty result set' });
    report.ok = checks.every(c => c.ok === true || c.name === 'sample record available');
    return report;
  }

  const first = records[0] as Record<string, unknown>;

  // Check 4: idField resolves to a scalar on the sample. Auto-discover a
  // sensible default when missing, AND fail loud when it resolves to an
  // object — otherwise the stringified "[object Object]" becomes the key
  // and every record collapses to the same memory row. Silent data loss.
  let resolvedIdField = profile.idField;
  let idValue: unknown = getByDotPath(first, resolvedIdField);
  if ((idValue === undefined || idValue === null) && typeof first === 'object') {
    // Auto-discover: try common id field names (scalar first, then
    // dot-paths into a nested `id` object for APIs like Attio v2 that
    // wrap ids as `{workspace_id, object_id, record_id}`).
    const idCandidates = ['id', '_id', 'uuid', 'ID', 'Id', 'id.record_id', 'id.id'];
    const found = idCandidates.find(c => {
      const v = getByDotPath(first, c);
      return v !== undefined && v !== null && typeof v !== 'object';
    });
    if (found) {
      resolvedIdField = found;
      idValue = getByDotPath(first, found);
      report.autoFixed = report.autoFixed ?? {};
      report.autoFixed.idField = found;
      checks.push({
        name: `idField auto-discovered → "${found}"`,
        ok: true,
        detail: `Profile had "${profile.idField}" which didn't resolve to a scalar; found "${found}"`,
      });
    }
  }

  if (idValue === undefined || idValue === null) {
    checks.push({
      name: `idField "${resolvedIdField}" present`,
      ok: false,
      detail: `Not found. Available fields: [${Object.keys(first).slice(0, 20).join(', ')}]`,
    });
  } else if (typeof idValue === 'object') {
    // CRITICAL: object values silently collapse on stringification. Reject
    // here so `sync run` can't drop 99% of the data into a single memory
    // row keyed "[object Object]". Suggest dotted leaves the caller can
    // choose from so the fix is obvious.
    const suggestions = typeof idValue === 'object' && idValue !== null
      ? Object.keys(idValue)
          .filter(k => typeof (idValue as Record<string, unknown>)[k] !== 'object')
          .map(k => `${resolvedIdField}.${k}`)
          .slice(0, 5)
      : [];
    checks.push({
      name: `idField "${resolvedIdField}" present`,
      ok: false,
      detail:
        `Resolved to a nested object (${Object.keys(idValue as object).slice(0, 5).join(', ')}…). ` +
        `Memory keys by string-stringified ids, so every row would collapse to "[object Object]" — silent data loss. ` +
        (suggestions.length
          ? `Try a dotted path: ${suggestions.join(' | ')}.`
          : 'Use a dotted path that resolves to a scalar (e.g. "id.record_id").'),
    });
  } else {
    checks.push({
      name: `idField "${resolvedIdField}" present`,
      ok: true,
      detail: `sample value: ${String(idValue).slice(0, 60)}`,
    });
  }

  // Check 5: pagination produces a next-page or cleanly signals "done"
  const nextParams = getNextPageParams(responseData, profile.pagination, 0, pageSize, records);
  if (profile.pagination.type === 'none') {
    checks.push({ name: 'pagination type: none', ok: true });
  } else if (nextParams) {
    checks.push({
      name: `pagination "${profile.pagination.type}" → next page`,
      ok: true,
      detail: JSON.stringify(nextParams).slice(0, 120),
    });
    report.paginationPreview = nextParams as Record<string, unknown>;
  } else {
    // Not necessarily a failure — could just be single page of data
    checks.push({
      name: `pagination "${profile.pagination.type}"`,
      ok: true,
      detail: 'no next page (single-page result or end-of-data)',
    });
  }

  // Fill detected columns and sample(s)
  report.detectedColumns = Object.entries(first).map(([name, value]) => ({
    name,
    type: detectColumnType(value),
  }));
  report.sample = first;
  report.samples = (records as Record<string, unknown>[]).slice(0, SEARCHABLE_SAMPLE_SIZE);

  // For an enriching profile the participant paths live in the DETAIL payload,
  // so previewing against list-shape samples always reported zero keys plus an
  // explanatory note. That told the author "this is expected" but never showed
  // what would actually resolve (#129, acceptance 4). Spend one detail call on
  // the first sample and preview against the merged shape instead.
  //
  // Best-effort: if the call fails (rate limit, permissions, a detail action
  // the key can't reach) we keep the un-enriched preview, which still carries
  // `resolvesAfterEnrich` so zero keys don't read as broken paths.
  if (profile.enrich && (profile.identityKeys?.length ?? 0) > 0 && report.samples.length > 0) {
    const merged = await enrichOneForPreview(api, profile, report.samples[0], connectionKey);
    if (merged) {
      const preview = buildIdentityKeysPreview([merged], profile);
      if (preview) report.identityKeysPreview = { ...preview, previewedAfterEnrich: true };
    }
  }

  report.identityKeysPreview ??= buildIdentityKeysPreview(report.samples, profile);

  report.ok = checks.every(c => c.ok);

  return report;
}
