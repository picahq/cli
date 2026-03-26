#!/usr/bin/env node

import { createRequire } from 'module';
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';
import { connectionAddCommand, connectionListCommand } from './commands/connection.js';
import { platformsCommand } from './commands/platforms.js';
import { actionsSearchCommand, actionsKnowledgeCommand, actionsExecuteCommand } from './commands/actions.js';
import {
  flowCreateCommand,
  flowExecuteCommand,
  flowListCommand,
  flowValidateCommand,
  flowResumeCommand,
  flowRunsCommand,
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
import { guideCommand } from './commands/guide.js';
import { onboardCommand } from './commands/onboard.js';
import { updateCommand, checkLatestVersionCached, getCurrentVersion } from './commands/update.js';
import { setAgentMode, isAgentMode } from './lib/output.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('one')
  .option('--agent', 'Machine-readable JSON output (no colors, spinners, or prompts)')
  .description(`One CLI — Connect AI agents to 200+ platforms through one interface.

  Setup:
    one init                              Set up API key and install MCP server
    one add <platform>                    Connect a platform via OAuth (e.g. gmail, slack, shopify)
    one config                            Configure access control (permissions, scoping)

  Workflow (use these in order):
    1. one list                           List your connected platforms and connection keys
    2. one actions search <platform> <q>  Search for actions using natural language
    3. one actions knowledge <plat> <id>  Get full docs for an action (ALWAYS do this before execute)
    4. one actions execute <p> <id> <key> Execute the action

  Guide:
    one guide [topic]                     Full CLI guide (topics: overview, actions, workflows, all)

  Workflows (multi-step):
    one flow list                         List saved workflows
    one flow create [key]                 Create a workflow from JSON
    one flow execute <key>                Execute a workflow
    one flow validate <key>               Validate a flow

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
  Run 'one platforms' to browse all 200+ available platforms.`)
  .version(version);

// Fire a non-blocking version check alongside every command
let updateCheckPromise: Promise<string | null> | undefined;

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
});

program.hook('postAction', async () => {
  if (!updateCheckPromise) return;
  const latestVersion = await updateCheckPromise;
  if (!latestVersion) return;
  const current = getCurrentVersion();
  if (current === latestVersion) return;
  if (isAgentMode()) {
    // In agent mode, append a notice field to stderr so it doesn't break JSON parsing
    process.stderr.write(`\nUpdate available: v${current} → v${latestVersion}. Run "one update" to upgrade.\n`);
  } else {
    console.log(`\n\x1b[33mUpdate available: v${current} → v${latestVersion}. Run \x1b[1mone update\x1b[22m to upgrade.\x1b[0m`);
  }
});

program
  .command('init')
  .description('Set up One and install MCP to your AI agents')
  .option('-y, --yes', 'Skip confirmations')
  .option('-g, --global', 'Install MCP globally (available in all projects)')
  .option('-p, --project', 'Install MCP for this project only (creates .mcp.json)')
  .action(async (options) => {
    await initCommand(options);
  });

program
  .command('config')
  .description('Configure MCP access control (permissions, connections, actions)')
  .action(async () => {
    await configCommand();
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
  .action(async (platform: string, query: string, options: { type?: string }) => {
    await actionsSearchCommand(platform, query, options);
  });

actions
  .command('knowledge <platform> <actionId>')
  .alias('k')
  .description('Get full docs for an action — MUST call before execute to know required params')
  .action(async (platform: string, actionId: string) => {
    await actionsKnowledgeCommand(platform, actionId);
  });

actions
  .command('execute <platform> <actionId> <connectionKey>')
  .alias('x')
  .description('Execute an action — pass connectionKey from "one list", actionId from "actions search"')
  .option('-d, --data <json>', 'Request body as JSON')
  .option('--path-vars <json>', 'Path variables as JSON')
  .option('--query-params <json>', 'Query parameters as JSON')
  .option('--headers <json>', 'Additional headers as JSON')
  .option('--form-data', 'Send as multipart/form-data')
  .option('--form-url-encoded', 'Send as application/x-www-form-urlencoded')
  .option('--dry-run', 'Show request that would be sent without executing')
  .action(async (platform: string, actionId: string, connectionKey: string, options: any) => {
    await actionsExecuteCommand(platform, actionId, connectionKey, {
      data: options.data,
      pathVars: options.pathVars,
      queryParams: options.queryParams,
      headers: options.headers,
      formData: options.formData,
      formUrlEncoded: options.formUrlEncoded,
      dryRun: options.dryRun,
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
  .option('-o, --output <path>', 'Custom output path (default .one/flows/<key>.flow.json)')
  .action(async (key: string | undefined, options: { definition?: string; output?: string }) => {
    await flowCreateCommand(key, options);
  });

flow
  .command('execute <keyOrPath>')
  .alias('x')
  .description('Execute a workflow by key or file path')
  .option('-i, --input <name=value>', 'Input parameter (repeatable)', collect, [])
  .option('--dry-run', 'Validate and show execution plan without running')
  .option('--mock', 'With --dry-run: execute transforms/code with mock API responses')
  .option('--allow-bash', 'Allow bash step execution (disabled by default for security)')
  .option('-v, --verbose', 'Show full request/response for each step')
  .action(async (keyOrPath: string, options: { input?: string[]; dryRun?: boolean; verbose?: boolean; mock?: boolean; allowBash?: boolean }) => {
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

program
  .command('guide [topic]')
  .description('Full CLI usage guide for agents (topics: overview, actions, flows, relay, all)')
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
