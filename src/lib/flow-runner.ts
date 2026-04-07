import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { OneApi } from './api.js';
import type { PermissionLevel } from './types.js';
import type {
  Flow,
  FlowContext,
  FlowEvent,
  FlowRunState,
  FlowExecuteOptions,
} from './flow-types.js';
import { executeFlow } from './flow-engine.js';
import { getNestedStepsKeys } from './flow-schema.js';
import type { FlowStep, FlowStepType } from './flow-types.js';

const FLOWS_DIR = '.one/flows';
const RUNS_DIR = '.one/flows/.runs';
const LOGS_DIR = '.one/flows/.logs';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateRunId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export class FlowRunner {
  private runId: string;
  private flowKey: string;
  private state: FlowRunState;
  private logPath: string;
  private statePath: string;
  private paused = false;

  constructor(flow: Flow, inputs: Record<string, unknown>, runId?: string) {
    this.runId = runId || generateRunId();
    this.flowKey = flow.key;

    ensureDir(RUNS_DIR);
    ensureDir(LOGS_DIR);

    this.statePath = path.join(RUNS_DIR, `${flow.key}-${this.runId}.state.json`);
    this.logPath = path.join(LOGS_DIR, `${flow.key}-${this.runId}.log`);

    // Resolve default values for optional inputs not provided
    const resolvedInputs: Record<string, unknown> = { ...inputs };
    for (const [name, decl] of Object.entries(flow.inputs)) {
      if (resolvedInputs[name] === undefined && decl.default !== undefined) {
        resolvedInputs[name] = decl.default;
      }
    }

    this.state = {
      runId: this.runId,
      flowKey: flow.key,
      status: 'running',
      startedAt: new Date().toISOString(),
      inputs: resolvedInputs,
      completedSteps: [],
      context: {
        input: inputs,
        env: {},
        steps: {},
        loop: {},
      },
    };
  }

  getRunId(): string {
    return this.runId;
  }

  getLogPath(): string {
    return this.logPath;
  }

  getStatePath(): string {
    return this.statePath;
  }

  requestPause(): void {
    this.paused = true;
  }

  private log(level: string, msg: string, data?: Record<string, unknown>): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...data,
    };
    fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
  }

  private saveState(): void {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  private createEventHandler(externalHandler?: (event: FlowEvent) => void): (event: FlowEvent) => void {
    return (event: FlowEvent) => {
      // Log every event
      this.log(
        event.event.includes('error') ? 'warn' : 'info',
        event.event as string,
        event,
      );

      // Track completed steps and persist state incrementally
      if (event.event === 'step:complete' && event.stepId) {
        this.state.completedSteps.push(event.stepId as string);
        this.state.currentStepId = undefined;
        this.saveState();
      }
      if (event.event === 'step:start' && event.stepId) {
        this.state.currentStepId = event.stepId as string;
      }

      // Forward to external handler
      externalHandler?.(event);

      // Check if pause was requested
      if (this.paused && event.event === 'step:complete') {
        this.state.status = 'paused';
        this.state.pausedAt = new Date().toISOString();
        this.saveState();
        // TODO: In a real implementation, we'd throw a special error to break execution
      }
    };
  }

  async execute(
    flow: Flow,
    api: OneApi,
    permissions: PermissionLevel,
    allowedActionIds: string[],
    options: FlowExecuteOptions = {},
  ): Promise<FlowContext> {
    this.log('info', 'Flow started', { flowKey: this.flowKey, runId: this.runId });
    this.state.status = 'running';

    // Pre-create live context so state persistence captures progress
    const liveContext: FlowContext = {
      input: this.state.inputs,
      env: process.env as Record<string, string | undefined>,
      steps: {},
      loop: {},
    };
    this.state.context = liveContext;
    this.saveState();

    const eventHandler = this.createEventHandler(options.onEvent);

    try {
      const context = await executeFlow(
        flow,
        this.state.inputs,
        api,
        permissions,
        allowedActionIds,
        { ...options, onEvent: eventHandler },
        { context: liveContext, completedSteps: [] },
      );

      this.state.status = 'completed';
      this.state.completedAt = new Date().toISOString();
      this.state.context = context;
      this.saveState();

      this.log('info', 'Flow completed', { status: 'success' });
      return context;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.state.status = 'failed';
      this.state.context.steps = this.state.context.steps || {};
      this.saveState();

      this.log('error', 'Flow failed', { error: errorMsg });
      throw error;
    }
  }

  async resume(
    flow: Flow,
    api: OneApi,
    permissions: PermissionLevel,
    allowedActionIds: string[],
    options: FlowExecuteOptions = {},
  ): Promise<FlowContext> {
    this.log('info', 'Flow resumed', { flowKey: this.flowKey, runId: this.runId });
    this.state.status = 'running';
    this.state.pausedAt = undefined;

    // Re-populate env from current process.env (don't rely on saved env)
    this.state.context.env = process.env as Record<string, string | undefined>;
    this.saveState();

    const eventHandler = this.createEventHandler(options.onEvent);

    try {
      const context = await executeFlow(
        flow,
        this.state.inputs,
        api,
        permissions,
        allowedActionIds,
        { ...options, onEvent: eventHandler },
        {
          context: this.state.context,
          completedSteps: this.state.completedSteps,
        },
      );

      this.state.status = 'completed';
      this.state.completedAt = new Date().toISOString();
      this.state.context = context;
      this.saveState();

      this.log('info', 'Flow completed after resume', { status: 'success' });
      return context;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.state.status = 'failed';
      this.saveState();

      this.log('error', 'Flow failed after resume', { error: errorMsg });
      throw error;
    }
  }

  static loadRunState(runId: string): FlowRunState | null {
    ensureDir(RUNS_DIR);
    const files = fs.readdirSync(RUNS_DIR).filter(f => f.includes(runId) && f.endsWith('.state.json'));
    if (files.length === 0) return null;

    try {
      const content = fs.readFileSync(path.join(RUNS_DIR, files[0]), 'utf-8');
      return JSON.parse(content) as FlowRunState;
    } catch {
      return null;
    }
  }

  static fromRunState(state: FlowRunState): FlowRunner {
    const runner = Object.create(FlowRunner.prototype) as FlowRunner;
    runner.runId = state.runId;
    runner.flowKey = state.flowKey;
    runner.state = state;
    runner.paused = false;
    runner.statePath = path.join(RUNS_DIR, `${state.flowKey}-${state.runId}.state.json`);
    runner.logPath = path.join(LOGS_DIR, `${state.flowKey}-${state.runId}.log`);
    return runner;
  }

  static listRuns(flowKey?: string): FlowRunState[] {
    ensureDir(RUNS_DIR);
    const files = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.state.json'));
    const runs: FlowRunState[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(RUNS_DIR, file), 'utf-8');
        const state = JSON.parse(content) as FlowRunState;
        if (!flowKey || state.flowKey === flowKey) {
          runs.push(state);
        }
      } catch {
        // Skip corrupted state files
      }
    }

    return runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }
}

