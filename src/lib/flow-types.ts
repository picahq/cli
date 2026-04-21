export interface FlowInputDeclaration {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
  description?: string;
  connection?: { platform: string };
  /**
   * Allowed values. If set, the resolved input must be strictly equal to one
   * of these (compared after type coercion). Useful for tier/stage/category
   * inputs where only a fixed vocabulary is valid.
   */
  enum?: unknown[];
}

export interface FlowActionConfig {
  platform: string;
  actionId: string;
  /**
   * Literal connection key (or `$.input.x` selector resolving to one). Legacy
   * form. Prefer `connection: { platform, tag? }` so re-auth doesn't break
   * the flow — re-auth always mints a new key, and the literal form forces a
   * manual edit (or external resolver script) every time.
   *
   * Exactly one of `connectionKey` or `connection` must be set per action.
   */
  connectionKey?: string;
  /**
   * Late-bound connection reference, resolved at flow-execute time. Survives
   * re-auth: the next run picks up the fresh key automatically. Use `tag` to
   * disambiguate when a platform has multiple connections (e.g. multiple
   * Gmail accounts). Both fields support `$.input.x` selectors so flows can
   * accept the tag (or the whole platform) as runtime input.
   *
   * Exactly one of `connectionKey` or `connection` must be set per action.
   */
  connection?: { platform: string; tag?: string };
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

/**
 * A bash-step env var value. Can be:
 * - a plain string (interpolated as-is, like before — caller is responsible for escaping)
 * - `{ json: <selector|value> }` — the value is JSON-serialized, written to a temp
 *   file, and the env var is set to the temp file path. Use with `@$VAR` in curl
 *   data, etc. The temp file is cleaned up after the step finishes.
 * - `{ shell: <selector|value> }` — the value is resolved and POSIX-shell-quoted,
 *   so it can be safely interpolated inside bash double-quoted strings via `"$VAR"`.
 */
export type FlowBashEnvValue = string | { json: unknown } | { shell: string };

export interface FlowBashConfig {
  command: string;
  timeout?: number;
  parseJson?: boolean;
  cwd?: string;
  env?: Record<string, FlowBashEnvValue>;
}

export interface FlowStepErrorConfig {
  strategy: 'fail' | 'continue' | 'retry' | 'fallback';
  retries?: number;
  retryDelayMs?: number;
  /**
   * Delay growth between retries.
   * - `fixed` (default): every retry waits `retryDelayMs`.
   * - `exponential`: retry N waits `retryDelayMs * 2^(N-1)`, capped at `maxDelayMs`.
   * - `exponential-jitter`: same as exponential, but each wait is multiplied by a
   *    uniform random factor in [0.5, 1.0) to spread retries and avoid thundering herds.
   */
  backoff?: 'fixed' | 'exponential' | 'exponential-jitter';
  /** Upper bound for backoff delays. Defaults to 30000 (30s). */
  maxDelayMs?: number;
  fallbackStepId?: string;
  /**
   * Conditional retry — only retry when the underlying error matches one of
   * these codes. Entries can be HTTP status numbers (429, 502), error code
   * strings ('TIMEOUT', 'ETIMEDOUT', 'ECONNRESET'), or substring matches
   * against the error message. If unset, all errors are retried (legacy
   * behavior).
   */
  retryOn?: (string | number)[];
  /**
   * Conditional fail-fast — if the error matches any entry here, the step
   * fails immediately without consuming further retries. Takes precedence
   * over `retryOn`. Same matching rules.
   */
  failFastOn?: (string | number)[];
}

export type FlowOutputSchemaType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown';
export type FlowOutputSchema = { [field: string]: FlowOutputSchemaType | FlowOutputSchema };

export type FlowStepType = 'action' | 'transform' | 'code' | 'condition' | 'loop' | 'parallel' | 'file-read' | 'file-write' | 'while' | 'flow' | 'paginate' | 'bash';

export interface FlowStep {
  id: string;
  name: string;
  type: FlowStepType;
  if?: string;
  unless?: string;
  /**
   * Wall-clock timeout for the step in milliseconds. When exceeded, the step fails with
   * a TimeoutError (errorCode: 'TIMEOUT'). If `onError.strategy` is `continue`, the step
   * result will have `status: 'timeout'` so downstream steps can distinguish a timeout
   * from a normal failure.
   */
  timeoutMs?: number;
  /**
   * Presence preconditions for this step. Each entry is a `$.input.X` or
   * `$.steps.X.output...` selector that must resolve to a non-empty value
   * (not undefined, null, '', or []) before the step runs. If any selector
   * is missing the step fails with a descriptive error — including *why*
   * the upstream value is missing (e.g. the source step was skipped or
   * failed). Failures honor the step's `onError` strategy.
   */
  requires?: string[];
  /**
   * Optional declaration of the shape of this step's `output`. When set, the
   * validator checks that downstream `$.steps.<this.id>.output.<field>`
   * references match a declared field. Field values are type names
   * (`string` | `number` | `boolean` | `object` | `array` | `unknown`) or
   * a nested record for object subfields. Purely a documentation /
   * validation aid — the engine does not coerce or check the runtime value
   * against the schema.
   */
  outputSchema?: FlowOutputSchema;
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
  // 'success' — step ran and produced output
  // 'skipped' — step was skipped by an `if`/`unless` condition
  // 'failed'  — step threw an error (and onError swallowed it, or the engine is reporting pre-throw state)
  // 'timeout' — step exceeded its configured `timeoutMs`
  status: 'success' | 'skipped' | 'failed' | 'timeout';
  response?: unknown;
  output?: unknown;
  error?: string;
  // Machine-readable error classifier. Currently set to 'TIMEOUT' for timed-out steps.
  // Other steps may populate this in the future (e.g. HTTP status codes for action errors).
  errorCode?: string;
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
  /**
   * Lazy-loaded connection cache — populated the first time an action step
   * resolves a `connection: { platform, tag? }` ref, then reused for the
   * rest of the run. Keeps a many-step flow from doing a `listConnections`
   * round-trip per step. Connections don't change mid-run, so caching for
   * the run's lifetime is safe.
   */
  _connections?: import('./types.js').Connection[];
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
  skipValidation?: boolean;
  /** Absolute directory that contains this flow's `flow.json` (or the legacy `.one/flows/` dir). Used to resolve code.module paths. */
  rootDir?: string;
  onEvent?: (event: FlowEvent) => void;
}
