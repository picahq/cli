/**
 * `one mem export [file]` / `one mem import <file>` — JSON round-trip.
 *
 * Format: a JSONL stream (one record per line), ordered by created_at ASC.
 * Uses the backend's `list` across every type seen in the store. Re-import
 * uses upsertByKeys so re-running is idempotent.
 */

import fs from 'node:fs';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import * as output from '../../lib/output.js';
import { getBackend } from '../../lib/memory/runtime.js';
import { okJson, requireMemoryInit } from './util.js';
import type { MemRecord, RecordInput } from '../../lib/memory/index.js';

/** Write one line, awaiting `drain` when the stream buffer is full so memory
 *  stays bounded regardless of how fast records are produced. */
async function writeLine(stream: Writable, line: string): Promise<void> {
  if (!stream.write(line)) {
    await once(stream, 'drain');
  }
}

export async function memExportCommand(outfile: string | undefined): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const stats = await backend.stats();

  // Stream records as JSONL page-by-page straight to the output, so peak
  // memory is O(page) — never materialize the whole store into one array or
  // one giant string. Previously a `records.map().join()` over the full set
  // OOM'd (RangeError: Invalid string length) around ~94K records. See #151.
  const toFile = !!outfile && outfile !== '-';
  const stream: Writable = toFile ? fs.createWriteStream(outfile as string, 'utf-8') : process.stdout;

  const all = await listAllTypes(backend);
  const pageSize = 500;
  let written = 0;

  for (const type of all) {
    for (const status of ['active', 'archived'] as const) {
      let offset = 0;
      while (true) {
        const page = await backend.list(type, { limit: pageSize, offset, status });
        for (const r of page) {
          await writeLine(stream, JSON.stringify(r) + '\n');
          written++;
        }
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    }
  }

  if (toFile) {
    stream.end();
    await once(stream, 'finish');
    okJson({ status: 'ok', file: outfile, recordsWritten: written, storeTotal: stats.recordCount });
    return;
  }
  // stdout: don't end() the shared process stream.
  if (!output.isAgentMode()) {
    process.stderr.write(`Exported ${written} records (${stats.recordCount} total in store).\n`);
  }
}

export async function memImportCommand(file: string): Promise<void> {
  requireMemoryInit();
  if (!fs.existsSync(file)) output.error(`File not found: ${file}`);
  const backend = await getBackend();
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const line of lines) {
    let record: Partial<MemRecord>;
    try { record = JSON.parse(line); }
    catch { skipped++; continue; }

    if (!record.type || !record.data) { skipped++; continue; }

    const keys = record.keys ?? [];
    if (keys.length === 0) {
      // No keys means we can't upsert deterministically — fall back to insert,
      // which may produce a duplicate on reimport. Warn.
      skipped++;
      continue;
    }

    const input: RecordInput = {
      type: record.type,
      data: record.data,
      tags: record.tags,
      keys,
      sources: record.sources,
      searchable_text: record.searchable_text ?? null,
      content_hash: record.content_hash ?? null,
      weight: record.weight,
    };
    const res = await backend.upsertByKeys(input);
    if (res.action === 'inserted') inserted++;
    else updated++;
  }
  okJson({ status: 'ok', file, inserted, updated, skipped, total: inserted + updated });
}

async function listAllTypes(backend: Awaited<ReturnType<typeof getBackend>>): Promise<string[]> {
  // No dedicated "types" query yet; context() returns a mix that's good
  // enough for a first pass. A backend.listTypes() method would be cleaner
  // and is a natural follow-up.
  const ctx = await backend.context({ limit: 10_000 });
  return Array.from(new Set(ctx.map(c => c.type)));
}
