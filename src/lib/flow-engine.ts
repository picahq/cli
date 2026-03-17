import fs from 'node:fs';
import path from 'node:path';
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
} from './flow-types.js';

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
  const fn = new AsyncFunction('$', source);
  const output = await fn(context);
  return { status: 'success', output, response: output };
}

async function executeConditionStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
): Promise<StepResult> {
  const condition = step.condition!;
  const result = evaluateExpression(condition.expression, context);

  const branch = result ? condition.then : (condition.else || []);
  const branchResults = await executeSteps(branch, context, api, permissions, allowedActionIds, options);

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
): Promise<StepResult> {
  const loop = step.loop!;
  const items = resolveValue(loop.over, context);

  if (!Array.isArray(items)) {
    throw new Error(`Loop "over" must resolve to an array, got ${typeof items}`);
  }

  const maxIterations = loop.maxIterations || 1000;
  const results: unknown[] = [];
  const savedLoop = { ...context.loop };

  for (let i = 0; i < Math.min(items.length, maxIterations); i++) {
    context.loop = {
      [loop.as]: items[i],
      item: items[i],
      i,
    };
    if (loop.indexAs) {
      context.loop[loop.indexAs] = i;
    }

    await executeSteps(loop.steps, context, api, permissions, allowedActionIds, options);
    results.push(context.loop[loop.as]);
  }

  context.loop = savedLoop;
  return { status: 'success', output: results, response: results };
}

async function executeParallelStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
): Promise<StepResult> {
  const parallel = step.parallel!;
  const maxConcurrency = parallel.maxConcurrency || 5;
  const steps = parallel.steps;
  const results: StepResult[] = [];

  // Process in batches of maxConcurrency
  for (let i = 0; i < steps.length; i += maxConcurrency) {
    const batch = steps.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(s => executeSingleStep(s, context, api, permissions, allowedActionIds, options))
    );
    results.push(...batchResults);
  }

  return { status: 'success', output: results, response: results };
}

function executeFileReadStep(step: FlowStep, context: FlowContext): StepResult {
  const config = step.fileRead!;
  const filePath = resolveValue(config.path, context) as string;
  const resolvedPath = path.resolve(filePath);
  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const output = config.parseJson ? JSON.parse(content) : content;
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

// ── Core Execution ──

export async function executeSingleStep(
  step: FlowStep,
  context: FlowContext,
  api: OneApi,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  options: FlowExecuteOptions,
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
          result = await executeConditionStep(step, context, api, permissions, allowedActionIds, options);
          break;
        case 'loop':
          result = await executeLoopStep(step, context, api, permissions, allowedActionIds, options);
          break;
        case 'parallel':
          result = await executeParallelStep(step, context, api, permissions, allowedActionIds, options);
          break;
        case 'file-read':
          result = executeFileReadStep(step, context);
          break;
        case 'file-write':
          result = executeFileWriteStep(step, context);
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
      const result = await executeSingleStep(step, context, api, permissions, allowedActionIds, options);
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

  if (options.dryRun) {
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
    event: 'flow:start',
    flowKey: flow.key,
    totalSteps: flow.steps.length,
    timestamp: new Date().toISOString(),
  });

  const flowStart = Date.now();

  try {
    await executeSteps(flow.steps, context, api, permissions, allowedActionIds, options, completedStepIds);

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
