import * as p from '@clack/prompts';
import pc from 'picocolors';
import { writeConfig, readConfig, getConfigPath } from '../lib/config.js';
import {
  getAllAgents,
  installMcpConfig,
  isMcpInstalled,
  getAgentConfigPath,
  supportsProjectScope,
  getAgentStatuses,
  type InstallScope,
  type AgentStatus,
} from '../lib/agents.js';
import { PicaApi, TimeoutError } from '../lib/api.js';
import { getApiKeyUrl, openApiKeyPage, openConnectionPage, getConnectionUrl } from '../lib/browser.js';
import open from 'open';
import { printTable } from '../lib/table.js';
import type { Agent } from '../lib/types.js';

export async function initCommand(options: { yes?: boolean; global?: boolean; project?: boolean }): Promise<void> {
  const existingConfig = readConfig();

  if (existingConfig) {
    p.intro(pc.bgCyan(pc.black(' Pica ')));
    await handleExistingConfig(existingConfig.apiKey, options);
    return;
  }

  // First-run: show welcome banner
  printBanner();
  await freshSetup(options);
}

// ── Status display + action menu when config already exists ──────────

async function handleExistingConfig(
  apiKey: string,
  options: { yes?: boolean; global?: boolean; project?: boolean },
): Promise<void> {
  const statuses = getAgentStatuses();

  // Display current setup
  const masked = maskApiKey(apiKey);
  console.log();
  console.log(`  ${pc.bold('Current Setup')}`);
  console.log(`  ${pc.dim('─'.repeat(42))}`);
  console.log(`  ${pc.dim('API Key:')}  ${masked}`);
  console.log(`  ${pc.dim('Config:')}   ${getConfigPath()}`);
  console.log();

  // Agent status table
  printTable(
    [
      { key: 'agent', label: 'Agent' },
      { key: 'global', label: 'Global' },
      { key: 'project', label: 'Project' },
    ],
    statuses.map(s => ({
      agent: s.agent.name,
      global: !s.detected
        ? pc.dim('-')
        : s.globalMcp
          ? pc.green('\u25cf yes')
          : pc.yellow('\u25cb no'),
      project: s.projectMcp === null
        ? pc.dim('-')
        : s.projectMcp
          ? pc.green('\u25cf yes')
          : pc.yellow('\u25cb no'),
    })),
  );

  const notDetected = statuses.filter(s => !s.detected);
  if (notDetected.length > 0) {
    console.log(`  ${pc.dim('- = not detected on this machine')}`);
  }
  console.log();

  // Build action menu: only show relevant options
  type Action = 'update-key' | 'install-more' | 'install-project' | 'start-fresh';
  const actionOptions: { value: Action; label: string; hint?: string }[] = [];

  actionOptions.push({
    value: 'update-key',
    label: 'Update API key',
  });

  const agentsMissingGlobal = statuses.filter(s => s.detected && !s.globalMcp);
  if (agentsMissingGlobal.length > 0) {
    actionOptions.push({
      value: 'install-more',
      label: 'Install MCP to more agents',
      hint: agentsMissingGlobal.map(s => s.agent.name).join(', '),
    });
  }

  const agentsMissingProject = statuses.filter(s => s.projectMcp === false);
  if (agentsMissingProject.length > 0) {
    actionOptions.push({
      value: 'install-project',
      label: 'Install MCP for this project',
      hint: agentsMissingProject.map(s => s.agent.name).join(', '),
    });
  }

  actionOptions.push({
    value: 'start-fresh',
    label: 'Start fresh (reconfigure everything)',
  });

  const action = await p.select({
    message: 'What would you like to do?',
    options: actionOptions,
  });

  if (p.isCancel(action)) {
    p.outro('No changes made.');
    return;
  }

  switch (action) {
    case 'update-key':
      await handleUpdateKey(statuses);
      break;
    case 'install-more':
      await handleInstallMore(apiKey, agentsMissingGlobal);
      break;
    case 'install-project':
      await handleInstallProject(apiKey, agentsMissingProject);
      break;
    case 'start-fresh':
      await freshSetup({ yes: true });
      break;
  }
}

