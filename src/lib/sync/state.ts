import fs from 'node:fs';
import path from 'node:path';
import type { SyncState, ModelSyncState } from './types.js';

const SYNC_DIR = path.join('.one', 'sync');
const STATE_DIR = path.join(SYNC_DIR, 'state');
const LEGACY_STATE_FILE = path.join(SYNC_DIR, 'sync_state.json');

// Per-platform/per-model state files live at `.one/sync/state/<platform>/<model>.json`.
// One writer per file means atomic rename can't collide with another writer, and
// there's no shared read-modify-write snapshot that can drop a concurrent update.

function modelFilePath(platform: string, model: string): string {
  return path.join(STATE_DIR, platform, `${model}.json`);
}

/**
 * One-time migration from the legacy single-file layout. Safe to call on every
 * read — no-ops once the old file is gone. If both old and new exist (e.g. a
 * partial migration in a prior run), the new layout wins and the legacy file
 * is removed.
 */
function migrateLegacyIfNeeded(): void {
  if (!fs.existsSync(LEGACY_STATE_FILE)) return;
  try {
    const raw = fs.readFileSync(LEGACY_STATE_FILE, 'utf-8');
    const legacy = JSON.parse(raw) as SyncState;
    for (const [platform, models] of Object.entries(legacy)) {
      for (const [model, modelState] of Object.entries(models)) {
        if (fs.existsSync(modelFilePath(platform, model))) continue;
        writeModelFile(platform, model, modelState);
      }
    }
    fs.unlinkSync(LEGACY_STATE_FILE);
  } catch {
    // Best-effort. If parsing fails, drop the legacy file so it stops shadowing
    // the new layout.
    try { fs.unlinkSync(LEGACY_STATE_FILE); } catch { /* ignore */ }
  }
}

function writeModelFile(platform: string, model: string, state: ModelSyncState): void {
  const dir = path.join(STATE_DIR, platform);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${model}.json`);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function readModelFile(platform: string, model: string): ModelSyncState | null {
  try {
    const raw = fs.readFileSync(modelFilePath(platform, model), 'utf-8');
    return JSON.parse(raw) as ModelSyncState;
  } catch {
    return null;
  }
}

export function readSyncState(): SyncState {
  migrateLegacyIfNeeded();
  const result: SyncState = {};
  let platforms: string[];
  try {
    platforms = fs.readdirSync(STATE_DIR);
  } catch {
    return result;
  }
  for (const platform of platforms) {
    const platformDir = path.join(STATE_DIR, platform);
    let entries: string[];
    try {
      entries = fs.readdirSync(platformDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const model = entry.slice(0, -'.json'.length);
      const modelState = readModelFile(platform, model);
      if (modelState) {
        if (!result[platform]) result[platform] = {};
        result[platform][model] = modelState;
      }
    }
  }
  return result;
}

export function getModelState(platform: string, model: string): ModelSyncState | null {
  migrateLegacyIfNeeded();
  return readModelFile(platform, model);
}

export function updateModelState(platform: string, model: string, partial: Partial<ModelSyncState>): void {
  migrateLegacyIfNeeded();
  const existing = readModelFile(platform, model) ?? {
    lastSync: null,
    lastCursor: null,
    totalRecords: 0,
    pagesProcessed: 0,
    since: null,
    status: 'idle' as const,
  };
  writeModelFile(platform, model, { ...existing, ...partial });
}

export function removeModelState(platform: string, model?: string): void {
  migrateLegacyIfNeeded();
  const platformDir = path.join(STATE_DIR, platform);
  if (model) {
    try { fs.unlinkSync(modelFilePath(platform, model)); } catch { /* already gone */ }
    try {
      if (fs.readdirSync(platformDir).length === 0) fs.rmdirSync(platformDir);
    } catch { /* dir already gone or not empty */ }
  } else {
    try { fs.rmSync(platformDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
