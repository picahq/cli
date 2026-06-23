/**
 * `one sync schema <platform/model>` — infer and print the JSON structure of
 * synced records so users can write `sync sql` `json_extract(...)` queries
 * without guessing paths. Samples up to N records of the type, walks each
 * record's `data`, and aggregates field paths → observed type(s), an example
 * value, and how often the path appears across the sample. See cli#106.
 */

import pc from 'picocolors';
import * as output from '../../output.js';
import { getBackend } from '../runtime.js';
import { requireMemoryInit, okJson } from '../../../commands/mem/util.js';

const SAMPLE_SIZE = 100;

export interface SchemaField {
  /** Dot/`[]` path, e.g. `messages[].sender`. */
  path: string;
  /** Observed type(s): `string` | `number` | `boolean` | `null` | `object` | `array[<elem>]`. */
  types: string[];
  /** First non-null example value for a leaf path (omitted for object/array containers). */
  example?: unknown;
  /** Number of sampled records in which this path appeared. */
  presence: number;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}

/** Truncate long example strings so the schema stays scannable. */
function exampleOf(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  return v;
}

interface Acc {
  types: Set<string>;
  example?: unknown;
  hasExample: boolean;
  presence: number;
}

function addPath(path: string, value: unknown, acc: Map<string, Acc>): void {
  const t = typeOf(value);
  let typeLabel: string;

  if (t === 'array') {
    const arr = value as unknown[];
    const elemType = arr.length ? typeOf(arr[0]) : 'unknown';
    typeLabel = `array[${elemType}]`;
  } else {
    typeLabel = t;
  }

  const entry = acc.get(path) ?? { types: new Set<string>(), hasExample: false, presence: 0 };
  entry.types.add(typeLabel);
  entry.presence += 1;
  // Capture an example only for leaf primitives — containers are described by
  // their type label and their child paths.
  if (!entry.hasExample && t !== 'object' && t !== 'array' && value !== null && value !== undefined) {
    entry.example = exampleOf(value);
    entry.hasExample = true;
  }
  acc.set(path, entry);

  // Recurse into structure.
  if (t === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      addPath(path ? `${path}.${k}` : k, v, acc);
    }
  } else if (t === 'array') {
    const arr = value as unknown[];
    if (arr.length && typeOf(arr[0]) === 'object') {
      // Describe element-object fields from the first element.
      for (const [k, v] of Object.entries(arr[0] as Record<string, unknown>)) {
        addPath(`${path}[].${k}`, v, acc);
      }
    }
  }
}

/**
 * Infer a flat, sorted field list from a sample of record `data` objects.
 * Pure — no I/O — so it's directly unit-testable.
 */
export function inferSyncSchema(dataRecords: Array<Record<string, unknown>>): SchemaField[] {
  const acc = new Map<string, Acc>();
  for (const data of dataRecords) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    for (const [k, v] of Object.entries(data)) addPath(k, v, acc);
  }
  return [...acc.entries()]
    .map(([path, e]) => ({
      path,
      types: [...e.types].sort(),
      ...(e.hasExample ? { example: e.example } : {}),
      presence: e.presence,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function syncSchemaCommand(platformModel: string, _options: Record<string, unknown> = {}): Promise<void> {
  requireMemoryInit();
  const type = platformModel;
  const backend = await getBackend();

  let recordCount = 0;
  try { recordCount = await backend.count(type, { status: 'active' }); } catch { /* best effort */ }

  const records = await backend.list(type, { limit: SAMPLE_SIZE, status: 'active' });
  if (records.length === 0) {
    if (output.isAgentMode()) {
      okJson({ type, recordCount: 0, sampled: 0, fields: [] });
      return;
    }
    output.note(`No records found for "${type}". Run \`one sync run <platform>\` first, or check \`one --agent sync status\`.`, 'Schema');
    return;
  }

  const fields = inferSyncSchema(records.map(r => r.data));

  if (output.isAgentMode()) {
    okJson({ type, recordCount, sampled: records.length, fields });
    return;
  }

  // Human: aligned tree of path / type / example.
  console.log();
  console.log(`${pc.bold(type)} ${pc.dim(`(${recordCount.toLocaleString()} record${recordCount === 1 ? '' : 's'}, sampled ${records.length})`)}`);
  console.log();
  const pathWidth = Math.min(Math.max(...fields.map(f => f.path.length), 4) + 2, 50);
  const typeWidth = Math.max(...fields.map(f => f.types.join('|').length), 4) + 2;
  for (const f of fields) {
    const optional = f.presence < records.length ? pc.yellow(' ?') : '';
    const ex = f.example !== undefined ? pc.dim(JSON.stringify(f.example)) : '';
    console.log(`  ${f.path.padEnd(pathWidth)}${pc.cyan(f.types.join('|').padEnd(typeWidth))}${ex}${optional}`);
  }
  console.log();
  console.log(pc.dim(`  ? = present in only some sampled records (optional/sparse field)`));
  console.log();
}
