import type { OneApi } from '../api.js';
import { ApiError } from '../api.js';
import type { ActionDetails } from '../types.js';
import { getByDotPath } from '../dot-path.js';
import { getNextPageParams } from './pagination.js';
import type { SyncProfile } from './types.js';
import { extractRecords, isRootPath } from './extract.js';

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
  detectedColumns?: Array<{ name: string; type: string }>;
  paginationPreview?: Record<string, unknown>;
  /** Fields that sync test auto-fixed from the real response (e.g. resultsPath). */
  autoFixed?: Record<string, string>;
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
      connectionKey: profile.connectionKey,
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

  // Check 4: idField exists on sample. Auto-discover if FILL_IN or missing.
  let resolvedIdField = profile.idField;
  let idValue = first[resolvedIdField];
  if ((idValue === undefined || idValue === null) && typeof first === 'object') {
    // Auto-discover: try common id field names
    const idCandidates = ['id', '_id', 'uuid', 'ID', 'Id'];
    const found = idCandidates.find(c => first[c] !== undefined && first[c] !== null);
    if (found) {
      resolvedIdField = found;
      idValue = first[found];
      report.autoFixed = report.autoFixed ?? {};
      report.autoFixed.idField = found;
      checks.push({
        name: `idField auto-discovered → "${found}"`,
        ok: true,
        detail: `Profile had "${profile.idField}" which wasn't on the record; found "${found}"`,
      });
    }
  }

  if (idValue === undefined || idValue === null) {
    checks.push({
      name: `idField "${resolvedIdField}" present`,
      ok: false,
      detail: `Not found. Available fields: [${Object.keys(first).slice(0, 20).join(', ')}]`,
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

  // Fill detected columns and sample
  report.detectedColumns = Object.entries(first).map(([name, value]) => ({
    name,
    type: detectColumnType(value),
  }));
  report.sample = first;
  report.ok = checks.every(c => c.ok);

  return report;
}