// ── Action handlers ──────────────────────────────────────────────────

async function handleUpdateKey(statuses: AgentStatus[]): Promise<void> {
  p.note(`Get your API key at:\n${pc.cyan(getApiKeyUrl())}`, 'API Key');

  const openBrowser = await p.confirm({
    message: 'Open browser to get API key?',
    initialValue: true,
  });

  if (p.isCancel(openBrowser)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  if (openBrowser) {
    await openApiKeyPage();
  }

  const newKey = await p.text({
    message: 'Enter your new Pica API key:',
    placeholder: 'sk_live_...',
    validate: (value) => {
      if (!value) return 'API key is required';
      if (!value.startsWith('sk_live_') && !value.startsWith('sk_test_')) {
        return 'API key should start with sk_live_ or sk_test_';
      }
      return undefined;
    },
  });

  if (p.isCancel(newKey)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  // Validate
  const spinner = p.spinner();
  spinner.start('Validating API key...');

  const api = new PicaApi(newKey);
  const isValid = await api.validateApiKey();

  if (!isValid) {
    spinner.stop('Invalid API key');
    p.cancel(`Invalid API key. Get a valid key at ${getApiKeyUrl()}`);
    process.exit(1);
  }

  spinner.stop('API key validated');

  // Re-install MCP to every agent that currently has it (preserve scopes)
  const reinstalled: string[] = [];
  for (const s of statuses) {
    if (s.globalMcp) {
      installMcpConfig(s.agent, newKey, 'global');
      reinstalled.push(`${s.agent.name} (global)`);
    }
    if (s.projectMcp) {
      installMcpConfig(s.agent, newKey, 'project');
      reinstalled.push(`${s.agent.name} (project)`);
    }
  }

  // Update config
  const config = readConfig();
  writeConfig({
    apiKey: newKey,
    installedAgents: config?.installedAgents ?? [],
    createdAt: config?.createdAt ?? new Date().toISOString(),
  });

  if (reinstalled.length > 0) {
    p.log.success(`Updated MCP configs: ${reinstalled.join(', ')}`);
  }

  p.outro('API key updated.');
}

async function handleInstallMore(apiKey: string, missing: AgentStatus[]): Promise<void> {
  if (missing.length === 1) {
    // Only one option, just confirm
    const agent = missing[0].agent;
    const confirm = await p.confirm({
      message: `Install Pica MCP to ${agent.name}?`,
      initialValue: true,
    });

    if (p.isCancel(confirm) || !confirm) {
      p.outro('No changes made.');
      return;
    }

    installMcpConfig(agent, apiKey, 'global');
    updateConfigAgents(agent.id);
    p.log.success(`${agent.name}: MCP installed`);
    p.outro('Done.');
    return;
  }

  const selected = await p.multiselect({
    message: 'Select agents to install MCP:',
    options: missing.map(s => ({
      value: s.agent.id,
      label: s.agent.name,
    })),
  });

  if (p.isCancel(selected)) {
    p.outro('No changes made.');
    return;
  }

  const agents = missing.filter(s => (selected as string[]).includes(s.agent.id));
  for (const s of agents) {
    installMcpConfig(s.agent, apiKey, 'global');
    updateConfigAgents(s.agent.id);
    p.log.success(`${s.agent.name}: MCP installed`);
  }

  p.outro('Done.');
}

async function handleInstallProject(apiKey: string, missing: AgentStatus[]): Promise<void> {
  if (missing.length === 1) {
    const agent = missing[0].agent;
    const confirm = await p.confirm({
      message: `Install project-level MCP for ${agent.name}?`,
      initialValue: true,
    });

    if (p.isCancel(confirm) || !confirm) {
      p.outro('No changes made.');
      return;
    }

    installMcpConfig(agent, apiKey, 'project');
    const configPath = getAgentConfigPath(agent, 'project');
    p.log.success(`${agent.name}: ${configPath} created`);
    p.note(
      pc.yellow('Project config files can be committed to share with your team.\n') +
      pc.yellow('Team members will need their own API key.'),
      'Tip',
    );
    p.outro('Done.');
    return;
  }

  const selected = await p.multiselect({
    message: 'Select agents for project-level MCP:',
    options: missing.map(s => ({
      value: s.agent.id,
      label: s.agent.name,
    })),
  });

  if (p.isCancel(selected)) {
    p.outro('No changes made.');
    return;
  }

  const agents = missing.filter(s => (selected as string[]).includes(s.agent.id));
  for (const s of agents) {
    installMcpConfig(s.agent, apiKey, 'project');
    const configPath = getAgentConfigPath(s.agent, 'project');
    p.log.success(`${s.agent.name}: ${configPath} created`);
  }

  p.note(
    pc.yellow('Project config files can be committed to share with your team.\n') +
    pc.yellow('Team members will need their own API key.'),
    'Tip',
  );
  p.outro('Done.');
}

// ── First-run setup (no existing config) ─────────────────────────────

async function freshSetup(options: { yes?: boolean; global?: boolean; project?: boolean }): Promise<void> {
  // Get API key
  p.note(`Get your API key at:\n${pc.cyan(getApiKeyUrl())}`, 'API Key');

  const openBrowser = await p.confirm({
    message: 'Open browser to get API key?',
    initialValue: true,
  });

  if (p.isCancel(openBrowser)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  if (openBrowser) {
    await openApiKeyPage();
  }

  const apiKey = await p.text({
    message: 'Enter your Pica API key:',
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
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // Validate API key
  const spinner = p.spinner();
  spinner.start('Validating API key...');

  const api = new PicaApi(apiKey);
  const isValid = await api.validateApiKey();

  if (!isValid) {
    spinner.stop('Invalid API key');
    p.cancel(`Invalid API key. Get a valid key at ${getApiKeyUrl()}`);
    process.exit(1);
  }

  spinner.stop('API key validated');

  // Save API key to config first
  writeConfig({
    apiKey,
    installedAgents: [],
    createdAt: new Date().toISOString(),
  });

  // Ask which agent to install for
  const allAgents = getAllAgents();

  const agentChoice = await p.select({
    message: 'Where do you want to install the MCP?',
    options: [
      {
        value: 'all',
        label: 'All agents',
        hint: allAgents.map(a => a.name).join(', '),
      },
      ...allAgents.map(agent => ({
        value: agent.id,
        label: agent.name,
      })),
    ],
  });

  if (p.isCancel(agentChoice)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const selectedAgents: Agent[] = agentChoice === 'all'
    ? allAgents
    : allAgents.filter(a => a.id === agentChoice);

  // Ask about installation scope if any selected agent supports project scope
  let scope: InstallScope = 'global';
  const hasProjectScopeAgent = selectedAgents.some(a => supportsProjectScope(a));

  if (options.global) {
    scope = 'global';
  } else if (options.project) {
    scope = 'project';
  } else if (hasProjectScopeAgent) {
    const scopeChoice = await p.select({
      message: 'How do you want to install it?',
      options: [
        {
          value: 'global',
          label: 'Global (Recommended)',
          hint: 'Available in all your projects',
        },
        {
          value: 'project',
          label: 'Project only',
          hint: 'Creates config files in current directory',
        },
      ],
    });

    if (p.isCancel(scopeChoice)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    scope = scopeChoice as InstallScope;
  }

  // Handle project scope installation
  if (scope === 'project') {
    const projectAgents = selectedAgents.filter(a => supportsProjectScope(a));
    const nonProjectAgents = selectedAgents.filter(a => !supportsProjectScope(a));

    if (projectAgents.length === 0) {
      const supported = allAgents.filter(a => supportsProjectScope(a)).map(a => a.name).join(', ');
      p.note(
        `${selectedAgents.map(a => a.name).join(', ')} does not support project-level MCP.\n` +
        `Project scope is supported by: ${supported}`,
        'Not Supported'
      );
      p.cancel('Run again and choose global scope or a different agent.');
      process.exit(1);
    }

    // Install project-scoped agents
    for (const agent of projectAgents) {
      const wasInstalled = isMcpInstalled(agent, 'project');
      installMcpConfig(agent, apiKey, 'project');
      const configPath = getAgentConfigPath(agent, 'project');
      const status = wasInstalled ? 'updated' : 'created';
      p.log.success(`${agent.name}: ${configPath} ${status}`);
    }

    // If "all agents" was selected and some don't support project scope,
    // install those globally and let the user know
    if (nonProjectAgents.length > 0) {
      p.log.info(`Installing globally for agents without project scope support:`);
      for (const agent of nonProjectAgents) {
        const wasInstalled = isMcpInstalled(agent, 'global');
        installMcpConfig(agent, apiKey, 'global');
        const status = wasInstalled ? 'updated' : 'installed';
        p.log.success(`${agent.name}: MCP ${status} (global)`);
      }
    }

    const allInstalled = [...projectAgents, ...nonProjectAgents];

    // Update config
    writeConfig({
      apiKey,
      installedAgents: allInstalled.map(a => a.id),
      createdAt: new Date().toISOString(),
    });

    const configPaths = projectAgents
      .map(a => `  ${a.name}: ${pc.dim(getAgentConfigPath(a, 'project'))}`)
      .join('\n');

    let summary = `Config saved to: ${pc.dim(getConfigPath())}\n` +
      `MCP configs:\n${configPaths}\n\n`;

    if (nonProjectAgents.length > 0) {
      const globalPaths = nonProjectAgents
        .map(a => `  ${a.name}: ${pc.dim(getAgentConfigPath(a, 'global'))}`)
        .join('\n');
      summary += `Global configs:\n${globalPaths}\n\n`;
    }

    summary +=
      pc.yellow('Note: Project config files can be committed to share with your team.\n') +
      pc.yellow('Team members will need their own API key.');

    p.note(summary, 'Setup Complete');

    await promptConnectIntegrations(apiKey);

    p.outro('Your AI agents now have access to Pica integrations!');
    return;
  }

  // Global scope: install to all selected agents
  const installedAgentIds: string[] = [];

  for (const agent of selectedAgents) {
    const wasInstalled = isMcpInstalled(agent, 'global');
    installMcpConfig(agent, apiKey, 'global');
    installedAgentIds.push(agent.id);

    const status = wasInstalled ? 'updated' : 'installed';
    p.log.success(`${agent.name}: MCP ${status}`);
  }

  // Save config
  writeConfig({
    apiKey,
    installedAgents: installedAgentIds,
    createdAt: new Date().toISOString(),
  });

  p.note(
    `Config saved to: ${pc.dim(getConfigPath())}`,
    'Setup Complete'
  );

  await promptConnectIntegrations(apiKey);

  p.outro('Your AI agents now have access to Pica integrations!');
}

// ── Welcome banner & post-setup integration prompt ───────────────────

function printBanner(): void {
  console.log();
  console.log(pc.cyan('  ██████████████   ██████   ██████████████   ██████████████'));
  console.log(pc.cyan('  ██████████████   ██████   ██████████████   ██████████████'));
  console.log(pc.cyan('  █████    █████   ██████   █████            █████    █████'));
  console.log(pc.cyan('  █████    █████   ██████   █████            █████    █████'));
  console.log(pc.cyan('  ██████████████   ██████   █████            ██████████████'));
  console.log(pc.cyan('  ██████████████   ██████   █████            ██████████████'));
  console.log(pc.cyan('  █████            ██████   █████            █████    █████'));
  console.log(pc.cyan('  █████            ██████   █████            █████    █████'));
  console.log(pc.cyan('  █████            ██████   ██████████████   █████    █████'));
  console.log(pc.cyan('  █████            ██████   ██████████████   █████    █████'));
  console.log();
  console.log(pc.dim('  U N I V E R S A L   I N T E G R A T I O N S   F O R   A I'));
  console.log();
}

const TOP_INTEGRATIONS = [
  { value: 'gmail', label: 'Gmail', hint: 'Read and send emails' },
  { value: 'google-calendar', label: 'Google Calendar', hint: 'Manage events and schedules' },
  { value: 'notion', label: 'Notion', hint: 'Access pages, databases, and docs' },
];

async function promptConnectIntegrations(apiKey: string): Promise<void> {
  const api = new PicaApi(apiKey);
  const connected: string[] = [];

  // Check which top integrations are already connected
  try {
    const existing = await api.listConnections();
    for (const conn of existing) {
      const match = TOP_INTEGRATIONS.find(
        i => i.value === conn.platform.toLowerCase(),
      );
      if (match) connected.push(match.value);
    }
  } catch {
    // If we can't check, show all options
  }

  let first = true;

  while (true) {
    const available = TOP_INTEGRATIONS.filter(i => !connected.includes(i.value));

    const options: { value: string; label: string; hint?: string }[] = [
      ...available.map(i => ({
        value: i.value,
        label: i.label,
        hint: i.hint,
      })),
      { value: 'more', label: 'Browse all 200+ platforms' },
      { value: 'skip', label: 'Skip for now', hint: 'you can always run pica add later' },
    ];

    const message = first
      ? 'Connect your first integration?'
      : 'Connect another?';

    const choice = await p.select({ message, options });

    if (p.isCancel(choice) || choice === 'skip') {
      break;
    }

    if (choice === 'more') {
      try {
        await open('https://app.picaos.com/connections');
        p.log.info('Opened Pica dashboard in browser.');
      } catch {
        p.note('https://app.picaos.com/connections', 'Open in browser');
      }
      p.log.info(`Connect from the dashboard, or use ${pc.cyan('pica add <platform>')}`);
      break;
    }

    const platform = choice as string;
    const integration = TOP_INTEGRATIONS.find(i => i.value === platform);
    const label = integration?.label ?? platform;

    p.log.info(`Opening browser to connect ${pc.cyan(label)}...`);

    try {
      await openConnectionPage(platform);
    } catch {
      const url = getConnectionUrl(platform);
      p.log.warn('Could not open browser automatically.');
      p.note(url, 'Open manually');
    }

    const spinner = p.spinner();
    spinner.start('Waiting for connection... (complete auth in browser)');

    try {
      await api.waitForConnection(platform, 5 * 60 * 1000, 5000);
      spinner.stop(`${label} connected!`);
      p.log.success(`${pc.green('\u2713')} ${label} is now available to your AI agents`);
      connected.push(platform);
      first = false;
    } catch (error) {
      spinner.stop('Connection timed out');
      if (error instanceof TimeoutError) {
        p.log.warn(`No worries. Connect later with: ${pc.cyan(`pica add ${platform}`)}`);
      }
      first = false;
    }

    // All top integrations connected
    if (TOP_INTEGRATIONS.every(i => connected.includes(i.value))) {
      p.log.success('All top integrations connected!');
      break;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function maskApiKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 8) + '...';
  return key.slice(0, 8) + '...' + key.slice(-4);
}

function updateConfigAgents(agentId: string): void {
  const config = readConfig();
  if (!config) return;
  if (!config.installedAgents.includes(agentId)) {
    config.installedAgents.push(agentId);
    writeConfig(config);
  }
}
