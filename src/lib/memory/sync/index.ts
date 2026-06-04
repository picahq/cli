import type { Command } from 'commander';
import * as output from '../../output.js';
import { OneApi } from '../../api.js';
import { getApiKey, getApiBase, getAccessControlFromAllSources } from '../../config.js';
import { discoverModels } from './models.js';
import { readProfile, writeProfile, writeDraftProfile, listProfiles, generateTemplate } from './profile.js';
import { syncModel } from './runner.js';
import { testSyncProfile } from './test.js';
import { inferProfileFromKnowledge } from './infer.js';
import { loadBuiltinProfile, listBuiltinProfiles } from './builtin-profiles.js';
import { addSchedule, listSchedules, removeSchedule, scheduleStatus, repairSchedule } from './schedule.js';
import { parseCondition, splitConditions } from './where-parser.js';
import { readSyncState, removeModelState, getModelState } from './state.js';
import { executeQuery } from './query.js';
import { searchSyncedData } from './search.js';
import { extractSearchableFromPaths, getSearchablePaths } from './mem-writer.js';
import { defaultSearchableText } from '../embedding.js';
import { suggestSearchablePaths } from './suggest-searchable.js';
import { openDatabase, getDatabaseSize, dropTable, deleteDatabase, countRecords, listTables, deleteRecords, rebuildFtsIndex, tableExists, sanitizeTableName } from './db.js';
import type { SyncProfile, SyncRunOptions, SyncQueryOptions } from './types.js';
import { isSqliteAvailable, loadSqlite } from './sqlite-loader.js';
import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import pc from 'picocolors';

// ── sync install / doctor ──

