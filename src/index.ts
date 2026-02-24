#!/usr/bin/env node

import { createRequire } from 'module';
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';
import { connectionAddCommand, connectionListCommand } from './commands/connection.js';
import { platformsCommand } from './commands/platforms.js';

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
