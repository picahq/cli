import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listRegistered,
  getRegistered,
  findByPlatform,
  upsertRegistered,
  removeRegistered,
  makeScheduleId,
  type RegisteredSchedule,
} from './schedule-registry.js';

const MARKER = '# one-sync';
const LOG_DIR_REL = path.join('.one', 'sync', 'logs');

export interface ScheduleEntry extends RegisteredSchedule {
  /** Whether a matching cron line exists right now in the user's crontab. */
  cronInstalled: boolean;
}

// ── Duration ↔ cron expression ──

export function durationToCron(every: string): string | null {
  const match = every.match(/^(\d+)([mhd])$/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2];

  if (unit === 'm') {
    if (amount < 1 || amount > 59 || 60 % amount !== 0) return null;
    return `*/${amount} * * * *`;
  }
  if (unit === 'h') {
    if (amount < 1 || amount > 23 || 24 % amount !== 0) return null;
    return `0 */${amount} * * *`;
  }
  if (unit === 'd') {
    if (amount !== 1) return null;
    return '0 0 * * *';
  }
  return null;
}

function cronExprToDuration(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;
  const mm = min.match(/^\*\/(\d+)$/);
  if (mm && hour === '*') return `${mm[1]}m`;
  const hm = hour.match(/^\*\/(\d+)$/);
  if (hm && min === '0') return `${hm[1]}h`;
  if (min === '0' && hour === '0') return '1d';
  return null;
}

// ── Environment helpers ──

function isWindows(): boolean {
  return os.platform() === 'win32';
}

function resolveOneBinary(): string {
  try {
    const entry = process.argv[1];
    if (entry && fs.existsSync(entry)) {
      return fs.realpathSync(entry);
    }
  } catch {
    // fall through
  }
  return 'one';
}

// ── Crontab I/O ──

function readCrontab(): string {
  try {
    const result = spawnSync('crontab', ['-l'], { encoding: 'utf-8' });
    if (result.status !== 0) return '';
    return result.stdout || '';
  } catch {
    return '';
  }
}

function writeCrontab(content: string): void {
  const result = spawnSync('crontab', ['-'], { input: content, encoding: 'utf-8' });
  if (result.status !== 0) {
    const stderr = result.stderr || '';
    // macOS TCC-specific hint
    if (stderr.includes('Operation not permitted')) {
      throw new Error(
        'crontab write was blocked by macOS privacy protection. ' +
        'Grant Full Disk Access to your terminal app in System Settings → Privacy & Security → Full Disk Access, then retry.'
      );
    }
    throw new Error(`Failed to write crontab: ${stderr || 'unknown error'}`);
  }
}

// ── Cron line building / matching ──

function buildCronLine(entry: RegisteredSchedule): string {
  const modelsArg = entry.models && entry.models.length > 0 ? ` --models ${entry.models.join(',')}` : '';
  const command =
    `cd ${JSON.stringify(entry.cwd)} && ` +
    `${JSON.stringify(entry.nodeBin)} ${JSON.stringify(entry.cliBin)} sync run ${entry.platform}${modelsArg} ` +
    `>> ${JSON.stringify(entry.logFile)} 2>&1`;
  return `${entry.cronExpr} ${command} ${MARKER}:${entry.id}`;
}

/**
 * Find any crontab line belonging to a specific schedule id. Supports both
 * new-format tags (`# one-sync:<id>`) and legacy tags (`# one-sync:<platform>`)
 * so migration from the old scheme works cleanly.
 */
function crontabHasId(crontab: string, id: string, legacyPlatform?: string): boolean {
  const lines = crontab.split('\n');
  return lines.some(
    l =>
      l.includes(`${MARKER}:${id}`) ||
      (legacyPlatform ? l.includes(`${MARKER}:${legacyPlatform}`) : false),
  );
}

/** Remove any crontab lines matching a schedule id or legacy platform tag. */
function removeCronLines(crontab: string, id: string, legacyPlatform?: string): string {
  const lines = crontab.split('\n');
  const filtered = lines.filter(
    l =>
      !l.includes(`${MARKER}:${id}`) &&
      !(legacyPlatform && l.includes(`${MARKER}:${legacyPlatform}`) && l.includes(process.cwd())),
  );
  return filtered.filter(l => l.length > 0).join('\n') + '\n';
}

