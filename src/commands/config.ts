import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readConfig, getAccessControl, updateAccessControl } from '../lib/config.js';
import { getAgentStatuses, installMcpConfig } from '../lib/agents.js';
import { OneApi } from '../lib/api.js';
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

  // Build settings
  const settings: AccessControlSettings = {
    permissions: permissions as PermissionLevel,
    connectionKeys: connectionKeys ?? ['*'],
    actionIds: actionIds ?? ['*'],
    knowledgeAgent: knowledgeAgent as boolean,
  };

  // Save
  updateAccessControl(settings);

  // Reinstall all agents
  const ac = getAccessControl();
  const statuses = getAgentStatuses();
  const reinstalled: string[] = [];

  for (const s of statuses) {
    if (s.globalMcp) {
      installMcpConfig(s.agent, config.apiKey, 'global', ac);
      reinstalled.push(`${s.agent.name} (global)`);
    }
    if (s.projectMcp) {
      installMcpConfig(s.agent, config.apiKey, 'project', ac);
      reinstalled.push(`${s.agent.name} (project)`);
    }
  }

  if (reinstalled.length > 0) {
    p.log.success(`Updated MCP configs: ${reinstalled.join(', ')}`);
  }

  p.outro('Access control updated.');
}

async function selectConnections(apiKey: string): Promise<string[] | undefined> {
  const spinner = p.spinner();
  spinner.start('Fetching connections...');

  let connections: { platform: string; key: string }[];

  try {
    const api = new OneApi(apiKey);
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
