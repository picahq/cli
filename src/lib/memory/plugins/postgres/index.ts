/**
 * Postgres backend plugin — Supabase, self-hosted, Neon, any Postgres.
 *
 * Thin adapter over node-pg. All heavy lifting lives in CoreBackend.
 * The pg dep is lazily imported at init() so the CLI installs without it.
 */

import type {
  MemBackend,
  MemBackendPlugin,
  BackendCapabilities,
  ParsedBackendConfig,
} from '../../backend.js';
import { SCHEMA_VERSION } from '../../schema.js';
import { CoreBackend } from '../postgres-core/index.js';
import type { PgClient, PgQueryResult } from '../postgres-core/index.js';

interface PostgresConfig extends ParsedBackendConfig {
  connectionString: string;
  schema: string;
}

const CAPABILITIES: BackendCapabilities = {
  vectorSearch: true,
  fullTextSearch: true,
  partialIndexes: true,
  jsonPathQuery: true,
  triggers: true,
  concurrentWriters: true,
  maxVectorDims: 2000,
  rawSql: true,
};

function parseConfig(raw: unknown): PostgresConfig {
  const r = (raw ?? {}) as Partial<PostgresConfig>;
  const envOverride = process.env.MEM_DATABASE_URL;
  const connectionString = envOverride ?? r.connectionString ?? '';
  if (!connectionString) {
    throw new Error(
      'Postgres backend requires a connection string. ' +
      'Set MEM_DATABASE_URL, or run `one mem config set memory.postgres.connectionString <url>`.',
    );
  }
  const schema = typeof r.schema === 'string' && r.schema ? r.schema : 'public';
  return { connectionString, schema };
}

// Structural type matching the pg.Pool subset we touch.
interface PgPool {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number }>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

interface PgPoolClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number }>;
  release(): void;
}

function wrapClient(pool: PgPool): PgClient {
  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<PgQueryResult<T>> {
      const res = await pool.query<T>(text, params);
      return { rows: res.rows, rowCount: res.rowCount ?? undefined };
    },
    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
      const tx = await pool.connect();
      const txClient: PgClient = {
        async query<U = Record<string, unknown>>(text: string, params?: unknown[]): Promise<PgQueryResult<U>> {
          const res = await tx.query<U>(text, params);
          return { rows: res.rows, rowCount: res.rowCount ?? undefined };
        },
        async transaction() {
          throw new Error('Nested transactions are not supported.');
        },
        async close() {
          tx.release();
        },
      };
      try {
        await tx.query('BEGIN');
        const result = await fn(txClient);
        await tx.query('COMMIT');
        return result;
      } catch (err) {
        try { await tx.query('ROLLBACK'); } catch { /* swallow */ }
        throw err;
      } finally {
        tx.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

class LazyPostgresBackend implements MemBackend {
  private backend: CoreBackend | null = null;
  private config: PostgresConfig;

  constructor(config: PostgresConfig) { this.config = config; }

  private async ensure(): Promise<CoreBackend> {
    if (this.backend) return this.backend;
    const pg = await import('pg').catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `pg is not installed. Run \`npm i -g pg\` or pick a different backend. (${msg})`,
      );
    });
    const PoolCtor = (pg as unknown as { Pool: new (opts: Record<string, unknown>) => PgPool; default?: { Pool: new (opts: Record<string, unknown>) => PgPool } }).Pool
                   ?? (pg as unknown as { default: { Pool: new (opts: Record<string, unknown>) => PgPool } }).default.Pool;
    const pool = new PoolCtor({ connectionString: this.config.connectionString });
    this.backend = new CoreBackend(wrapClient(pool), CAPABILITIES);
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

export const postgresPlugin: MemBackendPlugin = {
  name: 'postgres',
  description: 'Postgres over node-pg. Works with Supabase, Neon, self-hosted.',
  version: '0.1.0',
  schemaVersion: SCHEMA_VERSION,
  capabilities: CAPABILITIES,
  parseConfig,
  create(config) {
    return new LazyPostgresBackend(config as PostgresConfig);
  },
};

export default postgresPlugin;
