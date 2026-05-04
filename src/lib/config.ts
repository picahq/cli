import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config, AccessControlSettings, PermissionLevel, WhoAmIResponse } from './types.js';
import type { OneApi } from './api.js';

// Home-rooted paths are resolved LAZILY on every access. Binding them at
// module-load time would cache `os.homedir()` from the initial process env,
// which breaks tests (and any caller) that sets `process.env.HOME` after
// import. Test-isolation bug history: on 2026-04-21, running the unified-
// memory suite clobbered the user's real `~/.one/config.json` because
// these constants had already resolved to the real home before the test's
// `before()` hook ran. Keep these as getters.
function configDir(): string { return path.join(os.homedir(), '.one'); }
function configFile(): string { return path.join(configDir(), 'config.json'); }
function projectsDir(): string { return path.join(configDir(), 'projects'); }

export type ConfigScope = 'project' | 'global';

export interface ResolvedConfig {
  config: Config | null;
  scope: ConfigScope | null;   // null when no config exists anywhere
  path: string;                // path that was read (or would be read)
  projectRoot: string;         // detected project root for cwd
  projectSlug: string;         // slug used for project config dir
}

// ── Project detection ────────────────────────────────────────────────

/**
 * Walk up from cwd looking for a project marker (.git, package.json).
 * Falls back to cwd if nothing is found.
 */
export function getProjectRoot(cwd: string = process.cwd()): string {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (
      fs.existsSync(path.join(dir, '.git')) ||
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(cwd);
}

/**
 * Encode an absolute path into a slug, matching Claude Code's convention:
 * replace path separators with '-'. e.g.
 *   /Users/moe/projects/acme → -Users-moe-projects-acme
 */
export function getProjectSlug(projectRoot: string = getProjectRoot()): string {
  return projectRoot.replace(/[\\/]/g, '-');
}

export function getProjectConfigDir(projectRoot: string = getProjectRoot()): string {
  return path.join(projectsDir(), getProjectSlug(projectRoot));
}

export function getProjectConfigPath(projectRoot: string = getProjectRoot()): string {
  return path.join(getProjectConfigDir(projectRoot), 'config.json');
}

export function getGlobalConfigPath(): string {
  return configFile();
}

// ── Resolver ─────────────────────────────────────────────────────────

/**
 * Resolve which config to use for the current cwd. Project config wins when
 * present; otherwise the global config. Callers that need scope-awareness
 * should use this; convenience wrappers below preserve the legacy API.
 */
export function resolveConfig(): ResolvedConfig {
  const projectRoot = getProjectRoot();
  const projectSlug = getProjectSlug(projectRoot);
  const projectPath = getProjectConfigPath(projectRoot);

  // Check detected project root first
  if (fs.existsSync(projectPath)) {
    const config = readConfigFile(projectPath);
    if (config) {
      return { config, scope: 'project', path: projectPath, projectRoot, projectSlug };
    }
  }

  // Walk up from cwd checking each ancestor for a project config
  const root = path.parse(process.cwd()).root;
  let dir = path.resolve(process.cwd());
  while (dir !== root) {
    dir = path.dirname(dir);
    const slug = getProjectSlug(dir);
    const configPath = path.join(projectsDir(), slug, 'config.json');
    if (fs.existsSync(configPath)) {
      const config = readConfigFile(configPath);
      if (config) {
        return { config, scope: 'project', path: configPath, projectRoot: dir, projectSlug: slug };
      }
    }
  }

  if (fs.existsSync(configFile())) {
    const config = readConfigFile(configFile());
    if (config) {
      return { config, scope: 'global', path: configFile(), projectRoot, projectSlug };
    }
  }

  return { config: null, scope: null, path: configFile(), projectRoot, projectSlug };
}

function readConfigFile(filePath: string): Config | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Config;
  } catch {
    return null;
  }
}

// ── Legacy API (preserves existing call sites) ───────────────────────

export function getConfigPath(): string {
  return resolveConfig().path;
}

export function configExists(): boolean {
  return resolveConfig().config !== null;
}

export function globalConfigExists(): boolean {
  return fs.existsSync(configFile());
}

export function projectConfigExists(projectRoot: string = getProjectRoot()): boolean {
  return fs.existsSync(getProjectConfigPath(projectRoot));
}

export function getActiveScope(): ConfigScope | null {
  return resolveConfig().scope;
}

