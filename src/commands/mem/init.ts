/**
 * `one mem init` — interactive + non-interactive setup.
 *
 * Writes the memory config block into ~/.one/config.json (same file as
 * ONE_SECRET, mode 0600 enforced by writeConfig()), opens the backend,
 * runs ensureSchema, and optionally warms up the embedding provider.
 */

import * as p from '@clack/prompts';
import * as output from '../../lib/output.js';
import { readConfig } from '../../lib/config.js';
import {
  DEFAULT_MEMORY_CONFIG,
  getBackendPlugin,
  loadBackendFromConfig,
  memoryConfigExists,
  updateMemoryConfig,
  listBackendPlugins,
  setOpenAiApiKey,
} from '../../lib/memory/index.js';
import type { EmbeddingProvider, MemoryConfig } from '../../lib/memory/index.js';

interface InitFlags {
  backend?: string;
  embedding?: EmbeddingProvider;
  openaiKey?: string;
  dbPath?: string;
  connectionString?: string;
  embedOnAdd?: boolean;
  embedOnSync?: boolean;
  yes?: boolean;
  force?: boolean;
}

export async function memInitCommand(flags: InitFlags): Promise<void> {
  if (!readConfig()) {
    output.error('Run `one init` first to configure the base One CLI before `one mem init`.');
  }

  if (memoryConfigExists() && !flags.force) {
    if (output.isAgentMode()) {
      output.error('Memory is already configured. Pass --force to overwrite, or use `one mem config` to adjust.');
    }
    const shouldOverwrite = flags.yes ?? (await p.confirm({
      message: 'Memory is already configured. Overwrite the current config?',
      initialValue: false,
    }));
    if (p.isCancel(shouldOverwrite) || !shouldOverwrite) {
      output.outro('Aborted. Run `one mem config` to adjust specific fields.');
      return;
    }
  }

  const { config: nextConfig, openaiApiKey } = flags.yes
    ? buildFromFlags(flags)
    : await interactiveInit(flags);

  // Validate the backend can be constructed before persisting.
  try {
    const plugin = getBackendPlugin(nextConfig.backend);
    plugin.parseConfig((nextConfig as Record<string, unknown>)[nextConfig.backend] ?? {});
  } catch (err) {
    output.error(`Backend config invalid: ${err instanceof Error ? err.message : String(err)}`);
  }

  // OpenAI key lives at the top level of config.json alongside `apiKey` —
  // not nested under memory.embedding.* — so every subsystem that needs it
  // reads from one canonical place.
  if (openaiApiKey) {
    setOpenAiApiKey(openaiApiKey);
  }
  updateMemoryConfig(nextConfig);

  // Warm up: open, ensureSchema, roundtrip.
  const warmupErr = await warmup(nextConfig);
  if (warmupErr) {
    if (output.isAgentMode()) {
      output.json({ status: 'warmup_failed', error: warmupErr });
      return;
    }
    output.note(
      `Config saved but warmup failed: ${warmupErr}\n` +
      `Run \`one mem doctor\` for a detailed report.`,
      'one mem init',
    );
    return;
  }

  if (output.isAgentMode()) {
    output.json({
      status: 'ok',
      backend: nextConfig.backend,
      embedding: {
        provider: nextConfig.embedding.provider,
        model: nextConfig.embedding.model,
      },
    });
    return;
  }

  output.outro(
    `Memory ready.\n` +
    `  backend:   ${nextConfig.backend}\n` +
    `  embedding: ${nextConfig.embedding.provider}${nextConfig.embedding.provider === 'openai' ? ` (${nextConfig.embedding.model})` : ''}\n` +
    `  Run \`one mem add note '{"content":"hello"}'\` to write your first memory.`,
  );
}

interface BuiltConfig {
  config: MemoryConfig;
  /** OpenAI key to persist at the top level of config.json (not under memory). */
  openaiApiKey?: string;
}

