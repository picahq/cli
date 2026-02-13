import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getApiKey } from '../lib/config.js';
import { PicaApi } from '../lib/api.js';
import { extractPathVariables, resolveTemplateVariables } from '../lib/actions.js';
import { printTable } from '../lib/table.js';
import type { PlatformAction, ActionKnowledge } from '../lib/types.js';

function getApi(): PicaApi {
  const apiKey = getApiKey();
  if (!apiKey) {
    p.cancel('Not configured. Run `pica init` first.');
    process.exit(1);
  }
  return new PicaApi(apiKey);
}

function colorMethod(method: string): string {
  const m = method.toUpperCase();
  switch (m) {
    case 'GET': return pc.green(m);
    case 'POST': return pc.yellow(m);
    case 'PUT': return pc.blue(m);
    case 'PATCH': return pc.cyan(m);
    case 'DELETE': return pc.red(m);
    default: return pc.dim(m);
  }
}

function padMethod(method: string): string {
  return method.toUpperCase().padEnd(7);
}

// --- Search ---

export async function actionsSearchCommand(
  platform: string,
  query?: string,
  options: { json?: boolean; limit?: string } = {}
): Promise<void> {
  const api = getApi();

  if (!query) {
    const input = await p.text({
      message: `Search actions on ${pc.cyan(platform)}:`,
      placeholder: 'send email, create contact, list orders...',
    });
    if (p.isCancel(input)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    query = input;
  }

  const spinner = p.spinner();
  spinner.start(`Searching ${platform} actions...`);

  try {
    const limit = options.limit ? parseInt(options.limit, 10) : 10;
    const actions = await api.searchActions(platform, query, limit);
    spinner.stop(`${actions.length} action${actions.length === 1 ? '' : 's'} found`);

    if (options.json) {
      console.log(JSON.stringify(actions, null, 2));
      return;
    }

    if (actions.length === 0) {
      p.note(`No actions found for "${query}" on ${platform}.`, 'No Results');
      return;
    }

    console.log();

    const rows = actions.map(action => ({
      method: colorMethod(padMethod(action.method)),
      path: action.path,
      title: action.title,
      id: action._id,
    }));

    printTable(
      [
        { key: 'method', label: 'Method' },
        { key: 'title', label: 'Title' },
        { key: 'path', label: 'Path', color: pc.dim },
        { key: 'id', label: 'Action ID', color: pc.dim },
      ],
      rows
    );

    console.log();
    p.note(
      `Get docs:  ${pc.cyan('pica actions knowledge <actionId>')}\n` +
      `Execute:   ${pc.cyan('pica actions execute <actionId>')}`,
      'Next Steps'
    );
  } catch (error) {
    spinner.stop('Search failed');
    p.cancel(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

// --- Knowledge ---

export async function actionsKnowledgeCommand(
  actionId: string,
  options: { json?: boolean; full?: boolean } = {}
): Promise<void> {
  const api = getApi();

  const spinner = p.spinner();
  spinner.start('Loading action knowledge...');

  try {
    const knowledge = await api.getActionKnowledge(actionId);
    spinner.stop('Action knowledge loaded');

    if (!knowledge) {
      p.cancel(`No knowledge found for action: ${actionId}`);
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(knowledge, null, 2));
      return;
    }

    printKnowledge(knowledge, options.full);
  } catch (error) {
    spinner.stop('Failed to load knowledge');
    p.cancel(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

function printKnowledge(k: ActionKnowledge, full?: boolean): void {
  console.log();
  console.log(pc.bold(`  ${k.title}`));
  console.log();
  console.log(`  Platform:  ${pc.cyan(k.connectionPlatform)}`);
  console.log(`  Method:    ${colorMethod(k.method)}`);
  console.log(`  Path:      ${k.path}`);
  console.log(`  Base URL:  ${pc.dim(k.baseUrl)}`);

  if (k.tags?.length) {
    console.log(`  Tags:      ${k.tags.map(t => pc.dim(t)).join(', ')}`);
  }

  const pathVars = extractPathVariables(k.path);
  if (pathVars.length > 0) {
    console.log(`  Path Vars: ${pathVars.map(v => pc.yellow(`{{${v}}}`)).join(', ')}`);
  }

  console.log(`  Active:    ${k.active ? pc.green('yes') : pc.red('no')}`);
  console.log(`  ID:        ${pc.dim(k._id)}`);

  if (k.knowledge) {
    console.log();
    console.log(pc.bold('  API Documentation'));
    console.log(pc.dim('  ' + '─'.repeat(40)));
    console.log();

    const lines = k.knowledge.split('\n');
    const displayLines = full ? lines : lines.slice(0, 50);

    for (const line of displayLines) {
      console.log(`  ${line}`);
    }

    if (!full && lines.length > 50) {
      console.log();
      console.log(pc.dim(`  ... ${lines.length - 50} more lines. Use --full to see all.`));
    }
  }

  console.log();
}

// --- Execute ---

export async function actionsExecuteCommand(
  actionId: string,
  options: {
    json?: boolean;
    connection?: string;
    data?: string;
    pathVar?: string[];
    query?: string[];
    formData?: boolean;
    formUrlencoded?: boolean;
  } = {}
): Promise<void> {
  const api = getApi();

  // 1. Fetch action knowledge to get method + path
  const spinner = p.spinner();
  spinner.start('Loading action details...');

  let knowledge: ActionKnowledge;
  try {
    const k = await api.getActionKnowledge(actionId);
    if (!k) {
      spinner.stop('Action not found');
      p.cancel(`No action found for: ${actionId}`);
      process.exit(1);
    }
    knowledge = k;
    spinner.stop(`${colorMethod(knowledge.method)} ${knowledge.path}`);
  } catch (error) {
    spinner.stop('Failed to load action');
    p.cancel(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }

  // 2. Resolve connection key
  let connectionKey = options.connection;
  if (!connectionKey) {
    connectionKey = await resolveConnection(api, knowledge.connectionPlatform);
  }

  // 3. Resolve path variables
  const pathVarMap = parseKeyValuePairs(options.pathVar || []);
  const pathVars = extractPathVariables(knowledge.path);
  for (const v of pathVars) {
    if (!pathVarMap[v]) {
      const input = await p.text({
        message: `Value for path variable ${pc.yellow(`{{${v}}}`)}:`,
        validate: (val) => val.trim() ? undefined : 'Value is required',
      });
      if (p.isCancel(input)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      pathVarMap[v] = input;
    }
  }

  // 4. Resolve body data
  let bodyData: Record<string, unknown> = {};
  if (options.data) {
    try {
      bodyData = JSON.parse(options.data);
    } catch {
      p.cancel('Invalid JSON in --data flag.');
      process.exit(1);
    }
  } else if (!['GET', 'DELETE', 'HEAD'].includes(knowledge.method.toUpperCase())) {
    const input = await p.text({
      message: 'Request body (JSON):',
      placeholder: '{"key": "value"} or leave empty',
    });
    if (p.isCancel(input)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    if (input.trim()) {
      try {
        bodyData = JSON.parse(input);
      } catch {
        p.cancel('Invalid JSON.');
        process.exit(1);
      }
    }
  }

  // 5. Resolve query params
  const queryParams = parseKeyValuePairs(options.query || []);

  // 6. Resolve template variables in path
  const { resolvedPath, remainingData } = resolveTemplateVariables(
    knowledge.path,
    bodyData,
    pathVarMap
  );

  // 7. Show summary
  console.log();
  console.log(pc.bold('  Request Summary'));
  console.log(`  ${colorMethod(knowledge.method)} ${knowledge.baseUrl}${resolvedPath}`);
  console.log(`  Connection: ${pc.dim(connectionKey)}`);
  if (Object.keys(remainingData).length > 0) {
    console.log(`  Body: ${pc.dim(JSON.stringify(remainingData))}`);
  }
  if (Object.keys(queryParams).length > 0) {
    console.log(`  Query: ${pc.dim(JSON.stringify(queryParams))}`);
  }
  console.log();

  // 8. Execute
  const execSpinner = p.spinner();
  execSpinner.start('Executing...');

  try {
    const result = await api.executeAction({
      method: knowledge.method,
      path: resolvedPath,
      actionId,
      connectionKey,
      data: Object.keys(remainingData).length > 0 ? remainingData : undefined,
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
      isFormData: options.formData,
      isFormUrlEncoded: options.formUrlencoded,
    });

    execSpinner.stop(pc.green('Success'));

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log();
      console.log(pc.bold('  Response'));
      console.log(pc.dim('  ' + '─'.repeat(40)));
      console.log();
      console.log(formatResponse(result));
      console.log();
    }
  } catch (error) {
    execSpinner.stop(pc.red('Failed'));
    const msg = error instanceof Error ? error.message : 'Unknown error';
    p.cancel(`Execution failed: ${msg}`);
    process.exit(1);
  }
}

// --- Helpers ---

async function resolveConnection(api: PicaApi, platform: string): Promise<string> {
  const spinner = p.spinner();
  spinner.start('Loading connections...');

  const connections = await api.listConnections();
  const matching = connections.filter(
    c => c.platform.toLowerCase() === platform.toLowerCase()
  );
  spinner.stop(`${matching.length} ${platform} connection${matching.length === 1 ? '' : 's'} found`);

  if (matching.length === 0) {
    p.cancel(
      `No ${platform} connections found.\n\n` +
      `Add one with: ${pc.cyan(`pica connection add ${platform}`)}`
    );
    process.exit(1);
  }

  if (matching.length === 1) {
    p.log.info(`Using connection: ${pc.dim(matching[0].key)}`);
    return matching[0].key;
  }

  const selected = await p.select({
    message: `Multiple ${platform} connections found. Which one?`,
    options: matching.map(c => ({
      value: c.key,
      label: `${c.key}`,
      hint: c.state,
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  return selected as string;
}

function parseKeyValuePairs(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    result[key] = value;
  }
  return result;
}

function formatResponse(data: unknown, indent = 2): string {
  const prefix = ' '.repeat(indent);
  const json = JSON.stringify(data, null, 2);
  return json.split('\n').map(line => `${prefix}${line}`).join('\n');
}
