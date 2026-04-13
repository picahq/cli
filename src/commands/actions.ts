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
import type { PermissionLevel, ActionKnowledgeResponse, ActionDetails } from '../lib/types.js';
import { validateActionInput } from '../lib/validate.js';
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
    // Default to execute mode; only use knowledge mode when explicitly enabled in config
    const agentType = knowledgeAgent
      ? 'knowledge'
      : (options.type as 'execute' | 'knowledge' | undefined) || 'execute';

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
    mock?: boolean;
    skipValidation?: boolean;
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

    // Validate input against action schema
    if (!options.skipValidation) {
      const validation = validateActionInput(actionDetails, { data, pathVariables, queryParams });
      if (!validation.valid) {
        spinner.stop('Validation failed');
        if (output.isAgentMode()) {
          output.json({
            error: 'Validation failed: missing required parameters',
            validation: { missing: validation.missing },
            hint: 'Add the missing parameters, or pass --skip-validation to bypass this check.',
          });
          process.exit(1);
        }
        console.log();
        for (const m of validation.missing) {
          console.log(pc.red(`  ${m.flag} is missing "${m.param}"`));
          if (m.description) {
            console.log(pc.dim(`    ${m.description}`));
          }
        }
        console.log();
        output.error('Validation failed: missing required parameters. Pass --skip-validation to bypass.');
      }
    }

    // Mock mode — return example response without making an API call
    if (options.mock) {
      spinner.stop('Mock — returning example response');
      const mockResponse = actionDetails.ioSchema?.ioExample?.output ?? null;
      if (output.isAgentMode()) {
        output.json({
          mock: true,
          request: {
            method: actionDetails.method,
            url: actionDetails.path,
          },
          response: mockResponse,
          ...(mockResponse === null ? { message: 'No example output available for this action' } : {}),
        });
        return;
      }
      console.log();
      if (mockResponse) {
        console.log(pc.bold('Mock Response:'));
        console.log(JSON.stringify(mockResponse, null, 2));
      } else {
        output.note('No example output available for this action', 'Mock');
      }
      return;
    }

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

// ── Parallel Execute ──

interface ParsedSegment {
  platform: string;
  actionId: string;
  connectionKey: string;
  data?: string;
  pathVars?: string;
  queryParams?: string;
  headers?: string;
  formData?: boolean;
  formUrlEncoded?: boolean;
}

interface GlobalParallelFlags {
  dryRun: boolean;
  mock: boolean;
  skipValidation: boolean;
  maxConcurrency: number;
}

interface SegmentResult {
  segment: number;
  platform: string;
  actionId: string;
  status: 'success' | 'error';
  durationMs: number;
  dryRun?: boolean;
  mock?: boolean;
  request?: unknown;
  response?: unknown;
  error?: string;
}

