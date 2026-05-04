import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  dts: true,
  shims: true,
  // Keep native/wasm deps out of the bundle so their runtime assets
  // (better-sqlite3's .node, PGlite's vector.tar.gz, pg's pure-TS build,
  // pgserve's bundled Bun runtime + Postgres binaries) resolve from
  // node_modules at import time.
  external: ['better-sqlite3', '@electric-sql/pglite', '@electric-sql/pglite/vector', 'pg', 'pgserve'],
});
