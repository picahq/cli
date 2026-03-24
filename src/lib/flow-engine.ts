import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { OneApi } from './api.js';
import { isMethodAllowed, isActionAllowed } from './api.js';
import type { PermissionLevel } from './types.js';
import type {
  Flow,
  FlowStep,
  FlowContext,
  StepResult,
  FlowEvent,
  FlowExecuteOptions,
  FlowActionConfig,
} from './flow-types.js';

const execAsync = promisify(exec);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Selector Resolution ──

export function resolveSelector(selectorPath: string, context: FlowContext): unknown {
  if (!selectorPath.startsWith('$.')) return selectorPath;

  const parts = selectorPath.slice(2).split(/\.|\[/).map(p => p.replace(/\]$/, ''));
  let current: unknown = context;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (part === '*' && Array.isArray(current)) {
      // Wildcard: return the array itself — next part will map over it
      continue;
    }

    if (Array.isArray(current) && part === '*') {
      continue;
    }

    // Handle array wildcard mapping: after *, map remaining path
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!isNaN(idx)) {
        current = current[idx];
      } else {
        // Map: extract field from each element
        current = current.map((item: any) => item?.[part]);
      }
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

export function interpolateString(str: string, context: FlowContext): string {
  return str.replace(/\{\{(\$\.[^}]+)\}\}/g, (_match, selector) => {
    const value = resolveSelector(selector, context);
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

export function resolveValue(value: unknown, context: FlowContext): unknown {
  if (typeof value === 'string') {
    // Pure selector — return raw type
    if (value.startsWith('$.') && !value.includes('{{')) {
      return resolveSelector(value, context);
    }
    // String with interpolation
    if (value.includes('{{$.')) {
      return interpolateString(value, context);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveValue(item, context));
  }

  if (value && typeof value === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveValue(v, context);
    }
    return resolved;
  }

  return value;
}

export function evaluateExpression(expr: string, context: FlowContext): unknown {
  const fn = new Function('$', `return (${expr})`);
  return fn(context);
}

// ── Dot-path Helpers (for pagination) ──

function getByDotPath(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function setByDotPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === undefined || current[parts[i]] === null) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

// ── Code Sandbox ──

const ALLOWED_MODULES: Record<string, () => Promise<unknown>> = {
  buffer: () => import('node:buffer'),
  crypto: () => import('node:crypto'),
  url: () => import('node:url'),
  path: () => import('node:path'),
};

const BLOCKED_MODULES = new Set([
  'fs', 'http', 'https', 'net', 'child_process', 'process', 'os',
  'cluster', 'dgram', 'tls', 'vm', 'worker_threads',
]);

function createSandboxedRequire() {
  const cache: Record<string, unknown> = {};
  return async (moduleName: string) => {
    const clean = moduleName.replace(/^node:/, '');
    if (BLOCKED_MODULES.has(clean)) {
      throw new Error(`Module "${moduleName}" is blocked in code steps`);
    }
    if (!ALLOWED_MODULES[clean]) {
      throw new Error(`Module "${moduleName}" not available. Allowed: ${Object.keys(ALLOWED_MODULES).join(', ')}`);
    }
    if (!cache[clean]) cache[clean] = await ALLOWED_MODULES[clean]();
    return cache[clean];
  };
}

/** Strip markdown code fences (e.g. ```json\n...\n```) that LLMs wrap around JSON output. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:\w*)\s*\n([\s\S]*?)\n\s*```\s*$/);
  return match ? match[1].trim() : trimmed;
}

// ── Step Executors ──

async function executeActionStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
): Promise<StepResult> {
  const action = step.action!;
  const platform = resolveValue(action.platform, context) as string;
  const actionId = resolveValue(action.actionId, context) as string;
  const connectionKey = resolveValue(action.connectionKey, context) as string;
  const data = action.data ? resolveValue(action.data, context) as Record<string, unknown> : undefined;
  const pathVars = action.pathVars ? resolveValue(action.pathVars, context) as Record<string, string | number | boolean> : undefined;
  const queryParams = action.queryParams ? resolveValue(action.queryParams, context) as Record<string, any> : undefined;
  const headers = action.headers ? resolveValue(action.headers, context) as Record<string, string> : undefined;

  // Access control checks
  if (!isActionAllowed(actionId, allowedActionIds)) {
    throw new Error(`Action "${actionId}" is not in the allowed action list`);
  }

  const actionDetails = await api.getActionDetails(actionId);
  if (!isMethodAllowed(actionDetails.method, permissions)) {
    throw new Error(`Method "${actionDetails.method}" is not allowed under "${permissions}" permission level`);
  }

  const result = await api.executePassthroughRequest({
    platform,
    actionId,
    connectionKey,
    data,
    pathVariables: pathVars,
    queryParams,
    headers,
  }, actionDetails);

  return {
    status: 'success',
    response: result.responseData,
    output: result.responseData,
  };
}

function executeTransformStep(step: FlowStep, context: FlowContext): StepResult {
  const output = evaluateExpression(step.transform!.expression, context);
  return { status: 'success', output, response: output };
}

async function executeCodeStep(step: FlowStep, context: FlowContext): Promise<StepResult> {
  const source = step.code!.source;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const sandboxedRequire = createSandboxedRequire();
  const fn = new AsyncFunction('$', 'require', source);
  const output = await fn(context, sandboxedRequire);
  return { status: 'success', output, response: output };
}

async function executeConditionStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
  flowStack: string[],
): Promise<StepResult> {
  const condition = step.condition!;
  const result = evaluateExpression(condition.expression, context);

  const branch = result ? condition.then : (condition.else || []);
  const branchResults = await executeSteps(branch, context, api, permissions, allowedActionIds, options, undefined, flowStack);

  return {
    status: 'success',
    output: { conditionResult: !!result, stepsExecuted: branchResults },
    response: { conditionResult: !!result },
  };
}

async function executeLoopStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
  flowStack: string[],
): Promise<StepResult> {
  const loop = step.loop!;
  const items = resolveValue(loop.over, context);

  if (!Array.isArray(items)) {
    throw new Error(`Loop "over" must resolve to an array, got ${typeof items}`);
  }

  const maxIterations = loop.maxIterations || 1000;
  const bounded = items.slice(0, maxIterations);
  const savedLoop = { ...context.loop };
  const iterationResults: Record<string, StepResult>[] = [];

  if (loop.maxConcurrency && loop.maxConcurrency > 1) {
    // Parallel loop: process iterations in batches
    const results: unknown[] = new Array(bounded.length);

    for (let batchStart = 0; batchStart < bounded.length; batchStart += loop.maxConcurrency) {
      const batch = bounded.slice(batchStart, batchStart + loop.maxConcurrency);
      const batchResults = await Promise.all(
        batch.map(async (item, batchIdx) => {
          const i = batchStart + batchIdx;
          // Each concurrent iteration gets its own context clone for loop vars
          const iterContext: FlowContext = {
            ...context,
            loop: {
              [loop.as]: item,
              item,
              i,
              ...(loop.indexAs ? { [loop.indexAs]: i } : {}),
            },
            steps: { ...context.steps },
          };
          const beforeKeys = new Set(Object.keys(iterContext.steps));
          await executeSteps(loop.steps, iterContext, api, permissions, allowedActionIds, options, undefined, flowStack);
          // Collect new/changed step results for this iteration
          const iterResult: Record<string, StepResult> = {};
          for (const [key, val] of Object.entries(iterContext.steps)) {
            if (!beforeKeys.has(key) || iterContext.steps[key] !== context.steps[key]) {
              iterResult[key] = val;
            }
          }
          iterationResults[i] = iterResult;
          // Merge step results back
          Object.assign(context.steps, iterContext.steps);
          return iterContext.loop[loop.as];
        })
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[batchStart + j] = batchResults[j];
      }
    }

    context.loop = savedLoop;
    return {
      status: 'success',
      output: results,
      response: { items: results, iterations: iterationResults },
    };
  }

  // Sequential loop (default)
  const results: unknown[] = [];

  for (let i = 0; i < bounded.length; i++) {
    context.loop = {
      [loop.as]: bounded[i],
      item: bounded[i],
      i,
    };
    if (loop.indexAs) {
      context.loop[loop.indexAs] = i;
    }

    const beforeKeys = new Set(Object.keys(context.steps));
    await executeSteps(loop.steps, context, api, permissions, allowedActionIds, options, undefined, flowStack);
    // Collect new/changed step results for this iteration
    const iterResult: Record<string, StepResult> = {};
    for (const [key, val] of Object.entries(context.steps)) {
      if (!beforeKeys.has(key) || context.steps[key] !== (beforeKeys.has(key) ? undefined : val)) {
        iterResult[key] = val;
      }
    }
    iterationResults.push(iterResult);
    results.push(context.loop[loop.as]);
  }

  context.loop = savedLoop;
  return {
    status: 'success',
    output: results,
    response: { items: results, iterations: iterationResults },
  };
}

async function executeParallelStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
  flowStack: string[],
): Promise<StepResult> {
  const parallel = step.parallel!;
  const maxConcurrency = parallel.maxConcurrency || 5;
  const steps = parallel.steps;
  const results: StepResult[] = [];

  // Process in batches of maxConcurrency
  for (let i = 0; i < steps.length; i += maxConcurrency) {
    const batch = steps.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(s => executeSingleStep(s, context, api, permissions, allowedActionIds, options, flowStack))
    );
    // Feature 1: Explicit keying of parallel substep outputs by ID
    for (let j = 0; j < batch.length; j++) {
      context.steps[batch[j].id] = batchResults[j];
    }
    results.push(...batchResults);
  }

  return { status: 'success', output: results, response: results };
}

function executeFileReadStep(step: FlowStep, context: FlowContext): StepResult {
  const config = step.fileRead!;
  const filePath = resolveValue(config.path, context) as string;
  const resolvedPath = path.resolve(filePath);
  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const output = config.parseJson ? JSON.parse(stripCodeFences(content)) : content;
  return { status: 'success', output, response: output };
}

function executeFileWriteStep(step: FlowStep, context: FlowContext): StepResult {
  const config = step.fileWrite!;
  const filePath = resolveValue(config.path, context) as string;
  const content = resolveValue(config.content, context);
  const resolvedPath = path.resolve(filePath);

  // Ensure parent directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const stringContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

  if (config.append) {
    fs.appendFileSync(resolvedPath, stringContent);
  } else {
    fs.writeFileSync(resolvedPath, stringContent);
  }

  return { status: 'success', output: { path: resolvedPath, bytesWritten: stringContent.length }, response: { path: resolvedPath } };
}

// Feature 2: While loop
async function executeWhileStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
  flowStack: string[],
): Promise<StepResult> {
  const config = step.while!;
  const maxIterations = config.maxIterations ?? 100;
  const results: unknown[] = [];

  // Initialize step output so condition can reference it
  context.steps[step.id] = {
    status: 'success',
    output: { lastResult: undefined, iteration: 0, results: [] },
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Do-while: skip condition check on iteration 0
    if (iteration > 0) {
      const conditionResult = evaluateExpression(config.condition, context);
      if (!conditionResult) break;
    }

    await executeSteps(config.steps, context, api, permissions, allowedActionIds, options, undefined, flowStack);

    // Capture last step's output as lastResult
    const lastStepId = config.steps[config.steps.length - 1]?.id;
    const lastResult = lastStepId ? context.steps[lastStepId]?.output : undefined;
    results.push(lastResult);

    // Update step output so next condition evaluation can reference it
    context.steps[step.id] = {
      status: 'success',
      output: { lastResult, iteration, results },
    };
  }

  return {
    status: 'success',
    output: { lastResult: results[results.length - 1], iteration: results.length, results },
    response: { iterations: results.length, results },
  };
}

// Feature 3: Sub-flow
async function executeSubflowStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
  flowStack: string[],
): Promise<StepResult> {
  const config = step.flow!;
  const resolvedKey = resolveValue(config.key, context) as string;
  const resolvedInputs = config.inputs
    ? resolveValue(config.inputs, context) as Record<string, unknown>
    : {};

  // Circular flow detection
  if (flowStack.includes(resolvedKey)) {
    throw new Error(`Circular flow detected: ${[...flowStack, resolvedKey].join(' → ')}`);
  }

  // Dynamic import to avoid circular dependency at module level
  const { loadFlow } = await import('./flow-runner.js');
  const subFlow = loadFlow(resolvedKey);

  const subContext = await executeFlow(
    subFlow,
    resolvedInputs,
    api,
    permissions,
    allowedActionIds,
    options,
    undefined,
    [...flowStack, resolvedKey],
  );

  return {
    status: 'success',
    output: subContext.steps,
    response: subContext,
  };
}

// Feature 6: Pagination primitive
async function executePaginateStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
): Promise<StepResult> {
  const config = step.paginate!;
  const maxPages = config.maxPages ?? 10;
  const allResults: unknown[] = [];
  let pageToken: unknown = undefined;
  let pages = 0;

  for (let page = 0; page < maxPages; page++) {
    // Clone the action config and inject page token
    const actionConfig: FlowActionConfig = JSON.parse(JSON.stringify(config.action));
    if (pageToken !== undefined && pageToken !== null) {
      const resolved = resolveValue(actionConfig, context) as Record<string, unknown>;
      setByDotPath(resolved, config.inputTokenParam, pageToken);
      // Build a synthetic action step
      const syntheticStep: FlowStep = {
        id: `${step.id}__page${page}`,
        name: `${step.id} page ${page}`,
        type: 'action',
        action: resolved as any,
      };
      const result = await executeActionStep(syntheticStep, context, api, permissions, allowedActionIds);
      const response = result.response as Record<string, unknown>;
      const pageResults = getByDotPath(response, config.resultsField);
      if (Array.isArray(pageResults)) allResults.push(...pageResults);
      pageToken = getByDotPath(response, config.pageTokenField);
      pages++;

      options.onEvent?.({ event: 'step:page', stepId: step.id, page: pages });

      if (pageToken === undefined || pageToken === null) break;
    } else if (page === 0) {
      // First page — no token yet
      const resolvedAction = resolveValue(actionConfig, context) as any;
      const syntheticStep: FlowStep = {
        id: `${step.id}__page0`,
        name: `${step.id} page 0`,
        type: 'action',
        action: resolvedAction,
      };
      const result = await executeActionStep(syntheticStep, context, api, permissions, allowedActionIds);
      const response = result.response as Record<string, unknown>;
      const pageResults = getByDotPath(response, config.resultsField);
      if (Array.isArray(pageResults)) allResults.push(...pageResults);
      pageToken = getByDotPath(response, config.pageTokenField);
      pages++;

      options.onEvent?.({ event: 'step:page', stepId: step.id, page: pages });

      if (pageToken === undefined || pageToken === null) break;
    }
  }

  return {
    status: 'success',
    output: allResults,
    response: { pages, totalResults: allResults.length, results: allResults },
  };
}

// Feature 9: Bash step
async function executeBashStep(
  step: FlowStep,
  context: FlowContext,
  options: FlowExecuteOptions,
): Promise<StepResult> {
  if (!options.allowBash) {
    throw new Error('Bash steps require --allow-bash flag for security');
  }
  const config = step.bash!;
  const command = resolveValue(config.command, context) as string;
  const cwd = config.cwd ? resolveValue(config.cwd, context) as string : process.cwd();
  const env = config.env
    ? { ...process.env, ...resolveValue(config.env, context) as Record<string, string> }
    : process.env;

  const { stdout, stderr } = await execAsync(command, {
    timeout: config.timeout || 30000,
    cwd,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });

  const output = config.parseJson ? JSON.parse(stripCodeFences(stdout)) : stdout.trim();
  return {
    status: 'success',
    output,
    response: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 },
  };
}

// ── Core Execution ──

export async function executeSingleStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
  flowStack: string[] = [],
): Promise<StepResult> {
  // Conditional execution
  if (step.if) {
    const condResult = evaluateExpression(step.if, context);
    if (!condResult) {
      const result: StepResult = { status: 'skipped' };
      context.steps[step.id] = result;
      return result;
    }
  }
  if (step.unless) {
    const condResult = evaluateExpression(step.unless, context);
    if (condResult) {
      const result: StepResult = { status: 'skipped' };
      context.steps[step.id] = result;
      return result;
    }
  }

  const startTime = Date.now();
  let lastError: Error | undefined;
  const maxAttempts = (step.onError?.strategy === 'retry' && step.onError.retries) ? step.onError.retries + 1 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        options.onEvent?.({
          event: 'step:retry',
          stepId: step.id,
          attempt,
          maxRetries: step.onError!.retries!,
        });
        const delay = step.onError?.retryDelayMs || 1000;
        await sleep(delay);
      }

      // Feature 7: Mock mode — mock external steps, run logic steps normally
      if (options.mock && (step.type === 'action' || step.type === 'paginate' || step.type === 'bash')) {
        const resolvedConfig = step[step.type] ? resolveValue(step[step.type], context) : {};
        options.onEvent?.({ event: 'step:mock', stepId: step.id, type: step.type, config: resolvedConfig });
        const result: StepResult = {
          status: 'success',
          output: { _mock: true, ...resolvedConfig as Record<string, unknown> },
          response: { _mock: true },
          durationMs: Date.now() - startTime,
        };
        context.steps[step.id] = result;
        return result;
      }

      let result: StepResult;

      switch (step.type) {
        case 'action':
          result = await executeActionStep(step, context, api, permissions, allowedActionIds);
          break;
        case 'transform':
          result = executeTransformStep(step, context);
          break;
        case 'code':
          result = await executeCodeStep(step, context);
          break;
        case 'condition':
          result = await executeConditionStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          break;
        case 'loop':
          result = await executeLoopStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          break;
        case 'parallel':
          result = await executeParallelStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          break;
        case 'file-read':
          result = executeFileReadStep(step, context);
          break;
        case 'file-write':
          result = executeFileWriteStep(step, context);
          break;
        case 'while':
          result = await executeWhileStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          break;
        case 'flow':
          result = await executeSubflowStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          break;
        case 'paginate':
          result = await executePaginateStep(step, context, api, permissions, allowedActionIds, options);
          break;
        case 'bash':
          result = await executeBashStep(step, context, options);
          break;
        default:
          throw new Error(`Unknown step type: ${step.type}`);
      }

      result.durationMs = Date.now() - startTime;
      if (attempt > 1) result.retries = attempt - 1;
      context.steps[step.id] = result;
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) {
        // All retries exhausted or no retry strategy
        break;
      }
    }
  }

  // Handle error with strategy
  const errorMessage = lastError?.message || 'Unknown error';
  const strategy = step.onError?.strategy || 'fail';

  if (strategy === 'continue') {
    const result: StepResult = {
      status: 'failed',
      error: errorMessage,
      durationMs: Date.now() - startTime,
    };
    context.steps[step.id] = result;
    return result;
  }

  if (strategy === 'fallback' && step.onError?.fallbackStepId) {
    // The fallback step must already be defined in the flow
    // We mark this step as failed and the caller should handle fallback
    const result: StepResult = {
      status: 'failed',
      error: errorMessage,
      durationMs: Date.now() - startTime,
    };
    context.steps[step.id] = result;
    return result;
  }

  // Default: fail
  throw lastError;
}

export async function executeSteps(
  steps: FlowStep[],
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
  completedStepIds?: Set<string>,
  flowStack: string[] = [],
): Promise<StepResult[]> {
  const results: StepResult[] = [];

  for (const step of steps) {
    // Skip already-completed steps (for resume)
    if (completedStepIds?.has(step.id)) {
      results.push(context.steps[step.id] || { status: 'success' });
      continue;
    }

    options.onEvent?.({
      event: 'step:start',
      stepId: step.id,
      stepName: step.name,
      type: step.type,
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await executeSingleStep(step, context, api, permissions, allowedActionIds, options, flowStack);
      results.push(result);

      options.onEvent?.({
        event: 'step:complete',
        stepId: step.id,
        status: result.status,
        durationMs: result.durationMs,
        retries: result.retries,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      options.onEvent?.({
        event: 'step:error',
        stepId: step.id,
        error: errorMsg,
        strategy: step.onError?.strategy || 'fail',
      });

      throw error;
    }
  }

  return results;
}

export async function executeFlow(
  flow: Flow,
  inputs: Record<string, unknown>,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions = {},
  resumeState?: { context: FlowContext; completedSteps: string[] },
  flowStack: string[] = [],
): Promise<FlowContext> {
  // Validate required inputs
  for (const [name, decl] of Object.entries(flow.inputs)) {
    if (decl.required !== false && inputs[name] === undefined && decl.default === undefined) {
      throw new Error(`Missing required input: "${name}" — ${decl.description || ''}`);
    }
  }

  // Build resolved inputs with defaults
  const resolvedInputs: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(flow.inputs)) {
    if (inputs[name] !== undefined) {
      resolvedInputs[name] = inputs[name];
    } else if (decl.default !== undefined) {
      resolvedInputs[name] = decl.default;
    }
  }

  // Build context
  const context: FlowContext = resumeState?.context || {
    input: resolvedInputs,
    env: process.env as Record<string, string | undefined>,
    steps: {},
    loop: {},
  };

  const completedStepIds = resumeState
    ? new Set(resumeState.completedSteps)
    : undefined;

  // Feature 7: dry-run without mock — existing behavior
  if (options.dryRun && !options.mock) {
    options.onEvent?.({
      event: 'flow:dry-run',
      flowKey: flow.key,
      resolvedInputs,
      steps: flow.steps.map(s => ({ id: s.id, name: s.name, type: s.type })),
      timestamp: new Date().toISOString(),
    });
    return context;
  }

  options.onEvent?.({
    event: options.mock ? 'flow:mock-start' : 'flow:start',
    flowKey: flow.key,
    totalSteps: flow.steps.length,
    timestamp: new Date().toISOString(),
  });

  const flowStart = Date.now();

  try {
    await executeSteps(flow.steps, context, api, permissions, allowedActionIds, options, completedStepIds, flowStack);

    const stepEntries = Object.values(context.steps);
    const completed = stepEntries.filter(s => s.status === 'success').length;
    const failed = stepEntries.filter(s => s.status === 'failed').length;
    const skipped = stepEntries.filter(s => s.status === 'skipped').length;

    options.onEvent?.({
      event: 'flow:complete',
      flowKey: flow.key,
      status: 'success',
      durationMs: Date.now() - flowStart,
      stepsCompleted: completed,
      stepsFailed: failed,
      stepsSkipped: skipped,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    options.onEvent?.({
      event: 'flow:error',
      flowKey: flow.key,
      status: 'failed',
      error: errorMsg,
      durationMs: Date.now() - flowStart,
    });

    throw error;
  }

  return context;
}
