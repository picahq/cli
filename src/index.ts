#!/usr/bin/env node

import { createRequire } from 'module';
import path from 'node:path';
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';
import {
  resolveConfig,
  getGlobalConfigPath,
  getProjectConfigPath,
  globalConfigExists,
  projectConfigExists,
  getApiKey,
  getApiBase,
  getWhoAmI,
  updateWhoAmI,
  getEnvFromApiKey,
} from './lib/config.js';
import { connectionAddCommand, connectionListCommand, connectionDeleteCommand } from './commands/connection.js';
import { OneApi } from './lib/api.js';
import { platformsCommand } from './commands/platforms.js';
import { actionsSearchCommand, actionsKnowledgeCommand, actionsExecuteCommand, actionsExecuteParallelCommand } from './commands/actions.js';
import {
  flowCreateCommand,
  flowExecuteCommand,
  flowListCommand,
  flowValidateCommand,
  flowResumeCommand,
  flowRunsCommand,
  flowScaffoldCommand,
  collect,
} from './commands/flow.js';
import {
  relayCreateCommand,
  relayListCommand,
  relayGetCommand,
  relayUpdateCommand,
  relayDeleteCommand,
  relayActivateCommand,
  relayEventsCommand,
  relayEventGetCommand,
  relayDeliveriesCommand,
  relayEventTypesCommand,
} from './commands/relay.js';

import { registerSyncCommands } from './lib/sync/index.js';
import { cacheClearCommand, cacheListCommand, cacheUpdateAllCommand } from './commands/cache.js';
import { guideCommand } from './commands/guide.js';
import { onboardCommand } from './commands/onboard.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { updateCommand, checkLatestVersionCached, getCurrentVersion, isNewerVersion, autoUpdate } from './commands/update.js';
import { setAgentMode, isAgentMode, json as outputJson, error as outputError } from './lib/output.js';
import { syncSkillsIfStale, forceSyncSkills, getSkillStatus } from './lib/skill-sync.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('one')
  .option('--agent', 'Machine-readable JSON output (no colors, spinners, or prompts)')
  .description(`One CLI — Connect AI agents to 250+ platforms through one interface.

  Setup:
    one login                             Authenticate via browser (opens app.withone.ai)
    one logout                            Clear local credentials
    one init                              Set up API key and install MCP server
    one add <platform>                    Connect a platform via OAuth (e.g. gmail, slack, shopify)
    one connection delete <key>           Remove a connection (alias: one connection rm)
    one config                            Configure access control (permissions, scoping)
    one whoami                            Show current user, organization, and project

  Workflow (use these in order):
    1. one list                           List your connected platforms and connection keys
    2. one actions search <platform> <q>  Search for actions using natural language
    3. one actions knowledge <plat> <id>  Get full docs for an action (ALWAYS do this before execute)
    4. one actions execute <p> <id> <key> Execute the action

  Guide:
    one guide [topic]                     Full CLI guide (topics: overview, actions, workflows, all)

  Workflows (multi-step):
    one flow list                         List saved workflows
    one flow create [key]                 Create a workflow from JSON (key can be group/key)
    one flow execute <key>                Execute a workflow (key can be group/key)
    one flow validate <key>               Validate a flow

  Data Sync (run "one sync install" first, then "one guide sync" for full reference):
    one sync models <platform>            Discover available data models
    one sync init <plat> <model>          Create profile (auto-infers from knowledge)
    one sync test <plat>/<model>          Validate + auto-fix profile fields
    one sync run <platform>               Sync data (--full-refresh for deletions)
    one sync query <plat>/<model>         Query local data (--where, --refresh)
    one sync search "<query>"             Full-text search across all synced data
    one sync schedule add <plat> --every  Cron schedule (e.g. 1h) with change hooks

  Cache:
    one cache list                        List cached entries with age and status
    one cache clear                       Clear all cached knowledge and search data
    one cache update-all                  Re-fetch fresh data for all cached entries

  Webhook Relay:
    one relay create                      Create a relay endpoint for a connection
    one relay list                        List relay endpoints
    one relay activate <id>               Activate with passthrough actions
    one relay event-types <platform>      List supported event types
    one relay events                      List received webhook events
    one relay deliveries                  List delivery attempts

  Example — send an email through Gmail:
    $ one list
    # Find: gmail  operational  live::gmail::default::abc123

    $ one actions search gmail "send email" -t execute
    # Find: POST  Send Email  conn_mod_def::xxx::yyy

    $ one actions knowledge gmail conn_mod_def::xxx::yyy
    # Read the docs: required fields are to, subject, body, connectionKey

    $ one actions execute gmail conn_mod_def::xxx::yyy live::gmail::default::abc123 \\
        -d '{"to":"j@example.com","subject":"Hello","body":"Hi!","connectionKey":"live::gmail::default::abc123"}'

  Platform names are always kebab-case (e.g. hub-spot, ship-station, google-calendar).
  Run 'one platforms' to browse all 250+ available platforms.`)
  .version(version);

