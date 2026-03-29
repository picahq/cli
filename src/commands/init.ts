import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeConfig, readConfig, getConfigPath, getAccessControl } from '../lib/config.js';
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
import { OneApi, TimeoutError } from '../lib/api.js';
import { getApiKeyUrl, openApiKeyPage, openConnectionPage, getConnectionUrl } from '../lib/browser.js';
import { configCommand } from './config.js';
import open from 'open';
import * as output from '../lib/output.js';
import type { Agent } from '../lib/types.js';

export async function initCommand(options: { yes?: boolean; global?: boolean; project?: boolean }): Promise<void> {
  if (output.isAgentMode()) {
    output.error('This command requires interactive input. Run without --agent.');
  }

  const existingConfig = readConfig();

  printBanner();

  if (existingConfig) {
    await handleExistingConfig(existingConfig.apiKey, options);
    return;
  }
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
  const skillInstalled = isSkillInstalled();

  console.log();
  console.log(`  ${pc.bold('Current Setup')}`);
  console.log(`  ${pc.dim('─'.repeat(42))}`);
  console.log(`  ${pc.dim('API Key:')}  ${masked}`);
  console.log(`  ${pc.dim('Skill:')}    ${skillInstalled ? pc.green('installed') : pc.yellow('not installed')}`);
  console.log(`  ${pc.dim('Config:')}   ${getConfigPath()}`);

  // Show access control summary if non-default settings are configured
  const ac = getAccessControl();
  if (Object.keys(ac).length > 0) {
    console.log();
    console.log(`  ${pc.bold('Access Control')}`);
    console.log(`  ${pc.dim('─'.repeat(42))}`);
    if (ac.permissions) console.log(`  ${pc.dim('Permissions:')}   ${ac.permissions}`);
    if (ac.connectionKeys) console.log(`  ${pc.dim('Connections:')}   ${ac.connectionKeys.join(', ')}`);
    if (ac.actionIds) console.log(`  ${pc.dim('Action IDs:')}    ${ac.actionIds.join(', ')}`);
    if (ac.knowledgeAgent) console.log(`  ${pc.dim('Knowledge only:')} yes`);
  }
  console.log();

  // Build action menu
  type Action = 'install-skills' | 'show-prompt' | 'add-connection' | 'update-key' | 'access-control' | 'start-fresh';
  const actionOptions: { value: Action; label: string; hint?: string }[] = [];

  actionOptions.push({
    value: 'install-skills',
    label: skillInstalled ? 'Update skill' : 'Install skill',
    hint: skillInstalled ? 'reinstall latest version' : 'recommended',
  });

  actionOptions.push({
    value: 'show-prompt',
    label: 'Show agent onboarding prompt',
    hint: 'copy-paste to your AI agent',
  });

  actionOptions.push({
    value: 'add-connection',
    label: 'Connect a platform',
    hint: 'add Gmail, Slack, Shopify, etc.',
  });

  actionOptions.push({
    value: 'update-key',
    label: 'Update API key',
  });

  actionOptions.push({
    value: 'access-control',
    label: 'Configure access control',
    hint: 'permissions, connections, actions',
  });

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
    case 'install-skills': {
      const success = await promptSkillInstall();
      if (success) {
        printOnboardingPrompt();
        p.outro('Skill installed. Paste the prompt above to your AI agent.');
      } else {
        p.outro('Done.');
      }
      break;
    }
    case 'show-prompt':
      printOnboardingPrompt();
      p.outro('Paste the prompt above to your AI agent.');
      break;
    case 'add-connection':
      await promptConnectIntegrations(apiKey);
      p.outro('Done.');
      break;
    case 'update-key':
      await handleUpdateKey(statuses);
      break;
    case 'access-control':
      await configCommand();
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
    message: 'Enter your new One API key:',
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

  const api = new OneApi(newKey);
  const isValid = await api.validateApiKey();

  if (!isValid) {
    spinner.stop('Invalid API key');
    p.cancel(`Invalid API key. Get a valid key at ${getApiKeyUrl()}`);
    process.exit(1);
  }

  spinner.stop('API key validated');

  // Re-install MCP to every agent that currently has it (preserve scopes)
  const ac = getAccessControl();
  const reinstalled: string[] = [];
  for (const s of statuses) {
    if (s.globalMcp) {
      installMcpConfig(s.agent, newKey, 'global', ac);
      reinstalled.push(`${s.agent.name} (global)`);
    }
    if (s.projectMcp) {
      installMcpConfig(s.agent, newKey, 'project', ac);
      reinstalled.push(`${s.agent.name} (project)`);
    }
  }

  // Update config (preserve accessControl)
  const config = readConfig();
  writeConfig({
    apiKey: newKey,
    installedAgents: config?.installedAgents ?? [],
    createdAt: config?.createdAt ?? new Date().toISOString(),
    accessControl: config?.accessControl,
  });

  if (reinstalled.length > 0) {
    p.log.success(`Updated MCP configs: ${reinstalled.join(', ')}`);
  }

  p.outro('API key updated.');
}

