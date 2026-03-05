import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getApiKey } from '../lib/config.js';
import { getAccessControl } from '../lib/config.js';
import {
  PicaApi,
  filterByPermissions,
  isActionAllowed,
  isMethodAllowed,
  buildActionKnowledgeWithGuidance,
} from '../lib/api.js';
import { printTable } from '../lib/table.js';
import type { PermissionLevel } from '../lib/types.js';

function getConfig() {
  const apiKey = getApiKey();
  if (!apiKey) {
    p.cancel('Not configured. Run `pica init` first.');
    process.exit(1);
  }

  const ac = getAccessControl();
  const permissions: PermissionLevel = ac.permissions || 'admin';
  const connectionKeys: string[] = ac.connectionKeys || ['*'];
  const actionIds: string[] = ac.actionIds || ['*'];
  const knowledgeAgent: boolean = ac.knowledgeAgent || false;

  return { apiKey, permissions, connectionKeys, actionIds, knowledgeAgent };
}

export async function actionsSearchCommand(
  platform: string,
  query: string,
  options: { type?: string }
): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' Pica ')));

  const { apiKey, permissions, actionIds, knowledgeAgent } = getConfig();
  const api = new PicaApi(apiKey);

  const spinner = p.spinner();
  spinner.start(`Searching actions on ${pc.cyan(platform)} for "${query}"...`);

  try {
    // Force knowledge mode when knowledgeAgent is enabled
    const agentType = knowledgeAgent
      ? 'knowledge'
      : (options.type as 'execute' | 'knowledge' | undefined);

    let actions = await api.searchActions(platform, query, agentType);

    // Apply permission-level filtering
    actions = filterByPermissions(actions, permissions);

    // Apply action allowlist filtering
    actions = actions.filter((a) => isActionAllowed(a.systemId, actionIds));

    const cleanedActions = actions.map((action) => ({
      actionId: action.systemId,
      title: action.title,
      method: action.method,
      path: action.path,
    }));

    if (cleanedActions.length === 0) {
      spinner.stop('No actions found');
      p.note(
        `No actions found for platform '${platform}' matching query '${query}'.\n\n` +
          `Suggestions:\n` +
          `  - Try a more general query (e.g., 'list', 'get', 'search', 'create')\n` +
          `  - Verify the platform name is correct\n` +
          `  - Check available platforms with ${pc.cyan('pica platforms')}\n\n` +
          `Examples of good queries:\n` +
          `  - "search contacts"\n` +
          `  - "send email"\n` +
          `  - "create customer"\n` +
          `  - "list orders"`,
        'No Results'
      );
      return;
    }

    spinner.stop(
      `Found ${cleanedActions.length} action(s) for '${platform}' matching '${query}'`
    );

    console.log();

    const rows = cleanedActions.map((a) => ({
      method: colorMethod(a.method),
      title: a.title,
      actionId: a.actionId,
      path: a.path,
    }));

    printTable(
      [
        { key: 'method', label: 'Method' },
        { key: 'title', label: 'Title' },
        { key: 'actionId', label: 'Action ID', color: pc.dim },
        { key: 'path', label: 'Path', color: pc.dim },
      ],
      rows
    );

    console.log();
    p.note(
      `Get details: ${pc.cyan(`pica actions knowledge ${platform} <actionId>`)}\n` +
        `Execute:     ${pc.cyan(`pica actions execute ${platform} <actionId> <connectionKey>`)}`,
      'Next Steps'
    );
  } catch (error) {
    spinner.stop('Search failed');
    p.cancel(
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    process.exit(1);
  }
}

