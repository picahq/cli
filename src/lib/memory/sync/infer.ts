import type { PaginationConfig } from './types.js';

/**
 * Best-effort heuristics to infer sync profile fields from an action's
 * knowledge markdown. These are *hints* — the agent should still verify
 * with `one sync test <platform>/<model>` before running a full sync.
 */

export interface InferredProfileHints {
  pagination?: Partial<PaginationConfig> & { type: PaginationConfig['type'] };
  resultsPath?: string;
  idField?: string;
  dateFilterParam?: string;
  /** Where to send the page-size/limit param: "query" (default) or "body" (for POST-body list endpoints). */
  limitLocation?: 'query' | 'body';
  /** Name of the page-size param, e.g. "page_size", "limit", "maxResults". */
  limitParam?: string;
  /** Required path variables extracted from the URL template. */
  pathVars?: Record<string, string>;
  reasoning: string[];
}

/** Known pagination patterns keyed by common tell-tale parameter/response names. */
const PAGINATION_PATTERNS: Array<{
  match: RegExp;
  config: Partial<PaginationConfig> & { type: PaginationConfig['type'] };
  label: string;
}> = [
  // Notion-style: start_cursor + next_cursor in body (POST endpoints)
  {
    match: /start_cursor|next_cursor/i,
    config: {
      type: 'cursor',
      nextPath: 'next_cursor',
      passAs: 'body:start_cursor',
      hasMorePath: 'has_more',
    },
    label: 'Notion-style body cursor pagination (start_cursor/next_cursor)',
  },
  // Stripe-style: starting_after cursor returning has_more (checked AFTER Notion so we don't match has_more alone)
  {
    match: /starting_after/i,
    config: {
      type: 'id',
      passAs: 'query:starting_after',
      hasMorePath: 'has_more',
      idField: 'id',
    },
    label: 'Stripe-style id pagination (starting_after + has_more)',
  },
  // Shopify/GitHub Link-header cursor
  {
    match: /link:\s*<[^>]+>;\s*rel="next"|page_info=/i,
    config: { type: 'link', nextPath: 'headers.link', passAs: 'query:page_info' },
    label: 'Link header cursor pagination',
  },
  // HubSpot / Google: next page token
  {
    match: /next_page_token|nextPageToken|paging\.next\.after/i,
    config: {
      type: 'token',
      nextPath: 'paging.next.after',
      passAs: 'query:after',
    },
    label: 'token/after pagination (HubSpot/Google style)',
  },
  // Generic cursor
  {
    match: /next_cursor|nextCursor|cursor/i,
    config: { type: 'cursor', nextPath: 'next_cursor', passAs: 'query:cursor' },
    label: 'generic cursor pagination',
  },
  // Offset/limit
  {
    match: /offset.*limit|page.*per_page/i,
    config: { type: 'offset', passAs: 'query:offset' },
    label: 'offset/limit pagination',
  },
];

/**
 * Try to infer the results array path from knowledge.
 * Checks generic keys first ("data", "results", etc.), then falls back to
 * checking whether the model name itself appears as a response key — many
 * platforms use the model name as the wrapper (Attio → "companies",
 * Gmail → "threads", Shopify → "orders").
 */
