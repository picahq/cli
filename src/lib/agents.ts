import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { Agent } from './types.js';

export type InstallScope = 'global' | 'project';

function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function getClaudeDesktopConfigPath(): string {
  switch (process.platform) {
    case 'darwin':
      return '~/Library/Application Support/Claude/claude_desktop_config.json';
    case 'win32':
      return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
    default:
      return '~/.config/Claude/claude_desktop_config.json';
  }
}

function getClaudeDesktopDetectDir(): string {
  switch (process.platform) {
    case 'darwin':
      return '~/Library/Application Support/Claude';
    case 'win32':
      return path.join(process.env.APPDATA || '', 'Claude');
    default:
      return '~/.config/Claude';
  }
}

function getWindsurfConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  }
  return '~/.codeium/windsurf/mcp_config.json';
}

function getWindsurfDetectDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || os.homedir(), '.codeium', 'windsurf');
  }
  return '~/.codeium/windsurf';
}

function getCursorConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || os.homedir(), '.cursor', 'mcp.json');
  }
  return '~/.cursor/mcp.json';
}

const AGENTS: Agent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    configPath: '~/.claude.json',
    configKey: 'mcpServers',
    detectDir: '~/.claude',
    projectConfigPath: '.mcp.json',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    configPath: getClaudeDesktopConfigPath(),
    configKey: 'mcpServers',
    detectDir: getClaudeDesktopDetectDir(),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    configPath: getCursorConfigPath(),
    configKey: 'mcpServers',
    detectDir: '~/.cursor',
    projectConfigPath: '.cursor/mcp.json',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    configPath: getWindsurfConfigPath(),
    configKey: 'mcpServers',
    detectDir: getWindsurfDetectDir(),
  },
  {
    id: 'codex',
    name: 'Codex',
    configPath: '~/.codex/config.toml',
    configKey: 'mcp_servers',
    detectDir: '~/.codex',
    projectConfigPath: '.codex/config.toml',
    configFormat: 'toml',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    configPath: '~/.kiro/settings/mcp.json',
    configKey: 'mcpServers',
    detectDir: '~/.kiro',
    projectConfigPath: '.kiro/settings/mcp.json',
  },
];

export function getAllAgents(): Agent[] {
  return AGENTS;
}

export function detectInstalledAgents(): Agent[] {
  return AGENTS.filter(agent => {
    const detectDir = expandPath(agent.detectDir);
    return fs.existsSync(detectDir);
  });
}

export function supportsProjectScope(agent: Agent): boolean {
  return agent.projectConfigPath !== undefined;
}

export function getAgentConfigPath(agent: Agent, scope: InstallScope = 'global'): string {
  if (scope === 'project' && agent.projectConfigPath) {
    return path.join(process.cwd(), agent.projectConfigPath);
  }
  return expandPath(agent.configPath);
}

export function readAgentConfig(agent: Agent, scope: InstallScope = 'global'): Record<string, unknown> {
  const configPath = getAgentConfigPath(agent, scope);
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    if (agent.configFormat === 'toml') {
      return parseToml(content) as Record<string, unknown>;
    }
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function writeAgentConfig(agent: Agent, config: Record<string, unknown>, scope: InstallScope = 'global'): void {
  const configPath = getAgentConfigPath(agent, scope);
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (agent.configFormat === 'toml') {
    fs.writeFileSync(configPath, stringifyToml(config));
  } else {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
}

export function getMcpServerConfig(apiKey: string): Record<string, unknown> {
  return {
    command: 'npx',
    args: ['-y', '@picahq/mcp'],
    env: {
      PICA_SECRET: apiKey,
    },
  };
}

export function installMcpConfig(agent: Agent, apiKey: string, scope: InstallScope = 'global'): void {
  const config = readAgentConfig(agent, scope);
  const configKey = agent.configKey;

  const mcpServers = (config[configKey] as Record<string, unknown>) || {};
  mcpServers['pica'] = getMcpServerConfig(apiKey);

  config[configKey] = mcpServers;
  writeAgentConfig(agent, config, scope);
}

export function isMcpInstalled(agent: Agent, scope: InstallScope = 'global'): boolean {
  const config = readAgentConfig(agent, scope);
  const configKey = agent.configKey;
  const mcpServers = config[configKey] as Record<string, unknown> | undefined;
  return mcpServers?.['pica'] !== undefined;
}

export function getProjectConfigPaths(agents: Agent[]): string[] {
  const paths: string[] = [];
  for (const agent of agents) {
    if (agent.projectConfigPath) {
      paths.push(path.join(process.cwd(), agent.projectConfigPath));
    }
  }
  return paths;
}

export interface AgentStatus {
  agent: Agent;
  detected: boolean;
  globalMcp: boolean;
  projectMcp: boolean | null; // null = agent doesn't support project scope
}

export function getAgentStatuses(): AgentStatus[] {
  return AGENTS.map(agent => {
    const detected = fs.existsSync(expandPath(agent.detectDir));
    const globalMcp = detected && isMcpInstalled(agent, 'global');
    const projectMcp = agent.projectConfigPath
      ? isMcpInstalled(agent, 'project')
      : null;
    return { agent, detected, globalMcp, projectMcp };
  });
}
