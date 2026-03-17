import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getApiKey, getAccessControlFromAllSources } from '../lib/config.js';
import {
  PicaApi,
  filterByPermissions,
  isActionAllowed,
  isMethodAllowed,
  buildActionKnowledgeWithGuidance,
} from '../lib/api.js';
import { printTable } from '../lib/table.js';
import * as output from '../lib/output.js';
import type { PermissionLevel } from '../lib/types.js';

function getConfig() {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('Not configured. Run `pica init` first.');
  }

  const ac = getAccessControlFromAllSources();
  const permissions: PermissionLevel = ac.permissions || 'admin';
  const connectionKeys: string[] = ac.connectionKeys || ['*'];
  const actionIds: string[] = ac.actionIds || ['*'];
  const knowledgeAgent: boolean = ac.knowledgeAgent || false;

  return { apiKey, permissions, connectionKeys, actionIds, knowledgeAgent };
}

function parseJsonArg(value: string, argName: string): any {
  try {
    return JSON.parse(value);
  } catch {
    output.error(`Invalid JSON for ${argName}: ${value}`);
  }
}

export async function actionsSearchCommand(
  platform: string,
  query: string,
  options: { type?: string }
): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' Pica ')));

  const { apiKey, permissions, actionIds, knowledgeAgent } = getConfig();
  const api = new PicaApi(apiKey);

  const spinner = output.createSpinner();
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

    if (output.isAgentMode()) {
      output.json({ actions: cleanedActions });
      return;
    }

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
    output.error(
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function actionsKnowledgeCommand(
  platform: string,
  actionId: string
): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' Pica ')));

  const { apiKey, actionIds, connectionKeys } = getConfig();
  const api = new PicaApi(apiKey);

  // Check action allowlist
  if (!isActionAllowed(actionId, actionIds)) {
    output.error(`Action "${actionId}" is not in the allowed action list.`);
  }

  // Check connection scoping
  if (!connectionKeys.includes('*')) {
    const spinner = output.createSpinner();
    spinner.start('Checking connections...');
    try {
      const connections = await api.listConnections();
      const connectedPlatforms = connections.map((c) => c.platform);
      if (!connectedPlatforms.includes(platform)) {
        spinner.stop('Platform not connected');
        output.error(`Platform "${platform}" has no allowed connections.`);
      }
      spinner.stop('Connection verified');
    } catch (error) {
      spinner.stop('Failed to check connections');
      output.error(
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  const spinner = output.createSpinner();
  spinner.start(`Loading knowledge for action ${pc.dim(actionId)}...`);

  try {
    const { knowledge, method } = await api.getActionKnowledge(actionId);

    const knowledgeWithGuidance = buildActionKnowledgeWithGuidance(
      knowledge,
      method,
      platform,
      actionId
    );

    if (output.isAgentMode()) {
      output.json({ knowledge: knowledgeWithGuidance, method });
      return;
    }

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
    output.error(
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
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
  output.intro(pc.bgCyan(pc.black(' Pica ')));

  const { apiKey, permissions, actionIds, connectionKeys, knowledgeAgent } =
    getConfig();

  // Check knowledge-only mode
  if (knowledgeAgent) {
    output.error(
      'Action execution is disabled (knowledge-only mode).'
    );
  }

  // Check action allowlist
  if (!isActionAllowed(actionId, actionIds)) {
    output.error(`Action "${actionId}" is not in the allowed action list.`);
  }

  // Check connection key allowlist
  if (!connectionKeys.includes('*') && !connectionKeys.includes(connectionKey)) {
    output.error(`Connection key "${connectionKey}" is not allowed.`);
  }

  const api = new PicaApi(apiKey);

  const spinner = output.createSpinner();
  spinner.start('Loading action details...');

  try {
    const actionDetails = await api.getActionDetails(actionId);

    // Check method permissions
    if (!isMethodAllowed(actionDetails.method, permissions)) {
      spinner.stop('Permission denied');
      output.error(
        `Method "${actionDetails.method}" is not allowed under "${permissions}" permission level.`
      );
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

    const execSpinner = output.createSpinner();
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

    if (output.isAgentMode()) {
      output.json({
        request: {
          method: result.requestConfig.method,
          url: result.requestConfig.url,
        },
        response: result.responseData,
      });
      return;
    }

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
    output.error(
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
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