function inferResultsPath(knowledge: string, modelName?: string, platform?: string): string | undefined {
  const candidates = ['data', 'results', 'items', 'records', 'rows', 'entries'];
  for (const key of candidates) {
    const re = new RegExp(`"${key}"\\s*:\\s*\\[`, 'i');
    if (re.test(knowledge)) return key;
  }

  // Try the model name itself and common variations (singular, plural)
  if (modelName) {
    const namesToTry = new Set<string>();
    namesToTry.add(modelName);
    // CamelCase → lowercase: "balanceTransactions" → "balancetransactions"
    namesToTry.add(modelName.toLowerCase());
    // Strip platform prefix: "attioCompanies" → "Companies" → "companies"
    if (platform) {
      const lower = modelName.toLowerCase();
      const platLower = platform.toLowerCase().replace(/-/g, '');
      if (lower.startsWith(platLower)) {
        const stripped = modelName.slice(platLower.length);
        if (stripped.length > 0) {
          // "Companies" → "companies"
          namesToTry.add(stripped[0].toLowerCase() + stripped.slice(1));
        }
      }
    }
    // Simple plural/singular: "company" ↔ "companies", "thread" ↔ "threads"
    if (modelName.endsWith('ies')) {
      namesToTry.add(modelName.slice(0, -3) + 'y');
    } else if (modelName.endsWith('s')) {
      namesToTry.add(modelName.slice(0, -1));
    } else {
      namesToTry.add(modelName + 's');
    }

    for (const name of namesToTry) {
      // Check for "name": [ (JSON array) or `| name |` (markdown table) or `name` as a heading
      const reJson = new RegExp(`"${name}"\\s*:\\s*\\[`, 'i');
      const reProse = new RegExp(`\\b${name}\\b.*\\barray\\b|\\barray\\b.*\\b${name}\\b`, 'i');
      if (reJson.test(knowledge) || reProse.test(knowledge)) return name;
    }
  }

  return undefined;
}

/**
 * Extract required path variables from the URL template in knowledge.
 * Knowledge typically has a URL section like:
 *   `https://api.example.com/v1/calendars/{{calendarId}}/events`
 * or path-vars described in a table.
 *
 * Returns a map of { varName: "FILL_IN" } for each variable found,
 * plus smart defaults for well-known variables.
 */
function inferPathVars(knowledge: string): Record<string, string> | undefined {
  const vars: Record<string, string> = {};

  // Match {{varName}} or {varName} in URL patterns
  const urlMatches = knowledge.matchAll(/\{\{?([a-zA-Z_][a-zA-Z0-9_]*)\}?\}/g);
  for (const m of urlMatches) {
    const name = m[1];
    // Skip Handlebars template vars, internal keys, and record-level IDs
    if (['payload', 'timestamp', 'eventType', 'connectionId', 'relayEventId'].includes(name)) continue;
    if (isExcludedPathVar(name)) continue;
    vars[name] = suggestDefault(name);
  }

  if (Object.keys(vars).length === 0) return undefined;
  return vars;
}

/** Path variable names that are internal to the One API proxy and should never
 *  appear in a sync profile — they leak implementation details to the user. */
const INTERNAL_PATH_VARS = new Set([
  'internal_signing_key', 'signing_key', 'api_key', 'apikey',
  'secret', 'token', 'access_token', 'refresh_token',
]);

/** Path variable names that refer to a single record (not a list endpoint).
 *  These show up in knowledge because the same model has get-one and get-many
 *  actions, but they don't belong in a sync profile for the list action. */
const RECORD_LEVEL_PATH_VARS = new Set([
  'record_id', 'recordid', 'id', 'itemid', 'item_id',
  'pageid', 'page_id', 'objectid', 'object_id',
  'entryid', 'entry_id', 'resourceid', 'resource_id',
]);

/** Suggest a reasonable default value for well-known path variables. */
function suggestDefault(varName: string): string {
  const lower = varName.toLowerCase();
  if (lower === 'calendarid') return 'primary';
  if (lower === 'userid' || lower === 'user_id') return 'me';
  if (lower === 'accountid' || lower === 'account_id') return 'me';
  return 'FILL_IN';
}

/** Return true if this path var name should be excluded from sync profiles. */
function isExcludedPathVar(varName: string): boolean {
  const lower = varName.toLowerCase();
  return INTERNAL_PATH_VARS.has(lower) || RECORD_LEVEL_PATH_VARS.has(lower);
}

/** Try to infer the ID field from knowledge. */
function inferIdField(knowledge: string): string | undefined {
  // Prefer "id" if any "id" field appears in a schema-like context
  if (/"id"\s*:/.test(knowledge)) return 'id';
  if (/\b_id\b/.test(knowledge)) return '_id';
  if (/\buuid\b/i.test(knowledge)) return 'uuid';
  return undefined;
}

