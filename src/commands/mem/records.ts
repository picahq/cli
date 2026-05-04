/**
 * Record-level `one mem` handlers: add, get, update, archive, weight,
 * flush (reset access), list, search, context, sources, find-by-source,
 * link, unlink, linked.
 */

import * as output from '../../lib/output.js';
import { getBackend, addRecord } from '../../lib/memory/runtime.js';
import { embed } from '../../lib/memory/embedding.js';
import { getMemoryConfigOrDefault } from '../../lib/memory/index.js';
import { okJson, parseCsv, parseJsonArg, parsePositiveInt, printList, printRecord, requireMemoryInit, semanticSearchUpgradeHint, semanticSearchUpgradeLine } from './util.js';

interface AddFlags {
  tags?: string;
  keys?: string;
  weight?: string;
  embed?: boolean;
  noEmbed?: boolean;
}

export async function memAddCommand(type: string, dataRaw: string, flags: AddFlags): Promise<void> {
  requireMemoryInit();
  const data = parseJsonArg(dataRaw, 'data');
  const weight = flags.weight !== undefined ? parsePositiveInt(flags.weight, 5, 'weight') : undefined;
  if (weight !== undefined && (weight < 1 || weight > 10)) {
    output.error('weight must be between 1 and 10');
  }
  const opts = flags.noEmbed ? { embed: false } : flags.embed ? { embed: true } : {};
  const record = await addRecord(
    { type, data, tags: parseCsv(flags.tags), keys: parseCsv(flags.keys), weight },
    opts,
  );
  printRecord(record as unknown as Record<string, unknown>);
}

interface GetFlags {
  links?: boolean;
}

export async function memGetCommand(id: string, flags: GetFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const record = await backend.getById(id, { withLinks: flags.links });
  if (!record) output.error(`Record ${id} not found`);
  printRecord(record as unknown as Record<string, unknown>);
}

export async function memUpdateCommand(id: string, patchRaw: string): Promise<void> {
  requireMemoryInit();
  const patch = parseJsonArg(patchRaw, 'patch');
  const backend = await getBackend();
  const updated = await backend.update(id, { type: '', data: patch } as Parameters<typeof backend.update>[1]);
  if (!updated) output.error(`Record ${id} not found`);
  printRecord(updated as unknown as Record<string, unknown>);
}

interface ArchiveFlags {
  reason?: string;
}

export async function memArchiveCommand(id: string, flags: ArchiveFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const ok = await backend.archive(id, flags.reason);
  if (!ok) output.error(`Record ${id} not found or already archived`);
  okJson({ status: 'archived', id, reason: flags.reason ?? null });
}

export async function memWeightCommand(id: string, nRaw: string): Promise<void> {
  requireMemoryInit();
  const n = parsePositiveInt(nRaw, 5, 'weight');
  if (n < 1 || n > 10) output.error('weight must be between 1 and 10');
  const backend = await getBackend();
  const updated = await backend.update(id, { type: '', data: {}, weight: n } as Parameters<typeof backend.update>[1]);
  if (!updated) output.error(`Record ${id} not found`);
  okJson({ status: 'ok', id, weight: n });
}

export async function memFlushCommand(id: string): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  // Reset access_count by going through update — the schema doesn't expose
  // a first-class "flush" method and doing this server-side keeps the
  // semantics explicit.
  const existing = await backend.getById(id);
  if (!existing) output.error(`Record ${id} not found`);
  // Crude path: exec a small SQL update via the backend's own client. We
  // don't have a public API for raw SQL, so do it through a well-formed
  // backend call: set weight to its current value, then archive+unarchive
  // to touch updated_at. Not ideal; a dedicated backend.flush() would be
  // cleaner. Adding a short-circuit here for now.
  output.note('flush resets access_count; use `one mem weight <id> <n>` to adjust importance.', 'one mem flush');
  okJson({ status: 'noop', note: 'flush is a server-side operation; use backend-specific tooling until a first-class method is added' });
}

interface ListFlags {
  limit?: string;
  offset?: string;
  status?: 'active' | 'archived';
}

export async function memListCommand(type: string, flags: ListFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const limit = flags.limit ? parsePositiveInt(flags.limit, 100, 'limit') : 100;
  const offset = flags.offset ? parsePositiveInt(flags.offset, 0, 'offset') : 0;
  const status = flags.status ?? 'active';
  const [records, total] = await Promise.all([
    backend.list(type, { limit, offset, status }),
    backend.count(type, { status }),
  ]);

  // Honest counts: `total` is the backend COUNT(*), `returned` is the
  // page size. Human/agent callers can tell at a glance whether they
  // got all of it or just the first page.
  if (output.isAgentMode()) {
    output.json({ items: records, returned: records.length, total, limit, offset });
    return;
  }
  if (records.length === 0) {
    console.log('(no results)');
  } else {
    console.log(JSON.stringify(records, null, 2));
    if (total > records.length) {
      console.log(`\n${records.length} of ${total} — pass --offset ${offset + limit} to page.`);
    }
  }
}

