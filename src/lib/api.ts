import type {
  Connection,
  ConnectionsResponse,
  Platform,
  PlatformsResponse,
  AvailableAction,
  ActionDetails,
  ActionKnowledgeResponse,
  ExecuteActionArgs,
  ExecutePassthroughResponse,
  SanitizedRequestConfig,
} from './types.js';

const API_BASE = 'https://api.withone.ai/v1';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class OneApi {
  constructor(private apiKey: string) {}

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
    let url = `${API_BASE}${opts.path}`;
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

    return response.json() as Promise<T>;
  }

  async validateApiKey(): Promise<boolean> {
    try {
      await this.listConnections();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return false;
      }
      throw error;
    }
  }

  async listConnections(): Promise<Connection[]> {
    const response = await this.request<ConnectionsResponse>('/vault/connections');
    return response.rows || [];
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

  async searchActions(
    platform: string,
    query: string,
    agentType?: 'execute' | 'knowledge'
  ): Promise<AvailableAction[]> {
    const isKnowledgeAgent = !agentType || agentType === 'knowledge';
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
      ...args.headers,
    };

    const finalActionPath = args.pathVariables
      ? replacePathVariables(action.path, args.pathVariables)
      : action.path;

    const normalizedPath = finalActionPath.startsWith('/') ? finalActionPath : `/${finalActionPath}`;
    const url = `${API_BASE.replace('/v1', '')}/v1/passthrough${normalizedPath}`;

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
      const params = new URLSearchParams(
        Object.entries(args.queryParams).map(([k, v]) => [k, String(v)])
      );
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

    const response = await fetch(fullUrl, fetchOpts);

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || `HTTP ${response.status}`);
    }

    const responseText = await response.text();
    const responseData = responseText ? JSON.parse(responseText) : {};

    return {
      requestConfig: sanitizedConfig,
      responseData,
    };
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
    return encodeURIComponent(value.toString());
  });

  // Then, replace single bracket variables {variableName}
  result = result.replace(/\{([^}]+)\}/g, (_match, variable) => {
    const trimmedVariable = variable.trim();
    const value = variables[trimmedVariable];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing value for path variable: ${trimmedVariable}`);
    }
    return encodeURIComponent(value.toString());
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
  const baseUrl = 'https://api.withone.ai';

  return `${knowledge}

API REQUEST STRUCTURE
======================
URL: ${baseUrl}/v1/passthrough/{{PATH}}

IMPORTANT: When constructing the URL, only include the API endpoint path after the base URL.
Do NOT include the full third-party API URL.

Examples:
  Correct: ${baseUrl}/v1/passthrough/crm/v3/objects/contacts/search
  Incorrect: ${baseUrl}/v1/passthrough/https://api.hubapi.com/crm/v3/objects/contacts/search

METHOD: ${method}

HEADERS:
- x-one-secret: {{process.env.ONE_SECRET}}
- x-one-connection-key: {{process.env.ONE_${platform.toUpperCase()}_CONNECTION_KEY}}
- x-one-action-id: ${actionId}
- ... (other headers)

BODY: {{BODY}}

QUERY PARAMS: {{QUERY_PARAMS}}`;
}
