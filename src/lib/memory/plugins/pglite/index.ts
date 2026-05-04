/**
 * PGlite backend plugin — default for local, embedded Postgres.
 *
 * PGlite ships pgvector + pg_trgm as bundled extensions, so schema parity
 * with hosted Postgres is exact. Single-writer, filesystem-backed.
 *
 * The PGlite dep is lazily imported at init() so the CLI still installs
 * when a user picks a different backend via a third-party plugin.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type {
  MemBackend,
  MemBackendPlugin,
  BackendCapabilities,
  ParsedBackendConfig,
} from '../../backend.js';
import { SCHEMA_VERSION } from '../../schema.js';
import { CoreBackend } from '../postgres-core/index.js';
import type { PgClient, PgQueryResult } from '../postgres-core/index.js';

interface PgliteConfig extends ParsedBackendConfig {
  dbPath: string;
}

const CAPABILITIES: BackendCapabilities = {
  vectorSearch: true,
  fullTextSearch: true,
  partialIndexes: true,
  jsonPathQuery: true,
  triggers: true,
  concurrentWriters: false,
  maxVectorDims: 2000,
  rawSql: true,
};

function defaultDbPath(): string {
  return path.join(os.homedir(), '.one', 'mem.pglite');
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

function parseConfig(raw: unknown): PgliteConfig {
  const r = (raw ?? {}) as Partial<PgliteConfig>;
  const dbPath = typeof r.dbPath === 'string' && r.dbPath ? expandHome(r.dbPath) : defaultDbPath();
  return { dbPath };
}

// Type for the subset of PGlite we touch. Avoids a hard dep on the package's
// types (which live behind an optional install).
interface PgliteInstance {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(text: string): Promise<Array<{ rows?: unknown[]; affectedRows?: number }>>;
  close(): Promise<void>;
}

/**
 * PGlite's `query()` wraps each statement in a prepared-statement envelope,
 * which rejects multi-statement SQL (our schema blocks, transaction
 * envelopes, etc). `exec()` handles multiple statements but doesn't support
 * parameter binding. We route based on whether the caller passed params:
 * params → query(), no params → exec().
 */
function wrapClient(db: PgliteInstance): PgClient {
  async function run<T>(text: string, params?: unknown[]): Promise<PgQueryResult<T>> {
    if (params && params.length > 0) {
      const res = await db.query<T>(text, params);
      return { rows: res.rows, rowCount: res.affectedRows };
    }
    const results = await db.exec(text);
    const last = results.length > 0 ? results[results.length - 1] : undefined;
    return {
      rows: ((last?.rows as T[] | undefined) ?? []),
      rowCount: last?.affectedRows,
    };
  }

  const client: PgClient = {
    query: run,
    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
      await run('BEGIN');
      try {
        const result = await fn(client); // PGlite is single-writer; reuse outer client
        await run('COMMIT');
        return result;
      } catch (err) {
        try { await run('ROLLBACK'); } catch { /* swallow secondary error */ }
        throw err;
      }
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
  return client;
}

class PgliteBackend extends CoreBackend {
  static async open(config: PgliteConfig): Promise<PgliteBackend> {
    const { PGlite } = await import('@electric-sql/pglite').catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `PGlite is not installed. Run \`npm i -g @electric-sql/pglite\` or pick a different backend. (${msg})`,
      );
    });

    // PGlite needs a directory (or ":memory:"). Ensure the parent exists.
    if (config.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
    }

    // Load pgvector extension. PGlite exposes extensions via a subpath import.
    const { vector } = await import('@electric-sql/pglite/vector').catch(() => ({ vector: undefined }));

    const db = (await PGlite.create({
      dataDir: config.dbPath === ':memory:' ? undefined : config.dbPath,
      extensions: vector ? { vector } : undefined,
    })) as unknown as PgliteInstance;

    return new PgliteBackend(wrapClient(db), CAPABILITIES);
  }
}

/**
 * Plugin descriptor. Because `create()` is sync in the contract but PGlite's
 * constructor is async, we return a proxy that opens on first use. The real
 * async path is available directly via `PgliteBackend.open()` for callers
 * that prefer awaiting explicitly.
 */
class LazyPgliteBackend implements MemBackend {
  private backend: PgliteBackend | null = null;
  private config: PgliteConfig;

  constructor(config: PgliteConfig) {
    this.config = config;
  }

  private async ensure(): Promise<PgliteBackend> {
    if (!this.backend) this.backend = await PgliteBackend.open(this.config);
    return this.backend;
  }

  capabilities(): BackendCapabilities { return CAPABILITIES; }

  async init(): Promise<void> { await this.ensure(); }
  async close(): Promise<void> { if (this.backend) await this.backend.close(); this.backend = null; }
  async ensureSchema(): Promise<void> { return (await this.ensure()).ensureSchema(); }
  async getSchemaVersion(): ReturnType<MemBackend['getSchemaVersion']> { return (await this.ensure()).getSchemaVersion(); }

