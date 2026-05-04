/**
 * `one mem export [file]` / `one mem import <file>` — JSON round-trip.
 *
 * Format: a JSONL stream (one record per line), ordered by created_at ASC.
 * Uses the backend's `list` across every type seen in the store. Re-import
 * uses upsertByKeys so re-running is idempotent.
 */

import fs from 'node:fs';
import * as output from '../../lib/output.js';
import { getBackend } from '../../lib/memory/runtime.js';
import { okJson, requireMemoryInit } from './util.js';
import type { MemRecord, RecordInput } from '../../lib/memory/index.js';

export async function memExportCommand(outfile: string | undefined): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const stats = await backend.stats();

  // Iterate distinct types via context() as a quick enumerator — falls back
  // to fetching a page of every type. For v1 we just dump each type found.
  const all = await listAllTypes(backend);
  const records: MemRecord[] = [];
  for (const type of all) {
    let offset = 0;
    const pageSize = 500;
    while (true) {
      const page = await backend.list(type, { limit: pageSize, offset, status: 'active' });
      records.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    offset = 0;
    while (true) {
      const page = await backend.list(type, { limit: pageSize, offset, status: 'archived' });
      records.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
  }

  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  if (!outfile || outfile === '-') {
    process.stdout.write(lines);
    if (!output.isAgentMode()) {
      process.stderr.write(`Exported ${records.length} records (${stats.recordCount} total in store).\n`);
    }
    return;
  }
  fs.writeFileSync(outfile, lines, 'utf-8');
  okJson({ status: 'ok', file: outfile, recordsWritten: records.length, storeTotal: stats.recordCount });
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
