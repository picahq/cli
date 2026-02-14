#!/usr/bin/env node

import { createRequire } from 'module';
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { connectionAddCommand, connectionListCommand } from './commands/connection.js';
import { platformsCommand } from './commands/platforms.js';
import { actionsSearchCommand, actionsKnowledgeCommand, actionsExecuteCommand } from './commands/actions.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('pica')
  .description('CLI for managing Pica')
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

// Actions command group
const actions = program
  .command('actions')
  .alias('a')
  .description('Discover and execute platform actions');

actions
  .command('search <platform> [query]')
  .description('Search actions on a platform')
  .option('--json', 'Output as JSON')
  .option('-l, --limit <limit>', 'Max results', '10')
  .action(async (platform: string, query: string | undefined, options: { json?: boolean; limit?: string }) => {
    await actionsSearchCommand(platform, query, options);
  });

actions
  .command('knowledge <actionId>')
  .alias('k')
  .description('Get API docs for an action')
  .option('--json', 'Output as JSON')
  .option('--full', 'Show full knowledge (no truncation)')
  .action(async (actionId: string, options: { json?: boolean; full?: boolean }) => {
    await actionsKnowledgeCommand(actionId, options);
  });

actions
  .command('execute <actionId>')
  .alias('x')
  .description('Execute an action')
  .option('-c, --connection <key>', 'Connection key to use')
  .option('-d, --data <json>', 'Request body as JSON')
  .option('-p, --path-var <key=value...>', 'Path variable', collectValues)
  .option('-q, --query <key=value...>', 'Query parameter', collectValues)
  .option('--form-data', 'Send as multipart/form-data')
  .option('--form-urlencoded', 'Send as application/x-www-form-urlencoded')
  .option('--json', 'Output as JSON')
  .action(async (actionId: string, options) => {
    await actionsExecuteCommand(actionId, options);
  });

// Top-level shortcuts
program
  .command('search <platform> [query]')
  .description('Shortcut for: actions search')
  .option('--json', 'Output as JSON')
  .option('-l, --limit <limit>', 'Max results', '10')
  .action(async (platform: string, query: string | undefined, options: { json?: boolean; limit?: string }) => {
    await actionsSearchCommand(platform, query, options);
  });

program
  .command('exec <actionId>')
  .description('Shortcut for: actions execute')
  .option('-c, --connection <key>', 'Connection key to use')
  .option('-d, --data <json>', 'Request body as JSON')
  .option('-p, --path-var <key=value...>', 'Path variable', collectValues)
  .option('-q, --query <key=value...>', 'Query parameter', collectValues)
  .option('--form-data', 'Send as multipart/form-data')
  .option('--form-urlencoded', 'Send as application/x-www-form-urlencoded')
  .option('--json', 'Output as JSON')
  .action(async (actionId: string, options) => {
    await actionsExecuteCommand(actionId, options);
  });

function collectValues(value: string, previous: string[]): string[] {
  return (previous || []).concat([value]);
}

program.parse();
