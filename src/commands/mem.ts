/**
 * `one mem` command surface.
 *
 * See docs/plans/unified-memory.md §6. Sync subverb is soft-aliased here;
 * the long-form `one sync ...` path remains active with a deprecation note.
 */

import type { Command } from 'commander';
import * as output from '../lib/output.js';
import { listBackendPlugins, getMemoryConfig, SCHEMA_VERSION } from '../lib/memory/index.js';
import { memInitCommand } from './mem/init.js';
import { memConfigCommand } from './mem/config.js';
import { semanticSearchUpgradeHint, semanticSearchUpgradeLine } from './mem/util.js';
import { registerSyncCommands } from '../lib/memory/sync/index.js';
import {
  memAddCommand,
  memGetCommand,
  memUpdateCommand,
  memArchiveCommand,
  memWeightCommand,
  memFlushCommand,
  memListCommand,
  memSearchCommand,
  memContextCommand,
  memLinkCommand,
  memUnlinkCommand,
  memLinkedCommand,
  memSourcesCommand,
  memFindBySourceCommand,
} from './mem/records.js';
import { memDoctorCommand } from './mem/doctor.js';
import { memExportCommand, memImportCommand } from './mem/export.js';
import { memMigrateCommand } from './mem/migrate.js';
import { memVacuumCommand, memReindexCommand } from './mem/admin.js';
import { memSqlCommand } from './mem/sql.js';