/** Try to infer a date filter parameter for incremental sync. */
function inferDateFilter(knowledge: string): string | undefined {
  const candidates = ['updated_since', 'updatedSince', 'modified_since', 'since', 'updated_after', 'created_after'];
  for (const c of candidates) {
    if (new RegExp(`\\b${c}\\b`, 'i').test(knowledge)) return c;
  }
  return undefined;
}

export function inferProfileFromKnowledge(knowledge: string | undefined, modelName?: string, platform?: string): InferredProfileHints {
  const hints: InferredProfileHints = { reasoning: [] };
  if (!knowledge) {
    hints.reasoning.push('No knowledge available; all fields left as FILL_IN.');
    return hints;
  }

  for (const pattern of PAGINATION_PATTERNS) {
    if (pattern.match.test(knowledge)) {
      // Deep copy so we can strip inapplicable fields
      hints.pagination = { ...pattern.config };
      // Strip fields that don't apply to the detected type:
      // - offset doesn't need nextPath (you just increment by pageSize)
      // - none doesn't need nextPath or passAs
      if (hints.pagination.type === 'offset') {
        delete hints.pagination.nextPath;
        delete hints.pagination.hasMorePath;
      } else if (hints.pagination.type === 'none') {
        delete hints.pagination.nextPath;
        delete hints.pagination.passAs;
        delete hints.pagination.hasMorePath;
      }
      hints.reasoning.push(`Pagination: ${pattern.label}`);
      break;
    }
  }

  const resultsPath = inferResultsPath(knowledge, modelName, platform);
  if (resultsPath) {
    hints.resultsPath = resultsPath;
    hints.reasoning.push(`resultsPath: "${resultsPath}" (found in response schema)`);
  }

  const idField = inferIdField(knowledge);
  if (idField) {
    hints.idField = idField;
    hints.reasoning.push(`idField: "${idField}"`);
  }

  const dateFilter = inferDateFilter(knowledge);
  if (dateFilter) {
    hints.dateFilterParam = dateFilter;
    hints.reasoning.push(`dateFilter candidate: "${dateFilter}" (for incremental sync)`);
  }

  // Extract required path variables from the URL template
  const pathVars = inferPathVars(knowledge);
  if (pathVars) {
    hints.pathVars = pathVars;
    const varList = Object.entries(pathVars)
      .map(([k, v]) => v === 'FILL_IN' ? k : `${k}="${v}"`)
      .join(', ');
    hints.reasoning.push(`pathVars: {${varList}} (extracted from URL template)`);
  }

  // Detect POST-body list endpoints: if the knowledge says POST and mentions a body param
  // like page_size / pageSize / limit, the limit should be sent in the body, not query.
  const isPost = /\bPOST\b/.test(knowledge);
  if (isPost) {
    const bodyLimitMatch = knowledge.match(/\b(page_size|pageSize|limit|max_results|maxResults)\b/);
    if (bodyLimitMatch) {
      hints.limitLocation = 'body';
      hints.limitParam = bodyLimitMatch[1];
      hints.reasoning.push(
        `limitLocation: "body" (POST endpoint — page size "${bodyLimitMatch[1]}" goes in request body)`
      );
      // If the Notion pattern matched, its passAs is already body:start_cursor. If another
      // cursor/token pattern matched but this is a POST, switch its passAs to body: as well.
      if (hints.pagination && hints.pagination.passAs && hints.pagination.passAs.startsWith('query:')) {
        const paramName = hints.pagination.passAs.slice('query:'.length);
        hints.pagination.passAs = `body:${paramName}`;
        hints.reasoning.push(`adjusted pagination passAs to "body:${paramName}" (POST endpoint)`);
      }
    }
  }

  if (hints.reasoning.length === 0) {
    hints.reasoning.push('Could not infer any fields from knowledge — fill template manually.');
  }

  return hints;
}