// ── Flow File Helpers ──

/**
 * Resolve a flow key or path to its file location.
 *
 * Resolution order for bare keys:
 *   1. `.one/flows/<key>/flow.json` (folder layout — preferred for new flows)
 *   2. `.one/flows/<key>.flow.json` (legacy single-file layout)
 *
 * Returns the first existing path. If neither exists, returns the folder-layout
 * path so error messages point at the modern convention.
 */
export function resolveFlowPath(keyOrPath: string): string {
  // Explicit path or .json filename → use as-is
  if (keyOrPath.includes('/') || keyOrPath.includes('\\') || keyOrPath.endsWith('.json')) {
    return path.resolve(keyOrPath);
  }
  const folderPath = path.resolve(FLOWS_DIR, keyOrPath, 'flow.json');
  const legacyPath = path.resolve(FLOWS_DIR, `${keyOrPath}.flow.json`);
  if (fs.existsSync(folderPath)) return folderPath;
  if (fs.existsSync(legacyPath)) return legacyPath;
  return folderPath;
}

/**
 * Given a flow's JSON file path, return the directory that code modules
 * should resolve against. For folder flows this is the directory containing
 * `flow.json`; for legacy single-file flows it's `.one/flows/`.
 */
export function getFlowRootDir(flowFilePath: string): string {
  const dir = path.dirname(flowFilePath);
  const base = path.basename(flowFilePath);
  // Folder layout: <key>/flow.json → root is <key>/
  if (base === 'flow.json') return dir;
  // Legacy: .one/flows/<key>.flow.json → root is .one/flows/
  return dir;
}

export interface LoadedFlow {
  flow: Flow;
  filePath: string;
  rootDir: string;
}