function parseParallelSegments(): { segments: ParsedSegment[]; flags: GlobalParallelFlags } {
  const argv = process.argv.slice(2);

  // Find `execute` (or alias `x`) after `actions` (or alias `a`)
  let execIdx = -1;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === 'execute' || argv[i] === 'x') &&
        i > 0 && (argv[i - 1] === 'actions' || argv[i - 1] === 'a')) {
      execIdx = i;
      break;
    }
  }
  if (execIdx === -1) {
    output.error('Could not locate "actions execute" in argv');
  }

  const raw = argv.slice(execIdx + 1);

  // Strip global flags and collect their values
  const flags: GlobalParallelFlags = { dryRun: false, mock: false, skipValidation: false, maxConcurrency: 5 };
  const cleaned: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === '--parallel' || t === '--agent') continue;
    if (t === '--dry-run') { flags.dryRun = true; continue; }
    if (t === '--mock') { flags.mock = true; continue; }
    if (t === '--skip-validation') { flags.skipValidation = true; continue; }
    if (t === '--max-concurrency') { flags.maxConcurrency = parseInt(raw[++i], 10) || 5; continue; }
    cleaned.push(t);
  }

  // Split on `--` into segments
  const segmentArrays: string[][] = [];
  let current: string[] = [];
  for (const token of cleaned) {
    if (token === '--') {
      if (current.length > 0) segmentArrays.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segmentArrays.push(current);

  if (segmentArrays.length === 0) {
    output.error('--parallel requires at least one action segment. Usage: --parallel <platform> <actionId> <connectionKey> [-d ...] [-- <next action> ...]');
  }

  const segments = segmentArrays.map((tokens, i) => parseSegmentTokens(tokens, i + 1));
  return { segments, flags };
}

function parseSegmentTokens(tokens: string[], segmentIndex: number): ParsedSegment {
  if (tokens.length < 3) {
    output.error(`Segment ${segmentIndex}: expected <platform> <actionId> <connectionKey>, got ${tokens.length} token(s): ${tokens.join(' ')}`);
  }

  const segment: ParsedSegment = {
    platform: tokens[0],
    actionId: tokens[1],
    connectionKey: tokens[2],
  };

  for (let i = 3; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-d' || t === '--data') { segment.data = tokens[++i]; continue; }
    if (t === '--path-vars') { segment.pathVars = tokens[++i]; continue; }
    if (t === '--query-params') { segment.queryParams = tokens[++i]; continue; }
    if (t === '--headers') { segment.headers = tokens[++i]; continue; }
    if (t === '--form-data') { segment.formData = true; continue; }
    if (t === '--form-url-encoded') { segment.formUrlEncoded = true; continue; }
    output.error(`Segment ${segmentIndex}: unknown option "${t}"`);
  }

  return segment;
}

function tryParseJson(value: string, label: string): { value: unknown; error?: undefined } | { value?: undefined; error: string } {
  try {
    return { value: JSON.parse(value) };
  } catch {
    return { error: `Invalid JSON for ${label}: ${value}` };
  }
}

export async function actionsExecuteParallelCommand(): Promise<void> {
  const { segments, flags } = parseParallelSegments();

  const { apiKey, permissions, actionIds, connectionKeys, knowledgeAgent } = getConfig();

  if (knowledgeAgent) {
    output.error('Action execution is disabled (knowledge-only mode).');
  }

  const api = new OneApi(apiKey, getApiBase());

  // ── Phase 2: validate ALL segments upfront ──

  interface PreparedAction {
    segment: ParsedSegment;
    index: number;
    actionDetails: ActionDetails;
    data?: unknown;
    pathVariables?: Record<string, unknown>;
    queryParams?: Record<string, unknown>;
    headers?: Record<string, string>;
  }

  const prepared: PreparedAction[] = [];
  const errors: { segment: number; label: string; messages: string[] }[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = `${seg.platform}/${seg.actionId}`;
    const segErrors: string[] = [];

    // Access control
    if (!isActionAllowed(seg.actionId, actionIds)) {
      segErrors.push(`Action "${seg.actionId}" is not in the allowed action list`);
    }
    if (!connectionKeys.includes('*') && !connectionKeys.includes(seg.connectionKey)) {
      segErrors.push(`Connection key "${seg.connectionKey}" is not allowed`);
    }

    // Fetch action details
    let actionDetails: ActionDetails | undefined;
    try {
      actionDetails = await api.getActionDetails(seg.actionId);
    } catch (err) {
      segErrors.push(`Action not found: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (actionDetails && !isMethodAllowed(actionDetails.method, permissions)) {
      segErrors.push(`Method "${actionDetails.method}" not allowed under "${permissions}" permission level`);
    }

    // Parse JSON args
    let data: unknown;
    let pathVariables: Record<string, unknown> | undefined;
    let queryParams: Record<string, unknown> | undefined;
    let headers: Record<string, string> | undefined;

    if (seg.data) {
      const r = tryParseJson(seg.data, `segment ${i + 1} --data`);
      if (r.error) segErrors.push(r.error); else data = r.value;
    }
    if (seg.pathVars) {
      const r = tryParseJson(seg.pathVars, `segment ${i + 1} --path-vars`);
      if (r.error) segErrors.push(r.error); else pathVariables = r.value as Record<string, unknown>;
    }
    if (seg.queryParams) {
      const r = tryParseJson(seg.queryParams, `segment ${i + 1} --query-params`);
      if (r.error) segErrors.push(r.error); else queryParams = r.value as Record<string, unknown>;
    }
    if (seg.headers) {
      const r = tryParseJson(seg.headers, `segment ${i + 1} --headers`);
      if (r.error) segErrors.push(r.error); else headers = r.value as Record<string, string>;
    }

    // Schema validation
    if (actionDetails && !flags.skipValidation && segErrors.length === 0) {
      const validation = validateActionInput(actionDetails, { data, pathVariables, queryParams });
      if (!validation.valid) {
        for (const m of validation.missing) {
          segErrors.push(`Missing ${m.flag} "${m.param}"${m.description ? ` — ${m.description}` : ''}`);
        }
      }
    }

    if (segErrors.length > 0) {
      errors.push({ segment: i + 1, label, messages: segErrors });
    } else if (actionDetails) {
      prepared.push({ segment: seg, index: i, actionDetails, data, pathVariables, queryParams, headers });
    }
  }

  if (errors.length > 0) {
    if (output.isAgentMode()) {
      output.json({ error: 'Validation failed', segments: errors });
      process.exit(1);
    }
    console.log();
    for (const e of errors) {
      console.log(`  ${pc.red('✗')} Segment ${e.segment} (${e.label}):`);
      for (const msg of e.messages) {
        console.log(`    ${msg}`);
      }
    }
    console.log();
    output.error(`Validation failed for ${errors.length} segment(s). Fix errors above before executing.`);
  }

  // ── Phase 3: execute ──

  const total = prepared.length;
  const overallStart = Date.now();
  const results: SegmentResult[] = [];

  for (let i = 0; i < total; i += flags.maxConcurrency) {
    const batch = prepared.slice(i, i + flags.maxConcurrency);
    const settled = await Promise.allSettled(
      batch.map(async (action): Promise<SegmentResult> => {
        const start = Date.now();
        const seg = action.segment;
        const segIdx = action.index + 1;

        // Mock mode
        if (flags.mock) {
          const mockResponse = action.actionDetails.ioSchema?.ioExample?.output ?? null;
          return {
            segment: segIdx,
            platform: seg.platform,
            actionId: seg.actionId,
            status: 'success',
            durationMs: Date.now() - start,
            mock: true,
            request: { method: action.actionDetails.method, url: action.actionDetails.path },
            response: mockResponse,
          };
        }

        const result = await api.executePassthroughRequest({
          platform: seg.platform,
          actionId: seg.actionId,
          connectionKey: seg.connectionKey,
          data: action.data,
          pathVariables: action.pathVariables as Record<string, string | number | boolean> | undefined,
          queryParams: action.queryParams,
          headers: action.headers,
          isFormData: seg.formData,
          isFormUrlEncoded: seg.formUrlEncoded,
          dryRun: flags.dryRun,
        }, action.actionDetails);

        return {
          segment: segIdx,
          platform: seg.platform,
          actionId: seg.actionId,
          status: 'success',
          durationMs: Date.now() - start,
          dryRun: flags.dryRun || undefined,
          request: {
            method: result.requestConfig.method,
            url: result.requestConfig.url,
            ...(flags.dryRun ? { headers: result.requestConfig.headers, data: result.requestConfig.data } : {}),
          },
          response: flags.dryRun ? undefined : result.responseData,
        };
      }),
    );

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        // Find the matching prepared action for this rejected promise
        const batchIdx = settled.indexOf(s);
        const action = batch[batchIdx];
        results.push({
          segment: action.index + 1,
          platform: action.segment.platform,
          actionId: action.segment.actionId,
          status: 'error',
          durationMs: 0,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
      }
    }
  }

  const totalDurationMs = Date.now() - overallStart;
  const succeeded = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'error').length;

  // ── Phase 4: output ──

  if (output.isAgentMode()) {
    output.json({
      parallel: true,
      totalDurationMs,
      succeeded,
      failed,
      results,
    });
    if (failed > 0) process.exit(1);
    return;
  }

  // Human mode
  console.log();
  for (const r of results) {
    const label = `${r.platform}/${r.actionId}`;
    const time = pc.dim(`(${(r.durationMs / 1000).toFixed(2)}s)`);
    if (r.mock) {
      console.log(`  [${r.segment}/${total}] ${label} ${pc.cyan('◇ mock')} ${time}`);
      if (r.response) console.log(`  ${pc.dim(JSON.stringify(r.response, null, 2).split('\n').join('\n  '))}`);
    } else if (r.dryRun) {
      console.log(`  [${r.segment}/${total}] ${label} ${pc.yellow('⊘ dry-run')} ${time}`);
    } else if (r.status === 'success') {
      console.log(`  [${r.segment}/${total}] ${label} ${pc.green('✓')} ${time}`);
      if (r.response) console.log(`  ${pc.dim(JSON.stringify(r.response, null, 2).split('\n').join('\n  '))}`);
    } else {
      console.log(`  [${r.segment}/${total}] ${label} ${pc.red('✗')} ${time} — ${r.error}`);
    }
  }
  console.log();

  const tag = flags.mock ? 'mock' : flags.dryRun ? 'dry-run' : undefined;
  if (tag) {
    console.log(`  Summary: ${total} ${tag} (${(totalDurationMs / 1000).toFixed(2)}s total)`);
  } else {
    console.log(`  Summary: ${succeeded} succeeded, ${failed} failed (${(totalDurationMs / 1000).toFixed(2)}s total)`);
  }
  console.log();
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