// ── Migration from legacy cron-only schedules ──

/**
 * Scan the current crontab for legacy `# one-sync:<platform>` entries that
 * aren't in the registry yet, and backfill them. Idempotent.
 */
function migrateLegacyCronEntries(): void {
  const crontab = readCrontab();
  if (!crontab.includes(MARKER)) return;

  const registered = listRegistered();
  const registeredIds = new Set(registered.map(s => s.id));

  for (const line of crontab.split('\n')) {
    if (!line.includes(MARKER)) continue;

    // Match legacy format: `# one-sync:<platform>` at end of line
    const tagMatch = line.match(new RegExp(`${MARKER}:(\\S+)\\s*$`));
    if (!tagMatch) continue;
    const tag = tagMatch[1];

    // If the tag already looks like a new-format id that's registered, skip
    if (registeredIds.has(tag)) continue;

    // Extract cron expression and command
    const parseMatch = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+?)\s+#/);
    if (!parseMatch) continue;
    const cronExpr = parseMatch[1];
    const command = parseMatch[2];

    // Parse out cwd, nodeBin, cliBin, platform, models, logFile from the command
    const cwdMatch = command.match(/^cd\s+"([^"]+)"/);
    const cwd = cwdMatch ? cwdMatch[1] : process.cwd();

    // Two possible command shapes we've shipped:
    //   cd "cwd" && "cliBin" sync run platform ...              (very old)
    //   cd "cwd" && "nodeBin" "cliBin" sync run platform ...    (current)
    const twoPath = command.match(/"([^"]+)"\s+"([^"]+)"\s+sync\s+run\s+(\S+)/);
    const onePath = command.match(/&&\s+"([^"]+)"\s+sync\s+run\s+(\S+)/);

    let nodeBin = process.execPath;
    let cliBin = resolveOneBinary();
    let platform = tag;
    if (twoPath) {
      nodeBin = twoPath[1];
      cliBin = twoPath[2];
      platform = twoPath[3];
    } else if (onePath) {
      cliBin = onePath[1];
      platform = onePath[2];
    }

    const modelsMatch = command.match(/--models\s+(\S+)/);
    const models = modelsMatch ? modelsMatch[1].split(',') : undefined;

    const logMatch = command.match(/>>\s+"([^"]+)"/);
    const logFile = logMatch ? logMatch[1] : path.resolve(cwd, LOG_DIR_REL, `${platform}.log`);

    const id = makeScheduleId(platform, cwd);
    if (registeredIds.has(id)) continue;

    upsertRegistered({
      id,
      platform,
      models,
      every: cronExprToDuration(cronExpr) ?? cronExpr,
      cronExpr,
      cwd,
      nodeBin,
      cliBin,
      logFile,
      createdAt: new Date().toISOString(),
    });
    registeredIds.add(id);
  }
}

// ── Public API ──

export interface AddScheduleOptions {
  platform: string;
  every: string;
  models?: string[];
}

export interface AddScheduleResult {
  entry: RegisteredSchedule;
  replaced: boolean;
}