export function loadFlowWithMeta(keyOrPath: string): LoadedFlow {
  const filePath = resolveFlowPath(keyOrPath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Flow not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const flow = JSON.parse(content) as Flow;
  return { flow, filePath, rootDir: getFlowRootDir(filePath) };
}

export function loadFlow(keyOrPath: string): Flow {
  return loadFlowWithMeta(keyOrPath).flow;
}

/**
 * Walk a flow's steps (including nested steps in condition/loop/parallel/while)
 * and invoke `visit` for each step. Returns true if any visit returned true —
 * useful for "does this flow contain a bash step" type queries.
 */
export function walkSteps(steps: FlowStep[], visit: (step: FlowStep) => boolean | void): boolean {
  const nested = getNestedStepsKeys();
  for (const step of steps) {
    if (visit(step)) return true;
    for (const { configKey, fieldName } of nested) {
      const config = (step as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
      if (config && Array.isArray(config[fieldName])) {
        if (walkSteps(config[fieldName] as FlowStep[], visit)) return true;
      }
    }
  }
  return false;
}

/** Collect unique step types used in the flow (recursively). */
export function collectStepTypes(flow: Flow): FlowStepType[] {
  const types = new Set<FlowStepType>();
  walkSteps(flow.steps, step => { types.add(step.type); });
  return Array.from(types).sort();
}

/** True if any step (recursively) is a bash step. */
export function flowRequiresBash(flow: Flow): boolean {
  return walkSteps(flow.steps, step => step.type === 'bash');
}

/** True if any code step (recursively) uses an external module file. */
export function flowUsesCodeModules(flow: Flow): boolean {
  return walkSteps(flow.steps, step => step.type === 'code' && !!step.code?.module);
}

export interface FlowInputSummary {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
  connection?: { platform: string };
  autoResolvable: boolean;
}

export function summarizeFlowInputs(flow: Flow): FlowInputSummary[] {
  return Object.entries(flow.inputs).map(([name, decl]) => ({
    name,
    type: decl.type,
    required: decl.required !== false,
    default: decl.default,
    description: decl.description,
    connection: decl.connection,
    // An input is auto-resolvable if it points to a connection (the engine
    // will pick it automatically when exactly one matching connection exists).
    autoResolvable: !!decl.connection,
  }));
}

type FlowListEntry = {
  key: string;
  name: string;
  description?: string;
  inputCount: number;
  stepCount: number;
  path: string;
  layout: 'folder' | 'legacy';
  stepTypes: FlowStepType[];
  requiresBash: boolean;
  usesCodeModules: boolean;
  inputs: FlowInputSummary[];
};

export function listFlows(): FlowListEntry[] {
  const flowsDir = path.resolve(FLOWS_DIR);
  if (!fs.existsSync(flowsDir)) return [];

  const flows: FlowListEntry[] = [];
  const seenKeys = new Set<string>();

  const readFlowFile = (filePath: string): void => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const flow = JSON.parse(content) as Flow;
      if (seenKeys.has(flow.key)) return;
      seenKeys.add(flow.key);
      flows.push({
        key: flow.key,
        name: flow.name,
        description: flow.description,
        inputCount: Object.keys(flow.inputs).length,
        stepCount: flow.steps.length,
        path: filePath,
        layout: path.basename(filePath) === 'flow.json' ? 'folder' : 'legacy',
        stepTypes: collectStepTypes(flow),
        requiresBash: flowRequiresBash(flow),
        usesCodeModules: flowUsesCodeModules(flow),
        inputs: summarizeFlowInputs(flow),
      });
    } catch {
      // Skip malformed flow files
    }
  };

  for (const entry of fs.readdirSync(flowsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // skip .runs, .logs, etc.
    const full = path.join(flowsDir, entry.name);
    if (entry.isDirectory()) {
      const flowJson = path.join(full, 'flow.json');
      if (fs.existsSync(flowJson)) readFlowFile(flowJson);
    } else if (entry.isFile() && entry.name.endsWith('.flow.json')) {
      readFlowFile(full);
    }
  }

  return flows;
}

/**
 * Save a flow. New flows default to the folder layout
 * (`.one/flows/<key>/flow.json`), creating `<key>/lib/` alongside. An explicit
 * `outputPath` is respected as-is for backward compatibility.
 */
export function saveFlow(flow: Flow, outputPath?: string): string {
  let flowPath: string;
  if (outputPath) {
    flowPath = path.resolve(outputPath);
  } else {
    const legacyPath = path.resolve(FLOWS_DIR, `${flow.key}.flow.json`);
    const folderPath = path.resolve(FLOWS_DIR, flow.key, 'flow.json');
    // Preserve layout if a flow with this key already exists
    if (fs.existsSync(legacyPath) && !fs.existsSync(folderPath)) {
      flowPath = legacyPath;
    } else {
      flowPath = folderPath;
    }
  }

  const dir = path.dirname(flowPath);
  ensureDir(dir);

  // For folder layout, scaffold an empty lib/ so users know where modules go.
  if (path.basename(flowPath) === 'flow.json') {
    ensureDir(path.join(dir, 'lib'));
  }

  fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2) + '\n');
  return flowPath;
}