async function interactiveInit(flags: InitFlags): Promise<BuiltConfig> {
  output.intro('one mem init');

  const plugins = listBackendPlugins();
  const backend = flags.backend ?? (await p.select({
    message: 'Where should memory live?',
    options: plugins.map(plug => ({
      value: plug.name,
      label: plug.name,
      hint: plug.description,
    })),
    initialValue: 'embedded-postgres',
  })) as string;
  if (p.isCancel(backend)) output.error('Cancelled.');

  const perBackend: Record<string, unknown> = {};
  if (backend === 'embedded-postgres') {
    const dataDir = flags.dbPath ?? (await p.text({
      message: 'Postgres data directory (leave blank for default)',
      placeholder: '~/.one/pg',
      initialValue: '',
    }));
    if (p.isCancel(dataDir)) output.error('Cancelled.');
    if (dataDir) perBackend['embedded-postgres'] = { dataDir };
  } else if (backend === 'postgres') {
    const connectionString = flags.connectionString ?? (await p.text({
      message: 'Postgres connection string',
      placeholder: 'postgres://user:pass@host:5432/dbname',
      validate: v => (v ? undefined : 'Connection string is required'),
    }));
    if (p.isCancel(connectionString)) output.error('Cancelled.');
    perBackend.postgres = { connectionString };
  }

  const provider = flags.embedding ?? (await p.select({
    message: 'Enable embeddings (semantic search)?',
    options: [
      { value: 'openai', label: 'Yes, via OpenAI', hint: 'requires an API key' },
      { value: 'none', label: 'No (FTS-only, free)' },
    ],
    initialValue: 'none',
  })) as EmbeddingProvider;
  if (p.isCancel(provider)) output.error('Cancelled.');

  let apiKey: string | undefined;
  let embedOnAdd = DEFAULT_MEMORY_CONFIG.defaults.embedOnAdd;
  let embedOnSync = DEFAULT_MEMORY_CONFIG.defaults.embedOnSync;

  if (provider === 'openai') {
    const envKey = process.env.OPENAI_API_KEY;
    if (flags.openaiKey) {
      apiKey = flags.openaiKey;
    } else {
      const entered = await p.password({
        message: 'OpenAI API key',
        mask: '•',
        validate: v => (v || envKey ? undefined : 'Required (or set OPENAI_API_KEY)'),
      });
      if (p.isCancel(entered)) output.error('Cancelled.');
      apiKey = (entered as string) || envKey;
    }

    const embedAdd = flags.embedOnAdd ?? (await p.confirm({
      message: 'Embed user memories (mem add) by default?',
      initialValue: true,
    }));
    if (p.isCancel(embedAdd)) output.error('Cancelled.');
    embedOnAdd = embedAdd;

    const embedSync = flags.embedOnSync ?? (await p.confirm({
      message: 'Embed synced records by default? (overridable per profile)',
      initialValue: false,
    }));
    if (p.isCancel(embedSync)) output.error('Cancelled.');
    embedOnSync = embedSync;
  }

  return {
    config: {
      ...DEFAULT_MEMORY_CONFIG,
      backend,
      ...perBackend,
      embedding: {
        provider,
        model: DEFAULT_MEMORY_CONFIG.embedding.model,
        dimensions: DEFAULT_MEMORY_CONFIG.embedding.dimensions,
      },
      defaults: {
        trackAccessOnSearch: DEFAULT_MEMORY_CONFIG.defaults.trackAccessOnSearch,
        embedOnAdd,
        embedOnSync,
      },
    },
    openaiApiKey: apiKey,
  };
}

function buildFromFlags(flags: InitFlags): BuiltConfig {
  const backend = flags.backend ?? 'embedded-postgres';
  const perBackend: Record<string, unknown> = {};
  if (backend === 'embedded-postgres' && flags.dbPath) {
    perBackend['embedded-postgres'] = { dataDir: flags.dbPath };
  }
  if (backend === 'postgres') {
    if (!flags.connectionString && !process.env.MEM_DATABASE_URL) {
      output.error('Postgres backend requires --connection-string or MEM_DATABASE_URL');
    }
    perBackend.postgres = flags.connectionString
      ? { connectionString: flags.connectionString }
      : {};
  }

  const provider: EmbeddingProvider = flags.embedding ?? 'none';
  if (provider === 'openai' && !flags.openaiKey && !process.env.OPENAI_API_KEY) {
    output.error('Embedding provider `openai` requires --openai-key or OPENAI_API_KEY');
  }

  return {
    config: {
      ...DEFAULT_MEMORY_CONFIG,
      backend,
      ...perBackend,
      embedding: {
        provider,
        model: DEFAULT_MEMORY_CONFIG.embedding.model,
        dimensions: DEFAULT_MEMORY_CONFIG.embedding.dimensions,
      },
      defaults: {
        trackAccessOnSearch: DEFAULT_MEMORY_CONFIG.defaults.trackAccessOnSearch,
        embedOnAdd: flags.embedOnAdd ?? DEFAULT_MEMORY_CONFIG.defaults.embedOnAdd,
        embedOnSync: flags.embedOnSync ?? DEFAULT_MEMORY_CONFIG.defaults.embedOnSync,
      },
    },
    openaiApiKey: flags.openaiKey,
  };
}

async function warmup(cfg: MemoryConfig): Promise<string | null> {
  try {
    const backend = await loadBackendFromConfig(cfg);
    await backend.init();
    await backend.ensureSchema();
    const version = await backend.getSchemaVersion();
    if (!version) return 'schema version missing after ensureSchema';
    await backend.close();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
