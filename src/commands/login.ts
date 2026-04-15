import http from 'node:http';
import crypto from 'node:crypto';
import * as p from '@clack/prompts';
import { OneApi, ApiError } from '../lib/api.js';
import { getApiKey, writeConfig, resolveConfig, readGlobalConfig, readProjectConfig, getApiBase, getEnvFromApiKey, type ConfigScope } from '../lib/config.js';
import { getCliAuthUrl, openCliAuthPage } from '../lib/browser.js';
import * as output from '../lib/output.js';
import type { WhoAmIResponse } from '../lib/types.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PORT_RANGE_START = 49152;
const PORT_RANGE_END = 65535;
const MAX_PORT_ATTEMPTS = 5;
const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>One CLI</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa">
<div style="text-align:center">
<div style="width:48px;height:48px;border-radius:50%;background:rgba(34,197,94,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
<svg width="24" height="24" fill="none" stroke="#22c55e" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
</div>
<h1 style="font-size:20px;margin:0 0 8px">You're all set!</h1>
<p style="color:#a1a1aa;font-size:14px">Return to your terminal. You can close this tab.</p>
</div></body></html>`;

interface CallbackPayload {
  apiKey: string;
  state: string;
}

function randomPort(): number {
  return PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
}

function startCallbackServer(
  expectedState: string
): Promise<{ server: http.Server; port: number; result: Promise<CallbackPayload> }> {
  return new Promise((resolveSetup, rejectSetup) => {
    let attempts = 0;

    function tryListen() {
      const port = randomPort();
      attempts++;

      let resolveResult: (value: CallbackPayload) => void;
      const result = new Promise<CallbackPayload>((res) => {
        resolveResult = res;
      });

      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);

        if (url.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const encodedKey = url.searchParams.get('s');
        const state = url.searchParams.get('state');

        const apiKey = encodedKey ? Buffer.from(encodedKey, 'base64').toString('utf-8') : null;

        if (!apiKey || !state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing required parameters');
          return;
        }

        if (state !== expectedState) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('State mismatch');
          return;
        }

        // Serve success page to the browser
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        resolveResult({ apiKey, state });
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempts < MAX_PORT_ATTEMPTS) {
          tryListen();
          return;
        }
        rejectSetup(err);
      });

      server.listen(port, '127.0.0.1', () => {
        resolveSetup({ server, port, result });
      });
    }

    tryListen();
  });
}

// ── Reusable browser auth flow ──────────────────────────────────────
// Returns { apiKey, whoami } on success, null on failure/cancel.
// Handles the local callback server, browser open, and whoami validation.
// Does NOT handle scope selection, credential saving, or post-login UX.

export interface BrowserLoginResult {
  apiKey: string;
  whoami: WhoAmIResponse;
}

export async function browserLogin(): Promise<BrowserLoginResult | null> {
  const state = crypto.randomUUID();
  const spin = p.spinner();

  let server: http.Server;
  let port: number;
  let resultPromise: Promise<CallbackPayload>;

  try {
    ({ server, port, result: resultPromise } = await startCallbackServer(state));
  } catch {
    output.error('Could not start local server. Try: one init');
    return null;
  }

  const authUrl = getCliAuthUrl(port, state);

  p.note(
    `If the browser doesn't open, visit:\n${authUrl}`,
    'Opening browser for authentication...'
  );

  try {
    await openCliAuthPage(port, state);
  } catch {
    // Browser open failed — URL is already displayed above
  }

  spin.start('Waiting for authentication... (timeout: 5 min)');

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, LOGIN_TIMEOUT_MS);
    timer.unref();
  });

  try {
    const payload = await Promise.race([resultPromise, timeout]);
    spin.stop('Authentication received!');

    // Fetch whoami
    const apiBase = getApiBase();
    const api = new OneApi(payload.apiKey, apiBase);
    const whoami = await api.whoami();

    return { apiKey: payload.apiKey, whoami };
  } catch (err) {
    spin.stop('Authentication failed.');
    if (err instanceof Error && err.message === 'timeout') {
      output.error('Authentication timed out (5 min). Try again with: one login');
    } else if (err instanceof ApiError) {
      output.error(`Authentication failed: ${err.message}`);
    } else {
      output.error('Authentication failed. Try: one init');
    }
    return null;
  } finally {
    server!.closeAllConnections();
    server!.close();
  }
}

