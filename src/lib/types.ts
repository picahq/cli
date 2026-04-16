export interface Agent {
  id: string;
  name: string;
  configPath: string;
  configKey: string;
  detectDir: string;
  projectConfigPath?: string;
  configFormat?: 'json' | 'toml';
}

export interface Connection {
  id: string;
  platform: string;
  key: string;
  state: 'operational' | 'degraded' | 'failed' | 'unknown';
  name?: string;
  tags?: string[];
  createdAt?: string;
}

export interface Platform {
  id: number;
  name: string;
  key: string;
  platform: string;
  category: string;
  description?: string;
  status?: string;
  oauth?: boolean;
}

export interface PlatformsResponse {
  rows: Platform[];
  total: number;
  pages: number;
  page: number;
}

export type PermissionLevel = 'read' | 'write' | 'admin';

export interface AccessControlSettings {
  permissions?: PermissionLevel;
  connectionKeys?: string[];
  actionIds?: string[];
  knowledgeAgent?: boolean;
}

export interface WhoAmIUser { id: string; name: string; email: string }
export interface WhoAmIOrg { id: string; name: string }
export interface WhoAmIProject { id: string; name: string }
export interface WhoAmIResponse {
  user: WhoAmIUser;
  organization: WhoAmIOrg | null;
  project: WhoAmIProject | null;
}

export interface Config {
  apiKey: string;
  installedAgents: string[];
  createdAt: string;
  accessControl?: AccessControlSettings;
  cacheTtl?: number;
  apiBase?: string;
  whoami?: WhoAmIResponse;
}

export interface ConnectionsResponse {
  rows: Connection[];
  total: number;
  pages: number;
  page: number;
}

export interface AvailableAction {
  systemId: string;
  title: string;
  tags?: string[];
  knowledge?: string;
  path: string;
  method: string;
}

export interface IoSchemaGroup {
  required?: string[];
  properties?: Record<string, { description?: string; type?: string }>;
}

export interface IoSchema {
  inputSchema?: {
    required?: string[];
    properties?: Record<string, IoSchemaGroup>;
  };
  ioExample?: {
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  };
}

export interface ActionDetails {
  _id: string;
  title: string;
  tags?: string[];
  knowledge?: string;
  path: string;
  method: string;
  ioSchema?: IoSchema;
}

export interface ActionKnowledgeResponse {
  knowledge: string;
  method: string;
}

export interface ExecuteActionArgs {
  platform: string;
  actionId: string;
  connectionKey: string;
  data?: any;
  pathVariables?: Record<string, string | number | boolean>;
  queryParams?: Record<string, any>;
  headers?: Record<string, string>;
  isFormData?: boolean;
  isFormUrlEncoded?: boolean;
  dryRun?: boolean;
  output?: string;
}

export interface SanitizedRequestConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  params?: Record<string, string>;
  data?: unknown;
}

export interface ExecutePassthroughResponse {
  requestConfig: SanitizedRequestConfig;
  responseData: unknown;
}

// Webhook Relay types

export type RelayAction =
  | { type: 'url'; url: string; secret?: string; eventFilters?: string[]; hasSecret?: boolean }
  | { type: 'passthrough'; actionId: string; connectionKey: string; body?: unknown; headers?: unknown; query?: unknown; eventFilters?: string[] }
  | { type: 'agent'; agentId: string; eventFilters?: string[] };

export interface RelayEndpoint {
  id: string;
  connectionId: string;
  userId: string;
  url: string;
  active: boolean;
  deleted: boolean;
  description?: string;
  eventFilters?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  actions: RelayAction[];
  webhookPayload?: unknown;
  warning?: string;
  version?: string;
  changeLog?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface RelayEvent {
  id: string;
  connectionId: string;
  userId: string;
  platform: string;
  eventType: string;
  payload: unknown;
  headers?: unknown;
  metadata?: unknown;
  signatureValid?: boolean;
  active: boolean;
  deleted: boolean;
  timestamp: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelayDelivery {
  id: string;
  relayEventId: string;
  endpointId: string;
  actionIndex: number;
  status: string;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  attempt: number;
  deliveredAt?: string;
  createdAt: string;
}

// Cache types

export interface CacheEntry<T = unknown> {
  key: string;
  etag: string | null;
  cachedAt: string;
  ttl: number;
  data: T;
}

export interface CacheMeta {
  hit: boolean;
  age: number;
  fresh: boolean;
}

export interface ApiResponseWithMeta<T> {
  data: T;
  etag: string | null;
  status: number;
}

export interface RelayEndpointsResponse {
  rows: RelayEndpoint[];
  total: number;
  pages: number;
  page: number;
}

export interface RelayEventsResponse {
  rows: RelayEvent[];
  total: number;
  pages: number;
  page: number;
}