// Fire a non-blocking version check alongside every command
let updateCheckPromise: Promise<{ version: string; publishedAt: string | null } | null> | undefined;

program.hook('preAction', (thisCommand) => {
  const opts = program.opts();
  if (opts.agent) {
    setAgentMode(true);
  }
  // Start the fetch early so it resolves by the time the command finishes
  const commandName = thisCommand.args?.[0];
  if (commandName !== 'update') {
    updateCheckPromise = checkLatestVersionCached();
  }
  // Keep the installed skill files in lockstep with the CLI version. Cheap
  // no-op when the marker matches current version; copies packaged skills
  // into the canonical install dir when they drift. See lib/skill-sync.ts.
  if (commandName !== 'init' && commandName !== 'update') {
    try { syncSkillsIfStale(); } catch { /* best-effort, never block a command */ }
  }
});

program.hook('postAction', async () => {
  if (!updateCheckPromise) return;
  const info = await updateCheckPromise;
  if (!info) return;
  const current = getCurrentVersion();
  if (!isNewerVersion(info.version, current)) return;
  // Auto-update silently in the background
  autoUpdate(info.version, info.publishedAt);
});

program
  .command('init')
  .description('Set up One and install MCP to your AI agents (interactive: picks global or project scope)')
  .option('-y, --yes', 'Skip confirmations')
  .option('-g, --global', 'Write the One config globally (~/.one/config.json) — skips the scope picker')
  .option('-p, --project', 'Write the One config for this project only (~/.one/projects/<slug>/) — skips the scope picker')
  .action(async (options) => {
    await initCommand(options);
  });

program
  .command('login')
  .description('Authenticate with One via browser')
  .action(async () => {
    await loginCommand();
  });

program
  .command('logout')
  .description('Clear local credentials')
  .action(async () => {
    await logoutCommand();
  });

const config = program
  .command('config')
  .description('Configure the CLI (access control, skills, ...)')
  .action(async () => {
    // Default action: interactive access-control editor (unchanged behavior).
    await configCommand();
  });

config
  .command('path')
  .description('Show the active config path, scope, and the fallback chain (project → global)')
  .action(() => {
    const resolved = resolveConfig();
    const globalPath = getGlobalConfigPath();
    const projectPath = getProjectConfigPath(resolved.projectRoot);
    const hasGlobal = globalConfigExists();
    const hasProject = projectConfigExists(resolved.projectRoot);

    if (isAgentMode()) {
      outputJson({
        command: 'config path',
        scope: resolved.scope,
        path: resolved.path,
        projectRoot: resolved.projectRoot,
        projectSlug: resolved.projectSlug,
        fallback: {
          project: { path: projectPath, exists: hasProject },
          global:  { path: globalPath,  exists: hasGlobal  },
        },
      });
      return;
    }

    if (!resolved.scope) {
      console.log('No One config found.');
      console.log(`  project: ${projectPath} (not set up)`);
      console.log(`  global:  ${globalPath} (not set up)`);
      console.log("\nRun 'one init' to get started.");
      return;
    }

    console.log(`Active:   ${resolved.scope}`);
    console.log(`Path:     ${resolved.path}`);
    console.log(`\nResolution order (first match wins):`);
    console.log(`  1. project  ${projectPath}  ${hasProject ? '✓' : '—'}`);
    console.log(`  2. global   ${globalPath}   ${hasGlobal  ? '✓' : '—'}`);
  });

const configSkills = config
  .command('skills')
  .description('Manage locally-installed skill files');

