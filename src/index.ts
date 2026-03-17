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
import { guideCommand } from './commands/guide.js';
import { setAgentMode } from './lib/output.js';

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
    one guide [topic]                     Full CLI guide (topics: overview, actions, flows, all)

  Flows (multi-step workflows):
    one flow list                         List saved flows
    one flow create [key]                 Create a flow from JSON
    one flow execute <key>                Execute a flow
    one flow validate <key>               Validate a flow

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

program.hook('preAction', (thisCommand) => {
  const opts = program.opts();
  if (opts.agent) {
    setAgentMode(true);
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
  .action(async () => {
    await connectionListCommand();
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
  .action(async (platform: string, actionId: string, connectionKey: string, options: any) => {
    await actionsExecuteCommand(platform, actionId, connectionKey, {
      data: options.data,
      pathVars: options.pathVars,
      queryParams: options.queryParams,
      headers: options.headers,
      formData: options.formData,
      formUrlEncoded: options.formUrlEncoded,
    });
  });

// Flow commands
const flow = program
  .command('flow')
  .alias('f')
  .description('Create, execute, and manage multi-step API workflows');

flow
  .command('create [key]')
  .description('Create a new flow from JSON definition')
  .option('--definition <json>', 'Flow definition as JSON string')
  .option('-o, --output <path>', 'Custom output path (default .one/flows/<key>.flow.json)')
  .action(async (key: string | undefined, options: { definition?: string; output?: string }) => {
    await flowCreateCommand(key, options);
  });

flow
  .command('execute <keyOrPath>')
  .alias('x')
  .description('Execute a flow by key or file path')
  .option('-i, --input <name=value>', 'Input parameter (repeatable)', collect, [])
  .option('--dry-run', 'Validate and show execution plan without running')
  .option('-v, --verbose', 'Show full request/response for each step')
  .action(async (keyOrPath: string, options: { input?: string[]; dryRun?: boolean; verbose?: boolean }) => {
    await flowExecuteCommand(keyOrPath, options);
  });

flow
  .command('list')
  .alias('ls')
  .description('List all flows in .one/flows/')
  .action(async () => {
    await flowListCommand();
  });

flow
  .command('validate <keyOrPath>')
  .description('Validate a flow JSON file')
  .action(async (keyOrPath: string) => {
    await flowValidateCommand(keyOrPath);
  });

flow
  .command('resume <runId>')
  .description('Resume a paused or failed flow run')
  .action(async (runId: string) => {
    await flowResumeCommand(runId);
  });

flow
  .command('runs [flowKey]')
  .description('List flow runs (optionally filtered by flow key)')
  .action(async (flowKey?: string) => {
    await flowRunsCommand(flowKey);
  });

program
  .command('guide [topic]')
  .description('Full CLI usage guide for agents (topics: overview, actions, flows, all)')
  .action(async (topic?: string) => {
    await guideCommand(topic);
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
