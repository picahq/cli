import fs from 'node:fs';
import * as p from '@clack/prompts';
import {
  getApiKey,
  readGlobalConfig,
  readProjectConfig,
  getGlobalConfigPath,
  getProjectConfigPath,
  getEnvFromApiKey,
} from '../lib/config.js';
import * as output from '../lib/output.js';
import type { Config } from '../lib/types.js';

function formatWhoami(config: Config, apiKey: string, pc: typeof import('picocolors').default): string[] {
  const whoami = config.whoami;
  const env = getEnvFromApiKey(apiKey);
  const envLabel = env === 'test' ? pc.yellow('test') : pc.green('live');
  const lines: string[] = [];

  if (whoami) {
    const contextParts: string[] = [];
    if (whoami.organization) contextParts.push(whoami.organization.name);
    if (whoami.project) contextParts.push(whoami.project.name);
    const scopeDisplay = contextParts.length > 0 ? contextParts.join(' / ') : 'Personal';
    lines.push(`${pc.bold(scopeDisplay)} ${pc.dim('·')} ${envLabel}`);
    lines.push(`${whoami.user.name} ${pc.dim(`(${whoami.user.email})`)}`);
  } else {
    lines.push(`${pc.dim('Key:')} ${apiKey.slice(0, 8)}... ${pc.dim('·')} ${envLabel}`);
  }

  return lines;
}

export async function logoutCommand(): Promise<void> {
  const apiKey = getApiKey();

  if (!apiKey) {
    if (output.isAgentMode()) {
      output.json({ error: 'Not logged in.' });
      process.exit(1);
    }
    output.error('Not logged in. Run: one login');
    return;
  }

  if (output.isAgentMode()) {
    // Agent mode: clear resolved config, no prompts
    const globalPath = getGlobalConfigPath();
    const projectPath = getProjectConfigPath();
    let cleared = false;
    if (fs.existsSync(projectPath)) { fs.unlinkSync(projectPath); cleared = true; }
    if (fs.existsSync(globalPath)) { fs.unlinkSync(globalPath); cleared = true; }
    output.json({ status: cleared ? 'logged_out' : 'not_logged_in', message: cleared ? 'Credentials cleared.' : 'No config found.' });
    return;
  }

  const pc = (await import('picocolors')).default;
  const globalConfig = readGlobalConfig();
  const projectConfig = readProjectConfig();
  const hasGlobal = globalConfig?.apiKey != null;
  const hasProject = projectConfig?.apiKey != null;

  // Build scope options based on what exists
  type LogoutScope = 'global' | 'project' | 'both';
  let targetScope: LogoutScope;

  if (hasGlobal && hasProject) {
    // Both exist — let user choose
    const infoLines = ['You are logged in with multiple configs.', ''];
    if (projectConfig) {
      infoLines.push(`${pc.cyan('Local config:')}`);
      infoLines.push(...formatWhoami(projectConfig, projectConfig.apiKey, pc));
      infoLines.push('');
    }
    if (globalConfig) {
      infoLines.push(`${pc.magenta('Global config:')}`);
      infoLines.push(...formatWhoami(globalConfig, globalConfig.apiKey, pc));
    }
    p.note(infoLines.join('\n'));

    const choice = await p.select({
      message: 'What would you like to log out of?',
      options: [
        { value: 'project', label: 'This directory', hint: 'local config only' },
        { value: 'global', label: 'Globally', hint: 'global config only' },
        { value: 'both', label: 'Both', hint: 'remove all credentials' },
      ],
    });
    if (p.isCancel(choice)) {
      p.cancel('Logout cancelled.');
      return;
    }
    targetScope = choice as LogoutScope;
  } else if (hasProject) {
    const infoLines = ['You are logged in.', ''];
    infoLines.push(`${pc.dim('Stored in')} ${pc.cyan('local config')}`);
    infoLines.push(...formatWhoami(projectConfig!, projectConfig!.apiKey, pc));
    p.note(infoLines.join('\n'));
    targetScope = 'project';
  } else if (hasGlobal) {
    const infoLines = ['You are logged in.', ''];
    infoLines.push(`${pc.dim('Stored in')} ${pc.magenta('global config')}`);
    infoLines.push(...formatWhoami(globalConfig!, globalConfig!.apiKey, pc));
    p.note(infoLines.join('\n'));
    targetScope = 'global';
  } else {
    // Key comes from env var or .onerc — no config file to delete
    p.log.warn('Credentials are set via environment variable or .onerc, not a config file.');
    p.log.info('Remove the ONE_SECRET variable from your environment or .onerc file.');
    p.outro('Nothing to remove.');
    return;
  }

  // Confirm
  const scopeLabels: Record<LogoutScope, string> = {
    project: 'local',
    global: 'global',
    both: 'all',
  };
  const confirm = await p.confirm({
    message: `Remove ${scopeLabels[targetScope]} credentials?`,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.cancel('Logout cancelled.');
    return;
  }

  // Delete
  if (targetScope === 'project' || targetScope === 'both') {
    const projectPath = getProjectConfigPath();
    if (fs.existsSync(projectPath)) fs.unlinkSync(projectPath);
  }
  if (targetScope === 'global' || targetScope === 'both') {
    const globalPath = getGlobalConfigPath();
    if (fs.existsSync(globalPath)) fs.unlinkSync(globalPath);
  }

  p.log.success('Credentials cleared.');
  p.log.info('Your API key is still active. Manage keys at app.withone.ai/settings');
  p.outro('Logged out.');
}
