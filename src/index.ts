#!/usr/bin/env node

import { createRequire } from 'module';
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';
import { connectionAddCommand, connectionListCommand } from './commands/connection.js';
import { platformsCommand } from './commands/platforms.js';
import { actionsSearchCommand, actionsKnowledgeCommand, actionsExecuteCommand } from './commands/actions.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('pica')
  .description(`Pica CLI — Connect AI agents to 200+ platforms through one interface.

  Setup:
    pica init                              Set up API key and install MCP server
    pica add <platform>                    Connect a platform via OAuth (e.g. gmail, slack, shopify)
    pica config                            Configure access control (permissions, scoping)

  Workflow (use these in order):
    1. pica list                           List your connected platforms and connection keys
    2. pica actions search <platform> <q>  Search for actions using natural language
    3. pica actions knowledge <plat> <id>  Get full docs for an action (ALWAYS do this before execute)
    4. pica actions execute <p> <id> <key> Execute the action

  Example — send an email through Gmail:
    $ pica list
    # Find: gmail  operational  live::gmail::default::abc123

    $ pica actions search gmail "send email" -t execute
    # Find: POST  Send Email  conn_mod_def::xxx::yyy

    $ pica actions knowledge gmail conn_mod_def::xxx::yyy
    # Read the docs: required fields are to, subject, body, connectionKey

    $ pica actions execute gmail conn_mod_def::xxx::yyy live::gmail::default::abc123 \\
        -d '{"to":"j@example.com","subject":"Hello","body":"Hi!","connectionKey":"live::gmail::default::abc123"}'

  Platform names are always kebab-case (e.g. hub-spot, ship-station, google-calendar).
  Run 'pica platforms' to browse all 200+ available platforms.`)
  .version(version);

program
  .command('init')
  .description('Set up Pica and install MCP to your AI agents')
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
  .description('Search for actions on a platform (e.g. pica actions search gmail "send email")')
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
  .description('Execute an action — pass connectionKey from "pica list", actionId from "actions search"')
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
