import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config, AccessControlSettings, PermissionLevel } from './types.js';

const CONFIG_DIR = path.join(os.homedir(), '.one');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function readConfig(): Config | null {
  if (!configExists()) {
    return null;
  }
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as Config;
  } catch {
    return null;
  }
}

export function writeConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function readOneRc(): Record<string, string> {
  const rcPath = path.join(process.cwd(), '.onerc');
  if (!fs.existsSync(rcPath)) return {};

  try {
    const content = fs.readFileSync(rcPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function getApiKey(): string | null {
  // Priority: env var > .onerc > ~/.one/config.json
  if (process.env.ONE_SECRET) return process.env.ONE_SECRET;

  const rc = readOneRc();
  if (rc.ONE_SECRET) return rc.ONE_SECRET;

  return readConfig()?.apiKey ?? null;
}

export function getAccessControlFromAllSources(): AccessControlSettings {
  const rc = readOneRc();
  const fileAc = getAccessControl();

  // .onerc overrides take priority over config file
  const merged: AccessControlSettings = { ...fileAc };

  if (rc.ONE_PERMISSIONS) {
    merged.permissions = rc.ONE_PERMISSIONS as PermissionLevel;
  }
  if (rc.ONE_CONNECTION_KEYS) {
    merged.connectionKeys = rc.ONE_CONNECTION_KEYS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (rc.ONE_ACTION_IDS) {
    merged.actionIds = rc.ONE_ACTION_IDS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (rc.ONE_KNOWLEDGE_AGENT) {
    merged.knowledgeAgent = rc.ONE_KNOWLEDGE_AGENT === 'true';
  }

  return merged;
}

export function updateInstalledAgents(agentIds: string[]): void {
  const config = readConfig();
  if (config) {
    config.installedAgents = agentIds;
    writeConfig(config);
  }
}

export function getAccessControl(): AccessControlSettings {
  return readConfig()?.accessControl ?? {};
}

export function updateAccessControl(settings: AccessControlSettings): void {
  const config = readConfig();
  if (!config) return;

  const cleaned: AccessControlSettings = {};

  if (settings.permissions && settings.permissions !== 'admin') {
    cleaned.permissions = settings.permissions;
  }
  if (settings.connectionKeys && !(settings.connectionKeys.length === 1 && settings.connectionKeys[0] === '*')) {
    cleaned.connectionKeys = settings.connectionKeys;
  }
  if (settings.actionIds && !(settings.actionIds.length === 1 && settings.actionIds[0] === '*')) {
    cleaned.actionIds = settings.actionIds;
  }
  if (settings.knowledgeAgent) {
    cleaned.knowledgeAgent = true;
  }

  if (Object.keys(cleaned).length === 0) {
    delete config.accessControl;
  } else {
    config.accessControl = cleaned;
  }

  writeConfig(config);
}
