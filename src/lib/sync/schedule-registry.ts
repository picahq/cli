import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Global registry of sync schedules. Cron is still the execution engine
 * (survives reboots, managed by the OS), but the CLI owns the source of
 * truth for what schedules exist, where they run, and when they last ran.
 *
 * The registry lives at ~/.one/sync/schedules.json so a user can `sync
 * schedule list` from any directory and see every schedule across every
 * project they've ever set up.
 */

const REGISTRY_DIR = path.join(os.homedir(), '.one', 'sync');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'schedules.json');

export interface RegisteredSchedule {
  /** Stable id, e.g. "notion-cron-sync-test" (platform + slug of cwd). */
  id: string;
  platform: string;
  models?: string[];
  every: string;
  cronExpr: string;
  /** Working directory the schedule runs from. */
  cwd: string;
  /** Absolute path to the node binary used at creation time. */
  nodeBin: string;
  /** Absolute path to the CLI entry used at creation time. */
  cliBin: string;
  /** Absolute path to the log file cron appends to. */
  logFile: string;
  createdAt: string;
}

interface RegistryFile {
  schedules: RegisteredSchedule[];
}

function readRaw(): RegistryFile {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return { schedules: [] };
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!parsed || !Array.isArray(parsed.schedules)) return { schedules: [] };
    return parsed;
  } catch {
    return { schedules: [] };
  }
}

function writeRaw(file: RegistryFile): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const tmp = REGISTRY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, REGISTRY_FILE);
}

/** Generate a stable id from platform + cwd basename. */
export function makeScheduleId(platform: string, cwd: string): string {
  const slug = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  return `${platform}-${slug}`;
}

export function listRegistered(): RegisteredSchedule[] {
  return readRaw().schedules;
}

export function getRegistered(id: string): RegisteredSchedule | undefined {
  return readRaw().schedules.find(s => s.id === id);
}

export function findByPlatform(platform: string, cwd?: string): RegisteredSchedule[] {
  const all = readRaw().schedules;
  return all.filter(s => s.platform === platform && (cwd ? s.cwd === cwd : true));
}

export function upsertRegistered(entry: RegisteredSchedule): void {
  const file = readRaw();
  const idx = file.schedules.findIndex(s => s.id === entry.id);
  if (idx >= 0) {
    file.schedules[idx] = entry;
  } else {
    file.schedules.push(entry);
  }
  writeRaw(file);
}

export function removeRegistered(id: string): boolean {
  const file = readRaw();
  const before = file.schedules.length;
  file.schedules = file.schedules.filter(s => s.id !== id);
  if (file.schedules.length === before) return false;
  writeRaw(file);
  return true;
}
