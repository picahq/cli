/**
 * `one mem doctor` — actionable diagnostics for the memory subsystem.
 */

import pc from 'picocolors';
import * as output from '../../lib/output.js';
import {
  getMemoryConfig,
  loadBackendFromConfig,
  listBackendPlugins,
  SCHEMA_VERSION,
} from '../../lib/memory/index.js';
import { semanticSearchUpgradeHint, semanticSearchUpgradeLine } from './util.js';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function memDoctorCommand(): Promise<void> {
  const checks: Check[] = [];

  // 1. Config present
  const cfg = getMemoryConfig();
  if (!cfg) {
    checks.push({ name: 'memory config exists', ok: false, detail: 'run `one mem init`' });
    return emit(checks, { vectorSearchAvailable: true });
  }
  checks.push({ name: 'memory config exists', ok: true, detail: `backend=${cfg.backend}` });

  // 2. Backend plugin resolvable
  const available = listBackendPlugins().map(p => p.name);
  if (!available.includes(cfg.backend)) {
    checks.push({
      name: `backend plugin "${cfg.backend}" resolves`,
      ok: false,
      detail: `available: ${available.join(', ') || '(none)'}. If this is a third-party plugin, add it to memory.plugins in config.`,
    });
    return emit(checks, { vectorSearchAvailable: true });
  }
  checks.push({ name: `backend plugin "${cfg.backend}" resolves`, ok: true });

  // 3. Backend opens + applies schema
  let backend;
  try {
    backend = await loadBackendFromConfig(cfg);
    await backend.init();
    await backend.ensureSchema();
    checks.push({ name: 'backend opens and applies schema', ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'backend opens and applies schema',
      ok: false,
      detail: msg,
    });
    return emit(checks, { vectorSearchAvailable: true });
  }

  // 4. Schema version matches
  try {
    const ver = await backend.getSchemaVersion();
    const matches = ver === SCHEMA_VERSION;
    checks.push({
      name: 'schema version matches',
      ok: matches,
      detail: matches ? ver! : `got ${ver}, expected ${SCHEMA_VERSION}`,
    });
  } catch (err) {
    checks.push({
      name: 'schema version matches',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 5. Stats read cleanly
  try {
    const stats = await backend.stats();
    checks.push({
      name: 'stats query works',
      ok: true,
      detail: `${stats.recordCount} records (${stats.activeCount} active, ${stats.archivedCount} archived, ${stats.embeddedCount} embedded), ${stats.linkCount} links`,
    });
  } catch (err) {
    checks.push({
      name: 'stats query works',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Embedding provider healthy (if configured)
  if (cfg.embedding.provider === 'openai') {
    try {
      const { embed } = await import('../../lib/memory/embedding.js');
      const result = await embed('connectivity check');
      checks.push({
        name: 'OpenAI embedding provider reachable',
        ok: !!result,
        detail: result ? `${result.model}, ${result.vector.length} dims` : 'returned null — check OPENAI_API_KEY or network',
      });
    } catch (err) {
      checks.push({
        name: 'OpenAI embedding provider reachable',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    checks.push({ name: 'embedding provider', ok: true, detail: `disabled (${cfg.embedding.provider})` });
  }

  // 7. Capability vs profile sanity. If vector search is disabled but user has embedOnAdd=true,
  //    that's a warning-level mismatch.
  if (cfg.defaults.embedOnAdd && !backend.capabilities().vectorSearch) {
    checks.push({
      name: 'capability ↔ config consistent',
      ok: false,
      detail: 'embedOnAdd=true but backend advertises vectorSearch=false — embeddings will be stored but unusable',
    });
  } else {
    checks.push({ name: 'capability ↔ config consistent', ok: true });
  }

  const vectorSearchAvailable = backend.capabilities().vectorSearch;
  try { await backend.close(); } catch { /* ignore */ }
  emit(checks, { vectorSearchAvailable });
}

function emit(checks: Check[], capInfo: { vectorSearchAvailable: boolean }): void {
  const allOk = checks.every(c => c.ok);
  const upgrade = semanticSearchUpgradeHint({ vectorSearchAvailable: capInfo.vectorSearchAvailable });

  if (output.isAgentMode()) {
    output.json({ ok: allOk, checks, ...(upgrade ? { _upgrade: upgrade } : {}) });
    if (!allOk) process.exitCode = 1;
    return;
  }
  for (const c of checks) {
    const mark = c.ok ? pc.green('✓') : pc.red('✗');
    const detail = c.detail ? pc.dim(` — ${c.detail}`) : '';
    console.log(`  ${mark} ${c.name}${detail}`);
  }
  if (!allOk) {
    console.log('\n' + pc.yellow('Memory is not fully healthy.'));
    process.exitCode = 1;
  } else {
    console.log('\n' + pc.green('Memory is healthy.'));
  }
  const line = semanticSearchUpgradeLine({ vectorSearchAvailable: capInfo.vectorSearchAvailable });
  if (line) console.log(`\n${pc.dim(line)}`);
}