function memStatusCommand(): void {
  const cfg = getMemoryConfig();
  const plugins = listBackendPlugins().map(p => ({
    name: p.name,
    description: p.description,
    version: p.version,
    schemaVersion: p.schemaVersion,
    capabilities: p.capabilities,
  }));
  const upgrade = semanticSearchUpgradeHint();
  const payload = {
    configured: cfg !== null,
    backend: cfg?.backend ?? null,
    embedding: cfg ? { provider: cfg.embedding.provider, model: cfg.embedding.model } : null,
    expectedSchemaVersion: SCHEMA_VERSION,
    registeredPlugins: plugins,
    ...(upgrade ? { _upgrade: upgrade } : {}),
  };
  if (output.isAgentMode()) {
    output.json(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
  const line = semanticSearchUpgradeLine();
  if (line) console.log(`\n${line}`);
}

export function registerMemoryCommands(program: Command): void {
  const mem = program.command('mem').description('Unified memory (notes, decisions, synced data) — pluggable backends');

  mem.command('status')
    .description('Show memory subsystem status, config, and registered backend plugins')
    .action(memStatusCommand);

  mem.command('init')
    .description('Tune memory config (backend, path, embeddings) — optional; memory auto-inits on first use')
    .option('--backend <name>', 'Backend plugin name (embedded-postgres | postgres | third-party)')
    .option('--embedding <provider>', 'Embedding provider: openai | none', 'none')
    .option('--openai-key <key>', 'OpenAI API key (or set OPENAI_API_KEY)')
    .option('--db-path <path>', 'Embedded Postgres data directory')
    .option('--connection-string <url>', 'Postgres connection string')
    .option('--embed-on-add', 'Embed user memories by default', false)
    .option('--embed-on-sync', 'Embed synced records by default', false)
    .option('-y, --yes', 'Skip interactive prompts (requires flags for any missing values)', false)
    .option('--force', 'Overwrite existing memory config without confirmation', false)
    .action(memInitCommand);

  mem.command('config [action] [key] [value]')
    .description('Get or set memory config (actions: get, set, unset)')
    .option('--show-secrets', 'Include secret values in get output', false)
    .action((action: string | undefined, key: string | undefined, value: string | undefined, flags: { showSecrets?: boolean }) =>
      memConfigCommand(action, key, value, flags),
    );

  mem.command('doctor')
    .description('Diagnose schema, indexes, plugin resolution, connectivity, embeddings')
    .action(memDoctorCommand);

  mem.command('vacuum')
    .description('Run backend maintenance (VACUUM ANALYZE on tables)')
    .action(memVacuumCommand);

  mem.command('reindex')
    .description('Backfill embeddings: re-embed records missing an embedding or under a different model')
    .option('--type <type>', 'Restrict to one record type, e.g. attio/attioPeople')
    .option('--model <name>', 'Override the embedding model')
    .option('--force', 'Re-embed even rows that already have a matching embedding', false)
    .option('--batch <n>', 'OpenAI calls per batch (default 50)', '50')
    .option('--limit <n>', 'Safety cap on total records to scan (default 100000)')
    .action(memReindexCommand);

  mem.command('sql <query>')
    .description('Run a read-only SELECT / WITH / EXPLAIN against the memory store')
    .action(memSqlCommand);

  // Records
  mem.command('add <type> <data>')
    .description('Add a new memory record (data is JSON)')
    .option('--tags <csv>', 'Comma-separated tags')
    .option('--keys <csv>', 'Comma-separated keys (prefixed, e.g. email:x@y.com)')
    .option('--weight <n>', 'Importance 1-10 (default 5)')
    .option('--embed', 'Force embedding for this record')
    .option('--no-embed', 'Skip embedding for this record')
    .action(memAddCommand);

  mem.command('get <id>')
    .description('Get a record by id')
    .option('--links', 'Include outgoing and incoming links', false)
    .action(memGetCommand);

  mem.command('update <id> <patch>')
    .description('Update a record (patch is JSON merged into data)')
    .action(memUpdateCommand);

  mem.command('archive <id>')
    .description('Archive a record')
    .option('--reason <text>', 'Why it was archived (user_archived | deleted_upstream | superseded | …)')
    .action(memArchiveCommand);

  mem.command('weight <id> <n>')
    .description('Set record relevance weight (1-10)')
    .action(memWeightCommand);

  mem.command('flush <id>')
    .description('Reset access count for a record')
    .action(memFlushCommand);

  mem.command('list <type>')
    .description('List records of a given type')
    .option('--limit <n>', 'Max records (default 100)')
    .option('--offset <n>', 'Offset (default 0)')
    .option('--status <status>', 'active | archived', 'active')
    .action(memListCommand);

  // Search
  mem.command('search <query>')
    .description('Hybrid search across memory (FTS + optional semantic)')
    .option('--type <type>', 'Restrict to one record type')
    .option('--limit <n>', 'Max results (default 10)')
    .option('--deep', 'Force semantic embedding on the query', false)
    .option('--no-track', 'Do not bump access_count on results', false)
    .option('--include-archived', 'Include archived records', false)
    .action(memSearchCommand);

  mem.command('context')
    .description('Get the most relevant records for session context')
    .option('-n, --limit <n>', 'Max records (default 20)')
    .option('--types <csv>', 'Comma-separated types to include')
    .action(memContextCommand);

  // Graph
  mem.command('link <fromId> <toId> <relation>')
    .description('Create a typed link between two records')
    .option('--bi', 'Make the link bidirectional', false)
    .option('--meta <json>', 'JSON metadata attached to the link')
    .action(memLinkCommand);

  mem.command('unlink <fromId> <toId> <relation>')
    .description('Remove a link')
    .action(memUnlinkCommand);

  mem.command('linked <id>')
    .description('List linked records')
    .option('--relation <name>', 'Filter by relation')
    .option('--direction <dir>', 'outgoing | incoming | both', 'outgoing')
    .action(memLinkedCommand);

  // Sources
  mem.command('sources <id>')
    .description('List source entries on a record')
    .action(memSourcesCommand);

  mem.command('find-by-source <sourceKey>')
    .description('Look up the record owning "<system>/<model>:<external_id>"')
    .action(memFindBySourceCommand);

  // Sync subverb: mounted as a full alias of `one sync`. Same handlers, same
  // options — only the command path differs. Keeps `one mem sync` feeling
  // native inside the memory subsystem without forking the implementation.
  registerSyncCommands(mem, {
    description: 'Sync platform data into memory (alias of `one sync`)',
  });

  // Migration + export/import
  mem.command('migrate')
    .description('Import legacy .one/sync/data/*.db files into the unified store')
    .option('--platform <name>', 'Only migrate this platform')
    .option('--dry-run', 'Report what would be migrated without writing', false)
    .option('--cleanup', 'After migration, delete legacy files', false)
    .option('-y, --yes', 'Skip confirmation prompts', false)
    .option('--no-heal', 'Disable stale-idField self-healing against the built-in profile (default: heal enabled)')
    .action(memMigrateCommand);

  mem.command('export [outfile]')
    .description('Export records as JSONL (default: stdout)')
    .action(memExportCommand);

  mem.command('import <file>')
    .description('Import records from a JSONL file (idempotent via keys)')
    .action(memImportCommand);
}
