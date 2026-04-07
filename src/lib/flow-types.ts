export interface FlowInputDeclaration {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
  description?: string;
  connection?: { platform: string };
}

export interface FlowActionConfig {
  platform: string;
  actionId: string;
  connectionKey: string;
  data?: Record<string, unknown>;
  pathVars?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface FlowTransformConfig {
  expression: string;
}

export interface FlowConditionConfig {
  expression: string;
  then: FlowStep[];
  else?: FlowStep[];
}

export interface FlowLoopConfig {
  over: string;
  as: string;
  indexAs?: string;
  steps: FlowStep[];
  maxIterations?: number;
  maxConcurrency?: number;
}

export interface FlowParallelConfig {
  steps: FlowStep[];
  maxConcurrency?: number;
}

export interface FlowFileReadConfig {
  path: string;
  parseJson?: boolean;
}

export interface FlowFileWriteConfig {
  path: string;
  content: unknown;
  append?: boolean;
}

export interface FlowCodeConfig {
  /** Inline JS source (async function body). Mutually exclusive with `module`. */
  source?: string;
  /** Path to a .mjs file relative to the flow's root directory (e.g. "lib/normalize.mjs"). Mutually exclusive with `source`. */
  module?: string;
}

export interface FlowWhileConfig {
  condition: string;
  maxIterations?: number;
  steps: FlowStep[];
}

export interface FlowSubflowConfig {
  key: string;
  inputs?: Record<string, unknown>;
}

export interface FlowPaginateConfig {
  action: FlowActionConfig;
  pageTokenField: string;
  resultsField: string;
  inputTokenParam: string;
  maxPages?: number;
}

export interface FlowBashConfig {
  command: string;
  timeout?: number;
  parseJson?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

export interface FlowStepErrorConfig {
  strategy: 'fail' | 'continue' | 'retry' | 'fallback';
  retries?: number;
  retryDelayMs?: number;
  fallbackStepId?: string;
}

export type FlowStepType = 'action' | 'transform' | 'code' | 'condition' | 'loop' | 'parallel' | 'file-read' | 'file-write' | 'while' | 'flow' | 'paginate' | 'bash';

export interface FlowStep {
  id: string;
  name: string;
  type: FlowStepType;
  if?: string;
  unless?: string;
  onError?: FlowStepErrorConfig;
  action?: FlowActionConfig;
  transform?: FlowTransformConfig;
  condition?: FlowConditionConfig;
  loop?: FlowLoopConfig;
  parallel?: FlowParallelConfig;
  fileRead?: FlowFileReadConfig;
  fileWrite?: FlowFileWriteConfig;
  code?: FlowCodeConfig;
  while?: FlowWhileConfig;
  flow?: FlowSubflowConfig;
  paginate?: FlowPaginateConfig;
  bash?: FlowBashConfig;
}

export interface Flow {
  key: string;
  name: string;
  description?: string;
  version?: string;
  inputs: Record<string, FlowInputDeclaration>;
  steps: FlowStep[];
}

export interface StepResult {
  status: 'success' | 'skipped' | 'failed';
  response?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
  retries?: number;
}

export interface FlowContext {
  input: Record<string, unknown>;
  env: Record<string, string | undefined>;
  steps: Record<string, StepResult>;
  loop: {
    item?: unknown;
    i?: number;
    [key: string]: unknown;
  };
}

export interface FlowRunState {
  runId: string;
  flowKey: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  startedAt: string;
  pausedAt?: string;
  completedAt?: string;
  inputs: Record<string, unknown>;
  completedSteps: string[];
  currentStepId?: string;
  context: FlowContext;
}

export interface FlowEvent {
  event: string;
  [key: string]: unknown;
}

export interface FlowExecuteOptions {
  dryRun?: boolean;
  mock?: boolean;
  verbose?: boolean;
  allowBash?: boolean;
  /** Absolute directory that contains this flow's `flow.json` (or the legacy `.one/flows/` dir). Used to resolve code.module paths. */
  rootDir?: string;
  onEvent?: (event: FlowEvent) => void;
}
