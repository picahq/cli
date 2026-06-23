import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type {
  Connection,
  ConnectionRef,
  ConnectionsResponse,
  Platform,
  PlatformsResponse,
  AvailableAction,
  ActionDetails,
  ActionKnowledgeResponse,
  ExecuteActionArgs,
  ExecutePassthroughResponse,
  SanitizedRequestConfig,
  ApiResponseWithMeta,
  WhoAmIResponse,
} from './types.js';

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * True if a `Content-Type` names a textual format that should be rendered as a
 * string, not treated as binary. Covers `text/*` plus the common textual
 * `application/*` types (JSON, XML, JS, form-encoded, YAML, and `+json`/`+xml`
 * structured-suffix variants), ignoring any `; charset=…` parameter. See #163.
 */
export function isTextualContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct.startsWith('text/')) return true;
  if (ct.endsWith('+json') || ct.endsWith('+xml')) return true;
  return [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/ecmascript',
    'application/x-www-form-urlencoded',
    'application/yaml',
    'application/x-yaml',
    'application/csv',
  ].includes(ct);
}

/**
 * Heuristic: does a UTF-8-decoded body look like human-readable text rather than
 * binary? The API proxy mislabels text endpoints as `application/octet-stream`
 * (#163), so when the content-type is unhelpful we sniff the decoded string. A
 * NUL byte or a U+FFFD replacement char (invalid UTF-8) means binary; otherwise
 * we allow a small fraction of control characters (some text legitimately
 * contains the odd control byte) before calling it binary.
 */
export function looksLikeText(s: string): boolean {
  if (s.length === 0) return true;
  if (s.includes('\u0000') || s.includes('\uFFFD')) return false;
  let control = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Allow tab (0x09), LF (0x0a), CR (0x0d), and (rarely) other whitespace;
    // count the remaining C0 control chars as binary signal.
    if ((c < 0x09 || (c > 0x0d && c < 0x20)) || c === 0x7f) control++;
  }
  return control / s.length < 0.05;
}