configSkills
  .command('sync')
  .description('Re-copy packaged skill files over the local install (runs automatically after CLI upgrades)')
  .action(async () => {
    const result = forceSyncSkills();
    if (isAgentMode()) {
      outputJson({ command: 'config skills sync', ...result });
      return;
    }
    if (result.reason === 'not-installed') {
      console.log("No skill is installed yet. Run 'one init' first and opt in to skill installation.");
      return;
    }
    if (result.synced) {
      console.log(`✓ Skills synced to v${result.to}`);
      return;
    }
    if (result.reason === 'source-missing') {
      console.log('✗ Packaged skill source not found in this CLI build');
      return;
    }
    console.log(`✗ Sync failed${result.error ? ': ' + result.error : ''}`);
  });

configSkills
  .command('status')
  .description('Show installed skill version and whether it matches the current CLI')
  .action(async () => {
    const status = getSkillStatus();
    if (isAgentMode()) {
      outputJson({ command: 'config skills status', ...status });
      return;
    }
    if (!status.installed) {
      console.log("Skill is not installed. Run 'one init' to install it.");
      console.log(`Canonical path (empty): ${status.canonicalPath}`);
      return;
    }
    const marker = status.installedVersion ?? '(no marker — pre-sync install)';
    const state = status.upToDate ? '✓ up to date' : '⚠ stale — will sync on next command';
    console.log(`Skill: ${state}`);
    console.log(`  installed: ${marker}`);
    console.log(`  current:   ${status.currentVersion}`);
    console.log(`  path:      ${status.canonicalPath}`);
  });

config
  .command('reset')
  .description('Remove the project config for the current directory (falls back to global)')
  .option('--global', 'Remove the global config instead')
  .action(async (opts: { global?: boolean }) => {
    const resolved = resolveConfig();

    if (opts.global) {
      const globalPath = getGlobalConfigPath();
      if (!globalConfigExists()) {
        if (isAgentMode()) {
          outputJson({ deleted: false, reason: 'No global config found' });
        } else {
          console.log('No global config found.');
        }
        return;
      }
      if (!isAgentMode()) {
        const p = await import('@clack/prompts');
        const confirmed = await p.confirm({
          message: 'Delete the global config? This removes your API key for all projects without a project config.',
          initialValue: false,
        });
        if (p.isCancel(confirmed) || !confirmed) {
          console.log('Cancelled.');
          return;
        }
      }
      const fs = await import('node:fs');
      fs.unlinkSync(globalPath);
      if (isAgentMode()) {
        outputJson({ deleted: true, scope: 'global' });
      } else {
        console.log('Global config removed.');
      }
      return;
    }

    // Project reset
    if (resolved.scope !== 'project') {
      if (isAgentMode()) {
        outputJson({ deleted: false, reason: 'No project config found for this directory' });
      } else {
        console.log('No project config found for this directory.');
        console.log(`Currently using: ${resolved.scope ?? 'none'}`);
      }
      return;
    }

    // Determine what config will be used after deletion
    const fs = await import('node:fs');
    // Temporarily remove the file to check what resolves next
    const configContent = fs.readFileSync(resolved.path, 'utf-8');
    fs.unlinkSync(resolved.path);
    const next = resolveConfig();
    // Restore it before confirming
    fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
    fs.writeFileSync(resolved.path, configContent);

    let fallbackLabel: string;
    if (next.scope === 'project') {
      fallbackLabel = `parent project config (${path.basename(next.projectRoot)})`;
    } else if (next.scope === 'global') {
      fallbackLabel = 'global config';
    } else {
      fallbackLabel = 'no config';
    }

    if (!isAgentMode()) {
      const p = await import('@clack/prompts');
      const confirmed = await p.confirm({
        message: `Delete project config for ${path.basename(resolved.projectRoot)}? Will fall back to ${fallbackLabel}.`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    fs.unlinkSync(resolved.path);
    try { fs.rmdirSync(path.dirname(resolved.path)); } catch { /* not empty, fine */ }

    if (isAgentMode()) {
      outputJson({ deleted: true, scope: 'project', projectRoot: resolved.projectRoot, fallback: next.scope });
    } else {
      console.log(`Project config removed. Now using ${fallbackLabel}.`);
    }
  });

const connection = program
  .command('connection')
  .description('Manage connections');

connection
  .command('add [platform]')
  .alias('a')
  .description('Add a new connection')
  .action(async (platform) => {
    await connectionAddCommand(platform);
  });

connection
  .command('list')
  .alias('ls')
  .description('List your connections')
  .option('-s, --search <query>', 'Filter connections by platform name')
  .option('-l, --limit <n>', 'Max connections to return (agent mode default: 20)')
  .action(async (options) => {
    await connectionListCommand(options);
  });

connection
  .command('delete <connection-key>')
  .alias('rm')
  .description('Delete a connection')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (connectionKey: string, options: { force?: boolean }) => {
    await connectionDeleteCommand(connectionKey, options);
  });

program
  .command('platforms')
  .alias('p')
  .description('List available platforms')
  .option('-c, --category <category>', 'Filter by category')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await platformsCommand(options);
  });

