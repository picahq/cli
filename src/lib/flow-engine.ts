import fs from 'node:fs';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
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

/**
 * Error thrown when a step exceeds its `timeoutMs`. Carries an `errorCode` of
 * 'TIMEOUT' so the step-result builder can surface `status: 'timeout'` to
 * downstream consumers (withoneai/cli#58, #67).
 */
class StepTimeoutError extends Error {
  errorCode = 'TIMEOUT' as const;
  constructor(stepId: string, timeoutMs: number) {
    super(`Step "${stepId}" exceeded timeout of ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stepId: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(stepId, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Compute the delay before retry attempt N (1-indexed first retry = attempt 2
 * in the executor loop). Honours `backoff` and `maxDelayMs` from the step's
 * onError config; defaults to fixed-delay so existing flows are unchanged.
 */
function computeRetryDelay(onError: import('./flow-types.js').FlowStepErrorConfig, attempt: number): number {
  const base = onError.retryDelayMs ?? 1000;
  const max = onError.maxDelayMs ?? 30_000;
  const backoff = onError.backoff ?? 'fixed';
  // attempt == 2 is the first retry, so the exponent is (attempt - 2)
  const retryIndex = attempt - 2;
  let delay: number;
  if (backoff === 'exponential' || backoff === 'exponential-jitter') {
    delay = Math.min(base * Math.pow(2, retryIndex), max);
    if (backoff === 'exponential-jitter') {
      delay = delay * (0.5 + Math.random() * 0.5);
    }
  } else {
    delay = base;
  }
  return Math.round(delay);
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

/**
 * POSIX-shell-quote a string so it can be safely interpolated into a bash
 * command. Wraps in single quotes and escapes any embedded single quotes
 * using the standard `'\''` close-reopen trick.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function interpolateString(str: string, context: FlowContext): string {
  // Supports two token shapes:
  //   {{$.path.to.value}}        — raw stringification (string interp)
  //   {{q $.path.to.value}}      — POSIX-shell-quoted, safe for bash steps
  return str.replace(/\{\{\s*(q\s+)?(\$\.[^}\s]+)\s*\}\}/g, (_match, qFlag, selector) => {
    const value = resolveSelector(selector, context);
    if (value === undefined || value === null) return qFlag ? `''` : '';
    if (typeof value === 'object') {
      console.warn(
        `[flow] WARNING: Handlebars expression "{{${qFlag ? 'q ' : ''}${selector}}}" resolved to ${Array.isArray(value) ? 'an array' : 'an object'} and was stringified as JSON. ` +
        `To pass objects/arrays as native values, use a direct selector without {{ }}: "${selector}"`
      );
      const json = JSON.stringify(value);
      return qFlag ? shellQuote(json) : json;
    }
    const str = String(value);
    return qFlag ? shellQuote(str) : str;
  });
}

export function resolveValue(value: unknown, context: FlowContext): unknown {
  if (typeof value === 'string') {
    // Pure selector — return raw type
    if (value.startsWith('$.') && !value.includes('{{')) {
      return resolveSelector(value, context);
    }
    // String with interpolation ({{$.x}} or {{q $.x}})
    if (value.includes('{{$.') || /\{\{\s*q\s+\$\./.test(value)) {
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

async function executeCodeStep(
  step: FlowStep,
  context: FlowContext,
  options: FlowExecuteOptions,
): Promise<StepResult> {
  const config = step.code!;

  if (config.module) {
    const output = await executeCodeModule(step.id, config.module, context, options);
    return { status: 'success', output, response: output };
  }

  if (typeof config.source !== 'string') {
    throw new Error(`Code step "${step.id}" must define either "source" or "module"`);
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const sandboxedRequire = createSandboxedRequire();
  // Tag the source with a sourceURL so V8 stack frames are attributable to
  // this specific code step, then run it. On error, rewrite the stack so the
  // line numbers reference the user's source (not the AsyncFunction wrapper)
  // and prepend the offending line of code.
  const sourceURL = `code:${step.id}`;
  const taggedSource = `${config.source}\n//# sourceURL=${sourceURL}`;
  const fn = new AsyncFunction('$', 'require', taggedSource);
  try {
    const output = await fn(context, sandboxedRequire);
    return { status: 'success', output, response: output };
  } catch (err) {
    throw rewriteCodeStepError(err, step.id, config.source, sourceURL);
  }
}

/**
 * Rewrite an error thrown from inside a code step so the message points at
 * the user's source line instead of the AsyncFunction wrapper. The
 * `new AsyncFunction(...)` wrapper prepends 2 lines (`async function
 * anonymous($, require\n) {`) before the user's body, so stack frame line
 * numbers are off by 2.
 */
function rewriteCodeStepError(err: unknown, stepId: string, source: string, sourceURL: string): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const WRAPPER_LINE_OFFSET = 2;
  const sourceLines = source.split('\n');
  const stack = err.stack || '';
  // Match frames like "at code:stepId:LINE:COL" or "at <anonymous> (code:stepId:LINE:COL)"
  const re = new RegExp(`${sourceURL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}:(\\d+):(\\d+)`);
  const match = stack.match(re);
  if (!match) {
    err.message = `Code step "${stepId}" failed: ${err.message}`;
    return err;
  }
  const wrappedLine = parseInt(match[1], 10);
  const col = parseInt(match[2], 10);
  const userLine = wrappedLine - WRAPPER_LINE_OFFSET;
  const lineContent = sourceLines[userLine - 1] ?? '';
  const trimmed = lineContent.trim();
  err.message = `Code step "${stepId}" failed at line ${userLine}:${col}\n  ${trimmed}\n  ${err.message}`;
  // Also rewrite stack frames so further tooling sees user-relative lines.
  err.stack = stack.replace(new RegExp(`(${sourceURL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}:)(\\d+)`, 'g'), (_m, prefix, l) =>
    `${prefix}${parseInt(l, 10) - WRAPPER_LINE_OFFSET}`,
  );
  return err;
}

/**
 * Execute a code step that references an external .mjs module. The module is
 * spawned as a child `node` process; the flow context `$` is piped to stdin
 * as JSON and the module's stdout is parsed as JSON and returned.
 *
 * Contract for module authors (see guide):
 *
 *   const $ = JSON.parse(await new Response(process.stdin).text());
 *   // ...compute...
 *   process.stdout.write(JSON.stringify(result));
 */
async function executeCodeModule(
  stepId: string,
  modulePath: string,
  context: FlowContext,
  options: FlowExecuteOptions,
): Promise<unknown> {
  const rootDir = options.rootDir;
  if (!rootDir) {
    throw new Error(`Code step "${stepId}" uses module "${modulePath}" but no flow rootDir is available. Flows that use code modules must be loaded via loadFlowWithMeta.`);
  }

  // Safety: reject absolute paths and path traversal outside rootDir.
  if (path.isAbsolute(modulePath)) {
    throw new Error(`Code module path must be relative to the flow root, got absolute: "${modulePath}"`);
  }
  const absPath = path.resolve(rootDir, modulePath);
  const relFromRoot = path.relative(rootDir, absPath);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new Error(`Code module "${modulePath}" resolves outside the flow directory`);
  }

