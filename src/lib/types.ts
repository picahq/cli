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

export interface Config {
  apiKey: string;
  installedAgents: string[];
  createdAt: string;
}

export interface ConnectionsResponse {
  rows: Connection[];
  total: number;
  pages: number;
  page: number;
}

