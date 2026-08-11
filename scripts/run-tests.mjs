#!/usr/bin/env node
/**
 * Test runner entry point.
 *
 * Why this exists instead of `tsx --test "src/**\/*.test.ts"`:
 *
 * Runner-side glob expansion in `node --test` only landed in Node 21. On
 * Node 18 and 20 — both inside this package's declared `engines.node: >=18`
 * range — the quoted pattern is passed through literally, matches nothing,
 * and the runner exits 0 having run NOTHING. A contributor on Node 20 sees a
 * green test run that executed zero assertions.
 *
 * Discovering the files here makes the run identical on every supported Node
 * and every OS (no shell globbing differences between sh, cmd, and
 * PowerShell), and lets us fail loudly when discovery comes up empty.
 *
 * Pass extra args through to the runner, e.g.:
 *   node scripts/run-tests.mjs --test-name-pattern "identity keys"
 */
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const searchRoot = join(repoRoot, 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/** @param {string} dir @returns {string[]} */
function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findTests(full));
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const files = findTests(searchRoot).sort();

if (files.length === 0) {
  console.error(`No *.test.ts files found under ${relative(repoRoot, searchRoot) || 'src'}/.`);
  console.error('Refusing to report success for a run that executed nothing.');
  process.exit(1);
}

console.error(`Running ${files.length} test file(s) on node ${process.version}`);

const child = spawn(
  process.execPath,
  [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--test', ...process.argv.slice(2), ...files],
  { stdio: 'inherit', cwd: repoRoot },
);

child.on('exit', (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code ?? 1);
});
child.on('error', (err) => {
  console.error(`Failed to start the test runner: ${err.message}`);
  process.exit(1);
});
