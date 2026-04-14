import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readConfig, writeConfig, getApiBase, getAccessControl, updateAccessControl, updateApiBase } from '../lib/config.js';
import { getAgentStatuses, installMcpConfig } from '../lib/agents.js';
import { OneApi } from '../lib/api.js';
import { getApiKeyUrl } from '../lib/browser.js';
import * as output from '../lib/output.js';
import type { AccessControlSettings, PermissionLevel } from '../lib/types.js';

export async function configCommand(): Promise<void> {
  if (output.isAgentMode()) {
    output.error('This command requires interactive input. Run without --agent.');
  }

  const config = readConfig();

  if (!config) {
    p.log.error(`No One config found. Run ${pc.cyan('one init')} first.`);
    return;
  }

  p.intro(pc.bgCyan(pc.black(' One Access Control ')));

  const current = getAccessControl();

  // Display current settings
  console.log();
  console.log(`  ${pc.bold('Current Access Control')}`);
  console.log(`  ${pc.dim('─'.repeat(42))}`);
  console.log(`  ${pc.dim('Permissions:')}   ${current.permissions ?? 'admin'}`);
  console.log(`  ${pc.dim('Connections:')}   ${formatList(current.connectionKeys)}`);
  console.log(`  ${pc.dim('Action IDs:')}    ${formatList(current.actionIds)}`);
  console.log(`  ${pc.dim('Knowledge only:')} ${current.knowledgeAgent ? 'yes' : 'no'}`);
  console.log();

  // 1. Permission level
  const permissions = await p.select<PermissionLevel>({
    message: 'Permission level',
    options: [
      { value: 'admin', label: 'Admin', hint: 'Full access (GET, POST, PUT, PATCH, DELETE)' },
      { value: 'write', label: 'Write', hint: 'GET, POST, PUT, PATCH' },
      { value: 'read', label: 'Read', hint: 'GET only' },
    ],
    initialValue: current.permissions ?? 'admin',
  });

  if (p.isCancel(permissions)) {
    p.outro('No changes made.');
    return;
  }

  // 2. Connection keys
  const connectionMode = await p.select({
    message: 'Connection scope',
    options: [
      { value: 'all', label: 'All connections' },
      { value: 'specific', label: 'Select specific connections' },
    ],
    initialValue: current.connectionKeys ? 'specific' : 'all',
  });

  if (p.isCancel(connectionMode)) {
    p.outro('No changes made.');
    return;
  }

  let connectionKeys: string[] | undefined;

  if (connectionMode === 'specific') {
    connectionKeys = await selectConnections(config.apiKey);
    if (connectionKeys === undefined) {
      // User cancelled
      p.outro('No changes made.');
      return;
    }
    if (connectionKeys.length === 0) {
      p.log.info(`No connections found. Defaulting to all. Use ${pc.cyan('one add')} to connect platforms.`);
      connectionKeys = undefined;
    }
  }

  // 3. Action IDs
  const actionMode = await p.select({
    message: 'Action scope',
    options: [
      { value: 'all', label: 'All actions' },
      { value: 'specific', label: 'Restrict to specific action IDs' },
    ],
    initialValue: current.actionIds ? 'specific' : 'all',
  });

  if (p.isCancel(actionMode)) {
    p.outro('No changes made.');
    return;
  }

  let actionIds: string[] | undefined;

  if (actionMode === 'specific') {
    const actionInput = await p.text({
      message: 'Enter action IDs (comma-separated):',
      placeholder: 'action-id-1, action-id-2',
      initialValue: current.actionIds?.join(', ') ?? '',
      validate: (value) => {
        if (!value.trim()) return 'At least one action ID is required';
        return undefined;
      },
    });

    if (p.isCancel(actionInput)) {
      p.outro('No changes made.');
      return;
    }

    actionIds = actionInput.split(',').map(s => s.trim()).filter(Boolean);
  }

  // 4. Knowledge-only mode
  const knowledgeAgent = await p.confirm({
    message: 'Enable knowledge-only mode? (disables action execution)',
    initialValue: current.knowledgeAgent ?? false,
  });

  if (p.isCancel(knowledgeAgent)) {
    p.outro('No changes made.');
    return;
  }

  // 5. API base URL
  const currentBase = getApiBase();
  const isCustomBase = !!readConfig()?.apiBase;

  const baseUrlMode = await p.select({
    message: 'API base URL',
    options: [
      { value: 'default', label: 'Default', hint: 'https://api.withone.ai' },
      { value: 'custom', label: 'Custom', hint: 'Use a different API endpoint' },
    ],
    initialValue: isCustomBase ? 'custom' : 'default',
  });

  if (p.isCancel(baseUrlMode)) {
    p.outro('No changes made.');
    return;
  }

  let newApiKey = config.apiKey;

  if (baseUrlMode === 'custom') {
    const customUrl = await p.text({
      message: 'Enter API base URL:',
      placeholder: 'https://development-api.withone.ai',
      initialValue: isCustomBase ? currentBase.replace(/\/v1$/, '') : '',
      validate: (value) => {
        if (!value) return 'URL is required';
        try { new URL(value); } catch { return 'Invalid URL'; }
        return undefined;
      },
    });

    if (p.isCancel(customUrl)) {
      p.outro('No changes made.');
      return;
    }

    const normalized = customUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

    const apiKey = await p.text({
      message: `Enter your API key for ${pc.cyan(normalized)}:`,
      placeholder: 'sk_live_...',
      validate: (value) => {
        if (!value) return 'API key is required';
        if (!value.startsWith('sk_live_') && !value.startsWith('sk_test_')) {
          return 'API key should start with sk_live_ or sk_test_';
        }
        return undefined;
      },
    });

    if (p.isCancel(apiKey)) {
      p.outro('No changes made.');
      return;
    }

    const spinner = p.spinner();
    spinner.start('Validating API key...');

    let isValid = false;
    try {
      const api = new OneApi(apiKey, `${normalized}/v1`);
      isValid = await api.validateApiKey();
    } catch (err) {
      spinner.stop('Connection failed');
      const msg = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not reach ${pc.cyan(normalized)}: ${msg}`);
      return;
    }

    if (!isValid) {
      spinner.stop('Invalid API key');
      p.log.error(`Invalid API key for ${pc.cyan(normalized)}.`);
      return;
    }

    spinner.stop('API key validated');
    updateApiBase(normalized);
    newApiKey = apiKey;
  } else if (isCustomBase) {
    // Switching back to default — need a key for production
    const apiKey = await p.text({
      message: `Enter your API key for ${pc.cyan('https://api.withone.ai')}:`,
      placeholder: 'sk_live_...',
      validate: (value) => {
        if (!value) return 'API key is required';
        if (!value.startsWith('sk_live_') && !value.startsWith('sk_test_')) {
          return 'API key should start with sk_live_ or sk_test_';
        }
        return undefined;
      },
    });

    if (p.isCancel(apiKey)) {
      p.outro('No changes made.');
      return;
    }

    const spinner = p.spinner();
    spinner.start('Validating API key...');

    let isValid = false;
    try {
      const api = new OneApi(apiKey, 'https://api.withone.ai/v1');
      isValid = await api.validateApiKey();
    } catch (err) {
      spinner.stop('Connection failed');
      const msg = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not reach ${pc.cyan('https://api.withone.ai')}: ${msg}`);
      return;
    }

    if (!isValid) {
      spinner.stop('Invalid API key');
      p.log.error(`Invalid API key. Get a valid key at ${getApiKeyUrl()}`);
      return;
    }

    spinner.stop('API key validated');
    updateApiBase(null);
    newApiKey = apiKey;
  }

  // Build settings
  const settings: AccessControlSettings = {
    permissions: permissions as PermissionLevel,
    connectionKeys: connectionKeys ?? ['*'],
    actionIds: actionIds ?? ['*'],
    knowledgeAgent: knowledgeAgent as boolean,
  };

  // Save access control + API key
  updateAccessControl(settings);
  const updatedConfig = readConfig();
  if (updatedConfig && newApiKey !== config.apiKey) {
    updatedConfig.apiKey = newApiKey;
    delete updatedConfig.whoami;
    writeConfig(updatedConfig);
  }

  // Reinstall all agents
  const ac = getAccessControl();
  const statuses = getAgentStatuses();
  const reinstalled: string[] = [];

  for (const s of statuses) {
    if (s.globalMcp) {
      installMcpConfig(s.agent, newApiKey, 'global', ac);
      reinstalled.push(`${s.agent.name} (global)`);
    }
    if (s.projectMcp) {
      installMcpConfig(s.agent, newApiKey, 'project', ac);
      reinstalled.push(`${s.agent.name} (project)`);
    }
  }

  if (reinstalled.length > 0) {
    p.log.success(`Updated MCP configs: ${reinstalled.join(', ')}`);
  }

  p.outro('Configuration updated.');
}

