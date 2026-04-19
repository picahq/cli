// Concurrency test for sync state writers. Simulates many concurrent
// cron ticks hammering the state dir and asserts the final state is consistent.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';

const { readSyncState, updateModelState, removeModelState } = await import(
  new URL('../src/lib/sync/state.ts', import.meta.url).pathname
);

const originalCwd = cwd();
const workDir = mkdtempSync(join(tmpdir(), 'one-state-test-'));
chdir(workDir);

try {
  // Seed with four concurrent models, all starting from 'syncing' (the wedged
  // state from the bug report).
  const models = [
    ['attio', 'attioCompanies'],
    ['attio', 'attioPeople'],
    ['gmail', 'threads'],
    ['google-calendar', 'events'],
  ];

  // Legacy-file migration test: write an old sync_state.json and verify the
  // first read splits it into per-model files.
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.join('.one', 'sync'), { recursive: true });
  const legacy = {};
  for (const [p, m] of models) {
    legacy[p] ??= {};
    legacy[p][m] = {
      lastSync: null, lastCursor: null, totalRecords: 0,
      pagesProcessed: 0, since: null, status: 'syncing',
    };
  }
  writeFileSync(path.join('.one', 'sync', 'sync_state.json'), JSON.stringify(legacy, null, 2));

  // Trigger migration by reading.
  const migrated = readSyncState();
  const migratedOk =
    Object.keys(migrated).length === 3 &&
    !fs.existsSync(path.join('.one', 'sync', 'sync_state.json'));
  console.log('migration:', migratedOk ? 'ok' : 'FAILED', migrated);
  if (!migratedOk) throw new Error('legacy migration did not consume sync_state.json');

  // Hammer the writer with 200 concurrent updates spread across all models.
  // Each update is the same shape as the real sync writes: status transitions
  // and cursor/page snapshots.
  const promises = [];
  const N = 200;
  for (let i = 0; i < N; i++) {
    const [p, m] = models[i % models.length];
    promises.push(Promise.resolve().then(() => {
      updateModelState(p, m, {
        status: 'syncing',
        pagesProcessed: i,
        lastCursor: `cursor-${i}`,
      });
    }));
  }
  await Promise.all(promises);

  // Now finalize each to idle — the critical step the bug was losing.
  for (const [p, m] of models) {
    updateModelState(p, m, { status: 'idle', lastSync: new Date().toISOString(), lastCursor: null });
  }

  const final = readSyncState();
  const allIdle = models.every(([p, m]) => final[p]?.[m]?.status === 'idle');
  console.log('final statuses:');
  for (const [p, m] of models) {
    console.log(`  ${p}/${m}: status=${final[p]?.[m]?.status}`);
  }

  if (!allIdle) {
    throw new Error('at least one model did not land in status=idle');
  }

  // Ensure no stray .tmp files leaked.
  const stateDir = path.join('.one', 'sync', 'state');
  const stray = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.includes('.tmp')) stray.push(full);
    }
  }
  walk(stateDir);
  console.log('stray tmp files:', stray.length);
  if (stray.length) throw new Error(`stray tmp files found: ${stray.join(', ')}`);

  // removeModelState sanity
  removeModelState('google-calendar', 'events');
  const afterRemove = readSyncState();
  if (afterRemove['google-calendar']) {
    throw new Error('removeModelState did not clean up empty platform dir');
  }
  console.log('removeModelState: ok');

  console.log('\nPASS — concurrency test green (N=' + N + ')');
} finally {
  chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
}
