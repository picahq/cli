/**
 * Sync state persistence — thin adapter over the memory backend's
 * `mem_sync_state` table. Historically this lived in `.one/sync/state/
 * <platform>/<model>.json`; the unified memory branch moves it into the
 * database so the whole sync subsystem has a single source of truth.
 *
 * Legacy files (both the newer per-model layout and the older single-
 * file `sync_state.json`) are migrated into the backend on first access
 * and then deleted. No data loss during the upgrade.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getBackend } from '../runtime.js';
import type { SyncStateRow } from '../types.js';
import type { SyncState, ModelSyncState } from './types.js';

const SYNC_DIR = path.join('.one', 'sync');
const STATE_DIR = path.join(SYNC_DIR, 'state');
const LEGACY_SINGLE_FILE = path.join(SYNC_DIR, 'sync_state.json');

let legacyMigrationDone = false;

// ── Row ↔ ModelSyncState conversion ────────────────────────────────────────
//
// The backend row uses snake_case + JSONB; the sync module's in-memory
// shape is camelCase with `unknown` for cursor payloads. Keep the two
// shapes local so the rest of the codebase can keep using ModelSyncState
// without re-flowing types everywhere.

function rowToState(row: SyncStateRow): ModelSyncState {
  return {
    lastSync: row.last_sync_at ?? null,
    lastCursor: row.last_cursor ?? null,
    totalRecords: row.total_records,
    pagesProcessed: row.pages_processed,
    since: row.since ?? null,
    status: row.status,
  };
}

function stateToRow(platform: string, model: string, state: ModelSyncState, lastError?: string | null): SyncStateRow {
  return {
    platform,
    model,
    last_sync_at: state.lastSync ?? null,
    last_cursor: state.lastCursor ?? null,
    since: state.since ?? null,
    total_records: state.totalRecords,
    pages_processed: state.pagesProcessed,
    status: state.status,
    last_error: lastError ?? null,
  };
}

// ── Legacy file migration ──────────────────────────────────────────────────

async function migrateLegacyOnce(): Promise<void> {
  if (legacyMigrationDone) return;
  legacyMigrationDone = true;

  // Old single-file layout (SyncState map, pre-per-model JSON).
  if (fs.existsSync(LEGACY_SINGLE_FILE)) {
    try {
      const raw = fs.readFileSync(LEGACY_SINGLE_FILE, 'utf-8');
      const legacy = JSON.parse(raw) as SyncState;
      const backend = await getBackend();
      for (const [platform, models] of Object.entries(legacy)) {
        for (const [model, modelState] of Object.entries(models)) {
          const existing = await backend.getSyncState(platform, model);
          if (existing) continue;
          await backend.setSyncState(stateToRow(platform, model, modelState));
        }
      }
      fs.unlinkSync(LEGACY_SINGLE_FILE);
    } catch {
      try { fs.unlinkSync(LEGACY_SINGLE_FILE); } catch { /* ignore */ }
    }
  }

  // Per-model files at `.one/sync/state/<platform>/<model>.json`.
  if (fs.existsSync(STATE_DIR)) {
    try {
      const backend = await getBackend();
      const platforms = fs.readdirSync(STATE_DIR);
      for (const platform of platforms) {
        const platformDir = path.join(STATE_DIR, platform);
        let entries: string[];
        try { entries = fs.readdirSync(platformDir); } catch { continue; }
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue;
          const model = entry.slice(0, -'.json'.length);
          const filePath = path.join(platformDir, entry);
          try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const modelState = JSON.parse(raw) as ModelSyncState;
            const existing = await backend.getSyncState(platform, model);
            if (!existing) {
              await backend.setSyncState(stateToRow(platform, model, modelState));
            }
          } catch {
            // Skip unreadable files — they'll be cleaned up with the dir.
          }
        }
      }
      fs.rmSync(STATE_DIR, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

// ── Public API (async; was previously sync file I/O) ───────────────────────

export async function readSyncState(): Promise<SyncState> {
  await migrateLegacyOnce();
  const backend = await getBackend();
  const rows = await backend.listSyncStates();
  const result: SyncState = {};
  for (const row of rows) {
    if (!result[row.platform]) result[row.platform] = {};
    result[row.platform][row.model] = rowToState(row);
  }
  return result;
}

export async function getModelState(platform: string, model: string): Promise<ModelSyncState | null> {
  await migrateLegacyOnce();
  const backend = await getBackend();
  const row = await backend.getSyncState(platform, model);
  return row ? rowToState(row) : null;
}

export async function updateModelState(
  platform: string,
  model: string,
  partial: Partial<ModelSyncState>,
): Promise<void> {
  await migrateLegacyOnce();
  const backend = await getBackend();
  const existing = (await backend.getSyncState(platform, model)) ?? stateToRow(platform, model, {
    lastSync: null,
    lastCursor: null,
    totalRecords: 0,
    pagesProcessed: 0,
    since: null,
    status: 'idle',
  });
  const merged = rowToState(existing);
  const next: ModelSyncState = { ...merged, ...partial };
  await backend.setSyncState(stateToRow(platform, model, next));
}

export async function removeModelState(platform: string, model?: string): Promise<void> {
  await migrateLegacyOnce();
  const backend = await getBackend();
  await backend.removeSyncState(platform, model);
}