async function selectConnections(apiKey: string): Promise<string[] | undefined> {
  const spinner = p.spinner();
  spinner.start('Fetching connections...');

  let connections: { platform: string; key: string }[];

  try {
    const api = new OneApi(apiKey, getApiBase());
    const rawConnections = await api.listConnections();
    connections = rawConnections.map(c => ({ platform: c.platform, key: c.key }));
    spinner.stop(`Found ${connections.length} connection(s)`);
  } catch {
    spinner.stop('Could not fetch connections');
    // Fall back to manual input
    const manual = await p.text({
      message: 'Enter connection keys manually (comma-separated):',
      placeholder: 'conn_key_1, conn_key_2',
      validate: (value) => {
        if (!value.trim()) return 'At least one connection key is required';
        return undefined;
      },
    });

    if (p.isCancel(manual)) return undefined;
    return manual.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (connections.length === 0) {
    return [];
  }

  const selected = await p.multiselect({
    message: 'Select connections:',
    options: connections.map(c => ({
      value: c.key,
      label: `${c.platform}`,
      hint: c.key,
    })),
  });

  if (p.isCancel(selected)) return undefined;
  return selected as string[];
}



function formatList(list: string[] | undefined): string {
  if (!list || list.length === 0) return 'all';
  if (list.length === 1 && list[0] === '*') return 'all';
  return list.join(', ');
}
