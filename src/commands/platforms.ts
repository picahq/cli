import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getApiKey } from '../lib/config.js';
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

  const api = new OneApi(apiKey);

  const spinner = output.createSpinner();
  spinner.start('Loading platforms...');

  try {
    const platforms = await api.listPlatforms();
    spinner.stop(`${platforms.length} platforms available`);

    if (options.json) {
      if (output.isAgentMode()) {
        output.json({ platforms });
      } else {
        console.log(JSON.stringify(platforms, null, 2));
      }
      return;
    }

    // Group by category
    const byCategory = new Map<string, Platform[]>();
    for (const plat of platforms) {
      const category = plat.category || 'Other';
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(plat);
    }

    console.log();

    // Filter by category if specified
    if (options.category) {
      const categoryPlatforms = byCategory.get(options.category);
      if (!categoryPlatforms) {
        const categories = [...byCategory.keys()].sort();
        p.note(`Available categories:\n  ${categories.join(', ')}`, 'Unknown Category');
        process.exit(1);
      }

      const rows = categoryPlatforms
        .sort((a, b) => a.platform.localeCompare(b.platform))
        .map(plat => ({
          platform: plat.platform,
          name: plat.name,
          category: plat.category || 'Other',
        }));

      printTable(
        [
          { key: 'platform', label: 'Platform' },
          { key: 'name', label: 'Name' },
        ],
        rows
      );
    } else {
      const rows = platforms
        .sort((a, b) => a.category.localeCompare(b.category) || a.platform.localeCompare(b.platform))
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
