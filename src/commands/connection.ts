import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getApiKey } from '../lib/config.js';
import { OneApi, TimeoutError } from '../lib/api.js';
import { openConnectionPage, getConnectionUrl } from '../lib/browser.js';
import { findPlatform, findSimilarPlatforms } from '../lib/platforms.js';
import { printTable } from '../lib/table.js';
import * as output from '../lib/output.js';
import type { Connection } from '../lib/types.js';

export async function connectionAddCommand(platformArg?: string): Promise<void> {
  if (output.isAgentMode()) {
    output.error('This command requires interactive input. Run without --agent.');
  }

  p.intro(pc.bgCyan(pc.black(' One ')));

  const apiKey = getApiKey();
  if (!apiKey) {
    p.cancel('Not configured. Run `one init` first.');
    process.exit(1);
  }

  const api = new OneApi(apiKey);

  // Get platform list for validation
  const spinner = p.spinner();
  spinner.start('Loading platforms...');

  let platforms;
  try {
    platforms = await api.listPlatforms();
    spinner.stop(`${platforms.length} platforms available`);
  } catch (error) {
    spinner.stop('Failed to load platforms');
    p.cancel(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }

  // Get or prompt for platform
  let platform: string;

  if (platformArg) {
    const found = findPlatform(platforms, platformArg);
    if (found) {
      platform = found.platform;
    } else {
      const similar = findSimilarPlatforms(platforms, platformArg);
      if (similar.length > 0) {
        p.log.warn(`Unknown platform: ${platformArg}`);
        const suggestion = await p.select({
          message: 'Did you mean:',
          options: [
            ...similar.map(s => ({ value: s.platform, label: `${s.name} (${s.platform})` })),
            { value: '__other__', label: 'None of these' },
          ],
        });

        if (p.isCancel(suggestion) || suggestion === '__other__') {
          p.note(`Run ${pc.cyan('one platforms')} to see all available platforms.`);
          p.cancel('Connection cancelled.');
          process.exit(0);
        }

        platform = suggestion as string;
      } else {
        p.cancel(`Unknown platform: ${platformArg}\n\nRun ${pc.cyan('one platforms')} to see available platforms.`);
        process.exit(1);
      }
    }
  } else {
    const platformInput = await p.text({
      message: 'Which platform do you want to connect?',
      placeholder: 'gmail, slack, hubspot...',
      validate: (value) => {
        if (!value.trim()) return 'Platform name is required';
        return undefined;
      },
    });

    if (p.isCancel(platformInput)) {
      p.cancel('Connection cancelled.');
      process.exit(0);
    }

    const found = findPlatform(platforms, platformInput);
    if (found) {
      platform = found.platform;
    } else {
      p.cancel(`Unknown platform: ${platformInput}\n\nRun ${pc.cyan('one platforms')} to see available platforms.`);
      process.exit(1);
    }
  }

  // Open browser
  const url = getConnectionUrl(platform);
  p.log.info(`Opening browser to connect ${pc.cyan(platform)}...`);
  p.note(pc.dim(url), 'URL');

  try {
    await openConnectionPage(platform);
  } catch {
    p.log.warn('Could not open browser automatically.');
    p.note(`Open this URL manually:\n${url}`);
  }

  // Poll for connection
  const pollSpinner = p.spinner();
  pollSpinner.start('Waiting for connection... (complete auth in browser)');

  try {
    const connection = await api.waitForConnection(platform, 5 * 60 * 1000, 5000);
    pollSpinner.stop(`${platform} connected!`);

    p.log.success(`${pc.green('✓')} ${connection.platform} is now available to your AI agents.`);
    p.outro('Connection complete!');
  } catch (error) {
    pollSpinner.stop('Connection timed out');

    if (error instanceof TimeoutError) {
      p.note(
        `Possible issues:\n` +
        `  - OAuth flow was not completed in the browser\n` +
        `  - Browser popup was blocked\n` +
        `  - Wrong account selected\n\n` +
        `Try again with: ${pc.cyan(`one connection add ${platform}`)}`,
        'Timed Out'
      );
    } else {
      p.log.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    process.exit(1);
  }
}

export async function connectionListCommand(options?: { search?: string; limit?: string }): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('Not configured. Run `one init` first.');
  }

  const api = new OneApi(apiKey);

  const spinner = output.createSpinner();
  spinner.start('Loading connections...');

  try {
    const allConnections = await api.listConnections();

    // Filter by search query if provided
    const searchQuery = options?.search?.toLowerCase();
    const filtered = searchQuery
      ? allConnections.filter(conn => conn.platform.toLowerCase().includes(searchQuery))
      : allConnections;

    if (output.isAgentMode()) {
      const limit = options?.limit ? parseInt(options.limit, 10) : 20;
      const limited = filtered.slice(0, limit);

      output.json({
        total: filtered.length,
        showing: limited.length,
        ...(searchQuery && { search: searchQuery }),
        connections: limited.map(conn => ({
          platform: conn.platform,
          state: conn.state,
          key: conn.key,
        })),
        ...(limited.length < filtered.length && {
          hint: `Showing ${limited.length} of ${filtered.length} connections. Use --search <query> to filter by platform or --limit <n> to see more.`,
        }),
      });
      return;
    }

    spinner.stop(`${filtered.length} connection${filtered.length === 1 ? '' : 's'} found`);

    if (filtered.length === 0) {
      if (searchQuery) {
        p.note(
          `No connections matching "${searchQuery}".\n\n` +
          `Try: ${pc.cyan('one connection list')} to see all connections.`,
          'No Results'
        );
      } else {
        p.note(
          `No connections yet.\n\n` +
          `Add one with: ${pc.cyan('one connection add gmail')}`,
          'No Connections'
        );
      }
      return;
    }

    console.log();

    const rows = filtered.map(conn => ({
      status: getStatusIndicator(conn.state),
      platform: conn.platform,
      state: conn.state,
      key: conn.key,
    }));

    printTable(
      [
        { key: 'status', label: '' },
        { key: 'platform', label: 'Platform' },
        { key: 'state', label: 'Status' },
        { key: 'key', label: 'Connection Key', color: pc.dim },
      ],
      rows
    );

    console.log();
    p.note(`Add more with: ${pc.cyan('one connection add <platform>')}`, 'Tip');
  } catch (error) {
    spinner.stop('Failed to load connections');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function getStatusIndicator(state: Connection['state']): string {
  switch (state) {
    case 'operational':
      return pc.green('●');
    case 'degraded':
      return pc.yellow('●');
    case 'failed':
      return pc.red('●');
    default:
      return pc.dim('○');
  }
}
