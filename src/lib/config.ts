import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
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
 * Walk up from cwd looking for a project marker (.one, .git, package.json).
 * Falls back to cwd if nothing is found.
 *
 * `.one` is listed first so a monorepo subproject can opt into being its
 * own project root with `mkdir .one`, even when a parent already has .git
 * or package.json. Without this opt-in, every cwd under a parent marker
 * shares one project config keyed by the parent's slug.
 */
export function getProjectRoot(cwd: string = process.cwd()): string {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (
      fs.existsSync(path.join(dir, '.one')) ||
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
 * Encode an absolute path into a slug suitable for use as a single
 * directory name on every supported OS. Replaces path separators and
 * any character Windows forbids in a path component (`< > : " | ? *`)
 * with `-`. e.g.
 *   /Users/moe/projects/acme  → -Users-moe-projects-acme
 *   C:\Users\moe\projects\acme → C--Users-moe-projects-acme
 *
 * Without `:` in the replace set, a Windows path's drive-letter colon
 * survives in the slug — `C:-Users-...` — and `mkdirSync` of
 * `<HOME>\.one\projects\C:-Users-...` errors with ENOENT because NTFS
 * rejects `:` inside a path component. INT-2828.
 */
export function getProjectSlug(projectRoot: string = getProjectRoot()): string {
  return projectRoot.replace(/[\\/<>:"|?*]/g, '-');
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
  const detectedRoot = getProjectRoot();
  const detectedSlug = getProjectSlug(detectedRoot);

  // Walk from cwd up, checking each level's slug for a project config.
  // First match wins — closer to cwd is more specific (mirrors how
  // .gitignore / .envrc / .editorconfig resolve). This also catches the
  // "orphan config" case where a project config exists under cwd's slug
  // but cwd has no marker, so the marker walk above would otherwise
  // skip over it and fall through to global.
  const root = path.parse(process.cwd()).root;
  let dir = path.resolve(process.cwd());
  while (true) {
    const slug = getProjectSlug(dir);
    const configPath = path.join(projectsDir(), slug, 'config.json');
    if (fs.existsSync(configPath)) {
      const config = readConfigFile(configPath);
      if (config) {
        return { config, scope: 'project', path: configPath, projectRoot: dir, projectSlug: slug };
      }
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }

  // No project config anywhere; check global. Report the marker-detected
  // root in projectRoot so `one config path` still shows where a future
  // project config *would* live.
  if (fs.existsSync(configFile())) {
    const config = readConfigFile(configFile());
    if (config) {
      return { config, scope: 'global', path: configFile(), projectRoot: detectedRoot, projectSlug: detectedSlug };
    }
  }

  return { config: null, scope: null, path: configFile(), projectRoot: detectedRoot, projectSlug: detectedSlug };
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

// ── Analytics helpers (~/.one markers, no PII) ───────────────────────

function deviceIdFile(): string { return path.join(configDir(), 'device-id'); }
function telemetryNoticeFile(): string { return path.join(configDir(), '.telemetry-notice'); }

/**
 * Stable, random per-install id used as the analytics distinct_id before
 * the user authenticates (once logged in we key on the One user id instead,
 * so CLI + dashboard events unify on the same person). Stored once in
 * ~/.one/device-id. Best-effort: if the file can't be written we still return
 * a usable id for this process.
 */
export function getDeviceId(): string {
  try {
    const existing = fs.readFileSync(deviceIdFile(), 'utf-8').trim();
    if (existing) return existing;
  } catch { /* not created yet */ }

  const id = randomUUID();
  try {
    if (!fs.existsSync(configDir())) fs.mkdirSync(configDir(), { mode: 0o700 });
    fs.writeFileSync(deviceIdFile(), id, { mode: 0o600 });
  } catch { /* best-effort; fall through with the in-memory id */ }
  return id;
}

/** Whether the one-time telemetry disclosure has already been shown. */
export function telemetryNoticeShown(): boolean {
  return fs.existsSync(telemetryNoticeFile());
}

/** Record that the one-time telemetry disclosure has been shown. */
export function markTelemetryNoticeShown(): void {
  try {
    if (!fs.existsSync(configDir())) fs.mkdirSync(configDir(), { mode: 0o700 });
    fs.writeFileSync(telemetryNoticeFile(), new Date().toISOString(), { mode: 0o600 });
  } catch { /* best-effort */ }
}

// Bounded on-disk queue of analytics events not yet confirmed delivered. A
// CLI process is short-lived and analytics latency is ~1s, so we persist
// events instantly (sync) and deliver them opportunistically / on a later
// run — telemetry never blocks a command and nothing is lost when the process
// exits before a request completes. JSONL, one event per line.
function analyticsQueueFile(): string { return path.join(configDir(), '.analytics-queue.jsonl'); }
const ANALYTICS_QUEUE_MAX = 500;

export function appendAnalyticsQueue(line: string): void {
  try {
    if (!fs.existsSync(configDir())) fs.mkdirSync(configDir(), { mode: 0o700 });
    fs.appendFileSync(analyticsQueueFile(), `${line}\n`, { mode: 0o600 });
  } catch { /* best-effort */ }
}

export function readAnalyticsQueue(): string[] {
  try {
    return fs.readFileSync(analyticsQueueFile(), 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Replace the queue with `lines` (capped, newest kept); deletes it when empty. */
export function writeAnalyticsQueue(lines: string[]): void {
  try {
    if (lines.length === 0) {
      fs.rmSync(analyticsQueueFile(), { force: true });
      return;
    }
    if (!fs.existsSync(configDir())) fs.mkdirSync(configDir(), { mode: 0o700 });
    fs.writeFileSync(analyticsQueueFile(), `${lines.slice(-ANALYTICS_QUEUE_MAX).join('\n')}\n`, { mode: 0o600 });
  } catch { /* best-effort */ }
}

// Append-only log of CLI commands awaiting roll-up. To avoid flooding PostHog
// (and its bill) with one event per command, the CLI appends each command here
// and periodically emits ONE aggregated "CLI Usage Rollup" event with exact
// counts. Append-only JSONL is crash- and concurrency-safe — parallel CLI
// invocations can't corrupt it (same property the analytics queue relies on).
function usageLogFile(): string { return path.join(configDir(), '.cli-usage-log.jsonl'); }
function usageStateFile(): string { return path.join(configDir(), '.cli-usage-state.json'); }
const USAGE_LOG_MAX = 5000; // hard safety cap; the flush triggers keep it far below this

export function appendUsageLog(line: string): void {
  try {
    if (!fs.existsSync(configDir())) fs.mkdirSync(configDir(), { mode: 0o700 });
    fs.appendFileSync(usageLogFile(), `${line}\n`, { mode: 0o600 });
  } catch { /* best-effort */ }
}

export function readUsageLog(): string[] {
  try {
    return fs.readFileSync(usageLogFile(), 'utf-8').split('\n').filter(Boolean).slice(-USAGE_LOG_MAX);
  } catch {
    return [];
  }
}

/** Replace the usage log with `lines` (capped, newest kept); deletes it when empty. */
export function writeUsageLog(lines: string[]): void {
  try {
    if (lines.length === 0) {
      fs.rmSync(usageLogFile(), { force: true });
      return;
    }
    if (!fs.existsSync(configDir())) fs.mkdirSync(configDir(), { mode: 0o700 });
    fs.writeFileSync(usageLogFile(), `${lines.slice(-USAGE_LOG_MAX).join('\n')}\n`, { mode: 0o600 });
  } catch { /* best-effort */ }
}

/** First-touch bookkeeping so every user is captured on their first command of the day. */
export interface UsageState { lastDay?: string; distinctId?: string }

export function readUsageState(): UsageState {
  try {
    return JSON.parse(fs.readFileSync(usageStateFile(), 'utf-8')) as UsageState;
  } catch {
    return {};
  }
}

export function writeUsageState(state: UsageState): void {
  try {
    if (!fs.existsSync(configDir())) fs.mkdirSync(configDir(), { mode: 0o700 });
    fs.writeFileSync(usageStateFile(), JSON.stringify(state), { mode: 0o600 });
  } catch { /* best-effort */ }
}