/** Parse a Retry-After header value (either delta-seconds or HTTP-date). */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds)) return seconds;
  const dateMs = Date.parse(value);
  if (!isNaN(dateMs)) {
    const delta = Math.ceil((dateMs - Date.now()) / 1000);
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

export class OneApi {
  private apiBase: string;

  constructor(private apiKey: string, apiBase?: string) {
    this.apiBase = apiBase ?? 'https://api.withone.ai/v1';
  }

  private async request<T>(path: string): Promise<T> {
    return this.requestFull<T>({ path });
  }

  private async requestFull<T>(opts: {
    path: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
  }): Promise<T> {
    let url = `${this.apiBase}${opts.path}`;
    if (opts.queryParams && Object.keys(opts.queryParams).length > 0) {
      const params = new URLSearchParams(opts.queryParams);
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      'x-one-secret': this.apiKey,
      'Content-Type': 'application/json',
      ...opts.headers,
    };

    const fetchOpts: RequestInit = {
      method: opts.method || 'GET',
      headers,
    };

    if (opts.body !== undefined) {
      fetchOpts.body = JSON.stringify(opts.body);
    }

    const response = await fetch(url, fetchOpts);

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || `HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  async whoami(): Promise<WhoAmIResponse> {
    return this.request<WhoAmIResponse>('/users/whoami');
  }

  async validateApiKey(): Promise<WhoAmIResponse | false> {
    try {
      return await this.whoami();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return false;
      }
      throw error;
    }
  }

  async listConnections(): Promise<Connection[]> {
    const allConnections: Connection[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const response = await this.request<ConnectionsResponse>(`/vault/connections?page=${page}&limit=100`);
      allConnections.push(...(response.rows || []));
      totalPages = response.pages || 1;
      page++;
    } while (page <= totalPages);

    return allConnections;
  }

  async deleteConnection(id: string): Promise<void> {
    await this.requestFull({ path: `/vault/connections/${id}`, method: 'DELETE' });
  }

  /**
   * Set the tag set on a connection (replaces existing tags). Backs
   * `one add <platform> --tag <name>`, which tags a connection right after
   * the OAuth flow creates it so sync/flow profiles can reference it via
   * `connection: { platform, tag }` when several connections share a platform.
   * Maps to `PATCH /v1/vault/connections/{id}` (UpdateConnection { tags }).
   */
  async updateConnectionTags(id: string, tags: string[]): Promise<void> {
    await this.requestFull({ path: `/vault/connections/${id}`, method: 'PATCH', body: { tags } });
  }

  /**
   * Resolve a late-bound `ConnectionRef` to a current `Connection`. Pass
   * `cache` (a pre-fetched connection list) when resolving many refs in a
   * loop, so each resolve doesn't repeat the listConnections round-trip.
   *
   * Errors are deliberately verbose: a sync profile or flow that fails to
   * resolve a connection should surface *why* (no match / wrong tag /
   * ambiguous) so the agent can fix the ref without trial and error.
   */
  async resolveConnection(
    ref: ConnectionRef,
    cache?: Connection[]
  ): Promise<Connection> {
    const all = cache ?? await this.listConnections();
    const platformLower = ref.platform.toLowerCase();
    const candidates = all.filter(c => c.platform.toLowerCase() === platformLower);

    if (candidates.length === 0) {
      throw new Error(
        `No connection found for platform "${ref.platform}". ` +
        `Run 'one add ${ref.platform}' to connect.`
      );
    }

    let matches = candidates;
    if (ref.tag) {
      matches = candidates.filter(c => c.tags?.includes(ref.tag!));
      if (matches.length === 0) {
        const availableTags = candidates.flatMap(c => c.tags ?? []);
        throw new Error(
          `No "${ref.platform}" connection has tag "${ref.tag}". ` +
          `Available tags: ${availableTags.length > 0 ? availableTags.join(', ') : '(none)'}.`
        );
      }
    }

    if (matches.length > 1) {
      const tagList = matches
        .map(c => (c.tags?.length ? c.tags.join(',') : '(no tag)'))
        .join('; ');
      throw new Error(
        `Multiple "${ref.platform}" connections found (tags: ${tagList}). ` +
        `Add a "tag" field to the connection ref to disambiguate.`
      );
    }

    return matches[0];
  }

  async listPlatforms(): Promise<Platform[]> {
    const allPlatforms: Platform[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const response = await this.request<PlatformsResponse>(`/available-connectors?page=${page}&limit=100`);
      allPlatforms.push(...(response.rows || []));
      totalPages = response.pages || 1;
      page++;
    } while (page <= totalPages);

    return allPlatforms;
  }

  async listAvailableActions(platform: string, limit = 500): Promise<AvailableAction[]> {
    const response = await this.request<{ rows: AvailableAction[] }>(`/available-actions/${platform}?limit=${limit}`);
    return response.rows || [];
  }

  async searchActions(
    platform: string,
    query: string,
    agentType?: 'execute' | 'knowledge'
  ): Promise<AvailableAction[]> {
    const isKnowledgeAgent = agentType === 'knowledge';
    const queryParams: Record<string, string> = {
      query,
      limit: '5',
    };
    if (isKnowledgeAgent) {
      queryParams.knowledgeAgent = 'true';
    } else {
      queryParams.executeAgent = 'true';
    }

    const response = await this.requestFull<AvailableAction[]>({
      path: `/available-actions/search/${platform}`,
      queryParams,
    });
    return response || [];
  }

  async getActionDetails(actionId: string): Promise<ActionDetails> {
    const response = await this.requestFull<{ rows: ActionDetails[] }>({
      path: '/knowledge',
      queryParams: { _id: actionId },
    });

    const actions = response?.rows || [];
    if (actions.length === 0) {
      throw new ApiError(404, `Action with ID ${actionId} not found`);
    }

    return actions[0];
  }

  async getActionKnowledge(actionId: string): Promise<ActionKnowledgeResponse> {
    const action = await this.getActionDetails(actionId);

    if (!action.knowledge || !action.method) {
      return {
        knowledge: 'No knowledge was found',
        method: 'No method was found',
      };
    }

    return {
      knowledge: action.knowledge,
      method: action.method,
    };
  }

  private async requestWithMeta<T>(opts: {
    path: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    ifNoneMatch?: string;
  }): Promise<ApiResponseWithMeta<T>> {
    let url = `${this.apiBase}${opts.path}`;
    if (opts.queryParams && Object.keys(opts.queryParams).length > 0) {
      const params = new URLSearchParams(opts.queryParams);
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      'x-one-secret': this.apiKey,
      'Content-Type': 'application/json',
      ...opts.headers,
    };

    if (opts.ifNoneMatch) {
      headers['If-None-Match'] = opts.ifNoneMatch;
    }

    const fetchOpts: RequestInit = {
      method: opts.method || 'GET',
      headers,
    };

    if (opts.body !== undefined) {
      fetchOpts.body = JSON.stringify(opts.body);
    }

    const response = await fetch(url, fetchOpts);

    if (response.status === 304) {
      return { data: null as T, etag: opts.ifNoneMatch ?? null, status: 304 };
    }

    if (!response.ok) {
      const text = await response.text();
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      throw new ApiError(response.status, text || `HTTP ${response.status}`, retryAfter);
    }

    const etag = response.headers.get('etag') ?? null;
    const text = await response.text();
    const data = text ? (JSON.parse(text) as T) : ({} as T);
    return { data, etag, status: response.status };
  }

  /**
   * Full action details (method, path, tags, ioSchema, knowledge) with ETag
   * support. This is what the knowledge cache stores: caching the complete
   * object lets `actions execute` reuse it and skip its preflight round trip.
   */
  async getActionDetailsWithMeta(
    actionId: string,
    ifNoneMatch?: string
  ): Promise<ApiResponseWithMeta<ActionDetails>> {
    const result = await this.requestWithMeta<{ rows: ActionDetails[] }>({
      path: '/knowledge',
      queryParams: { _id: actionId },
      ifNoneMatch,
    });

    if (result.status === 304) {
      return { data: null as unknown as ActionDetails, etag: result.etag, status: 304 };
    }

    const actions = result.data?.rows || [];
    if (actions.length === 0) {
      throw new ApiError(404, `Action with ID ${actionId} not found`);
    }

    return { data: actions[0], etag: result.etag, status: result.status };
  }

  async searchActionsWithMeta(
    platform: string,
    query: string,
    agentType?: 'execute' | 'knowledge',
    ifNoneMatch?: string
  ): Promise<ApiResponseWithMeta<AvailableAction[]>> {
    const isKnowledgeAgent = agentType === 'knowledge';
    const queryParams: Record<string, string> = {
      query,
      limit: '5',
    };
    if (isKnowledgeAgent) {
      queryParams.knowledgeAgent = 'true';
    } else {
      queryParams.executeAgent = 'true';
    }

    const result = await this.requestWithMeta<AvailableAction[]>({
      path: `/available-actions/search/${platform}`,
      queryParams,
      ifNoneMatch,
    });

    if (result.status === 304) {
      return { data: null as unknown as AvailableAction[], etag: result.etag, status: 304 };
    }

    return { data: result.data || [], etag: result.etag, status: result.status };
  }

  async executePassthroughRequest(
    args: ExecuteActionArgs,
    preloadedAction?: ActionDetails
  ): Promise<ExecutePassthroughResponse> {
    const action = preloadedAction ?? await this.getActionDetails(args.actionId);

    const method = action.method;
    const contentType = args.isFormData
      ? 'multipart/form-data'
      : args.isFormUrlEncoded
        ? 'application/x-www-form-urlencoded'
        : 'application/json';

    const requestHeaders: Record<string, string> = {
      'x-one-secret': this.apiKey,
      'x-one-connection-key': args.connectionKey,
      'x-one-action-id': action._id,
      'Content-Type': contentType,
      Accept: 'application/json, text/event-stream, */*',
      ...args.headers,
    };

    const finalActionPath = args.pathVariables
      ? replacePathVariables(action.path, args.pathVariables)
      : action.path;

    const normalizedPath = finalActionPath.startsWith('/') ? finalActionPath : `/${finalActionPath}`;
    const url = `${this.apiBase.replace('/v1', '')}/v1/passthrough${normalizedPath}`;

    // Check if action has "custom" tag and add connectionKey to body if needed
    const isCustomAction = action.tags?.includes('custom');
    let requestData = args.data;
    if (isCustomAction && method?.toLowerCase() !== 'get') {
      requestData = {
        ...args.data,
        connectionKey: args.connectionKey,
      };
    }

    let queryString = '';
    if (args.queryParams && Object.keys(args.queryParams).length > 0) {
      const entries: [string, string][] = [];
      for (const [k, v] of Object.entries(args.queryParams)) {
        if (Array.isArray(v)) {
          for (const item of v) {
            entries.push([k, String(item)]);
          }
        } else {
          entries.push([k, String(v)]);
        }
      }
      const params = new URLSearchParams(entries);
      queryString = `?${params.toString()}`;
    }

    const fullUrl = `${url}${queryString}`;

    const fetchOpts: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (method?.toLowerCase() !== 'get' && requestData !== undefined) {
      if (args.isFormUrlEncoded) {
        const params = new URLSearchParams();
        if (requestData && typeof requestData === 'object' && !Array.isArray(requestData)) {
          Object.entries(requestData).forEach(([key, value]) => {
            if (typeof value === 'object') {
              params.append(key, JSON.stringify(value));
            } else {
              params.append(key, String(value));
            }
          });
        }
        fetchOpts.body = params.toString();
      } else if (args.isFormData) {
        // For form-data in Node.js with fetch, build manually
        const boundary = `----FormBoundary${Date.now()}`;
        requestHeaders['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
        let body = '';
        if (requestData && typeof requestData === 'object' && !Array.isArray(requestData)) {
          Object.entries(requestData).forEach(([key, value]) => {
            body += `--${boundary}\r\n`;
            body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
            body += typeof value === 'object' ? JSON.stringify(value) : String(value);
            body += '\r\n';
          });
        }
        body += `--${boundary}--\r\n`;
        fetchOpts.body = body;
        fetchOpts.headers = requestHeaders;
      } else {
        fetchOpts.body = JSON.stringify(requestData);
      }
    }

    const sanitizedConfig: SanitizedRequestConfig = {
      url: fullUrl,
      method,
      headers: {
        ...requestHeaders,
        'x-one-secret': '***REDACTED***',
      },
      params: args.queryParams ? Object.fromEntries(
        Object.entries(args.queryParams).map(([k, v]) => [k, String(v)])
      ) : undefined,
      data: requestData,
    };

    if (args.dryRun) {
      return {
        requestConfig: sanitizedConfig,
        responseData: null,
      };
    }

    const response = await fetch(fullUrl, fetchOpts);

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || `HTTP ${response.status}`);
    }

    const responseContentType = response.headers.get('content-type') || '';

    // Textual content-type (text/*, application/json|xml|…) or none: read as
    // text, parse JSON when possible, otherwise return the raw text instead of
    // crashing on JSON.parse — e.g. text/plain, text/html, CSV, XML. (#163)
    if (isTextualContentType(responseContentType) || !responseContentType) {
      const responseText = await response.text();
      if (!responseText) return { requestConfig: sanitizedConfig, responseData: {} };
      try {
        return { requestConfig: sanitizedConfig, responseData: JSON.parse(responseText) };
      } catch {
        return {
          requestConfig: sanitizedConfig,
          responseData: { text: responseText, contentType: responseContentType || 'text/plain' },
        };
      }
    }

    // Non-textual content-type (e.g. application/octet-stream — which the proxy
    // also uses for JSON responses AND for mislabeled text endpoints, #163).
    // With --output: stream to disk (memory-safe for large binary files).
    if (args.output) {
      const outputPath = resolve(args.output);
      const body = response.body;
      if (!body) {
        throw new ApiError(0, 'Response body is null — cannot save to file');
      }
      const nodeReadable = Readable.fromWeb(body as any);
      await pipeline(nodeReadable, createWriteStream(outputPath));
      const contentLength = response.headers.get('content-length');
      const size = contentLength ? parseInt(contentLength, 10) : undefined;
      return {
        requestConfig: sanitizedConfig,
        responseData: { saved: true, path: outputPath, size, contentType: responseContentType },
      };
    }

    // Without --output: try JSON parse (the proxy often sends JSON as
    // octet-stream); then sniff — a printable body is a text endpoint the proxy
    // mislabeled, so return it as text (#163); only genuine bytes become the
    // binary stub.
    const responseText = await response.text();
    try {
      const responseData = responseText ? JSON.parse(responseText) : {};
      return { requestConfig: sanitizedConfig, responseData };
    } catch {
      if (looksLikeText(responseText)) {
        return {
          requestConfig: sanitizedConfig,
          responseData: { text: responseText, contentType: responseContentType },
        };
      }
      const contentLength = response.headers.get('content-length');
      const size = contentLength ? parseInt(contentLength, 10) : responseText.length;
      return {
        requestConfig: sanitizedConfig,
        responseData: {
          binary: true,
          size,
          contentType: responseContentType,
          message: 'Binary response received. Use --output <path> to save to a file.',
        },
      };
    }
  }

  // Webhook Relay methods

  async createRelayEndpoint(body: {
    connectionKey: string;
    createWebhook?: boolean;
    description?: string;
    eventFilters?: string[];
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    return this.requestFull({ path: '/webhooks/relay', method: 'POST', body });
  }

  async listRelayEndpoints(query?: Record<string, string>): Promise<any> {
    return this.requestFull({ path: '/webhooks/relay', queryParams: query });
  }

  async getRelayEndpoint(id: string): Promise<any> {
    return this.requestFull({ path: `/webhooks/relay/${id}` });
  }

  async updateRelayEndpoint(id: string, body: Record<string, unknown>): Promise<any> {
    return this.requestFull({ path: `/webhooks/relay/${id}`, method: 'PATCH', body });
  }

  async deleteRelayEndpoint(id: string): Promise<any> {
    return this.requestFull({ path: `/webhooks/relay/${id}`, method: 'DELETE' });
  }

  async activateRelayEndpoint(id: string, body: { actions: any[]; webhookSecret?: string }): Promise<any> {
    return this.requestFull({ path: `/webhooks/relay/${id}/activate`, method: 'POST', body });
  }

  async listRelayEvents(query?: Record<string, string>): Promise<any> {
    return this.requestFull({ path: '/webhooks/relay/events', queryParams: query });
  }

  async getRelayEvent(id: string): Promise<any> {
    return this.requestFull({ path: `/webhooks/relay/events/${id}` });
  }

  async listRelayEndpointDeliveries(endpointId: string): Promise<any> {
    return this.requestFull({ path: `/webhooks/relay/${endpointId}/deliveries` });
  }

  async listRelayEventDeliveries(eventId: string): Promise<any> {
    return this.requestFull({ path: `/webhooks/relay/events/${eventId}/deliveries` });
  }

  async listRelayEventTypes(platform: string): Promise<any> {
    return this.requestFull({ path: '/webhooks/relay/event-types', queryParams: { platform } });
  }

  async listRelayPlatforms(): Promise<Array<{ platform: string; eventTypeCount: number }>> {
    return this.requestFull({ path: '/webhooks/relay/platforms' });
  }


  async waitForConnection(
    platform: string,
    timeoutMs = 5 * 60 * 1000,
    pollIntervalMs = 5000,
    onPoll?: () => void
  ): Promise<Connection> {
    const startTime = Date.now();
    const existingConnections = await this.listConnections();
    const existingIds = new Set(existingConnections.map(c => c.id));

    while (Date.now() - startTime < timeoutMs) {
      await sleep(pollIntervalMs);
      onPoll?.();

      const currentConnections = await this.listConnections();
      const newConnection = currentConnections.find(
        c => c.platform.toLowerCase() === platform.toLowerCase() && !existingIds.has(c.id)
      );

      if (newConnection) {
        return newConnection;
      }
    }

    throw new TimeoutError(`Timed out waiting for ${platform} connection`);
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function replacePathVariables(
  path: string,
  variables: Record<string, string | number | boolean>
): string {
  if (!path) return path;

  let result = path;

  // First, replace double bracket variables {{variableName}}
  result = result.replace(/\{\{([^}]+)\}\}/g, (_match, variable) => {
    const trimmedVariable = variable.trim();
    const value = variables[trimmedVariable];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing value for path variable: ${trimmedVariable}`);
    }
    return encodeURIComponent(value.toString()).replace(/%3A/gi, ':');
  });

  // Then, replace single bracket variables {variableName}
  result = result.replace(/\{([^}]+)\}/g, (_match, variable) => {
    const trimmedVariable = variable.trim();
    const value = variables[trimmedVariable];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing value for path variable: ${trimmedVariable}`);
    }
    return encodeURIComponent(value.toString()).replace(/%3A/gi, ':');
  });

  return result;
}

import type { PermissionLevel } from './types.js';

const PERMISSION_METHODS: Record<PermissionLevel, string[] | null> = {
  read: ['GET'],
  write: ['GET', 'POST', 'PUT', 'PATCH'],
  admin: null,
};

export function filterByPermissions<T extends { method: string }>(
  actions: T[],
  permissions: PermissionLevel
): T[] {
  const allowed = PERMISSION_METHODS[permissions];
  if (allowed === null) return actions;
  return actions.filter((a) => allowed.includes(a.method.toUpperCase()));
}

export function isMethodAllowed(
  method: string,
  permissions: PermissionLevel
): boolean {
  const allowed = PERMISSION_METHODS[permissions];
  if (allowed === null) return true;
  return allowed.includes(method.toUpperCase());
}

export function isActionAllowed(
  actionId: string,
  allowedActionIds: string[]
): boolean {
  return allowedActionIds.includes('*') || allowedActionIds.includes(actionId);
}

export function buildActionKnowledgeWithGuidance(
  knowledge: string,
  method: string,
  platform: string,
  actionId: string
): string {
  return `CLI EXECUTION GUIDE (read this FIRST)
========================================
To execute this action, use the One CLI with SEPARATE flags for each parameter type.
Do NOT pass path variables or query parameters in the -d body flag — this causes 403 errors.

PARAMETER → FLAG MAPPING:
- Path variables (URL placeholders like {userId}, {id}) → --path-vars '{"userId": "me"}'
- Query parameters (filtering, pagination, format) → --query-params '{"key": "value"}'
  - For repeated params, use arrays: --query-params '{"metadataHeaders": ["From", "Subject"]}'
- Request body (POST/PUT/PATCH payload) → -d '{"field": "value"}'

EXAMPLE:
one --agent actions execute ${platform} ${actionId} <connectionKey> \\
  --path-vars '{ ... }' \\
  --query-params '{ ... }' \\
  -d '{ ... }'

Omit any flag not needed (e.g., omit --path-vars if URL has no placeholders, omit -d for GET).

Read the API documentation below to identify which parameters are path variables, query parameters, or body fields, then map them to the correct flags above.

========================================

${knowledge}`;
}