  if (!fs.existsSync(absPath)) {
    throw new Error(`Code module not found: ${absPath}`);
  }

  // Strip `env` — don't leak process.env into arbitrary user scripts via $.
  const { env: _omitEnv, ...safeContext } = context;
  void _omitEnv;
  const stdinPayload = JSON.stringify(safeContext);

  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(process.execPath, [absPath], {
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    child.on('error', err => reject(err));
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code !== 0) {
        reject(new Error(`Code module "${modulePath}" exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      const trimmed = stdout.trim();
      if (trimmed === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(stripCodeFences(trimmed)));
      } catch (err) {
        reject(new Error(`Code module "${modulePath}" did not print valid JSON to stdout: ${(err as Error).message}`));
      }
    });

    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
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
  const { loadFlowWithMeta } = await import('./flow-runner.js');
  const { flow: subFlow, rootDir: subRootDir } = loadFlowWithMeta(resolvedKey);

  // Sub-flows resolve their own code modules against their own rootDir.
  const subContext = await executeFlow(
    subFlow,
    resolvedInputs,
    api,
    permissions,
    allowedActionIds,
    { ...options, rootDir: subRootDir },
    undefined,
    [...flowStack, resolvedKey],
  );

  // Sub-flow output layout (withoneai/cli#66):
  //
  //   Previously: `output = subContext.steps`, forcing callers to write
  //     `$.steps.loadConfig.output.<innerStepId>.output.<field>`
  //
  //   Now: we flatten the sub-flow's FINAL step output onto the top-level
  //   output, so `$.steps.loadConfig.output.<field>` works directly. The
  //   legacy nested path (`.output.<innerStepId>.output.<field>`) continues
  //   to work because we spread flattened fields OVER the steps map — both
  //   access patterns resolve. If an inner step id collides with a
  //   flattened field name, the flattened field wins (and we emit a
  //   deprecation warning once per collision).
  //
  //   Also exposed: `output._steps` always points at the full sub-flow
  //   steps map for callers that need deterministic access regardless of
  //   field collisions.
  const finalStep = subFlow.steps[subFlow.steps.length - 1];
  const finalOutput = finalStep ? subContext.steps[finalStep.id]?.output : undefined;
  let flattenedOutput: unknown;
  if (finalOutput && typeof finalOutput === 'object' && !Array.isArray(finalOutput)) {
    const collisions = Object.keys(finalOutput as Record<string, unknown>).filter(
      k => k in subContext.steps,
    );
    if (collisions.length > 0) {
      options.onEvent?.({
        event: 'flow:warning',
        message: `Sub-flow "${resolvedKey}" final step output fields [${collisions.join(', ')}] collide with sub-step ids — flattened fields take precedence.`,
      } as FlowEvent);
    }
    flattenedOutput = {
      ...subContext.steps,
      ...(finalOutput as Record<string, unknown>),
      _steps: subContext.steps,
    };
  } else {
    flattenedOutput = {
      ...subContext.steps,
      _steps: subContext.steps,
      ...(finalOutput !== undefined ? { _finalOutput: finalOutput } : {}),
    };
  }

  return {
    status: 'success',
    output: flattenedOutput,
    response: flattenedOutput,
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

// ── Input describe helper (for type-error messages) ──

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array (${JSON.stringify(value)})`;
  if (typeof value === 'object') return `object (${JSON.stringify(value)})`;
  return `${typeof value} (${JSON.stringify(value)})`;
}

// ── Requires precondition check ──

/**
 * A required selector is "missing" if it resolves to undefined, null, an
 * empty string, or an empty array. Empty objects are intentionally allowed
 * — `{}` is a valid value for many step types.
 */
function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Build a "...because step X was skipped" suffix when a required selector
 * points at an upstream step whose status explains the missing value.
 */
function explainMissing(selector: string, context: FlowContext): string {
  const parts = selector.slice(2).split('.');
  if (parts[0] !== 'steps' || parts.length < 2) return '';
  const stepId = parts[1].replace(/\[.*$/, '');
  const upstream = context.steps[stepId];
  if (!upstream) return ` (upstream step "${stepId}" has not run)`;
  if (upstream.status === 'skipped') return ` (upstream step "${stepId}" was skipped)`;
  if (upstream.status === 'failed') return ` (upstream step "${stepId}" failed: ${upstream.error ?? 'unknown error'})`;
  if (upstream.status === 'timeout') return ` (upstream step "${stepId}" timed out)`;
  return '';
}

export function checkRequires(step: FlowStep, context: FlowContext): void {
  if (!step.requires || step.requires.length === 0) return;
  for (const selector of step.requires) {
    const value = resolveSelector(selector, context);
    if (isMissing(value)) {
      const why = explainMissing(selector, context);
      throw new Error(
        `Step "${step.id}" requires ${selector} but it resolved to ${value === undefined ? 'undefined' : value === null ? 'null' : Array.isArray(value) ? 'an empty array' : 'an empty string'}${why}`
      );
    }
  }
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
        const delay = computeRetryDelay(step.onError!, attempt);
        options.onEvent?.({
          event: 'step:retry',
          stepId: step.id,
          attempt,
          maxRetries: step.onError!.retries!,
          delayMs: delay,
        });
        await sleep(delay);
      }

      // Presence preconditions: fail fast (and via onError) if any required
      // selector resolves to a missing value. Run before mock dispatch so
      // contract violations surface even in dry runs.
      checkRequires(step, context);

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

      const dispatch = async (): Promise<StepResult> => {
        switch (step.type) {
          case 'action':
            return await executeActionStep(step, context, api, permissions, allowedActionIds);
          case 'transform':
            return executeTransformStep(step, context);
          case 'code':
            return await executeCodeStep(step, context, options);
          case 'condition':
            return await executeConditionStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          case 'loop':
            return await executeLoopStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          case 'parallel':
            return await executeParallelStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          case 'file-read':
            return executeFileReadStep(step, context);
          case 'file-write':
            return executeFileWriteStep(step, context);
          case 'while':
            return await executeWhileStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          case 'flow':
            return await executeSubflowStep(step, context, api, permissions, allowedActionIds, options, flowStack);
          case 'paginate':
            return await executePaginateStep(step, context, api, permissions, allowedActionIds, options);
          case 'bash':
            return await executeBashStep(step, context, options);
          default:
            throw new Error(`Unknown step type: ${step.type}`);
        }
      };

      const result: StepResult = step.timeoutMs
        ? await withTimeout(dispatch(), step.timeoutMs, step.id)
        : await dispatch();

      result.durationMs = Date.now() - startTime;
      if (attempt > 1) {
        result.retries = attempt - 1;
        // Surface a clear "succeeded after N retries" event so observers
        // (and downstream tooling) can distinguish a clean run from a
        // recovered run.
        options.onEvent?.({
          event: 'step:retry-success',
          stepId: step.id,
          retries: attempt - 1,
        });
      }
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
  const retriesUsed = Math.max(0, maxAttempts - 1);
  const isTimeout = lastError instanceof StepTimeoutError;
  const errorCode = (lastError as { errorCode?: string } | undefined)?.errorCode;

  if (strategy === 'continue') {
    const result: StepResult = {
      status: isTimeout ? 'timeout' : 'failed',
      error: errorMessage,
      ...(errorCode ? { errorCode } : {}),
      durationMs: Date.now() - startTime,
      retries: retriesUsed,
    };
    context.steps[step.id] = result;
    return result;
  }

  if (strategy === 'fallback' && step.onError?.fallbackStepId) {
    // The fallback step must already be defined in the flow
    // We mark this step as failed and the caller should handle fallback
    const result: StepResult = {
      status: isTimeout ? 'timeout' : 'failed',
      error: errorMessage,
      ...(errorCode ? { errorCode } : {}),
      durationMs: Date.now() - startTime,
      retries: retriesUsed,
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
  // Validate, coerce, and apply defaults to inputs.
  // Coercion is intentionally narrow: it only fixes the cases where a value
  // arrived as the "wrong" primitive (string from a CLI flag, JSON-parsed
  // value from a subflow caller). It never silently drops information.
  const resolvedInputs: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(flow.inputs)) {
    const provided = inputs[name];
    const isMissing = provided === undefined || provided === null;

    if (isMissing) {
      if (decl.required !== false && decl.default === undefined) {
        throw new Error(`Missing required input: "${name}"${decl.description ? ` — ${decl.description}` : ''}`);
      }
      if (decl.default !== undefined) {
        resolvedInputs[name] = decl.default;
      }
      continue;
    }

    let value: unknown = provided;

    // Type coercion + check
    switch (decl.type) {
      case 'string':
        if (typeof value !== 'string') value = String(value);
        break;
      case 'number':
        if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
          value = Number(value);
        }
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new Error(`Input "${name}" must be a number, got ${describe(provided)}`);
        }
        break;
      case 'boolean':
        if (value === 'true' || value === '1' || value === 1) value = true;
        else if (value === 'false' || value === '0' || value === 0) value = false;
        if (typeof value !== 'boolean') {
          throw new Error(`Input "${name}" must be a boolean, got ${describe(provided)}`);
        }
        break;
      case 'array':
        if (typeof value === 'string') {
          try { value = JSON.parse(value); } catch { /* leave as-is, fail below */ }
        }
        if (!Array.isArray(value)) {
          throw new Error(`Input "${name}" must be an array, got ${describe(provided)}`);
        }
        break;
      case 'object':
        if (typeof value === 'string') {
          try { value = JSON.parse(value); } catch { /* leave as-is, fail below */ }
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`Input "${name}" must be an object, got ${describe(provided)}`);
        }
        break;
    }

    // Enum check (post-coercion)
    if (Array.isArray(decl.enum) && decl.enum.length > 0) {
      if (!decl.enum.some(allowed => allowed === value)) {
        throw new Error(`Input "${name}" must be one of ${JSON.stringify(decl.enum)}, got ${JSON.stringify(value)}`);
      }
    }

    resolvedInputs[name] = value;
  }

  // Build context. When resuming (or when FlowRunner pre-creates the
  // context), the caller's `input` map is the raw, un-coerced one — we
  // overwrite it with the validated/coerced inputs so that `$.input.X`
  // selectors see the right types.
  const context: FlowContext = resumeState?.context || {
    input: resolvedInputs,
    env: process.env as Record<string, string | undefined>,
    steps: {},
    loop: {},
  };
  context.input = resolvedInputs;

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