export function addSchedule(opts: AddScheduleOptions): AddScheduleResult {
  if (isWindows()) {
    throw new Error(
      'Scheduling via `one sync schedule` is not supported on Windows yet. ' +
      'Use Task Scheduler manually: create a task that runs `one sync run ' + opts.platform + '` on your interval.'
    );
  }

  const cronExpr = durationToCron(opts.every);
  if (!cronExpr) {
    throw new Error(
      `Invalid --every value "${opts.every}". Supported: <n>m (must divide 60), <n>h (must divide 24), or 1d. ` +
      `Examples: 15m, 30m, 1h, 6h, 12h, 1d`
    );
  }

  migrateLegacyCronEntries();

  const cwd = process.cwd();
  const id = makeScheduleId(opts.platform, cwd);
  const replaced = getRegistered(id) !== undefined;
  const logDir = path.join(cwd, LOG_DIR_REL);
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${opts.platform}.log`);

  const entry: RegisteredSchedule = {
    id,
    platform: opts.platform,
    models: opts.models,
    every: opts.every,
    cronExpr,
    cwd,
    nodeBin: process.execPath,
    cliBin: resolveOneBinary(),
    logFile,
    createdAt: new Date().toISOString(),
  };

  // Remove any prior cron line for this id (or legacy platform-tagged line in same cwd)
  const current = readCrontab();
  const cleaned = removeCronLines(current, id, opts.platform);
  const nextLine = buildCronLine(entry);
  const next = (cleaned.trimEnd() + '\n' + nextLine + '\n').replace(/^\n+/, '');
  writeCrontab(next);

  upsertRegistered(entry);
  return { entry, replaced };
}

export function listSchedules(): ScheduleEntry[] {
  migrateLegacyCronEntries();
  const registered = listRegistered();
  const crontab = readCrontab();
  return registered.map(entry => ({
    ...entry,
    cronInstalled: crontabHasId(crontab, entry.id, entry.platform),
  }));
}

export interface RemoveResult {
  removed: RegisteredSchedule[];
  notFound: boolean;
}

/**
 * Remove a schedule by id, or by platform (removes all schedules for that
 * platform across all projects when no id is given).
 */
export function removeSchedule(idOrPlatform: string, options?: { allProjects?: boolean }): RemoveResult {
  migrateLegacyCronEntries();

  // Exact id match first
  const byId = getRegistered(idOrPlatform);
  let toRemove: RegisteredSchedule[];
  if (byId) {
    toRemove = [byId];
  } else {
    // Fall back to platform match, default to current cwd unless --all
    const cwd = options?.allProjects ? undefined : process.cwd();
    toRemove = findByPlatform(idOrPlatform, cwd);
  }

  if (toRemove.length === 0) {
    return { removed: [], notFound: true };
  }

  let crontab = readCrontab();
  for (const entry of toRemove) {
    crontab = removeCronLines(crontab, entry.id, entry.platform);
    removeRegistered(entry.id);
  }
  writeCrontab(crontab);

  return { removed: toRemove, notFound: false };
}

export interface ScheduleStatus {
  entry: ScheduleEntry;
  logExists: boolean;
  logSize: number;
  logTail: string[];
  lastRunAt: string | null;
  drift: 'ok' | 'missing-cron' | 'stale-node-bin' | 'stale-cli-bin';
}

export function scheduleStatus(): ScheduleStatus[] {
  const entries = listSchedules();
  return entries.map(entry => {
    const logExists = fs.existsSync(entry.logFile);
    const logSize = logExists ? fs.statSync(entry.logFile).size : 0;
    let logTail: string[] = [];
    let lastRunAt: string | null = null;
    if (logExists) {
      try {
        lastRunAt = fs.statSync(entry.logFile).mtime.toISOString();
        if (logSize > 0) {
          const content = fs.readFileSync(entry.logFile, 'utf-8');
          logTail = content.trim().split('\n').slice(-10);
        }
      } catch {
        // ignore
      }
    }

    let drift: ScheduleStatus['drift'] = 'ok';
    if (!entry.cronInstalled) drift = 'missing-cron';
    else if (!fs.existsSync(entry.nodeBin)) drift = 'stale-node-bin';
    else if (!fs.existsSync(entry.cliBin)) drift = 'stale-cli-bin';

    return { entry, logExists, logSize, logTail, lastRunAt, drift };
  });
}

/**
 * Re-install the cron line for a registered schedule whose cron entry is
 * missing or broken (drift). Useful when a user hand-edited their crontab or
 * moved the CLI binary.
 */
export function repairSchedule(id: string): RegisteredSchedule {
  const entry = getRegistered(id);
  if (!entry) throw new Error(`No registered schedule with id "${id}".`);

  // Update stale paths to current values
  const healed: RegisteredSchedule = {
    ...entry,
    nodeBin: process.execPath,
    cliBin: resolveOneBinary(),
  };

  const crontab = readCrontab();
  const cleaned = removeCronLines(crontab, healed.id, healed.platform);
  const next = (cleaned.trimEnd() + '\n' + buildCronLine(healed) + '\n').replace(/^\n+/, '');
  writeCrontab(next);

  upsertRegistered(healed);
  return healed;
}
