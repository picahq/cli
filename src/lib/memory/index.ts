/**
 * Unified-memory subsystem public entry point.
 *
 * Importing this module registers the first-party backend plugins as a side
 * effect (via plugins.ts). Callers that want to use a backend should:
 *
 *   import { loadBackendFromConfig, getMemoryConfigOrDefault } from './memory/index.js';
 *   const backend = await loadBackendFromConfig(getMemoryConfigOrDefault());
 *   await backend.init();
 *   await backend.ensureSchema();
 */

export type {
  MemRecord,
  MemRecordWithLinks,
  LinkedRecord,
  SearchResult,
  ContextResult,
  RecordInput,
  ListOptions,
  SearchOptions,
  ContextOptions,
  LinkOptions,
  LinkedOptions,
  SourceRefInput,
  SyncStateRow,
  BackendStats,
  SourceEntry,
  SourcesMap,
  RecordStatus,
} from './types.js';

export type {
  MemBackend,
  MemBackendPlugin,
  BackendCapabilities,
  ParsedBackendConfig,
  UpsertResult,
} from './backend.js';

export type {
  MemoryConfig,
  EmbeddingProvider,
  EmbeddingConfig,
  MemoryDefaults,
} from './config.js';

export {
  getMemoryConfig,
  getMemoryConfigOrDefault,
  memoryConfigExists,
  updateMemoryConfig,
  getEmbeddingApiKey,
  setOpenAiApiKey,
  getPostgresConnectionString,
  DEFAULT_MEMORY_CONFIG,
} from './config.js';

export {
  registerBackend,
  getBackendPlugin,
  listBackendPlugins,
  isBackendRegistered,
  loadBackendFromConfig,
} from './plugins.js';

export {
  SCHEMA_VERSION,
  getFullSchemaSQL,
  EXTENSIONS_SQL,
  TABLES_SQL,
  INDEXES_SQL,
  FUNCTIONS_SQL,
  VECTOR_INDEX_SQL,
  HYBRID_SEARCH_SQL,
} from './schema.js';

export { canonicalize, contentHash } from './canonical.js';
export { calculateRelevance } from './scoring.js';
export type { RelevanceInputs } from './scoring.js';