/** Run `npm install -g better-sqlite3` (or local if -g fails). */
async function syncInstallCommand(): Promise<void> {
  if (await isSqliteAvailable()) {
    if (output.isAgentMode()) {
      output.json({ status: 'already-installed', module: 'better-sqlite3' });
    } else {
      output.note('better-sqlite3 is already installed.', 'Sync');
    }
    return;
  }

  if (!output.isAgentMode()) {
    process.stderr.write('Installing better-sqlite3 (native module, may take ~30s)...\n');
  }

  const install = (args: string[]): Promise<number> =>
    new Promise(resolve => {
      const child = spawn('npm', args, { stdio: output.isAgentMode() ? 'ignore' : 'inherit' });
      child.on('exit', code => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });

  // Try global first (typical for a CLI installed via `npm install -g`)
  let code = await install(['install', '-g', 'better-sqlite3']);
  if (code !== 0) {
    // Fall back to local install in case this is a dev checkout
    code = await install(['install', 'better-sqlite3']);
  }

  if (code !== 0) {
    output.error(
      'Failed to install better-sqlite3. This usually means your system is missing build tools.\n' +
      'On macOS: xcode-select --install\n' +
      'On Linux: install python3, make, g++\n' +
      'Then retry: one sync install'
    );
  }

  if (output.isAgentMode()) {
    output.json({ status: 'installed', module: 'better-sqlite3' });
  } else {
    output.outro('better-sqlite3 installed. You can now run one sync commands.');
  }
}

async function syncDoctorCommand(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

  // Check 1: module loads
  try {
    const Database = await loadSqlite();
    checks.push({ name: 'better-sqlite3 loads', ok: true });

    // Check 2: can open an in-memory DB
    try {
      const db = new Database(':memory:');
      db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
      const row = db.prepare('SELECT x FROM t').get() as { x: number };
      db.close();
      checks.push({ name: 'in-memory DB read/write', ok: row.x === 1 });
    } catch (err) {
      checks.push({ name: 'in-memory DB read/write', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }

    // Check 3: FTS5 available
    try {
      const db = new Database(':memory:');
      db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
      db.close();
      checks.push({ name: 'FTS5 virtual table support', ok: true });
    } catch (err) {
      checks.push({ name: 'FTS5 virtual table support', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    checks.push({ name: 'better-sqlite3 loads', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  const allOk = checks.every(c => c.ok);

  if (output.isAgentMode()) {
    output.json({ ok: allOk, checks });
    return;
  }

  for (const c of checks) {
    const mark = c.ok ? pc.green('✓') : pc.red('✗');
    console.log(`  ${mark} ${c.name}${c.detail ? pc.dim(` — ${c.detail}`) : ''}`);
  }
  if (!allOk) {
    console.log(`\n${pc.yellow('Sync is not ready.')} Try: ${pc.bold('one sync install')}`);
  } else {
    console.log(`\n${pc.green('Sync is ready.')}`);
  }
}

function getApi(): OneApi {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('No API key configured. Run "one init" first.');
  }
  return new OneApi(apiKey!, getApiBase());
}

// ── sync profiles (built-in) ──

async function syncProfilesCommand(platform?: string): Promise<void> {
  const profiles = listBuiltinProfiles(platform);

  if (output.isAgentMode()) {
    output.json({
      profiles: profiles.map(p => ({
        platform: p.platform,
        model: p.model,
        description: p.description,
        hasEnrich: !!(p as any).enrich,
        hasIdentityKey: !!(p as any).identityKey,
      })),
      total: profiles.length,
      _hint: profiles.length > 0
        ? 'Use a built-in profile: one --agent sync init <platform> <model>'
        : 'No built-in profiles found. Use sync init to auto-infer from action knowledge.',
    });
    return;
  }

  if (profiles.length === 0) {
    output.note(
      platform
        ? `No built-in profiles for ${platform}. Use sync init to auto-infer from action knowledge.`
        : 'No built-in profiles found.',
      'Profiles'
    );
    return;
  }

  for (const p of profiles) {
    const extras: string[] = [];
    if ((p as any).enrich) extras.push('enrich');
    if ((p as any).identityKey) extras.push('identity');
    if ((p as any).dateFilter) extras.push('incremental');
    const tags = extras.length > 0 ? ` ${pc.dim(`[${extras.join(', ')}]`)}` : '';
    console.log(`  ${pc.bold(`${p.platform}/${p.model}`.padEnd(35))} ${p.description}${tags}`);
  }
  console.log(`\n${profiles.length} built-in profile(s). Run ${pc.bold('one sync init <platform> <model>')} to use one.`);
}

// ── sync models ──

async function syncModelsCommand(platform: string): Promise<void> {
  const api = getApi();
  const spinner = output.createSpinner();
  spinner.start(`Discovering models for ${platform}...`);

  try {
    const models = await discoverModels(api, platform);
    spinner.stop(`Found ${models.length} models`);

    if (output.isAgentMode()) {
      output.json({ platform, models, total: models.length });
      return;
    }

    if (models.length === 0) {
      output.note('No list-type actions found for this platform.', 'Models');
      return;
    }

    const lines = models.map(m =>
      `  ${pc.bold(m.name.padEnd(30))} ${pc.dim(m.listAction.method)} ${pc.dim(m.listAction.path)}`
    );
    output.note(lines.join('\n'), `${platform} — ${models.length} models`);
  } catch (err) {
    spinner.stop('Failed');
    output.error(`Error discovering models: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync init ──

async function syncInitCommand(platform: string, model: string, options: { config?: string }): Promise<void> {
  if (!options.config) {
    // Output a template with resolved executable action ID
    const api = getApi();
    const spinner = output.createSpinner();
    spinner.start(`Looking up ${platform}/${model}...`);

    try {
      // Find the model in available actions
      const models = await discoverModels(api, platform);
      const match = models.find(m => m.name === model || m.name.toLowerCase() === model.toLowerCase());

      // Use the actionId already resolved by discoverModels (which does
      // the searchActions resolution internally). No need for a second search.
      let actionId: string | undefined;
      if (match) {
        actionId = match.listAction.actionId;
        // Only trust it if it's the executable format (conn_mod_def::)
        if (actionId && !actionId.startsWith('conn_mod_def::')) {
          actionId = undefined;
        }
        spinner.stop(actionId ? 'Found model + action ID' : 'Found model (action ID not resolved)');
      } else {
        spinner.stop('Model not found in available actions');
      }

      // Check for a built-in profile first — pre-validated configs that skip inference
      const builtin = loadBuiltinProfile(platform, model);
      let template: Record<string, unknown>;
      let inferred: ReturnType<typeof inferProfileFromKnowledge> | null = null;

      if (builtin) {
        // Use the built-in profile as the base, overriding actionId if we resolved one
        template = { ...builtin };
        if (actionId) template.actionId = actionId;
        delete template.description; // don't persist the description into the profile
        inferred = { reasoning: [`Built-in profile found for ${platform}/${model}: "${builtin.description}"`] };
      } else {
        template = generateTemplate(platform, model, actionId) as Record<string, unknown>;
      }

      // Try to infer from knowledge if no built-in was found
      if (actionId && !builtin) {
        try {
          const knowledgeResp = await api.getActionKnowledge(actionId);
          inferred = inferProfileFromKnowledge(knowledgeResp?.knowledge, model, platform);

          // Replace the template's default pagination entirely with the inferred
          // one — merging would preserve stale FILL_IN keys that the inferred
          // config deliberately omitted (e.g. nextPath for offset pagination).
          if (inferred.pagination) template.pagination = inferred.pagination;
          if (inferred.resultsPath) template.resultsPath = inferred.resultsPath;
          if (inferred.idField) template.idField = inferred.idField;
          if (inferred.dateFilterParam) {
            template.dateFilter = { param: inferred.dateFilterParam, format: 'iso8601' };
          }
          if (inferred.limitLocation) template.limitLocation = inferred.limitLocation;
          if (inferred.limitParam) template.limitParam = inferred.limitParam;
          if (inferred.pathVars && Object.keys(inferred.pathVars).length > 0) {
            template.pathVars = inferred.pathVars;
          }
        } catch {
          // Knowledge fetch failed — leave template as-is
        }
      }

      // Set up the connection ref. The template already defaults to
      // `connection: { platform }` (late-bound, survives re-auth). When
      // multiple connections exist, surface the tags so the agent knows
      // to add a `tag` field — but don't pick one for them, since the
      // tags express user intent (e.g. multi-account Gmail).
      try {
        const connections = await api.listConnections();
        const platformConns = connections.filter(
          (c: { platform: string; tags?: string[] }) => c.platform === platform
        );
        if (platformConns.length === 1) {
          inferred?.reasoning.push(`connection: { platform: "${platform}" } resolves to the single available connection`);
        } else if (platformConns.length > 1) {
          const tags = platformConns
            .map(c => c.tags?.join(',') ?? '(no tag)')
            .join('; ');
          inferred?.reasoning.push(
            `connection: ${platformConns.length} ${platform} connections found (tags: ${tags}). ` +
            `Add a \`tag\` field to the connection ref to disambiguate.`
          );
        }
      } catch {
        // Best-effort — leave the default `connection: { platform }`
      }

      // Persist as a draft
      try {
        writeDraftProfile(platform, model, template);
      } catch {
        // Best-effort
      }

      // Check if the profile is complete (no FILL_IN values remaining)
      const templateStr = JSON.stringify(template);
      const isComplete = !templateStr.includes('FILL_IN');

      // If complete, auto-run sync test so the agent gets immediate feedback
      let testReport: Awaited<ReturnType<typeof testSyncProfile>> | null = null;
      if (isComplete) {
        try {
          testReport = await testSyncProfile(api, template as unknown as SyncProfile);
          // If test auto-fixed fields, persist them
          if (testReport.autoFixed && Object.keys(testReport.autoFixed).length > 0) {
            Object.assign(template, testReport.autoFixed);
            try { writeDraftProfile(platform, model, template); } catch { /* best-effort */ }
          }
        } catch {
          // Test failed — report will show the error
        }
      }

      const hint = isComplete
        ? (testReport?.ok
            ? `Profile complete and validated. Run: one sync run ${platform} --models ${model}`
            : `Profile complete but test had issues — check the test report below.`)
        : (actionId
            ? `Fill remaining FILL_IN fields, then: one sync test ${platform}/${model}`
            : `Action ID not resolved. Run: one --agent actions search ${platform} "list ${model}" -t execute`);

      if (output.isAgentMode()) {
        output.json({
          ...template,
          _hint: hint,
          _inferred: inferred?.reasoning ?? [],
          _draft: !isComplete,
          _complete: isComplete,
          ...(testReport ? { _test: { ok: testReport.ok, checks: testReport.checks, autoFixed: testReport.autoFixed } } : {}),
        });
      } else {
        output.note(JSON.stringify(template, null, 2), 'Sync profile template');
        if (inferred && inferred.reasoning.length > 0) {
          console.log(`\n${pc.bold('Inferred from knowledge:')}`);
          for (const r of inferred.reasoning) console.log(`  ${pc.dim('•')} ${r}`);
        }
        if (testReport) {
          console.log(`\n${pc.bold('Test results:')}`);
          for (const c of testReport.checks) {
            const mark = c.ok ? pc.green('✓') : pc.red('✗');
            console.log(`  ${mark} ${c.name}${c.detail ? pc.dim(` — ${c.detail}`) : ''}`);
          }
        }
        console.log(`\n${hint}`);
        if (!isComplete) {
          console.log(`\nRun with --config to save:\n  one sync init ${platform} ${model} --config '${JSON.stringify(template)}'`);
        }
      }
    } catch (err) {
      spinner.stop('Failed');
      output.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // Parse --config. Merge into an existing profile if one exists so the agent
  // can patch a single field (like connectionKey) without re-supplying everything.
  let patch: Partial<SyncProfile>;
  try {
    patch = JSON.parse(options.config) as Partial<SyncProfile>;
  } catch {
    output.error('Invalid JSON in --config. Provide a valid JSON sync profile.');
    return;
  }

  // Seed base: prefer an on-disk profile (user has been editing), else the
  // built-in (agents tweaking a known platform shouldn't have to re-supply
  // actionId, pagination, etc.), else an empty shell. This was missing
  // when --config was passed first-time for a built-in platform, leaving
  // users with `Missing required field: actionId`.
  const existing = readProfile(platform, model);
  const base = existing ?? (loadBuiltinProfile(platform, model) as SyncProfile | null) ?? ({} as SyncProfile);

  const profile: SyncProfile = {
    ...base,
    ...patch,
    // Ensure platform/model from args always win
    platform,
    model,
    // Deep-merge pagination so you can patch just nextPath without losing type
    pagination: {
      ...(base.pagination ?? ({} as SyncProfile['pagination'])),
      ...(patch.pagination ?? {}),
    },
  };

  // Connection form is mutually exclusive: if the patch supplies one form,
  // clear the other from the merged result. Otherwise a `connection` patch
  // applied to a profile with a literal `connectionKey` would leave both set
  // and writeProfile would reject the merged profile.
  if (patch.connection && !patch.connectionKey) {
    delete profile.connectionKey;
  } else if (patch.connectionKey && !patch.connection) {
    delete profile.connection;
  }

  try {
    writeProfile(profile);
    if (output.isAgentMode()) {
      output.json({ status: 'created', platform, model, profile });
    } else {
      output.outro(`Sync profile saved for ${platform}/${model}`);
    }
  } catch (err) {
    output.error(`Error saving profile: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync test ──

async function syncTestCommand(
  platformModel: string,
  options: { showSearchable?: boolean } = {},
): Promise<void> {
  const [platform, model] = platformModel.split('/');
  if (!platform || !model) {
    output.error('Usage: one sync test <platform>/<model>. Example: one sync test shopify/orders');
  }

  const profile = readProfile(platform, model);
  if (!profile) {
    output.error(
      `No sync profile found for ${platform}/${model}. ` +
      `Create one with: one sync init ${platform} ${model} --config '...'`
    );
  }

  const api = getApi();
  const report = await testSyncProfile(api, profile!);

  // If sync test auto-discovered fields (like resultsPath), patch the
  // profile on disk so the agent can go straight to `sync run` without
  // another `--config` round-trip.
  if (report.autoFixed && Object.keys(report.autoFixed).length > 0) {
    try {
      const existing = readProfile(platform, model);
      if (existing) {
        const patched = { ...existing, ...report.autoFixed };
        writeProfile(patched as SyncProfile);
      }
    } catch {
      // Best-effort — agent can still manually --config
    }
  }

  const searchablePreview = options.showSearchable
    ? buildSearchablePreview(profile!, report.samples)
    : null;

  if (output.isAgentMode()) {
    output.json({ ...report, ...(searchablePreview ? { searchable: searchablePreview } : {}) });
    return;
  }

  for (const c of report.checks) {
    const mark = c.ok ? pc.green('✓') : pc.red('✗');
    console.log(`  ${mark} ${c.name}${c.detail ? pc.dim(` — ${c.detail}`) : ''}`);
  }

  if (report.detectedColumns && report.detectedColumns.length > 0) {
    console.log(`\n  ${pc.bold('Detected columns:')}`);
    for (const col of report.detectedColumns.slice(0, 20)) {
      console.log(`    ${col.name.padEnd(30)} ${pc.dim(col.type)}`);
    }
    if (report.detectedColumns.length > 20) {
      console.log(pc.dim(`    ... and ${report.detectedColumns.length - 20} more`));
    }
  }

  if (searchablePreview) {
    console.log(`\n  ${pc.bold('Searchable preview')} ${pc.dim(`(${searchablePreview.mode}, ${searchablePreview.sampledRecords} sample${searchablePreview.sampledRecords === 1 ? '' : 's'})`)}`);
    console.log(`    ${pc.dim('length:')}  ${searchablePreview.length} chars (first sample)`);
    console.log(`    ${pc.dim('text:')}    ${searchablePreview.text.slice(0, 300)}${searchablePreview.length > 300 ? pc.dim(' …') : ''}`);
    if (searchablePreview.paths) {
      console.log(`    ${pc.dim('paths:')}  ${pc.dim('(hit rate across all samples — differentiates "wrong path" from "field sometimes missing")')}`);
      for (const p of searchablePreview.paths) {
        const rate = `${p.hits}/${p.total}`;
        const mark = p.hits === p.total
          ? pc.green('✓')
          : p.hits === 0
            ? pc.red('✗')
            : pc.yellow('~');
        const trailer = p.sample
          ? pc.dim(` → "${p.sample}"`)
          : p.hits === 0
            ? pc.dim(' (no sample matched — typo, or field never populated in this page)')
            : '';
        console.log(`      ${mark} ${rate.padStart(5)} ${p.path}${trailer}`);
      }
    } else {
      console.log(`    ${pc.yellow('note:')} no memory.searchable declared — using the default walker (walks every field, often noisy).`);
      console.log(`    ${pc.dim('tip:')}  run \`one sync suggest-searchable ${platform}/${model}\` for an auto-ranked starter list, or pick paths by hand and add them to profile.memory.searchable.`);
    }
  }

  console.log(
    `\n${report.ok ? pc.green('Profile looks good.') : pc.red('Profile has issues.')} ` +
    (report.ok
      ? `Run: ${pc.bold(`one sync run ${platform} --models ${model}`)}`
      : 'Fix the issues above and test again.')
  );
}

/**
 * Run the same searchable-text extraction `sync run --to-memory` would, so
 * the agent can iterate on `memory.searchable` before committing embeddings.
 * Returns null when no sample record is available.
 */
function buildSearchablePreview(
  profile: SyncProfile,
  samples: Array<Record<string, unknown>> | undefined,
):
  | {
      mode: 'declared' | 'default';
      text: string;
      length: number;
      sampledRecords: number;
      /**
       * Per-path resolution across the sampled records, with a hit rate.
       * `hits / total` disambiguates the old single-sample `found` flag:
       *   5/5 = path looks right
       *   3/5 = path works, some records lack this field
       *   0/5 = path doesn't exist (likely typo OR field always absent)
       */
      paths?: Array<{
        path: string;
        hits: number;
        total: number;
        sample: string;
      }>;
    }
  | null {
  if (!samples || samples.length === 0) return null;
  const first = samples[0];
  const paths = getSearchablePaths(profile);

  if (paths) {
    // Aggregate per-path hits across all samples; keep the first non-
    // empty sample value for display so the agent sees real data.
    const perPathAgg = paths.map(path => ({ path, hits: 0, total: samples.length, sample: '' }));
    for (const record of samples) {
      const { paths: perPath } = extractSearchableFromPaths(record, paths);
      perPath.forEach((p, i) => {
        if (p.found) {
          perPathAgg[i].hits++;
          if (!perPathAgg[i].sample) perPathAgg[i].sample = p.sample;
        }
      });
    }
    // Text preview is built from the first sample so the "what would get
    // embedded" snapshot is concrete, not synthetic across records.
    const { text } = extractSearchableFromPaths(first, paths);
    return { mode: 'declared', text, length: text.length, sampledRecords: samples.length, paths: perPathAgg };
  }

  // Mirror the runtime fallback so the preview reflects what WOULD be
  // embedded today (noisy).
  const text = defaultSearchableText(first);
  return { mode: 'default', text, length: text.length, sampledRecords: samples.length };
}

// ── sync run ──

async function syncRunCommand(platform: string, options: SyncRunOptions): Promise<void> {
  const api = getApi();
  const profiles = listProfiles(platform);
  const targetModels = options.models;

  const toSync = targetModels
    ? profiles.filter(p => targetModels.includes(p.model))
    : profiles;

  if (toSync.length === 0) {
    output.error(
      `No sync profiles found for ${platform}` +
      (targetModels ? ` with models: ${targetModels.join(', ')}` : '') +
      `. Run 'one sync init ${platform} <model> --config ...' first.`
    );
  }

  // Auto-migrate on first encounter with legacy data. Fires when:
  //   (a) ~/.one/sync/data/<platform>.db exists on disk, AND
  //   (b) memory has zero records for any of this platform's types.
  // Otherwise we'd leave users with two sources of truth (the old .db
  // keeps rowcount, the new memory starts empty, neither agrees with
  // the other) and no nudge to reconcile.
  //
  // --agent mode: silent auto-migrate + log the numbers to stderr.
  // TTY mode: prompt interactively (default: yes) so nothing surprising
  // happens without a human beat.
  if (!options.dryRun) {
    await maybeAutoMigrateLegacy(platform, toSync.map(p => p.model));
  }

  const results = [];
  for (const profile of toSync) {
    try {
      const result = await syncModel(api, profile, options);
      results.push(result);
    } catch (err) {
      // Use real counts attached by the runner (if available) instead of 0
      const errObj = err as any;
      const errorContext: { message: string; httpStatus?: number; retryAfter?: number } = {
        message: err instanceof Error ? err.message : String(err),
        ...(errObj?._httpStatus !== undefined ? { httpStatus: errObj._httpStatus } : {}),
        ...(errObj?._retryAfter !== undefined ? { retryAfter: errObj._retryAfter } : {}),
      };
      results.push({
        model: profile.model,
        recordsSynced: errObj?._recordsSynced ?? 0,
        pagesProcessed: errObj?._pagesProcessed ?? 0,
        duration: '0s',
        status: 'failed',
        error: errorContext,
      });
    }
  }

  if (output.isAgentMode()) {
    output.json({ platform, results });
    return;
  }

  // Human output
  for (const r of results) {
    const status = r.status === 'complete'
      ? pc.green('complete')
      : r.status === 'dry-run'
        ? pc.yellow('dry-run')
        : pc.red('failed');
    console.log(`  ${pc.bold(r.model)} — ${r.recordsSynced} records, ${r.pagesProcessed} pages, ${r.duration} [${status}]`);
    if ((r as { reconcileSkipped?: boolean }).reconcileSkipped) {
      console.log(`    ${pc.yellow('--full-refresh reconcile skipped — pagination truncated (e.g. --max-pages). Re-run without the cap to prune stale rows.')}`);
    }
    const sc = (r as { statusCounts?: { active: number; archived: number } }).statusCounts;
    if (sc && (sc.archived > 0 || sc.active > 0)) {
      // Highlight imbalance — archived > active suggests prior reconcile damage.
      const archivedColor = sc.archived > sc.active ? pc.red : pc.dim;
      console.log(`    memory: ${pc.green(String(sc.active))} active, ${archivedColor(String(sc.archived))} archived`);
    }
    if (r.error) {
      const errParts = [r.error.message];
      if (r.error.httpStatus) errParts.push(`HTTP ${r.error.httpStatus}`);
      if (r.error.retryAfter) errParts.push(`retry after ${r.error.retryAfter}s`);
      console.log(`    ${pc.red(errParts.join(' — '))}`);
    }
  }
}

// ── sync query ──

async function syncQueryCommand(platformModel: string, options: SyncQueryOptions): Promise<void> {
  const [platform, model] = platformModel.split('/');
  if (!platform || !model) {
    output.error('Usage: one sync query <platform>/<model>. Example: one sync query shopify/orders');
  }

  // Handle --refresh
  if (options.refresh) {
    const api = getApi();
    const profile = readProfile(platform, model);
    if (profile) {
      if (!output.isAgentMode()) {
        process.stderr.write(`Refreshing ${platform}/${model}...\n`);
      }
      await syncModel(api, profile, { force: options.refreshForce });
    }
  }

  try {
    const result = await executeQuery(platform, model, options);
    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    console.log(pc.dim(`Query: ${result.query}`));
    console.log(pc.dim(`Source: local | Last sync: ${result.lastSync ?? 'never'} | Age: ${result.syncAge ?? 'n/a'}`));
    console.log(JSON.stringify(result.results, null, 2));
    console.log(`\n${result.total} results`);
  } catch (err) {
    output.error(`Query error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync search ──

async function syncSearchCommand(query: string, options: { platform?: string; models?: string; limit?: string }): Promise<void> {
  const modelList = options.models?.split(',').map(m => m.trim());
  const limit = options.limit ? parseInt(options.limit, 10) : 20;

  try {
    const result = await searchSyncedData(query, { platform: options.platform, models: modelList, limit });
    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    if (result.results.length === 0) {
      output.note('No results found.', 'Search');
      return;
    }

    for (const r of result.results) {
      console.log(`  ${pc.bold(`${r.platform}/${r.model}`)} ${pc.dim(`(rank: ${r.rank.toFixed(2)})`)}`);
      console.log(`    ${JSON.stringify(r.record)}`);
    }
    console.log(`\n${result.total} results`);
  } catch (err) {
    output.error(`Search error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync sql ──
//
// Delegates to the shared mem SQL surface via the platform/model-aware
// helper in src/commands/mem/sql.ts. Read-only SELECT / WITH / EXPLAIN;
// DDL / DML / session-control rejected by the backend's guard.

async function syncSqlCommand(platformModel: string, sql: string): Promise<void> {
  const { syncSqlCommand: runSyncSql } = await import('../../../commands/mem/sql.js');
  await runSyncSql(platformModel, sql);
}

// ── sync delete ──

async function syncDeleteCommand(platformModel: string, options: { where?: string; whereSql?: string; id?: string; yes?: boolean }): Promise<void> {
  const [platform, model] = platformModel.split('/');
  if (!platform || !model) {
    output.error('Usage: one sync delete <platform>/<model> --id <id> or --where "field=value"');
  }

  if (!options.id && !options.where && !options.whereSql) {
    output.error('Provide --id <value>, --where "field=value", or --where-sql "SQL predicate" to specify which records to delete.');
  }

  const db = await openDatabase(platform);
  try {
    if (!tableExists(db, model)) {
      db.close();
      output.error(`No synced data for ${platform}/${model}.`);
    }

    // Build WHERE clause
    let where: string;
    let params: unknown[];

    if (options.id) {
      // Find the idField from the profile
      const profile = readProfile(platform, model);
      const idField = profile?.idField || 'id';
      where = `"${idField}" = ?`;
      params = [options.id];
    } else if (options.whereSql) {
      // Raw SQL predicate — allows json_each(), subqueries, etc.
      // Safe because the DB is local and user-owned.
      where = options.whereSql;
      params = [];
    } else {
      // Parse --where conditions (splits on commas outside quoted sections,
      // strips surrounding quotes from values)
      const conditions = splitConditions(options.where!);
      const clauses: string[] = [];
      params = [];
      for (const cond of conditions) {
        try {
          const parsed = parseCondition(cond);
          clauses.push(`"${parsed.field}" ${parsed.operator} ?`);
          params.push(parsed.value);
        } catch (err) {
          db.close();
          output.error(err instanceof Error ? err.message : String(err));
        }
      }
      where = clauses.join(' AND ');
    }

    // Preview what will be deleted
    const safeTable = sanitizeTableName(model);
    const preview = db.prepare(`SELECT COUNT(*) as count FROM "${safeTable}" WHERE ${where}`).get(...params) as { count: number };

    if (preview.count === 0) {
      db.close();
      if (output.isAgentMode()) {
        output.json({ deleted: 0, platform, model });
      } else {
        console.log('No matching records found.');
      }
      return;
    }

    // Confirm unless --yes
    if (!options.yes && !output.isAgentMode()) {
      const confirmed = await p.confirm({ message: `Delete ${preview.count} record(s) from ${platform}/${model}?` });
      if (p.isCancel(confirmed) || !confirmed) {
        db.close();
        output.cancel('Cancelled.');
        return;
      }
    }

    const deleted = deleteRecords(db, model, where, params);

    // Rebuild FTS index
    rebuildFtsIndex(db, model);

    db.close();

    if (output.isAgentMode()) {
      output.json({ deleted, platform, model });
    } else {
      console.log(`Deleted ${deleted} record(s) from ${platform}/${model}.`);
    }
  } catch (err) {
    db.close();
    output.error(`Delete error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Detect legacy `.one/sync/data/<platform>.db` that memory hasn't
 * absorbed yet, and migrate it automatically. Silent-pass when nothing
 * matches. Logs counts to stderr (agent mode) or prompts (TTY).
 */
async function maybeAutoMigrateLegacy(platform: string, models: string[]): Promise<void> {
  const dbSize = getDatabaseSize(platform);
  if (!dbSize || dbSize === '0 B') return;

  // Check memory: any records of this platform's types? If yes, the user
  // has already run at least one memory-primary sync — don't re-migrate,
  // they can explicitly invoke `mem migrate --cleanup` when ready.
  const { getBackend } = await import('../runtime.js');
  const backend = await getBackend();
  let memoryHasData = false;
  for (const model of models) {
    const n = await backend.count(`${platform}/${model}`, { status: 'active' }).catch(() => 0);
    if (n > 0) { memoryHasData = true; break; }
  }
  if (memoryHasData) return;

  if (output.isAgentMode()) {
    process.stderr.write(
      `  detected legacy .one/sync/data/${platform}.db (${dbSize}) — auto-migrating into memory before sync.\n`,
    );
    const { memMigrateCommand } = await import('../../../commands/mem/migrate.js');
    await memMigrateCommand({ platform, yes: true });
    return;
  }

  // TTY: tell the user, default yes.
  const shouldMigrate = await p.confirm({
    message:
      `Found legacy .one/sync/data/${platform}.db (${dbSize}) with no corresponding memory records. ` +
      `Migrate into the unified memory store before syncing?`,
    initialValue: true,
  });
  if (p.isCancel(shouldMigrate) || !shouldMigrate) return;

  const { memMigrateCommand } = await import('../../../commands/mem/migrate.js');
  await memMigrateCommand({ platform, yes: true });
}

// ── sync suggest-searchable ──

async function syncSuggestSearchableCommand(
  platformModel: string,
  options: { limit?: string } = {},
): Promise<void> {
  const [platform, model] = platformModel.split('/');
  if (!platform || !model) {
    output.error('Usage: one sync suggest-searchable <platform>/<model>. Example: one sync suggest-searchable attio/attioPeople');
  }

  const profile = readProfile(platform, model);
  if (!profile) {
    output.error(
      `No sync profile found for ${platform}/${model}. ` +
      `Create one with: one sync init ${platform} ${model}`,
    );
  }

  const api = getApi();
  const report = await testSyncProfile(api, profile!);
  const samples = report.samples ?? [];
  if (samples.length === 0) {
    output.error(
      'No sample records available to rank against. Fix the failures in `sync test` first, then re-run suggest-searchable.',
    );
  }

  const limit = options.limit ? parseInt(options.limit, 10) : 15;
  const suggestions = suggestSearchablePaths(samples, limit);

  // Build a paste-ready config JSON that the agent can drop straight
  // into `sync init --config`. Defaults to embed:true since opting for
  // semantic search is the whole reason you ran this command.
  const topPaths = suggestions.map(s => s.path);
  const configPatch = { memory: { embed: true, searchable: topPaths } };

  if (output.isAgentMode()) {
    output.json({
      platform,
      model,
      sampledRecords: samples.length,
      suggestions,
      configPatch,
      hint: `To apply: one --agent sync init ${platform} ${model} --config '${JSON.stringify(configPatch)}'`,
    });
    return;
  }

  console.log(`\n  ${pc.bold('memory.searchable — ranked suggestions')} ${pc.dim(`(${samples.length} samples)`)}`);
  if (suggestions.length === 0) {
    console.log(`    ${pc.yellow('no high-signal leaves found')} — page may be all UUIDs / timestamps / enum markers. Inspect the sample with \`sync test\` and pick paths manually.`);
    return;
  }

  for (const s of suggestions) {
    const hitPct = Math.round(s.hitRate * 100);
    const noisePct = Math.round(s.noiseFraction * 100);
    const noiseBadge = noisePct > 0 ? pc.dim(` noise=${noisePct}%`) : '';
    console.log(
      `    ${pc.green(String(s.score).padStart(5))}  ${pc.cyan(s.path.padEnd(52))}` +
      pc.dim(` ${hitPct}% hit`) + pc.dim(` avg=${s.avgLength}ch`) + noiseBadge +
      (s.sampleValue ? pc.dim(`\n          → "${s.sampleValue.slice(0, 140)}"`) : '')
    );
  }

  console.log(`\n  ${pc.bold('Paste-ready:')}`);
  console.log('    ' + pc.cyan(`one sync init ${platform} ${model} --config '${JSON.stringify(configPatch)}'`));
  console.log(`\n  ${pc.dim('then preview: ')}${pc.cyan(`one sync test ${platform}/${model} --show-searchable`)}`);
}

// ── sync list ──

async function syncListCommand(platform?: string): Promise<void> {
  const profiles = listProfiles(platform);
  const state = await readSyncState();
  const { getBackend } = await import('../runtime.js');
  const backend = await getBackend();

  // Count records from the memory backend — the post-unified-memory
  // source of truth. The sync-state `totalRecords` counter lags when
  // multiple runs race against each other and can't be trusted for
  // display; `dbSize` on the legacy .db file is worse — it can be
  // non-zero even when memory holds the real data. Use COUNT(*) + the
  // on-disk .db size as a "legacy footprint" tell.
  const syncs = await Promise.all(profiles.map(async p => {
    const modelState = state[p.platform]?.[p.model];
    const type = `${p.platform}/${p.model}`;
    const totalRecords = await backend.count(type, { status: 'active' }).catch(() => 0);
    const legacyDbSize = getDatabaseSize(p.platform);
    return {
      platform: p.platform,
      model: p.model,
      lastSync: modelState?.lastSync ?? null,
      totalRecords,
      pagesProcessed: modelState?.pagesProcessed ?? 0,
      // Legacy .db footprint — non-zero means there's a stale file worth
      // running `one mem migrate --cleanup` to remove. Kept distinct
      // from totalRecords so the dashboard doesn't conflate the two.
      legacyDbSize,
      status: modelState?.status ?? 'idle',
    };
  }));

  if (output.isAgentMode()) {
    output.json({ syncs });
    return;
  }

  if (syncs.length === 0) {
    output.note('No sync profiles configured.', 'Sync');
    return;
  }

  for (const s of syncs) {
    const status = s.status === 'idle'
      ? pc.green('idle')
      : s.status === 'syncing'
        ? pc.yellow(`syncing — page ${s.pagesProcessed}`)
        : pc.red('failed');
    const legacy = s.legacyDbSize && s.legacyDbSize !== '0 B'
      ? pc.yellow(`  legacy .db ${s.legacyDbSize}`)
      : '';
    console.log(
      `  ${pc.bold(`${s.platform}/${s.model}`.padEnd(35))} ` +
      `${String(s.totalRecords).padStart(8)} records  ` +
      `${status}  ` +
      `${pc.dim(s.lastSync ? `last: ${s.lastSync}` : 'never synced')}` +
      legacy
    );
  }
}

// ── sync remove ──

async function syncRemoveCommand(platform: string, options: { models?: string; yes?: boolean; dryRun?: boolean }): Promise<void> {
  const modelList = options.models?.split(',').map(m => m.trim());

  // Build a preview of what will be removed so the user sees the blast radius.
  const preview: Array<{ model: string; records: number }> = [];
  const profiles = listProfiles(platform);
  const targetModels = modelList ?? profiles.map(p => p.model);

  try {
    if (targetModels.length > 0) {
      const db = await openDatabase(platform);
      for (const model of targetModels) {
        preview.push({ model, records: tableExists(db, model) ? countRecords(db, model) : 0 });
      }
      db.close();
    }
  } catch {
    // DB may not exist yet — preview will just be empty counts
    for (const model of targetModels) preview.push({ model, records: 0 });
  }

  const totalRecords = preview.reduce((sum, p) => sum + p.records, 0);
  const dbSize = getDatabaseSize(platform);

  // --dry-run: just show the preview and exit
  if (options.dryRun) {
    if (output.isAgentMode()) {
      output.json({ dryRun: true, platform, models: preview, totalRecords, dbSize });
    } else {
      output.note(
        preview.map(p => `  ${p.model.padEnd(30)} ${String(p.records).padStart(8)} records`).join('\n') +
          `\n\n  Total: ${totalRecords} records across ${preview.length} model(s), ${dbSize} on disk`,
        `Would remove from ${platform}`
      );
    }
    return;
  }

  // Confirm unless --yes
  if (!options.yes && !output.isAgentMode()) {
    const target = modelList
      ? `${platform}/${modelList.join(', ')}`
      : `all synced data for ${platform}`;
    const confirmed = await p.confirm({
      message: `Remove ${target}? (${totalRecords} records, ${dbSize} on disk)`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      output.cancel('Cancelled.');
      return;
    }
  }

  try {
    if (modelList) {
      const db = await openDatabase(platform);
      for (const model of modelList) {
        dropTable(db, model);
        await removeModelState(platform, model);
      }
      db.close();
    } else {
      // Remove data for this platform (profiles are preserved)
      deleteDatabase(platform);
      await removeModelState(platform);
    }

    if (output.isAgentMode()) {
      output.json({ status: 'removed', platform, models: modelList ?? 'all' });
    } else {
      output.outro(`Removed sync data for ${platform}${modelList ? `/${modelList.join(', ')}` : ''}`);
    }
  } catch (err) {
    output.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync schedule ──

async function syncScheduleAddCommand(platform: string, options: { every: string; models?: string }): Promise<void> {
  try {
    const { entry, replaced } = addSchedule({
      platform,
      every: options.every,
      models: options.models?.split(',').map(m => m.trim()),
    });

    if (output.isAgentMode()) {
      output.json({ status: replaced ? 'replaced' : 'scheduled', ...entry });
      return;
    }

    const verb = replaced ? 'Replaced existing schedule' : 'Scheduled sync';
    output.outro(
      `${verb} ${pc.bold(entry.id)} — every ${pc.bold(entry.every)} ` +
      `(cron: ${pc.dim(entry.cronExpr)})\nLogs: ${pc.dim(entry.logFile)}`
    );
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
  }
}

async function syncScheduleListCommand(): Promise<void> {
  try {
    const entries = listSchedules();
    if (output.isAgentMode()) {
      output.json({ schedules: entries });
      return;
    }
    if (entries.length === 0) {
      output.note('No scheduled syncs. Add one with: one sync schedule add <platform> --every 1h', 'Schedule');
      return;
    }
    for (const e of entries) {
      const modelsStr = e.models ? ` [${e.models.join(',')}]` : '';
      const installed = e.cronInstalled ? pc.green('●') : pc.red('✗');
      console.log(
        `  ${installed} ${pc.bold(e.id.padEnd(32))} every ${pc.bold(e.every.padEnd(5))} ` +
        `${pc.dim(e.cronExpr.padEnd(13))}${modelsStr}`
      );
      console.log(`      ${pc.dim('cwd:')} ${e.cwd}`);
    }
    console.log(`\n${pc.dim('● = cron line installed  ✗ = registry drift, run `sync schedule repair <id>`')}`);
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
  }
}

async function syncScheduleRemoveCommand(idOrPlatform: string, options: { all?: boolean }): Promise<void> {
  try {
    const result = removeSchedule(idOrPlatform, { allProjects: options.all });
    if (output.isAgentMode()) {
      output.json({
        status: result.notFound ? 'not-found' : 'removed',
        idOrPlatform,
        removed: result.removed.map(r => ({ id: r.id, platform: r.platform, cwd: r.cwd })),
      });
      return;
    }
    if (result.notFound) {
      output.note(
        `No scheduled sync found for "${idOrPlatform}"${options.all ? '' : ' in this directory'}. ` +
        `Run \`one sync schedule list\` to see all schedules, or pass --all to match across projects.`,
        'Schedule'
      );
      return;
    }
    for (const r of result.removed) {
      console.log(`  ${pc.green('✓')} removed ${pc.bold(r.id)} ${pc.dim(`(${r.cwd})`)}`);
    }
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
  }
}

async function syncScheduleStatusCommand(): Promise<void> {
  try {
    const statuses = scheduleStatus();
    if (output.isAgentMode()) {
      output.json({ schedules: statuses });
      return;
    }
    if (statuses.length === 0) {
      output.note('No scheduled syncs.', 'Schedule');
      return;
    }
    for (const s of statuses) {
      const driftMarker =
        s.drift === 'ok'
          ? pc.green('●')
          : s.drift === 'missing-cron'
            ? pc.red('✗ missing cron line')
            : pc.yellow(`⚠ ${s.drift}`);
      console.log(`  ${driftMarker} ${pc.bold(s.entry.id)} — every ${s.entry.every} (${pc.dim(s.entry.cronExpr)})`);
      console.log(`      ${pc.dim('cwd:')} ${s.entry.cwd}`);
      console.log(`      ${pc.dim('last run:')} ${s.lastRunAt ?? pc.yellow('never')}`);
      console.log(`      ${pc.dim('log:')} ${s.entry.logFile} ${s.logExists ? pc.dim(`(${s.logSize} bytes)`) : pc.yellow('(empty)')}`);
      if (s.logTail.length > 0) {
        console.log(pc.dim('      last lines:'));
        for (const line of s.logTail.slice(-3)) {
          console.log(pc.dim(`        ${line}`));
        }
      }
    }
    if (statuses.some(s => s.drift !== 'ok')) {
      console.log(`\n${pc.yellow('Drift detected.')} Run ${pc.bold('one sync schedule repair <id>')} to heal.`);
    }
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
  }
}

async function syncScheduleRepairCommand(id: string): Promise<void> {
  try {
    const healed = repairSchedule(id);
    if (output.isAgentMode()) {
      output.json({ status: 'repaired', ...healed });
      return;
    }
    output.outro(`Repaired ${pc.bold(healed.id)}: re-installed cron line with current node/cli paths.`);
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
  }
}

// ── Register all sync commands ──

/**
 * Register the full `sync` subtree against a parent command.
 *
 * Called twice:
 *  1. `program` → exposes the commands as `one sync ...` with the `s` alias.
 *  2. `one mem` → exposes the same commands as `one mem sync ...`. Single
 *     source of truth, no drift between the two surfaces.
 *
 * `opts.parentLabel` controls the alias + description wording so each
 * registration can present itself in its own context without forking
 * the entire tree.
 */
export function registerSyncCommands(
  program: Command,
  opts: { alias?: string; description?: string } = {},
): void {
  const sync = program
    .command('sync')
    .description(opts.description ?? 'Sync platform data locally for instant offline queries');
  if (opts.alias) sync.alias(opts.alias);
  registerSyncSubcommands(sync);
}

function registerSyncSubcommands(sync: Command): void {

  sync
    .command('install')
    .description('Install the local sync engine (better-sqlite3 native module)')
    .action(async () => {
      await syncInstallCommand();
    });

  sync
    .command('doctor')
    .description('Verify the local sync engine is installed and working')
    .action(async () => {
      await syncDoctorCommand();
    });

  sync
    .command('profiles [platform]')
    .description('List built-in sync profiles (pre-validated configs for common platforms)')
    .action(async (platform?: string) => {
      await syncProfilesCommand(platform);
    });

  sync
    .command('models <platform>')
    .description('Discover available data models for a platform')
    .action(async (platform: string) => {
      await syncModelsCommand(platform);
    });

  sync
    .command('init <platform> <model>')
    .description('Create or update a sync profile for a model')
    .option('--config <json>', 'Sync profile configuration as JSON')
    .action(async (platform: string, model: string, options: { config?: string }) => {
      await syncInitCommand(platform, model, options);
    });

  sync
    .command('test <platform/model>')
    .description('Validate a sync profile with a single-page fetch (no DB writes)')
    .option('--show-searchable', 'Also preview the text that would be embedded / FTS-indexed, per memory.searchable', false)
    .action(async (platformModel: string, options: { showSearchable?: boolean }) => {
      await syncTestCommand(platformModel, { showSearchable: options.showSearchable });
    });

  sync
    .command('suggest-searchable <platform/model>')
    .description('Rank candidate memory.searchable paths by signal density (for profiles with memory.embed: true)')
    .option('--limit <n>', 'Top N paths to return (default 15)')
    .action(async (platformModel: string, options: { limit?: string }) => {
      await syncSuggestSearchableCommand(platformModel, options);
    });

  sync
    .command('run <platform>')
    .description('Run sync for a platform (syncs all configured models, or specify --models)')
    .option('--models <models>', 'Comma-separated list of models to sync')
    .option('--since <duration>', 'Sync records since duration (e.g. 90d, 30d, 7d) or date')
    .option('--force', 'Ignore existing sync state and start fresh')
    .option('--max-pages <n>', 'Maximum number of pages to fetch')
    .option('--dry-run', 'Fetch first page only, show results without persisting')
    .option('--full-refresh', 'Fetch ALL records and delete local rows no longer in the source (handles deletions)')
    .option('--no-memory', 'Skip the unified memory dual-write (default: memory is always written)')
    .option('--embed', 'Embed synced rows under the configured model, regardless of profile.memory.embed', false)
    .option('--no-embed', 'Skip embedding even if the profile opts in')
    // Back-compat alias: `--to-memory` was opt-in during the dual-write
    // derisking window. Memory is now the primary target, so the flag is
    // a silent no-op retained so existing scripts keep running.
    .option('--to-memory', '(deprecated — memory is now always written; flag kept for back-compat)')
    .action(async (platform: string, options: { models?: string; since?: string; force?: boolean; maxPages?: string; dryRun?: boolean; fullRefresh?: boolean; memory?: boolean; embed?: boolean; toMemory?: boolean }) => {
      await syncRunCommand(platform, {
        models: options.models?.split(',').map(m => m.trim()),
        since: options.since,
        force: options.force,
        maxPages: options.maxPages ? parseInt(options.maxPages, 10) : undefined,
        dryRun: options.dryRun,
        fullRefresh: options.fullRefresh,
        // Commander inverts `--no-memory` / `--no-embed` into options.X === false.
        toMemory: options.memory !== false,
        // Only override when the flag was actually passed — leaving
        // options.embed as undefined means "defer to profile + config".
        // Commander sets `false` for the `--no-embed` case.
        embed: options.embed === undefined ? undefined : options.embed,
      });
    });

  sync
    .command('query <platform/model>')
    .description('Query local synced data (e.g. one sync query shopify/orders --where "status=unfulfilled")')
    .option('--where <conditions>', 'Filter conditions (e.g. "status=active,plan=pro")')
    .option('--after <date>', 'Records after this date')
    .option('--before <date>', 'Records before this date')
    .option('--limit <n>', 'Max results (default: 50)')
    .option('--order-by <field>', 'Sort by field')
    .option('--order <dir>', 'Sort direction: asc or desc')
    .option('--refresh', 'Trigger incremental sync before querying')
    .option('--refresh-force', 'Trigger full re-sync before querying (implies --refresh)')
    .option('--date-field <field>', 'Specify date column for --after/--before')
    .action(async (platformModel: string, options: any) => {
      await syncQueryCommand(platformModel, {
        where: options.where,
        after: options.after,
        before: options.before,
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        orderBy: options.orderBy,
        order: options.order,
        refresh: options.refresh || options.refreshForce,
        refreshForce: options.refreshForce,
        dateField: options.dateField,
      });
    });

  sync
    .command('search <query>')
    .description('Full-text search across all synced data (or filter by --platform / --models)')
    .option('--platform <platform>', 'Search only this platform (default: all)')
    .option('--models <models>', 'Comma-separated list of models to search')
    .option('--limit <n>', 'Max results (default: 20)')
    .action(async (query: string, options: { platform?: string; models?: string; limit?: string }) => {
      await syncSearchCommand(query, options);
    });

  sync
    .command('sql <platform/model> <sql>')
    .description('Run a read-only SELECT / WITH / EXPLAIN against the memory store (type-scoped helper)')
    .action(async (platformModel: string, sql: string) => {
      await syncSqlCommand(platformModel, sql);
    });

  sync
    .command('delete <platform/model>')
    .description('Delete records from local sync data (e.g. one sync delete notion/pages --id "abc-123")')
    .option('--id <value>', 'Delete record by ID')
    .option('--where <conditions>', 'Delete records matching conditions (e.g. "status=archived")')
    .option('--where-sql <predicate>', 'Delete using a raw SQL WHERE clause (e.g. "json_extract(data, \'$.type\') = \'promotion\'")')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (platformModel: string, options: { id?: string; where?: string; whereSql?: string; yes?: boolean }) => {
      await syncDeleteCommand(platformModel, options);
    });

  sync
    .command('list [platform]')
    .alias('ls')
    .description('List all configured sync profiles and their status')
    .action(async (platform?: string) => {
      await syncListCommand(platform);
    });

  const schedule = sync
    .command('schedule')
    .description('Manage scheduled syncs (runs via system cron on macOS/Linux)');

  schedule
    .command('add <platform>')
    .description('Schedule a sync to run on an interval (e.g. --every 1h)')
    .requiredOption('--every <duration>', 'Interval: <n>m (divides 60), <n>h (divides 24), or 1d')
    .option('--models <models>', 'Only sync these models (comma-separated)')
    .action(async (platform: string, options: { every: string; models?: string }) => {
      await syncScheduleAddCommand(platform, options);
    });

  schedule
    .command('list')
    .alias('ls')
    .description('List all scheduled syncs')
    .action(async () => {
      await syncScheduleListCommand();
    });

  schedule
    .command('remove <id-or-platform>')
    .alias('rm')
    .description('Remove a scheduled sync by id, or by platform (defaults to current directory)')
    .option('--all', 'When matching by platform, remove across all projects')
    .action(async (idOrPlatform: string, options: { all?: boolean }) => {
      await syncScheduleRemoveCommand(idOrPlatform, options);
    });

  schedule
    .command('status')
    .description('Show scheduled syncs with last-run time, log tail, and drift detection')
    .action(async () => {
      await syncScheduleStatusCommand();
    });

  schedule
    .command('repair <id>')
    .description('Re-install a schedule whose cron line is missing or broken (drift)')
    .action(async (id: string) => {
      await syncScheduleRepairCommand(id);
    });

  sync
    .command('remove <platform>')
    .description('Remove sync data and profiles for a platform')
    .option('--models <models>', 'Specific models to remove (comma-separated)')
    .option('--dry-run', 'Show what would be removed without deleting')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (platform: string, options: { models?: string; yes?: boolean; dryRun?: boolean }) => {
      await syncRemoveCommand(platform, options);
    });
}