export function readConfig(): Config | null {
  return resolveConfig().config;
}

/**
 * Read only the global config, regardless of project scope. Used by init
 * when presenting scope choices or switching between them.
 */
export function readGlobalConfig(): Config | null {
  if (!fs.existsSync(configFile())) return null;
  return readConfigFile(configFile());
}

/**
 * Read only the project config for the current cwd, regardless of fallback.
 */
export function readProjectConfig(): Config | null {
  const projectPath = getProjectConfigPath();
  if (!fs.existsSync(projectPath)) return null;
  return readConfigFile(projectPath);
}

/**
 * Write config. When `scope` is omitted, writes to whichever scope is
 * currently active (project if one exists for cwd, else global). This keeps
 * callers like updateAccessControl/updateApiBase scope-preserving.
 */
export function writeConfig(config: Config, scope?: ConfigScope): void {
  const targetScope: ConfigScope = scope ?? resolveConfig().scope ?? 'global';

  if (targetScope === 'project') {
    const dir = getProjectConfigDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const filePath = getProjectConfigPath();
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
    return;
  }

  if (!fs.existsSync(configDir())) {
    fs.mkdirSync(configDir(), { mode: 0o700 });
  }
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── .onerc override (unchanged behavior) ─────────────────────────────

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
  // Priority: env var > .onerc > project config > global config
  if (process.env.ONE_SECRET) return process.env.ONE_SECRET;

  const rc = readOneRc();
  if (rc.ONE_SECRET) return rc.ONE_SECRET;

  return readConfig()?.apiKey ?? null;
}

/**
 * Resolve the OpenAI API key using the same precedence as ONE_SECRET:
 *   env > .onerc > project config > global config.
 *
 * `openaiApiKey` is a top-level Config field (peer of `apiKey`) so every
 * subsystem that needs OpenAI reads from one canonical place and respects
 * project/global scope + file mode 0600.
 */
export function getOpenAiApiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  const rc = readOneRc();
  if (rc.OPENAI_API_KEY) return rc.OPENAI_API_KEY;

  return readConfig()?.openaiApiKey ?? null;
}

/**
 * Persist the OpenAI API key to the active config scope (project if a
 * project config exists for cwd, else global). File mode 0600 is enforced
 * by writeConfig. Pass an empty string to clear the key instead of
 * persisting an empty value.
 */
export function setOpenAiApiKey(key: string): void {
  const resolved = resolveConfig();
  if (!resolved.config) {
    throw new Error('No One config found. Run `one init` first.');
  }
  if (key === '') {
    delete resolved.config.openaiApiKey;
  } else {
    resolved.config.openaiApiKey = key;
  }
  writeConfig(resolved.config, resolved.scope ?? 'global');
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

const DEFAULT_API_BASE = 'https://api.withone.ai/v1';

export function getApiBase(): string {
  const config = readConfig();
  if (config?.apiBase) return `${config.apiBase}/v1`;
  return DEFAULT_API_BASE;
}

export function updateApiBase(url: string | null): void {
  const config = readConfig();
  if (!config) return;

  if (url) {
    config.apiBase = url;
  } else {
    delete config.apiBase;
  }

  // Clear cached whoami — base URL changed, so it needs to be re-fetched
  delete config.whoami;

  writeConfig(config);
}

export function getCacheTtl(): number {
  if (process.env.ONE_CACHE_TTL) {
    const val = parseInt(process.env.ONE_CACHE_TTL, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  const config = readConfig();
  if (config?.cacheTtl && config.cacheTtl > 0) return config.cacheTtl;
  return 3600;
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

// ── WhoAmI helpers ──────────────────────────────────────────────────

export function getWhoAmI(): WhoAmIResponse | null {
  return readConfig()?.whoami ?? null;
}

export function updateWhoAmI(whoami: WhoAmIResponse): void {
  const config = readConfig();
  if (!config) return;
  config.whoami = whoami;
  writeConfig(config);
}

export async function ensureWhoAmI(api: OneApi): Promise<WhoAmIResponse | null> {
  const cached = getWhoAmI();
  if (cached) return cached;

  try {
    const whoami = await api.whoami();
    updateWhoAmI(whoami);
    return whoami;
  } catch {
    return null;
  }
}

export function getEnvFromApiKey(apiKey: string): 'live' | 'test' {
  return apiKey.startsWith('sk_test_') ? 'test' : 'live';
}