export async function actionsKnowledgeCommand(
  platform: string,
  actionId: string
): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' Pica ')));

  const { apiKey, actionIds, connectionKeys } = getConfig();
  const api = new PicaApi(apiKey);

  // Check action allowlist
  if (!isActionAllowed(actionId, actionIds)) {
    p.cancel(`Action "${actionId}" is not in the allowed action list.`);
    process.exit(1);
  }

  // Check connection scoping
  if (!connectionKeys.includes('*')) {
    const spinner = p.spinner();
    spinner.start('Checking connections...');
    try {
      const connections = await api.listConnections();
      const connectedPlatforms = connections.map((c) => c.platform);
      if (!connectedPlatforms.includes(platform)) {
        spinner.stop('Platform not connected');
        p.cancel(`Platform "${platform}" has no allowed connections.`);
        process.exit(1);
      }
      spinner.stop('Connection verified');
    } catch (error) {
      spinner.stop('Failed to check connections');
      p.cancel(
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  }

  const spinner = p.spinner();
  spinner.start(`Loading knowledge for action ${pc.dim(actionId)}...`);

  try {
    const { knowledge, method } = await api.getActionKnowledge(actionId);

    const knowledgeWithGuidance = buildActionKnowledgeWithGuidance(
      knowledge,
      method,
      platform,
      actionId
    );

    spinner.stop('Knowledge loaded');
    console.log();
    console.log(knowledgeWithGuidance);
    console.log();

    p.note(
      `Execute: ${pc.cyan(`pica actions execute ${platform} ${actionId} <connectionKey>`)}`,
      'Next Step'
    );
  } catch (error) {
    spinner.stop('Failed to load knowledge');
    p.cancel(
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    process.exit(1);
  }
}

export async function actionsExecuteCommand(
  platform: string,
  actionId: string,
  connectionKey: string,
  options: {
    data?: string;
    pathVars?: string;
    queryParams?: string;
    headers?: string;
    formData?: boolean;
    formUrlEncoded?: boolean;
  }
): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' Pica ')));

  const { apiKey, permissions, actionIds, connectionKeys, knowledgeAgent } =
    getConfig();

  // Check knowledge-only mode
  if (knowledgeAgent) {
    p.cancel(
      'Action execution is disabled (knowledge-only mode).\n' +
        `Configure with: ${pc.cyan('pica config')}`
    );
    process.exit(1);
  }

  // Check action allowlist
  if (!isActionAllowed(actionId, actionIds)) {
    p.cancel(`Action "${actionId}" is not in the allowed action list.`);
    process.exit(1);
  }

  // Check connection key allowlist
  if (!connectionKeys.includes('*') && !connectionKeys.includes(connectionKey)) {
    p.cancel(`Connection key "${connectionKey}" is not allowed.`);
    process.exit(1);
  }

  const api = new PicaApi(apiKey);

  const spinner = p.spinner();
  spinner.start('Loading action details...');

  try {
    const actionDetails = await api.getActionDetails(actionId);

    // Check method permissions
    if (!isMethodAllowed(actionDetails.method, permissions)) {
      spinner.stop('Permission denied');
      p.cancel(
        `Method "${actionDetails.method}" is not allowed under "${permissions}" permission level.`
      );
      process.exit(1);
    }

    spinner.stop(`Action: ${actionDetails.title} [${actionDetails.method}]`);

    // Parse optional JSON arguments
    const data = options.data ? parseJsonArg(options.data, '--data') : undefined;
    const pathVariables = options.pathVars
      ? parseJsonArg(options.pathVars, '--path-vars')
      : undefined;
    const queryParams = options.queryParams
      ? parseJsonArg(options.queryParams, '--query-params')
      : undefined;
    const headers = options.headers
      ? parseJsonArg(options.headers, '--headers')
      : undefined;

    const execSpinner = p.spinner();
    execSpinner.start('Executing action...');

    const result = await api.executePassthroughRequest(
      {
        platform,
        actionId,
        connectionKey,
        data,
        pathVariables,
        queryParams,
        headers,
        isFormData: options.formData,
        isFormUrlEncoded: options.formUrlEncoded,
      },
      actionDetails
    );

    execSpinner.stop('Action executed successfully');

    console.log();
    console.log(pc.dim('Request:'));
    console.log(
      pc.dim(
        `  ${result.requestConfig.method} ${result.requestConfig.url}`
      )
    );
    console.log();
    console.log(pc.bold('Response:'));
    console.log(JSON.stringify(result.responseData, null, 2));
  } catch (error) {
    spinner.stop('Execution failed');
    p.cancel(
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    process.exit(1);
  }
}

function parseJsonArg(value: string, argName: string): any {
  try {
    return JSON.parse(value);
  } catch {
    p.cancel(`Invalid JSON for ${argName}: ${value}`);
    process.exit(1);
  }
}

function colorMethod(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return pc.green(method);
    case 'POST':
      return pc.yellow(method);
    case 'PUT':
      return pc.blue(method);
    case 'PATCH':
      return pc.magenta(method);
    case 'DELETE':
      return pc.red(method);
    default:
      return method;
  }
}