async function handleInstallMore(apiKey: string, missing: AgentStatus[]): Promise<void> {
  const ac = getAccessControl();

  if (missing.length === 1) {
    // Only one option, just confirm
    const agent = missing[0].agent;
    const confirm = await p.confirm({
      message: `Install One MCP to ${agent.name}?`,
      initialValue: true,
    });

    if (p.isCancel(confirm) || !confirm) {
      p.outro('No changes made.');
      return;
    }

    installMcpConfig(agent, apiKey, 'global', ac);
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
    installMcpConfig(s.agent, apiKey, 'global', ac);
    updateConfigAgents(s.agent.id);
    p.log.success(`${s.agent.name}: MCP installed`);
  }

  p.outro('Done.');
}

async function handleInstallProject(apiKey: string, missing: AgentStatus[]): Promise<void> {
  const ac = getAccessControl();

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

    installMcpConfig(agent, apiKey, 'project', ac);
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
    installMcpConfig(s.agent, apiKey, 'project', ac);
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

// ── Skill installer ───────────────────────────────────────────────────

interface SkillAgent {
  id: string;
  name: string;
  skillDir: string; // relative to home, e.g. '.claude/skills'
  primary?: boolean; // show in the default list
}

const SKILL_AGENTS: SkillAgent[] = [
  { id: 'claude-code', name: 'Claude Code', skillDir: '.claude/skills', primary: true },
  { id: 'claude-desktop', name: 'Claude Desktop', skillDir: '.claude/skills', primary: true },
  { id: 'codex', name: 'Codex', skillDir: '.codex/skills', primary: true },
  { id: 'cursor', name: 'Cursor', skillDir: '.cursor/skills' },
  { id: 'windsurf', name: 'Windsurf', skillDir: '.codeium/windsurf/skills' },
  { id: 'kiro', name: 'Kiro', skillDir: '.kiro/skills' },
  { id: 'goose', name: 'Goose', skillDir: '.config/goose/skills' },
  { id: 'amp', name: 'Amp', skillDir: '.amp/skills' },
  { id: 'opencode', name: 'OpenCode', skillDir: '.opencode/skills' },
  { id: 'roo', name: 'Roo', skillDir: '.roo/skills' },
];

// Canonical location — shared by universal agents
const CANONICAL_SKILL_DIR = '.agents/skills';

function getSkillSourceDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', 'skills', 'one');
}

function getCanonicalSkillPath(): string {
  return path.join(os.homedir(), CANONICAL_SKILL_DIR, 'one');
}

function getAgentSkillPath(agent: SkillAgent): string {
  return path.join(os.homedir(), agent.skillDir, 'one');
}

function isSkillInstalled(): boolean {
  return fs.existsSync(path.join(getCanonicalSkillPath(), 'SKILL.md'));
}

function isSkillInstalledForAgent(agent: SkillAgent): boolean {
  return fs.existsSync(path.join(getAgentSkillPath(agent), 'SKILL.md'));
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function installSkillForAgents(agentIds: string[]): { installed: string[]; failed: string[] } {
  const source = getSkillSourceDir();
  const canonical = getCanonicalSkillPath();
  const installed: string[] = [];
  const failed: string[] = [];

  // Verify source exists
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    return { installed: [], failed: ['skill source not found'] };
  }

  // Step 1: Copy to canonical location
  try {
    if (fs.existsSync(canonical)) {
      fs.rmSync(canonical, { recursive: true });
    }
    copyDirSync(source, canonical);
  } catch {
    return { installed: [], failed: ['canonical copy'] };
  }

  // Step 2: Symlink for each selected agent
  // Deduplicate by skillDir (e.g. claude-code and claude-desktop share .claude/skills)
  const seen = new Map<string, boolean>(); // path -> success
  for (const id of agentIds) {
    const agent = SKILL_AGENTS.find(a => a.id === id);
    if (!agent) continue;

    const agentPath = getAgentSkillPath(agent);

    // If we already processed this path, mirror its result
    if (seen.has(agentPath)) {
      (seen.get(agentPath) ? installed : failed).push(agent.name);
      continue;
    }

    try {
      const agentSkillsDir = path.dirname(agentPath);
      fs.mkdirSync(agentSkillsDir, { recursive: true });

      // Remove existing (real dir or symlink, including broken ones)
      try { fs.lstatSync(agentPath); fs.rmSync(agentPath, { recursive: true }); } catch { /* doesn't exist */ }

      const relative = path.relative(agentSkillsDir, canonical);
      fs.symlinkSync(relative, agentPath);
      installed.push(agent.name);
      seen.set(agentPath, true);
    } catch {
      failed.push(agent.name);
      seen.set(agentPath, false);
    }
  }

  return { installed, failed };
}

