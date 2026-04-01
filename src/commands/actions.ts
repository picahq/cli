import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getApiKey, getApiBase, getAccessControlFromAllSources } from '../lib/config.js';
import {
  OneApi,
  filterByPermissions,
  isActionAllowed,
  isMethodAllowed,
  buildActionKnowledgeWithGuidance,
} from '../lib/api.js';
import { printTable } from '../lib/table.js';
import * as output from '../lib/output.js';
import type { PermissionLevel, ActionKnowledgeResponse } from '../lib/types.js';
import {
  knowledgeCachePath,
  searchCachePath,
  readCache,
  writeCache,
  isFresh,
  getAge,
  buildCacheMeta,
  formatAge,
  makeCacheEntry,
} from '../lib/cache.js';

function getConfig() {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('Not configured. Run `one init` first.');
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
  options: { type?: string; cache?: boolean }
): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One ')));

  const { apiKey, permissions, actionIds, knowledgeAgent } = getConfig();
  const api = new OneApi(apiKey, getApiBase());

  const spinner = output.createSpinner();
  spinner.start(`Searching actions on ${pc.cyan(platform)} for "${query}"...`);

  try {
    // Force knowledge mode when knowledgeAgent is enabled
    const agentType = knowledgeAgent
      ? 'knowledge'
      : (options.type as 'execute' | 'knowledge' | undefined);

    const useCache = options.cache !== false;
    const cachePath = searchCachePath(platform, query, agentType || 'knowledge');
    const cached = useCache ? readCache<{ actions: Array<{ actionId: string; title: string; method: string; path: string }> }>(cachePath) : null;

    let cleanedActions: Array<{ actionId: string; title: string; method: string; path: string }>;
    let cacheHit = false;

    if (cached && isFresh(cached)) {
      // Serve from cache
      cleanedActions = cached.data.actions;
      cacheHit = true;
    } else {
      // Fetch from API (conditional if stale cache exists)
      try {
        const result = await api.searchActionsWithMeta(
          platform, query, agentType, cached?.etag ?? undefined
        );

        if (result.status === 304 && cached) {
          // Content unchanged — update cachedAt and serve cached data
          cached.cachedAt = new Date().toISOString();
          writeCache(cachePath, cached);
          cleanedActions = cached.data.actions;
          cacheHit = true;
        } else {
          let actions = result.data;
          actions = filterByPermissions(actions, permissions);
          actions = actions.filter((a) => isActionAllowed(a.systemId, actionIds));

          cleanedActions = actions.map((action) => ({
            actionId: action.systemId,
            title: action.title,
            method: action.method,
            path: action.path,
          }));

          // Write to cache
          writeCache(cachePath, makeCacheEntry(
            `${platform}_${query}_${agentType || 'knowledge'}`,
            { actions: cleanedActions },
            result.etag
          ));
        }
      } catch (fetchError) {
        // Network failure — serve stale cache if available
        if (cached) {
          process.stderr.write(
            `Warning: serving cached search results (network unavailable, cached ${formatAge(getAge(cached))} ago)\n`
          );
          cleanedActions = cached.data.actions;
          cacheHit = true;
        } else {
          throw fetchError;
        }
      }
    }

    if (output.isAgentMode()) {
      const response: Record<string, unknown> = { actions: cleanedActions };
      if (cacheHit && cached) {
        response._cache = buildCacheMeta(cached, true);
      } else {
        const freshEntry = readCache(cachePath);
        response._cache = buildCacheMeta(freshEntry, false);
      }
      output.json(response);
      return;
    }

    if (cleanedActions.length === 0) {
      spinner.stop('No actions found');
      p.note(
        `No actions found for platform '${platform}' matching query '${query}'.\n\n` +
          `Suggestions:\n` +
          `  - Try a more general query (e.g., 'list', 'get', 'search', 'create')\n` +
          `  - Verify the platform name is correct\n` +
          `  - Check available platforms with ${pc.cyan('one platforms')}\n\n` +
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
      `Get details: ${pc.cyan(`one actions knowledge ${platform} <actionId>`)}\n` +
        `Execute:     ${pc.cyan(`one actions execute ${platform} <actionId> <connectionKey>`)}`,
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
  actionId: string,
  options: { cache?: boolean; cacheStatus?: boolean }
): Promise<void> {
  const cachePath = knowledgeCachePath(actionId);

  // --cache-status: print cache metadata and return
  if (options.cacheStatus) {
    const entry = readCache<ActionKnowledgeResponse>(cachePath);
    if (!entry) {
      output.json({
        cached: false,
        path: cachePath,
      });
    } else {
      const age = getAge(entry);
      output.json({
        cached: true,
        cachedAt: entry.cachedAt,
        age: formatAge(age),
        ttl: entry.ttl,
        expired: !isFresh(entry),
        etag: entry.etag,
        path: cachePath,
      });
    }
    return;
  }

  output.intro(pc.bgCyan(pc.black(' One ')));

  const { apiKey, actionIds, connectionKeys } = getConfig();
  const api = new OneApi(apiKey, getApiBase());

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
    const useCache = options.cache !== false;
    const cached = useCache ? readCache<ActionKnowledgeResponse>(cachePath) : null;

    let knowledgeData: ActionKnowledgeResponse;
    let cacheHit = false;
    let cacheEntry = cached;

    if (cached && isFresh(cached) && useCache) {
      // Fresh cache hit — serve directly
      knowledgeData = cached.data;
      cacheHit = true;
    } else {
      // Fetch from API (conditional if stale cache exists)
      try {
        const result = await api.getActionKnowledgeWithMeta(
          actionId, cached?.etag ?? undefined
        );

        if (result.status === 304 && cached) {
          // Content unchanged — refresh cachedAt
          cached.cachedAt = new Date().toISOString();
          writeCache(cachePath, cached);
          knowledgeData = cached.data;
          cacheHit = true;
        } else {
          knowledgeData = result.data;

          // Write to cache
          const newEntry = makeCacheEntry(actionId, knowledgeData, result.etag);
          writeCache(cachePath, newEntry);
          cacheEntry = newEntry;
        }
      } catch (fetchError) {
        // Network failure — serve stale cache if available
        if (cached) {
          process.stderr.write(
            `Warning: serving cached knowledge (network unavailable, cached ${formatAge(getAge(cached))} ago)\n`
          );
          knowledgeData = cached.data;
          cacheHit = true;
        } else {
          throw fetchError;
        }
      }
    }

    const knowledgeWithGuidance = buildActionKnowledgeWithGuidance(
      knowledgeData.knowledge,
      knowledgeData.method,
      platform,
      actionId
    );

    if (output.isAgentMode()) {
      const response: Record<string, unknown> = {
        knowledge: knowledgeWithGuidance,
        method: knowledgeData.method,
        _cache: buildCacheMeta(cacheEntry, cacheHit),
      };
      output.json(response);
      return;
    }

    spinner.stop('Knowledge loaded');
    console.log();
    console.log(knowledgeWithGuidance);
    console.log();

    p.note(
      `Execute: ${pc.cyan(`one actions execute ${platform} ${actionId} <connectionKey>`)}`,
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
    dryRun?: boolean;
  }
): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One ')));

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

  const api = new OneApi(apiKey, getApiBase());

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
    execSpinner.start(options.dryRun ? 'Building request...' : 'Executing action...');

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
        dryRun: options.dryRun,
      },
      actionDetails
    );

    execSpinner.stop(options.dryRun ? 'Dry run — request not sent' : 'Action executed successfully');

    if (output.isAgentMode()) {
      output.json({
        dryRun: options.dryRun || false,
        request: {
          method: result.requestConfig.method,
          url: result.requestConfig.url,
          headers: options.dryRun ? result.requestConfig.headers : undefined,
          data: options.dryRun ? result.requestConfig.data : undefined,
        },
        response: options.dryRun ? undefined : result.responseData,
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

    if (options.dryRun) {
      if (result.requestConfig.data) {
        console.log();
        console.log(pc.dim('Body:'));
        console.log(pc.dim(JSON.stringify(result.requestConfig.data, null, 2)));
      }
      console.log();
      output.note('Dry run — request was not sent', 'Dry Run');
    } else {
      console.log();
      console.log(pc.bold('Response:'));
      console.log(JSON.stringify(result.responseData, null, 2));
    }
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