const actions = program
  .command('actions')
  .alias('a')
  .description('Search, explore, and execute platform actions (workflow: search → knowledge → execute)');

actions
  .command('search <platform> <query>')
  .description('Search for actions on a platform (e.g. one actions search gmail "send email")')
  .option('-t, --type <type>', 'execute (to run it) or knowledge (to learn about it). Default: knowledge')
  .option('--no-cache', 'Skip cache, fetch fresh from API')
  .action(async (platform: string, query: string, options: { type?: string; cache?: boolean }) => {
    await actionsSearchCommand(platform, query, options);
  });

actions
  .command('knowledge <platform> <actionId>')
  .alias('k')
  .description('Get full docs for an action — MUST call before execute to know required params')
  .option('--no-cache', 'Skip cache, fetch fresh from API')
  .option('--cache-status', 'Print cache metadata without fetching')
  .action(async (platform: string, actionId: string, options: { cache?: boolean; cacheStatus?: boolean }) => {
    await actionsKnowledgeCommand(platform, actionId, options);
  });

actions
  .command('execute [platform] [actionId] [connectionKey]')
  .alias('x')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .description('Execute an action (or multiple with --parallel, separated by --)')
  .option('-d, --data <json>', 'Request body as JSON')
  .option('--path-vars <json>', 'Path variables as JSON')
  .option('--query-params <json>', 'Query parameters as JSON')
  .option('--headers <json>', 'Additional headers as JSON')
  .option('--form-data', 'Send as multipart/form-data')
  .option('--form-url-encoded', 'Send as application/x-www-form-urlencoded')
  .option('--dry-run', 'Show request that would be sent without executing')
  .option('--mock', 'Return example response without making an API call')
  .option('--skip-validation', 'Skip input validation against the action schema')
  .option('--output <path>', 'Save binary response to a file (for non-JSON responses like file downloads)')
  .option('--parallel', 'Execute multiple actions concurrently (separate actions with --)')
  .option('--max-concurrency <n>', 'Max concurrent actions when using --parallel (default: 5)', '5')
  .action(async (platform: string | undefined, actionId: string | undefined, connectionKey: string | undefined, options: any) => {
    if (options.parallel) {
      await actionsExecuteParallelCommand();
      return;
    }
    if (!platform || !actionId || !connectionKey) {
      outputError('Usage: one actions execute <platform> <actionId> <connectionKey> [-d ...]');
    }
    await actionsExecuteCommand(platform!, actionId!, connectionKey!, {
      data: options.data,
      pathVars: options.pathVars,
      queryParams: options.queryParams,
      headers: options.headers,
      formData: options.formData,
      formUrlEncoded: options.formUrlEncoded,
      dryRun: options.dryRun,
      mock: options.mock,
      skipValidation: options.skipValidation,
      output: options.output,
    });
  });

// Flow commands
const flow = program
  .command('flow')
  .alias('f')
  .description('Create, execute, and manage multi-step workflows');

flow
  .command('create [key]')
  .description('Create a new workflow from JSON definition')
  .option('--definition <json>', 'Workflow definition as JSON string')
  .option('-o, --output <path>', 'Custom output path (default .one/flows/<key>/flow.json)')
  .action(async (key: string | undefined, options: { definition?: string; output?: string }) => {
    await flowCreateCommand(key, options);
  });

