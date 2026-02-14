import type {
  Connection,
  ConnectionsResponse,
  Platform,
  PlatformsResponse,
} from './types.js';

const API_BASE = 'https://api.picaos.com/v1';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class PicaApi {
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
      'x-pica-secret': this.apiKey,
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
