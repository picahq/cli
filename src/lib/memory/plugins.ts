/**
 * Backend plugin registry + loader.
 *
 * First-party plugins register statically when this module loads:
 * `embedded-postgres` (default — bundled real-Postgres daemon with pgvector
 * detect-and-degrade) and `postgres` (remote/self-hosted). Third-party
 * plugins are declared in `memory.plugins` and dynamically imported by
 * `loadBackendFromConfig()`.
 */

import type { MemBackend, MemBackendPlugin } from './backend.js';
import type { MemoryConfig } from './config.js';

const registry = new Map<string, MemBackendPlugin>();

export function registerBackend(plugin: MemBackendPlugin): void {
  if (registry.has(plugin.name)) {
    const existing = registry.get(plugin.name)!;
    if (existing.version === plugin.version) return; // idempotent re-register
    throw new Error(
      `Backend plugin name conflict: "${plugin.name}" already registered ` +
      `(v${existing.version}); refusing to overwrite with v${plugin.version}.`
    );
  }
  registry.set(plugin.name, plugin);
}

export function getBackendPlugin(name: string): MemBackendPlugin {
  const plugin = registry.get(name);
  if (!plugin) {
    const available = [...registry.keys()].join(', ') || '(none registered)';
    throw new Error(
      `Backend plugin "${name}" is not registered. Available: ${available}. ` +
      `If this is a third-party plugin, add it to "memory.plugins" in your config.`
    );
  }
  return plugin;
}

export function listBackendPlugins(): MemBackendPlugin[] {
  return [...registry.values()];
}

export function isBackendRegistered(name: string): boolean {
  return registry.has(name);
}

/**
 * Resolve the active backend from memory config. Loads third-party plugin
 * packages first (via dynamic import), then picks the one named by
 * `memory.backend`, validates the backend-specific config block, and
 * returns a constructed (but not yet initialized) backend instance.
 *
 * Caller is responsible for `init()` + `ensureSchema()`.
 */
export async function loadBackendFromConfig(cfg: MemoryConfig): Promise<MemBackend> {
  for (const spec of cfg.plugins ?? []) {
    try {
      const mod = await import(spec);
      const plugin = (mod.default ?? mod) as MemBackendPlugin;
      if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string') {
        throw new Error(
          `Package "${spec}" does not export a MemBackendPlugin as default. ` +
          `Ensure the package's default export is the plugin descriptor.`
        );
      }
      registerBackend(plugin);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load memory plugin "${spec}": ${message}`);
    }
  }

  const plugin = getBackendPlugin(cfg.backend);
  const backendConfig = plugin.parseConfig((cfg as Record<string, unknown>)[cfg.backend] ?? {});
  return plugin.create(backendConfig);
}

// ─── First-party plugin registration ───────────────────────────────────────

import { postgresPlugin } from './plugins/postgres/index.js';
import { embeddedPostgresPlugin } from './plugins/embedded-postgres/index.js';

registerBackend(embeddedPostgresPlugin);
registerBackend(postgresPlugin);