// ── Standalone login command ────────────────────────────────────────

function saveCredentials(apiKey: string, scope: ConfigScope): void {
  const existing = scope === 'project' ? readProjectConfig() : readGlobalConfig();
  writeConfig({
    apiKey,
    installedAgents: existing?.installedAgents ?? [],
    createdAt: new Date().toISOString(),
    accessControl: existing?.accessControl,
    cacheTtl: existing?.cacheTtl,
    apiBase: existing?.apiBase,
  }, scope);
}

export async function loginCommand(): Promise<void> {
  if (output.isAgentMode()) {
    output.json({ error: 'Browser login not available in agent mode. Use: one init' });
    return;
  }

  // Determine login scope
  let targetScope: ConfigScope = 'global';
  const existingKey = getApiKey();

  if (existingKey) {
    // Show current session info (same format as `one whoami`)
    const pc = (await import('picocolors')).default;
    const resolved = resolveConfig();
    const whoami = resolved.config?.whoami;
    const env = getEnvFromApiKey(existingKey);
    const envLabel = env === 'test' ? pc.yellow('test') : pc.green('live');
    const currentScope = resolved.scope === 'project'
      ? pc.cyan('local config')
      : pc.magenta('global config');

    const lines: string[] = ['You are already logged in.', ''];
    if (whoami) {
      const contextParts: string[] = [];
      if (whoami.organization) contextParts.push(whoami.organization.name);
      if (whoami.project) contextParts.push(whoami.project.name);
      const scopeDisplay = contextParts.length > 0 ? contextParts.join(' / ') : 'Personal';
      lines.push(`${pc.bold(scopeDisplay)} ${pc.dim('·')} ${envLabel}`);
      lines.push(`${whoami.user.name} ${pc.dim(`(${whoami.user.email})`)}`);
      if (whoami.organization) lines.push(`${pc.dim('Org:')} ${whoami.organization.name}`);
      if (whoami.project) lines.push(`${pc.dim('Project:')} ${whoami.project.name}`);
    }
    lines.push('');
    lines.push(`${pc.dim('Stored in')} ${currentScope}`);
    p.note(lines.join('\n'));

    // Let user pick scope for new login
    const scopeChoice = await p.select({
      message: 'Where would you like to log in?',
      options: [
        { value: 'global', label: 'Globally', hint: 'applies everywhere' },
        { value: 'project', label: 'This directory', hint: 'only this project' },
      ],
    });
    if (p.isCancel(scopeChoice)) {
      p.cancel('Login cancelled.');
      return;
    }
    targetScope = scopeChoice as ConfigScope;
  }

  // Run browser auth
  const result = await browserLogin();
  if (!result) return;

  const { apiKey, whoami } = result;

  // Save credentials and whoami
  saveCredentials(apiKey, targetScope);
  const resolved = resolveConfig();
  if (resolved.config) {
    writeConfig({ ...resolved.config, whoami }, targetScope);
  }

  // Display result
  const pc = (await import('picocolors')).default;
  const env = getEnvFromApiKey(apiKey);
  const contextParts: string[] = [];
  if (whoami.organization) contextParts.push(whoami.organization.name);
  if (whoami.project) contextParts.push(whoami.project.name);
  const scopeDisplay = contextParts.length > 0 ? contextParts.join(' / ') : 'Personal';
  const envLabel = env === 'test' ? pc.yellow('test') : pc.green('live');
  const configLabel = targetScope === 'project'
    ? pc.cyan('local config')
    : pc.magenta('global config');

  const infoLines = [
    `${pc.bold(scopeDisplay)} ${pc.dim('·')} ${envLabel}`,
    `${whoami.user.name} ${pc.dim(`(${whoami.user.email})`)}`,
  ];
  if (whoami.organization) infoLines.push(`${pc.dim('Org:')} ${whoami.organization.name}`);
  if (whoami.project) infoLines.push(`${pc.dim('Project:')} ${whoami.project.name}`);
  infoLines.push('');
  infoLines.push(`${pc.dim('Stored in')} ${configLabel}`);
  p.note(infoLines.join('\n'), 'Logged in');

  console.log();
  console.log(`  ${pc.dim('Next steps:')}`);
  console.log(`  ${pc.cyan('one add <platform>')}  ${pc.dim('—')} Connect a platform (e.g. gmail, slack, stripe)`);
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
  p.outro('Happy building!');
}