  async insert(...a: Parameters<MemBackend['insert']>): ReturnType<MemBackend['insert']> { return (await this.ensure()).insert(...a); }
  async upsertByKeys(...a: Parameters<MemBackend['upsertByKeys']>): ReturnType<MemBackend['upsertByKeys']> { return (await this.ensure()).upsertByKeys(...a); }
  async getById(...a: Parameters<MemBackend['getById']>): ReturnType<MemBackend['getById']> { return (await this.ensure()).getById(...a); }
  async update(...a: Parameters<MemBackend['update']>): ReturnType<MemBackend['update']> { return (await this.ensure()).update(...a); }
  async remove(...a: Parameters<MemBackend['remove']>): ReturnType<MemBackend['remove']> { return (await this.ensure()).remove(...a); }
  async archive(...a: Parameters<MemBackend['archive']>): ReturnType<MemBackend['archive']> { return (await this.ensure()).archive(...a); }
  async unarchive(...a: Parameters<MemBackend['unarchive']>): ReturnType<MemBackend['unarchive']> { return (await this.ensure()).unarchive(...a); }
  async list(...a: Parameters<MemBackend['list']>): ReturnType<MemBackend['list']> { return (await this.ensure()).list(...a); }
  async count(...a: Parameters<MemBackend['count']>): ReturnType<MemBackend['count']> { return (await this.ensure()).count(...a); }
  async listForReindex(...a: Parameters<MemBackend['listForReindex']>): ReturnType<MemBackend['listForReindex']> { return (await this.ensure()).listForReindex(...a); }
  async listKeysByType(...a: Parameters<MemBackend['listKeysByType']>): ReturnType<MemBackend['listKeysByType']> { return (await this.ensure()).listKeysByType(...a); }
  async updateEmbedding(...a: Parameters<MemBackend['updateEmbedding']>): ReturnType<MemBackend['updateEmbedding']> { return (await this.ensure()).updateEmbedding(...a); }
  async raw(sql: string, params?: unknown[]): ReturnType<NonNullable<MemBackend['raw']>> {
    const b = await this.ensure();
    if (!b.raw) throw new Error('Backend does not support raw SQL');
    return b.raw(sql, params);
  }

  async search(...a: Parameters<MemBackend['search']>): ReturnType<MemBackend['search']> { return (await this.ensure()).search(...a); }
  async context(...a: Parameters<MemBackend['context']>): ReturnType<MemBackend['context']> { return (await this.ensure()).context(...a); }
  async trackAccess(...a: Parameters<MemBackend['trackAccess']>): ReturnType<MemBackend['trackAccess']> { return (await this.ensure()).trackAccess(...a); }

  async link(...a: Parameters<MemBackend['link']>): ReturnType<MemBackend['link']> { return (await this.ensure()).link(...a); }
  async unlink(...a: Parameters<MemBackend['unlink']>): ReturnType<MemBackend['unlink']> { return (await this.ensure()).unlink(...a); }
  async linked(...a: Parameters<MemBackend['linked']>): ReturnType<MemBackend['linked']> { return (await this.ensure()).linked(...a); }

  async addSource(...a: Parameters<MemBackend['addSource']>): ReturnType<MemBackend['addSource']> { return (await this.ensure()).addSource(...a); }
  async removeSource(...a: Parameters<MemBackend['removeSource']>): ReturnType<MemBackend['removeSource']> { return (await this.ensure()).removeSource(...a); }
  async findBySource(...a: Parameters<MemBackend['findBySource']>): ReturnType<MemBackend['findBySource']> { return (await this.ensure()).findBySource(...a); }
  async listSources(...a: Parameters<MemBackend['listSources']>): ReturnType<MemBackend['listSources']> { return (await this.ensure()).listSources(...a); }

  async getSyncState(...a: Parameters<MemBackend['getSyncState']>): ReturnType<MemBackend['getSyncState']> { return (await this.ensure()).getSyncState(...a); }
  async setSyncState(...a: Parameters<MemBackend['setSyncState']>): ReturnType<MemBackend['setSyncState']> { return (await this.ensure()).setSyncState(...a); }
  async listSyncStates(): ReturnType<MemBackend['listSyncStates']> { return (await this.ensure()).listSyncStates(); }
  async removeSyncState(...a: Parameters<MemBackend['removeSyncState']>): ReturnType<MemBackend['removeSyncState']> { return (await this.ensure()).removeSyncState(...a); }

  async ensureHotColumn(...a: Parameters<MemBackend['ensureHotColumn']>): ReturnType<MemBackend['ensureHotColumn']> { return (await this.ensure()).ensureHotColumn(...a); }
  async dropHotColumn(...a: Parameters<MemBackend['dropHotColumn']>): ReturnType<MemBackend['dropHotColumn']> { return (await this.ensure()).dropHotColumn(...a); }

  async vacuum(): ReturnType<MemBackend['vacuum']> { return (await this.ensure()).vacuum(); }
  async stats(): ReturnType<MemBackend['stats']> { return (await this.ensure()).stats(); }
}

export const pglitePlugin: MemBackendPlugin = {
  name: 'pglite',
  description: 'Embedded Postgres via PGlite (default). Zero external deps.',
  version: '0.1.0',
  schemaVersion: SCHEMA_VERSION,
  capabilities: CAPABILITIES,
  parseConfig,
  create(config) {
    return new LazyPgliteBackend(config as PgliteConfig);
  },
};

export default pglitePlugin;
