import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getApiKey, getApiBase } from '../lib/config.js';
import { OneApi } from '../lib/api.js';
import { printTable } from '../lib/table.js';
import * as output from '../lib/output.js';
import type { Platform } from '../lib/types.js';

export async function platformsCommand(options: { category?: string; json?: boolean }): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('Not configured. Run `one init` first.');
  }

  // In agent mode, force JSON output
  if (output.isAgentMode()) {
    options.json = true;
  }

  const api = new OneApi(apiKey, getApiBase());

  const spinner = output.createSpinner();
  spinner.start('Loading platforms...');

  try {
    const platforms = await api.listPlatforms();
    spinner.stop(`${platforms.length} platforms available`);

    // Filter by category if specified (applies to all output modes)
    let filtered = platforms;
    if (options.category) {
      filtered = platforms.filter(plat => (plat.category || 'Other') === options.category);
      if (filtered.length === 0) {
        const categories = [...new Set(platforms.map(plat => plat.category || 'Other'))].sort();
        if (output.isAgentMode()) {
          output.json({ error: `Unknown category "${options.category}"`, availableCategories: categories });
          process.exit(1);
        }
        p.note(`Available categories:\n  ${categories.join(', ')}`, 'Unknown Category');
        process.exit(1);
      }
    }

    if (options.json) {
      if (output.isAgentMode()) {
        output.json({ platforms: filtered });
      } else {
        console.log(JSON.stringify(filtered, null, 2));
      }
      return;
    }

    console.log();

    if (options.category) {
      const rows = filtered
        .sort((a, b) => a.platform.localeCompare(b.platform))
        .map(plat => ({
          platform: plat.platform,
          name: plat.name,
        }));

      printTable(
        [
          { key: 'platform', label: 'Platform' },
          { key: 'name', label: 'Name' },
        ],
        rows
      );
    } else {
      const rows = filtered
        .sort((a, b) => (a.category || 'Other').localeCompare(b.category || 'Other') || a.platform.localeCompare(b.platform))
        .map(plat => ({
          platform: plat.platform,
          name: plat.name,
          category: plat.category || 'Other',
        }));

      printTable(
        [
          { key: 'category', label: 'Category' },
          { key: 'platform', label: 'Platform' },
          { key: 'name', label: 'Name' },
        ],
        rows
      );
    }

    console.log();
    p.note(`Connect with: ${pc.cyan('one connection add <platform>')}`, 'Tip');
  } catch (error) {
    spinner.stop('Failed to load platforms');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