flow
  .command('execute <keyOrPath>')
  .alias('x')
  .description('Execute a workflow by key or file path')
  .option('-i, --input <name=value>', 'Input parameter (repeatable)', collect, [])
  .option('--dry-run', 'Validate and show execution plan without running')
  .option('--mock', 'With --dry-run: execute transforms/code with realistic mock API responses')
  .option('--skip-validation', 'Skip input validation against action schemas')
  .option('--allow-bash', 'Allow bash step execution (disabled by default for security)')
  .option('-v, --verbose', 'Show full request/response for each step')
  .action(async (keyOrPath: string, options: { input?: string[]; dryRun?: boolean; verbose?: boolean; mock?: boolean; allowBash?: boolean; skipValidation?: boolean }) => {
    await flowExecuteCommand(keyOrPath, options);
  });

flow
  .command('list')
  .alias('ls')
  .description('List all workflows in .one/flows/')
  .action(async () => {
    await flowListCommand();
  });

flow
  .command('validate <keyOrPath>')
  .description('Validate a workflow JSON file')
  .action(async (keyOrPath: string) => {
    await flowValidateCommand(keyOrPath);
  });

flow
  .command('resume <runId>')
  .description('Resume a paused or failed workflow run')
  .action(async (runId: string) => {
    await flowResumeCommand(runId);
  });

flow
  .command('runs [flowKey]')
  .description('List workflow runs (optionally filtered by flow key)')
  .action(async (flowKey?: string) => {
    await flowRunsCommand(flowKey);
  });

flow
  .command('scaffold [template]')
  .description('Generate a workflow scaffold (templates: basic, conditional, loop, ai)')
  .action(async (template?: string) => {
    await flowScaffoldCommand(template);
  });

// ── Relay Commands ──

const relay = program
  .command('relay')
  .alias('r')
  .description('Receive webhooks from platforms and relay them via passthrough actions');

relay
  .command('create')
  .description('Create a new relay endpoint for a connection')
  .requiredOption('--connection-key <key>', 'Connection key for the source platform')
  .option('--description <desc>', 'Description of the relay endpoint')
  .option('--event-filters <json>', 'JSON array of event types to filter (e.g. \'["customer.created"]\')')
  .option('--tags <json>', 'JSON array of tags')
  .option('--create-webhook', 'Automatically register the webhook with the source platform')
  .action(async (options: { connectionKey: string; description?: string; eventFilters?: string; tags?: string; createWebhook?: boolean }) => {
    await relayCreateCommand(options);
  });

relay
  .command('list')
  .alias('ls')
  .description('List all relay endpoints')
  .option('--limit <n>', 'Max results per page')
  .option('--page <n>', 'Page number')
  .action(async (options: { limit?: string; page?: string }) => {
    await relayListCommand(options);
  });

relay
  .command('get <id>')
  .description('Get details of a relay endpoint')
  .action(async (id: string) => {
    await relayGetCommand(id);
  });

relay
  .command('update <id>')
  .description('Update a relay endpoint')
  .option('--description <desc>', 'Update description')
  .option('--active', 'Set active')
  .option('--no-active', 'Set inactive')
  .option('--event-filters <json>', 'JSON array of event types')
  .option('--tags <json>', 'JSON array of tags')
  .option('--actions <json>', 'JSON array of actions (url, passthrough, or agent)')
  .action(async (id: string, options: { description?: string; active?: boolean; eventFilters?: string; tags?: string; actions?: string }) => {
    await relayUpdateCommand(id, options);
  });

relay
  .command('delete <id>')
  .description('Delete a relay endpoint')
  .action(async (id: string) => {
    await relayDeleteCommand(id);
  });

relay
  .command('activate <id>')
  .description('Activate a relay endpoint with forwarding actions')
  .requiredOption('--actions <json>', 'JSON array of actions (url, passthrough, or agent)')
  .option('--webhook-secret <secret>', 'Webhook signing secret for signature verification')
  .action(async (id: string, options: { actions: string; webhookSecret?: string }) => {
    await relayActivateCommand(id, options);
  });

relay
  .command('events')
  .description('List received webhook events')
  .option('--limit <n>', 'Max results per page')
  .option('--page <n>', 'Page number')
  .option('--platform <platform>', 'Filter by platform')
  .option('--event-type <type>', 'Filter by event type')
  .option('--after <iso>', 'Events after this timestamp')
  .option('--before <iso>', 'Events before this timestamp')
  .action(async (options: { limit?: string; page?: string; platform?: string; eventType?: string; after?: string; before?: string }) => {
    await relayEventsCommand(options);
  });

relay
  .command('event <id>')
  .description('Get details of a specific webhook event')
  .action(async (id: string) => {
    await relayEventGetCommand(id);
  });