async function promptSkillInstall(): Promise<boolean> {
  const primaryAgents = SKILL_AGENTS.filter(a => a.primary);
  const otherAgents = SKILL_AGENTS.filter(a => !a.primary);

  const options: { value: string; label: string; hint?: string }[] = [
    ...primaryAgents.map(a => ({
      value: a.id,
      label: a.name,
      hint: isSkillInstalledForAgent(a) ? pc.green('installed') : undefined,
    })),
    {
      value: '_other',
      label: 'Other agents',
      hint: otherAgents.map(a => a.name).join(', '),
    },
  ];

  const choice = await p.multiselect({
    message: 'Install the One skill to:',
    options,
    initialValues: primaryAgents.map(a => a.id),
  });

  if (p.isCancel(choice)) {
    return false;
  }

  let selectedIds = choice as string[];

  // If "Other agents" was selected, show the expanded list
  if (selectedIds.includes('_other')) {
    selectedIds = selectedIds.filter(id => id !== '_other');

    const otherChoice = await p.multiselect({
      message: 'Select additional agents:',
      options: otherAgents.map(a => ({
        value: a.id,
        label: a.name,
        hint: isSkillInstalledForAgent(a) ? pc.green('installed') : undefined,
      })),
    });

    if (!p.isCancel(otherChoice)) {
      selectedIds.push(...(otherChoice as string[]));
    }
  }

  if (selectedIds.length === 0) {
    p.log.info('No agents selected.');
    return false;
  }

  const spinner = p.spinner();
  spinner.start('Installing skill...');
  const { installed, failed } = installSkillForAgents(selectedIds);
  spinner.stop(installed.length > 0 ? 'Skill installed' : 'Installation failed');

  for (const name of installed) {
    p.log.success(`${name}: ${pc.green('\u2713')} skill installed`);
  }
  for (const name of failed) {
    p.log.warn(`${name}: failed to install`);
  }

  return installed.length > 0;
}

// ── Onboarding prompt ─────────────────────────────────────────────────

function printOnboardingPrompt(): void {
  console.log();
  console.log(pc.bold('  Copy-paste this to your AI agent:'));
  console.log();
  console.log(pc.cyan('  ┌─────────────────────────────────────────────────────────────'));
  console.log(pc.cyan('  │'));
  console.log(pc.cyan('  │  The One CLI (`one`) is now installed on this machine. It'));
  console.log(pc.cyan('  │  lets you interact with 250+ third-party platforms (Gmail,'));
  console.log(pc.cyan('  │  Slack, Shopify, HubSpot, Stripe, GitHub, etc.) through'));
  console.log(pc.cyan('  │  their APIs. Whenever you need to interact with any'));
  console.log(pc.cyan('  │  third-party platform or external service, use the `one`'));
  console.log(pc.cyan('  │  skill. Please save this to your project instructions or'));
  console.log(pc.cyan('  │  memory so you remember it in future conversations.'));
  console.log(pc.cyan('  │'));
  console.log(pc.cyan('  └─────────────────────────────────────────────────────────────'));
  console.log();
}

// ── MCP install helper (extracted from freshSetup) ────────────────────

