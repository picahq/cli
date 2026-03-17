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

    this.state = {
      runId: this.runId,
      flowKey: flow.key,
      status: 'running',
      startedAt: new Date().toISOString(),
      inputs,
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

      // Track completed steps
      if (event.event === 'step:complete' && event.stepId) {
        this.state.completedSteps.push(event.stepId as string);
        this.state.currentStepId = undefined;
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

export function resolveFlowPath(keyOrPath: string): string {
  // If it looks like a file path (contains / or \ or ends with .json)
  if (keyOrPath.includes('/') || keyOrPath.includes('\\') || keyOrPath.endsWith('.json')) {
    return path.resolve(keyOrPath);
  }
  // Otherwise treat as a flow key
  return path.resolve(FLOWS_DIR, `${keyOrPath}.flow.json`);
}

export function loadFlow(keyOrPath: string): Flow {
  const flowPath = resolveFlowPath(keyOrPath);

  if (!fs.existsSync(flowPath)) {
    throw new Error(`Flow not found: ${flowPath}`);
  }

  const content = fs.readFileSync(flowPath, 'utf-8');
  return JSON.parse(content) as Flow;
}

export function listFlows(): { key: string; name: string; description?: string; inputCount: number; stepCount: number; path: string }[] {
  const flowsDir = path.resolve(FLOWS_DIR);
  if (!fs.existsSync(flowsDir)) return [];

  const files = fs.readdirSync(flowsDir).filter(f => f.endsWith('.flow.json'));
  const flows: { key: string; name: string; description?: string; inputCount: number; stepCount: number; path: string }[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(flowsDir, file), 'utf-8');
      const flow = JSON.parse(content) as Flow;
      flows.push({
        key: flow.key,
        name: flow.name,
        description: flow.description,
        inputCount: Object.keys(flow.inputs).length,
        stepCount: flow.steps.length,
        path: path.join(flowsDir, file),
      });
    } catch {
      // Skip malformed flow files
    }
  }

  return flows;
}

export function saveFlow(flow: Flow, outputPath?: string): string {
  const flowPath = outputPath
    ? path.resolve(outputPath)
    : path.resolve(FLOWS_DIR, `${flow.key}.flow.json`);

  const dir = path.dirname(flowPath);
  ensureDir(dir);

  fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2) + '\n');
  return flowPath;
}