relay
  .command('deliveries')
  .description('List delivery attempts for an endpoint or event')
  .option('--endpoint-id <id>', 'Relay endpoint ID')
  .option('--event-id <id>', 'Relay event ID')
  .action(async (options: { endpointId?: string; eventId?: string }) => {
    await relayDeliveriesCommand(options);
  });

relay
  .command('event-types <platform>')
  .description('List supported webhook event types for a platform')
  .action(async (platform: string) => {
    await relayEventTypesCommand(platform);
  });


// ── Sync Commands ──

registerSyncCommands(program);

// ── Cache Commands ──

const cache = program
  .command('cache')
  .description('Manage the local knowledge and search cache');

cache
  .command('clear [actionId]')
  .description('Clear all cached data, or a specific action by ID')
  .action(async (actionId?: string) => {
    await cacheClearCommand(actionId);
  });

cache
  .command('list')
  .alias('ls')
  .description('List all cached entries with age and status')
  .option('--expired', 'Show only expired entries')
  .action(async (options: { expired?: boolean }) => {
    await cacheListCommand(options);
  });

cache
  .command('update-all')
  .description('Re-fetch fresh data for all cached entries')
  .action(async () => {
    await cacheUpdateAllCommand();
  });

program
  .command('guide [topic]')
  .description('Full CLI usage guide for agents (topics: overview, actions, flows, relay, cache, sync, all)')
  .action(async (topic?: string) => {
    await guideCommand(topic);
  });

program
  .command('onboard')
  .description('Agent onboarding — teaches your agent what the One CLI can do')
  .option('--step <number>', 'Run a specific onboarding step (1, 2, or 3)')
  .action(async (options: { step?: string }) => {
    await onboardCommand(options.step ? parseInt(options.step, 10) : undefined);
  });

program
  .command('update')
  .description('Update the One CLI to the latest version')
  .action(async () => {
    await updateCommand();
  });

program
  .command('whoami')
  .description('Show the user, organization, and project for the current API key')
  .action(async () => {
    const apiKey = getApiKey();
    if (!apiKey) {
      outputError('Not configured. Run `one init` first.');
      return;
    }

    const api = new OneApi(apiKey, getApiBase());

    let whoami;
    try {
      whoami = await api.whoami();
      updateWhoAmI(whoami);
    } catch (error) {
      outputError(`Failed to fetch account info: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return;
    }

    const env = getEnvFromApiKey(apiKey);
    const resolved = resolveConfig();
    const configScope = resolved.scope ?? 'global';
    const apiBase = getApiBase();

    if (isAgentMode()) {
      outputJson({
        user: whoami.user,
        organization: whoami.organization,
        project: whoami.project,
        env,
        configScope,
        apiBase,
      });
      return;
    }

    const pc = (await import('picocolors')).default;
    const contextParts: string[] = [];
    if (whoami.organization) contextParts.push(whoami.organization.name);
    if (whoami.project) contextParts.push(whoami.project.name);
    const scopeDisplay = contextParts.length > 0 ? contextParts.join(' / ') : 'Personal';
    const envLabel = env === 'test' ? pc.yellow('test') : pc.green('live');
    const configLabel = configScope === 'project'
      ? pc.cyan('project config')
      : pc.magenta('global config');

    console.log();
    console.log(`  ${pc.bold(scopeDisplay)} ${pc.dim('·')} ${envLabel}`);
    console.log(`  ${whoami.user.name} ${pc.dim(`(${whoami.user.email})`)}`);
    if (whoami.organization) console.log(`  ${pc.dim('Org:')} ${whoami.organization.name} ${pc.dim(`(${whoami.organization.id})`)}`);
    if (whoami.project) console.log(`  ${pc.dim('Project:')} ${whoami.project.name} ${pc.dim(`(${whoami.project.id})`)}`);
    console.log();
    console.log(`  ${pc.dim('Using')} ${configLabel}`);
    console.log(`  ${pc.dim('API:')} ${apiBase}`);
    console.log();
  });

// Shortcuts
program
  .command('add [platform]')
  .description('Shortcut for: connection add')
  .action(async (platform) => {
    await connectionAddCommand(platform);
  });

program
  .command('list')
  .alias('ls')
  .description('Shortcut for: connection list')
  .action(async () => {
    await connectionListCommand();
  });

program.parse();
