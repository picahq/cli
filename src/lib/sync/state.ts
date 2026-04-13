import fs from 'node:fs';
import path from 'node:path';
import type { SyncState, ModelSyncState } from './types.js';

const SYNC_DIR = path.join('.one', 'sync');
const STATE_FILE = path.join(SYNC_DIR, 'sync_state.json');

export function readSyncState(): SyncState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as SyncState;
  } catch {
    return {};
  }
}

/** Atomic write: write to .tmp then rename to prevent corruption on crash */
export function writeSyncState(state: SyncState): void {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

export function getModelState(platform: string, model: string): ModelSyncState | null {
  const state = readSyncState();
  return state[platform]?.[model] ?? null;
}

export function updateModelState(platform: string, model: string, partial: Partial<ModelSyncState>): void {
  const state = readSyncState();
  if (!state[platform]) state[platform] = {};
  const existing = state[platform][model] ?? {
    lastSync: null,
    lastCursor: null,
    totalRecords: 0,
    pagesProcessed: 0,
    since: null,
    status: 'idle' as const,
  };
  state[platform][model] = { ...existing, ...partial };
  writeSyncState(state);
}

export function removeModelState(platform: string, model?: string): void {
  const state = readSyncState();
  if (!state[platform]) return;
  if (model) {
    delete state[platform][model];
    if (Object.keys(state[platform]).length === 0) {
      delete state[platform];
    }
  } else {
    delete state[platform];
  }
  writeSyncState(state);
}