async function promptAndInstallMcp(
  apiKey: string,
  options: { yes?: boolean; global?: boolean; project?: boolean },
): Promise<void> {
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
    p.log.info('Skipped MCP installation.');
    return;
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
      p.log.info('Skipped MCP installation.');
      return;
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
      p.log.warn('Run again and choose global scope or a different agent.');
      return;
    }

    for (const agent of projectAgents) {
      const wasInstalled = isMcpInstalled(agent, 'project');
      installMcpConfig(agent, apiKey, 'project');
      const configPath = getAgentConfigPath(agent, 'project');
      const status = wasInstalled ? 'updated' : 'created';
      p.log.success(`${agent.name}: ${configPath} ${status}`);
    }

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
    updateConfigAgentsList(allInstalled.map(a => a.id));

    p.note(
      pc.yellow('Project config files can be committed to share with your team.\n') +
      pc.yellow('Team members will need their own API key.'),
      'Tip',
    );
    return;
  }

  // Global scope
  const installedAgentIds: string[] = [];

  for (const agent of selectedAgents) {
    const wasInstalled = isMcpInstalled(agent, 'global');
    installMcpConfig(agent, apiKey, 'global');
    installedAgentIds.push(agent.id);

    const status = wasInstalled ? 'updated' : 'installed';
    p.log.success(`${agent.name}: MCP ${status}`);
  }

  updateConfigAgentsList(installedAgentIds);
}

// ── First-run setup (no existing config) ─────────────────────────────

async function freshSetup(options: { yes?: boolean; global?: boolean; project?: boolean }): Promise<void> {
  // Step 1: Get API key
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
    message: 'Enter your One API key:',
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

  const api = new OneApi(apiKey);
  const isValid = await api.validateApiKey();

  if (!isValid) {
    spinner.stop('Invalid API key');
    p.cancel(`Invalid API key. Get a valid key at ${getApiKeyUrl()}`);
    process.exit(1);
  }

  spinner.stop('API key validated');

  // Save API key to config
  writeConfig({
    apiKey,
    installedAgents: [],
    createdAt: new Date().toISOString(),
  });

  // Step 2: Install skill
  await promptSkillInstall();

  // Step 3: Connect integrations
  await promptConnectIntegrations(apiKey);

  p.note(
    `Config saved to: ${pc.dim(getConfigPath())}`,
    'Setup Complete'
  );

  printOnboardingPrompt();

  p.outro('Done! Paste the prompt above to your AI agent.');
}

// ── Welcome banner & post-setup integration prompt ───────────────────

function printBanner(): void {
  console.log();
  console.log(pc.yellow('  ██████████████   ██████     ██████   ██████████████'));
  console.log(pc.yellow('  ██████████████   ███████    ██████   ██████████████'));
  console.log(pc.yellow('  ██████    ████   ████████   ██████   ██████       '));
  console.log(pc.yellow('  ██████    ████   ██████████ ██████   ██████       '));
  console.log(pc.yellow('  ██████    ████   ██████ ██████████   ██████████   '));
  console.log(pc.yellow('  ██████    ████   ██████  █████████   ██████████   '));
  console.log(pc.yellow('  ██████    ████   ██████   ████████   ██████       '));
  console.log(pc.yellow('  ██████    ████   ██████    ███████   ██████       '));
  console.log(pc.yellow('  ██████████████   ██████     ██████   ██████████████'));
  console.log(pc.yellow('  ██████████████   ██████      █████   ██████████████'));
  console.log();
  console.log(pc.dim('  I N F R A S T R U C T U R E   F O R   A G E N T S'));
  console.log();
}

const TOP_INTEGRATIONS = [
  { value: 'gmail', label: 'Gmail', hint: 'Read and send emails' },
  { value: 'google-calendar', label: 'Google Calendar', hint: 'Manage events and schedules' },
  { value: 'notion', label: 'Notion', hint: 'Access pages, databases, and docs' },
];

async function promptConnectIntegrations(apiKey: string): Promise<void> {
  const api = new OneApi(apiKey);
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
      { value: 'skip', label: 'Skip for now', hint: 'you can always run one add later' },
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
        await open('https://app.withone.ai/connections');
        p.log.info('Opened One dashboard in browser.');
      } catch {
        p.note('https://app.withone.ai/connections', 'Open in browser');
      }
      p.log.info(`Connect from the dashboard, or use ${pc.cyan('one add <platform>')}`);
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
        p.log.warn(`No worries. Connect later with: ${pc.cyan(`one add ${platform}`)}`);
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

function updateConfigAgentsList(agentIds: string[]): void {
  const config = readConfig();
  if (!config) return;
  for (const id of agentIds) {
    if (!config.installedAgents.includes(id)) {
      config.installedAgents.push(id);
    }
  }
  writeConfig(config);
}