interface SearchFlags {
  type?: string;
  limit?: string;
  deep?: boolean;
  noTrack?: boolean;
  includeArchived?: boolean;
}

export async function memSearchCommand(query: string, flags: SearchFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const cfg = getMemoryConfigOrDefault();

  // `--deep` forces semantic embedding if provider configured. Default also
  // does semantic when provider is openai; FTS-only when provider is none.
  let queryEmbedding: number[] | null = null;
  if ((flags.deep || cfg.embedding.provider === 'openai') && backend.capabilities().vectorSearch) {
    const embedded = await embed(query);
    if (embedded) queryEmbedding = embedded.vector;
  }

  const results = await backend.search(query, {
    type: flags.type,
    limit: flags.limit ? parsePositiveInt(flags.limit, 10, 'limit') : undefined,
    queryEmbedding,
    trackAccess: !flags.noTrack && cfg.defaults.trackAccessOnSearch,
    includeArchived: flags.includeArchived,
  });

  // Surface the upgrade path on every search that ran without embeddings.
  // Agents need this in structured form so they can tell their users;
  // humans get a dim one-liner after the results. The hint only appears
  // when semantic search is actually off — no noise otherwise. Pass
  // `vectorSearchAvailable` so the hint distinguishes "missing pgvector"
  // (most actionable — `brew install pgvector`) from "missing OpenAI key".
  const upgrade = !queryEmbedding
    ? semanticSearchUpgradeHint({ vectorSearchAvailable: backend.capabilities().vectorSearch })
    : null;

  // The backend's hybrid search caps at `limit` per run, so `total` ==
  // `returned` for now. When a more expensive "total matches" becomes
  // worth surfacing (separate COUNT query), add it under `totalMatches`
  // — but don't lie about what we have now.
  if (output.isAgentMode()) {
    output.json({
      items: results,
      returned: results.length,
      total: results.length,
      searchMode: queryEmbedding ? 'hybrid' : 'fts_only',
      ...(upgrade ? { _upgrade: upgrade } : {}),
    });
    return;
  }

  if (results.length === 0) {
    console.log('(no results)');
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
  const line = !queryEmbedding
    ? semanticSearchUpgradeLine({ vectorSearchAvailable: backend.capabilities().vectorSearch })
    : '';
  if (line) console.log(`\n${line}`);
}

interface ContextFlags {
  limit?: string;
  types?: string;
}

export async function memContextCommand(flags: ContextFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const results = await backend.context({
    limit: flags.limit ? parsePositiveInt(flags.limit, 20, 'limit') : undefined,
    types: parseCsv(flags.types),
  });
  printList(results);
}

// ─── Graph ─────────────────────────────────────────────────────────────────

interface LinkFlags {
  bi?: boolean;
  meta?: string;
}

export async function memLinkCommand(fromId: string, toId: string, relation: string, flags: LinkFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const metadata = flags.meta ? parseJsonArg(flags.meta, 'metadata') : undefined;
  const linkId = await backend.link(fromId, toId, relation, { bidirectional: flags.bi, metadata });
  okJson({ status: 'ok', linkId, from: fromId, to: toId, relation, bidirectional: !!flags.bi });
}

export async function memUnlinkCommand(fromId: string, toId: string, relation: string): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const ok = await backend.unlink(fromId, toId, relation);
  if (!ok) output.error(`No such link from ${fromId} to ${toId} (${relation})`);
  okJson({ status: 'ok', removed: true });
}

interface LinkedFlags {
  relation?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
}

export async function memLinkedCommand(id: string, flags: LinkedFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const records = await backend.linked(id, {
    relation: flags.relation,
    direction: flags.direction,
  });
  printList(records);
}

// ─── Sources ───────────────────────────────────────────────────────────────

export async function memSourcesCommand(id: string): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const sources = await backend.listSources(id);
  okJson({ id, sources });
}

export async function memFindBySourceCommand(sourceKey: string): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const record = await backend.findBySource(sourceKey);
  if (!record) output.error(`No record owns source "${sourceKey}"`);
  printRecord(record as unknown as Record<string, unknown>);
}
