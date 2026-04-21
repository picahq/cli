import type { Command } from 'commander';
import * as output from '../output.js';
import { OneApi } from '../api.js';
import { getApiKey, getAccessControlFromAllSources } from '../config.js';
import { discoverModels } from './models.js';
import { readProfile, writeProfile, writeDraftProfile, listProfiles, generateTemplate } from './profile.js';
import { syncModel } from './runner.js';
import { testSyncProfile } from './test.js';
import { inferProfileFromKnowledge } from './infer.js';
import { loadBuiltinProfile, listBuiltinProfiles } from './builtin-profiles.js';
import { addSchedule, listSchedules, removeSchedule, scheduleStatus, repairSchedule } from './schedule.js';
import { parseCondition, splitConditions } from './where-parser.js';
import { readSyncState, removeModelState, getModelState } from './state.js';
import { executeQuery, executeRawSql } from './query.js';
import { searchSyncedData } from './search.js';
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
  return new OneApi(apiKey);
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

  const existing = readProfile(platform, model);
  const profile: SyncProfile = {
    ...(existing ?? ({} as SyncProfile)),
    ...patch,
    // Ensure platform/model from args always win
    platform,
    model,
    // Deep-merge pagination so you can patch just nextPath without losing type
    pagination: {
      ...(existing?.pagination ?? ({} as SyncProfile['pagination'])),
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

async function syncTestCommand(platformModel: string): Promise<void> {
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

  if (output.isAgentMode()) {
    output.json(report);
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

  console.log(
    `\n${report.ok ? pc.green('Profile looks good.') : pc.red('Profile has issues.')} ` +
    (report.ok
      ? `Run: ${pc.bold(`one sync run ${platform} --models ${model}`)}`
      : 'Fix the issues above and test again.')
  );
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

  const results = [];
  for (const profile of toSync) {
    try {
      const result = await syncModel(api, profile, options);
      results.push(result);
    } catch (err) {
      // Use real counts attached by the runner (if available) instead of 0
      const errObj = err as any;
      results.push({
        model: profile.model,
        recordsSynced: errObj?._recordsSynced ?? 0,
        pagesProcessed: errObj?._pagesProcessed ?? 0,
        duration: '0s',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
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
    if ('error' in r && r.error) {
      console.log(`    ${pc.red(r.error as string)}`);
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

async function syncSqlCommand(platform: string, sql: string): Promise<void> {
  try {
    const result = await executeRawSql(platform, sql);
    if (output.isAgentMode()) {
      output.json({ platform, ...result, total: result.results.length });
      return;
    }

    console.log(JSON.stringify(result.results, null, 2));
    console.log(`\n${result.results.length} rows`);
  } catch (err) {
    output.error(`SQL error: ${err instanceof Error ? err.message : String(err)}`);
  }
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

// ── sync list ──

async function syncListCommand(platform?: string): Promise<void> {
  const profiles = listProfiles(platform);
  const state = readSyncState();

  const syncs = profiles.map(p => {
    const modelState = state[p.platform]?.[p.model];
    return {
      platform: p.platform,
      model: p.model,
      lastSync: modelState?.lastSync ?? null,
      totalRecords: modelState?.totalRecords ?? 0,
      pagesProcessed: modelState?.pagesProcessed ?? 0,
      dbSize: getDatabaseSize(p.platform),
      status: modelState?.status ?? 'idle',
    };
  });

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
    console.log(
      `  ${pc.bold(`${s.platform}/${s.model}`.padEnd(35))} ` +
      `${String(s.totalRecords).padStart(8)} records  ` +
      `${s.dbSize.padStart(10)}  ` +
      `${status}  ` +
      `${pc.dim(s.lastSync ? `last: ${s.lastSync}` : 'never synced')}`
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
        removeModelState(platform, model);
      }
      db.close();
    } else {
      // Remove data for this platform (profiles are preserved)
      deleteDatabase(platform);
      removeModelState(platform);
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

export function registerSyncCommands(program: Command): void {
  const sync = program
    .command('sync')
    .alias('s')
    .description('Sync platform data locally for instant offline queries');

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
    .action(async (platformModel: string) => {
      await syncTestCommand(platformModel);
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
    .action(async (platform: string, options: { models?: string; since?: string; force?: boolean; maxPages?: string; dryRun?: boolean; fullRefresh?: boolean }) => {
      await syncRunCommand(platform, {
        models: options.models?.split(',').map(m => m.trim()),
        since: options.since,
        force: options.force,
        maxPages: options.maxPages ? parseInt(options.maxPages, 10) : undefined,
        dryRun: options.dryRun,
        fullRefresh: options.fullRefresh,
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
    .command('sql <platform> <sql>')
    .description('Execute raw SQL against local sync database (SELECT only)')
    .action(async (platform: string, sql: string) => {
      await syncSqlCommand(platform, sql);
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
