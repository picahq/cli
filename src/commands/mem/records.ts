/**
 * Record-level `one mem` handlers: add, get, update, archive, weight,
 * flush (reset access), list, search, context, sources, find-by-source,
 * link, unlink, linked.
 */

import pc from 'picocolors';
import * as output from '../../lib/output.js';
import { getBackend, addRecord, updateRecord } from '../../lib/memory/runtime.js';
import { embed } from '../../lib/memory/embedding.js';
import { getMemoryConfigOrDefault } from '../../lib/memory/index.js';
import type { MemRecord } from '../../lib/memory/types.js';
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
  // The patch is merged into `data`. `keys` is a first-class column, not a
  // data field — steer callers to `one mem key` instead of silently
  // burying `{"keys":[...]}` under data.keys where it does nothing.
  if (patch && typeof patch === 'object' && !Array.isArray(patch) && 'keys' in patch) {
    output.error('`keys` is not a data field. Use `one mem key <id> --set <csv>` (or --add/--remove) to change a record\'s keys.');
  }
  // Route through updateRecord so searchable_text + content_hash are
  // regenerated from the merged data (backend.update alone leaves them
  // stale — see runtime.updateRecord).
  const updated = await updateRecord(id, { data: patch } as Parameters<typeof updateRecord>[1]);
  if (!updated) output.error(`Record ${id} not found`);
  printRecord(updated as unknown as Record<string, unknown>);
}

interface KeyFlags {
  add?: string;
  remove?: string;
  set?: string;
}

/**
 * Manage the `keys` column on an existing record — the first-class,
 * uniqueness-checked way to change identity keys after creation. Without
 * this, keys could only be set at insert time (`mem add --keys`), and
 * `mem update '{"keys":[...]}'` silently wrote them into `data` instead.
 */
export async function memKeyCommand(id: string, flags: KeyFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();

  const setList = parseCsv(flags.set);
  const addList = parseCsv(flags.add) ?? [];
  const removeList = parseCsv(flags.remove) ?? [];
  if (!setList && addList.length === 0 && removeList.length === 0) {
    output.error('Pass at least one of --add <csv>, --remove <csv>, or --set <csv>.');
  }

  const existing = (await backend.getById(id)) as { keys?: string[] } | null;
  if (!existing) output.error(`Record ${id} not found`);

  // --set replaces wholesale; otherwise start from current keys, add, remove.
  let next: string[];
  if (setList) {
    next = setList;
  } else {
    const removeSet = new Set(removeList);
    next = [...(existing!.keys ?? []), ...addList].filter(k => !removeSet.has(k));
  }
  // De-dupe, preserve order.
  next = [...new Set(next)];

  const outcome = await backend.updateKeys(id, next);
  if (outcome.status === 'not_found') output.error(`Record ${id} not found`);
  if (outcome.status === 'conflict') {
    output.error(
      `Key "${outcome.key}" is already owned by active record ${outcome.recordId} (type ${outcome.recordType}). ` +
      `Keys must be unique across active records — archive or re-key that record first.`,
    );
  }
  printRecord((outcome as { record: unknown }).record as Record<string, unknown>);
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

interface FindByKeyFlags {
  type?: string;
  limit?: string;
}

/** Best-effort human label for a record (the first present common title-ish field). */
function summarizeRecord(r: MemRecord): string {
  const d = r.data ?? {};
  for (const field of ['title', 'subject', 'name', 'full_name', 'display_name', 'summary', 'headline', 'email']) {
    const v = (d as Record<string, unknown>)[field];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
  }
  return pc.dim(r.id.slice(0, 8));
}

/** Compact "2d ago" style relative time. */
function relativeTime(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * `one mem find-by-key <key> [<key2>]` — list every record whose `keys[]`
 * contains the given identity key (e.g. `email:jane@acme.com`), grouped by
 * type. Two keys → the intersection (records carrying BOTH). This is the
 * cross-platform-join query surface for #131 (issue proposed `mem linked`, but
 * that name is already taken by the relation-graph command, so this mirrors the
 * existing `find-by-source`). Works for any prefix — `email:`, `domain:`, etc.
 */
export async function memFindByKeyCommand(key: string, secondKey: string | undefined, flags: FindByKeyFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const keys = secondKey ? [key, secondKey] : [key];
  const perType = parsePositiveInt(flags.limit, 10, '--limit');
  const records = await backend.findByKeys(keys, { type: flags.type });

  // Group by type, preserving the query's type-then-recency ordering.
  const byType = new Map<string, MemRecord[]>();
  for (const r of records) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  if (output.isAgentMode()) {
    const grouped: Record<string, { count: number; items: MemRecord[] }> = {};
    for (const [type, list] of byType) {
      grouped[type] = { count: list.length, items: list.slice(0, perType) };
    }
    output.json({ keys, total: records.length, byType: grouped });
    return;
  }

  const label = keys.map(k => pc.cyan(k)).join(pc.dim(' + '));
  if (records.length === 0) {
    console.log(`\n  No records linked to ${label}.\n`);
    return;
  }

  console.log();
  console.log(`  ${label} ${pc.dim('—')} ${records.length} record${records.length === 1 ? '' : 's'} across ${byType.size} type${byType.size === 1 ? '' : 's'}`);
  console.log();
  const typeWidth = Math.min(30, Math.max(...[...byType.keys()].map(t => t.length)));
  for (const [type, list] of byType) {
    console.log(`  ${pc.bold(type.padEnd(typeWidth))}  ${pc.dim(`${list.length} record${list.length === 1 ? '' : 's'}`)}`);
    for (const r of list.slice(0, perType)) {
      console.log(`    ${pc.dim('·')} ${summarizeRecord(r)}  ${pc.dim(relativeTime(r.updated_at))}`);
    }
    if (list.length > perType) {
      console.log(`    ${pc.dim(`… and ${list.length - perType} more (raise --limit)`)}`);
    }
  }
  console.log();
}
