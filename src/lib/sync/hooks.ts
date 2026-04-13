import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EVENTS_DIR = path.join('.one', 'sync', 'events');

export type ChangeType = 'insert' | 'update';

export interface ChangeEvent {
  type: ChangeType;
  platform: string;
  model: string;
  record: Record<string, unknown>;
  timestamp: string;
}

/**
 * Classify each record as insert or update by checking whether its id already
 * exists in the local table. Returns two arrays.
 *
 * This is called BEFORE the upsert so we can detect the change type.
 */
export function classifyRecords(
  db: import('better-sqlite3').Database,
  model: string,
  records: Record<string, unknown>[],
  idField: string,
  tableExists: boolean,
): { inserts: Record<string, unknown>[]; updates: Record<string, unknown>[] } {
  if (!tableExists || records.length === 0) {
    return { inserts: records, updates: [] };
  }

  const safeTable = model.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeIdField = idField.replace(/"/g, '""');

  // Batch lookup: fetch all existing ids in one query
  const ids = records.map(r => r[idField]).filter(id => id !== undefined && id !== null);
  if (ids.length === 0) return { inserts: records, updates: [] };

  // Chunk the IN clause to stay under SQLite's variable limit
  const CHUNK = 500;
  const existingIds = new Set<string | number>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT "${safeIdField}" as id FROM "${safeTable}" WHERE "${safeIdField}" IN (${placeholders})`
    ).all(...(chunk as (string | number)[])) as Array<{ id: string | number }>;
    for (const row of rows) existingIds.add(row.id);
  }

  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  for (const record of records) {
    const id = record[idField];
    if (typeof id === 'string' || typeof id === 'number') {
      if (existingIds.has(id)) {
        updates.push(record);
      } else {
        inserts.push(record);
      }
    } else {
      inserts.push(record); // No id → treat as new
    }
  }

  return { inserts, updates };
}

/**
 * Fire hooks for a batch of change events. Handles three hook modes:
 *
 * 1. "log" → append JSONL to .one/sync/events/<platform>_<model>.jsonl
 * 2. Shell command → spawn process with record JSON on stdin (batched)
 * 3. Flow command → if hook starts with "one flow execute", treat as shell
 */
export async function fireHooks(
  hookCommand: string,
  events: ChangeEvent[],
): Promise<void> {
  if (events.length === 0) return;

  if (hookCommand === 'log') {
    appendEventLog(events);
    return;
  }

  // Shell command — pipe all events as newline-delimited JSON to stdin
  await runShellHook(hookCommand, events);
}

function appendEventLog(events: ChangeEvent[]): void {
  if (events.length === 0) return;
  const { platform, model } = events[0];
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  const logPath = path.join(EVENTS_DIR, `${platform}_${model}.jsonl`);
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(logPath, lines);
}

function runShellHook(command: string, events: ChangeEvent[]): Promise<void> {
  return new Promise(resolve => {
    // Pipe events as newline-delimited JSON to stdin
    const input = events.map(e => JSON.stringify(e)).join('\n') + '\n';

    const child = spawn('sh', ['-c', command], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    child.stdin.write(input);
    child.stdin.end();

    child.on('exit', () => resolve());
    child.on('error', () => resolve());

    // Don't block sync on slow hooks — give them 30s max then move on
    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve();
    }, 30_000);
  });
}
