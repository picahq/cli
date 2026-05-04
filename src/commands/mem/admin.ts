/**
 * Admin / maintenance `one mem` commands: vacuum, reindex.
 */

import * as output from '../../lib/output.js';
import { getBackend } from '../../lib/memory/runtime.js';
import { embed } from '../../lib/memory/embedding.js';
import { getMemoryConfigOrDefault } from '../../lib/memory/index.js';
import { okJson, parsePositiveInt, requireMemoryInit } from './util.js';

export async function memVacuumCommand(): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  // VACUUM cannot run inside a transaction. For PGlite single-writer this
  // is fine; for Postgres pool, pg uses auto-commit by default.
  try {
    await backend.vacuum();
    okJson({ status: 'ok' });
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
  }
}

interface ReindexFlags {
  /** Embedding model to write. Defaults to the configured embedding.model. */
  model?: string;
  /** Restrict to one record type (e.g. attio/attioPeople). */
  type?: string;
  /** Re-embed every eligible row, even if it already has an embedding. */
  force?: boolean;
  /** OpenAI calls per iteration. Higher = faster, more likely to rate-limit. */
  batch?: string;
  /** Safety cap on total records to process. */
  limit?: string;
}

/**
 * Backfill embeddings across records that are missing them (or whose
 * embedding_model doesn't match the configured one). Designed to fix
 * the "synced data landed with embedOnSync:false, now I want semantic
 * search over it" flow.
 *
 * Lean read path: uses `backend.listForReindex` which pulls ONLY the
 * columns needed (id, type, searchable_text, content_hash,
 * embedding_model). The previous implementation pulled the full `data`
 * JSONB per row, which triggered WASM memory-access corruption on
 * PGlite at Attio-scale — the column was never actually needed since
 * embedding only consumes `searchable_text`. Writes go through
 * `updateEmbedding` for the same reason (no round-trip of `data`).
 */
export async function memReindexCommand(flags: ReindexFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const cfg = getMemoryConfigOrDefault();
  if (cfg.embedding.provider !== 'openai') {
    output.error('Reindex requires an embedding provider. Run `one mem config set embedding.provider openai` first (and `one mem config set embedding.apiKey sk-...` if no key).');
  }
  const targetModel = flags.model ?? cfg.embedding.model;
  const batchSize = flags.batch ? parsePositiveInt(flags.batch, 50, 'batch') : 50;
  const totalCap = flags.limit ? parsePositiveInt(flags.limit, 100_000, 'limit') : 100_000;

  let reembedded = 0;
  let skipped = 0;
  let considered = 0;
  // Target model as the backend stores it (prefix + name). Used to
  // filter rows whose embedding_model doesn't match.
  const targetFullModel = `openai:${targetModel}`;

  // Fixed page size for the scan — large enough to amortize the
  // embedding-generation cost against the SQL round-trip, small enough
  // that a partial run reports reasonable progress. The per-batch
  // OpenAI batching is separate (controlled by --batch).
  const PAGE = 500;

  while (considered < totalCap) {
    const remaining = totalCap - considered;
    const pageSize = Math.min(PAGE, remaining);
    const rows = await backend.listForReindex({
      type: flags.type,
      targetEmbeddingModel: targetFullModel,
      includeAlreadyEmbedded: !!flags.force,
      limit: pageSize,
      // Offset stays at 0: the SQL filter only returns rows that STILL
      // need work, and each batch advances the pointer by embedding
      // them (they drop out of the next page's result naturally).
      // Paging with offset against a moving target would miss rows.
      offset: 0,
    });
    if (rows.length === 0) break;
    considered += rows.length;

    // Batch OpenAI calls to stay under rate limits. Sequential across
    // batches so a rate-limit on one doesn't fan out concurrently to
    // the next.
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      await Promise.all(batch.map(async r => {
        if (!r.searchable_text) { skipped++; return; }
        const res = await embed(r.searchable_text, { model: targetModel });
        if (!res) { skipped++; return; }
        await backend.updateEmbedding(r.id, res.vector, res.model);
        reembedded++;
      }));
      if (!output.isAgentMode()) {
        process.stderr.write(`  re-embedded ${reembedded} / considered ${considered}\r`);
      }
    }
  }

  if (!output.isAgentMode()) {
    process.stderr.write('\n');
  }

  okJson({
    status: 'ok',
    model: targetModel,
    type: flags.type ?? null,
    considered,
    reembedded,
    skipped,
    force: !!flags.force,
  });
}
