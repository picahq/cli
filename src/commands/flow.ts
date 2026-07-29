import pc from 'picocolors';
import { getApiKey, getApiBase, getAccessControlFromAllSources } from '../lib/config.js';
import { OneApi } from '../lib/api.js';
import * as output from '../lib/output.js';
import { printTable } from '../lib/table.js';
import { validateFlow } from '../lib/flow-validator.js';
import { FlowRunner, loadFlowWithMeta, listFlows, saveFlow, resolveFlowPath, flowRequiresBash, walkSteps } from '../lib/flow-runner.js';
import type { DryResolvedStep, DryResolvedRef } from '../lib/flow-engine.js';
import type { Flow, FlowEvent, StepResult } from '../lib/flow-types.js';
import type { PermissionLevel } from '../lib/types.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Stream a `workflow:result` envelope to a file, serializing each step's
 * result separately rather than building one giant JSON string. A flow that
 * aggregates many/large sub-flow outputs can exceed V8's max string length
 * (`RangeError: Invalid string length`) or get truncated on stdout — both
 * reported in #87. Streaming bounds peak memory to the largest single step,
 * not the sum, and keeps the full result off stdout entirely.
 */
export async function writeFlowResultFile(
  filePath: string,
  meta: { runId: string; logFile: string; status: string },
  steps: Record<string, StepResult>,
): Promise<string> {
  const abs = path.resolve(filePath);
  const ws = fs.createWriteStream(abs);
  const done = new Promise<void>((resolve, reject) => {
    ws.on('finish', () => resolve());
    ws.on('error', reject);
  });
  ws.write(
    `{"event":"workflow:result","runId":${JSON.stringify(meta.runId)},` +
    `"logFile":${JSON.stringify(meta.logFile)},"status":${JSON.stringify(meta.status)},"steps":{`,
  );
  let first = true;
  for (const [id, result] of Object.entries(steps)) {
    ws.write(`${first ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(result)}`);
    first = false;
  }
  ws.write('}}');
  ws.end();
  await done;
  return abs;
}

/** Compact, single-line preview of a resolved value for human-readable output. */
function previewValue(value: unknown, max = 120): string {
  if (value === undefined) return '<undefined>';
  let str: string;
  try { str = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value); }
  catch { str = String(value); }
  if (str === undefined) str = String(value);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/** Render a single dry-run reference line (selector → resolved/deferred/missing). */
function renderDryRef(ref: DryResolvedRef): string {
  if (ref.status === 'resolved') {
    return `${pc.green('✓')} ${ref.selector} ${pc.dim('→')} ${previewValue(ref.value)}`;
  }
  if (ref.status === 'deferred') {
    return `${pc.dim('○')} ${ref.selector} ${pc.dim('→ pending (produced by a later step)')}`;
  }
  return `${pc.yellow('!')} ${ref.selector} ${pc.yellow('→ unresolved — check the input/env name')}`;
}

/** Render the per-step interpolation resolution from a `--dry-run`. */
function renderDryResolution(steps: DryResolvedStep[]): void {
  const isExpr = (t: string) => t === 'transform' || t === 'condition' || t === 'while';
  for (const s of steps) {
    const label = s.name ? `${s.stepId} ${pc.dim(`"${s.name}"`)}` : s.stepId;
    console.log(`  ${pc.cyan('▸')} ${label} ${pc.dim(`(${s.type})`)}`);
    if (s.error !== undefined) {
      console.log(`      ${pc.red('error')} ${s.error}`);
    } else if (isExpr(s.type) && s.deferred) {
      const deps = s.references.map(r => r.selector).join(', ');
      console.log(`      ${pc.dim('○ pending — depends on')} ${deps} ${pc.dim('(produced by a later step)')}`);
    } else if (isExpr(s.type)) {
      console.log(`      ${pc.dim('=')} ${previewValue(s.resolved)}`);
    }
    // Declarative refs (expression steps that are deferred already printed theirs above).
    if (!(isExpr(s.type) && s.deferred)) {
      for (const ref of s.references) {
        console.log(`      ${renderDryRef(ref)}`);
      }
    }
    if (!isExpr(s.type) && s.references.length === 0 && s.error === undefined) {
      console.log(`      ${pc.dim('(no interpolations)')}`);
    }
  }
}

function getConfig() {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('Not configured. Run `one init` first.');
  }

  const ac = getAccessControlFromAllSources();
  const permissions: PermissionLevel = ac.permissions || 'admin';
  const connectionKeys: string[] = ac.connectionKeys || ['*'];
  const actionIds: string[] = ac.actionIds || ['*'];

  return { apiKey, permissions, connectionKeys, actionIds };
}

function parseInputs(inputArgs: string[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const arg of inputArgs) {
    const eqIndex = arg.indexOf('=');
    if (eqIndex === -1) {
      output.error(`Invalid input format: "${arg}" — expected name=value`);
    }
    const key = arg.slice(0, eqIndex);
    const value = arg.slice(eqIndex + 1);

    // Try to parse as JSON, fall back to string
    try {
      inputs[key] = JSON.parse(value);
    } catch {
      inputs[key] = value;
    }
  }
  return inputs;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export { collect };

async function autoResolveConnectionInputs(
  flow: Flow,
  inputs: Record<string, unknown>,
  api: OneApi,
): Promise<Record<string, unknown>> {
  const resolved = { ...inputs };
  const connectionInputs = Object.entries(flow.inputs).filter(
    ([, decl]) => decl.connection && !resolved[decl.connection!.platform]
  );

  if (connectionInputs.length === 0) return resolved;

  // Check which connection inputs are missing
  const missing = connectionInputs.filter(([name]) => !resolved[name]);
  if (missing.length === 0) return resolved;

  // Fetch connections and try to auto-resolve
  const connections = await api.listConnections();
  for (const [name, decl] of missing) {
    const platform = decl.connection!.platform;
    const matching = connections.filter(c => c.platform.toLowerCase() === platform.toLowerCase());
    if (matching.length === 1) {
      resolved[name] = matching[0].key;
    }
  }

  return resolved;
}

// ── Commands ──

export async function flowCreateCommand(
  key: string | undefined,
  options: { definition?: string; output?: string },
): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Workflow ')));

  let flow: Flow;

  if (options.definition) {
    // Support @file.json syntax (like curl's -d @file)
    let raw = options.definition;
    if (raw.startsWith('@')) {
      const filePath = raw.slice(1);
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        output.error(`Cannot read file "${filePath}": ${(err as Error).message}`);
      }
    }
    try {
      flow = JSON.parse(raw) as Flow;
    } catch {
      output.error('Invalid JSON in --definition. If your JSON contains special characters (like :: in action IDs), try --definition @file.json instead.');
    }
  } else if (!process.stdin.isTTY) {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    try {
      flow = JSON.parse(raw) as Flow;
    } catch {
      output.error('Invalid JSON from stdin');
    }
  } else {
    output.error('Interactive workflow creation not yet supported. Use --definition <json> or pipe JSON via stdin.');
  }

  // Override key if provided as arg — extract group prefix if present (e.g. "research/company-research")
  let group: string | undefined;
  if (key) {
    if (key.includes('/')) {
      const parts = key.split('/');
      flow!.key = parts.pop()!;
      group = parts.join('/');
    } else {
      flow!.key = key;
    }
  }

  // Validate
  const errors = validateFlow(flow!);
  if (errors.length > 0) {
    if (output.isAgentMode()) {
      output.json({ error: 'Validation failed', errors });
      process.exit(1);
    }
    output.error(`Validation failed:\n${errors.map(e => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  const flowPath = saveFlow(flow!, options.output, group);

  if (output.isAgentMode()) {
    output.json({ created: true, key: flow!.key, path: flowPath });
    return;
  }

  output.note(`Workflow "${flow!.name}" saved to ${flowPath}`, 'Created');
  output.outro(`Validate: ${pc.cyan(`one flow validate ${flow!.key}`)}\nExecute:  ${pc.cyan(`one flow execute ${flow!.key}`)}`);
}

export async function flowExecuteCommand(
  keyOrPath: string,
  options: { input?: string[]; dryRun?: boolean; verbose?: boolean; mock?: boolean; allowBash?: boolean; skipValidation?: boolean; outputFile?: string; stopAfter?: string },
): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Workflow ')));

  const { apiKey, permissions, actionIds } = getConfig();
  const api = new OneApi(apiKey, getApiBase());

  const spinner = output.createSpinner();
  spinner.start(`Loading workflow "${keyOrPath}"...`);

  let flow: Flow;
  let rootDir: string;
  let flowFilePath: string;
  try {
    const loaded = loadFlowWithMeta(keyOrPath);
    flow = loaded.flow;
    rootDir = loaded.rootDir;
    flowFilePath = loaded.filePath;
  } catch (err) {
    spinner.stop('Workflow not found');
    output.error(err instanceof Error ? err.message : String(err));
    return; // unreachable — output.error exits
  }

  spinner.stop(`Workflow: ${flow.name} (${flow.steps.length} steps)`);

  // Pre-flight validation — catches schema/syntax errors before any step runs.
  const preflightErrors = validateFlow(flow, rootDir);
  if (preflightErrors.length > 0) {
    if (output.isAgentMode()) {
      output.json({ error: 'Validation failed', errors: preflightErrors });
      process.exit(1);
    }
    output.error(`Validation failed:\n${preflightErrors.map(e => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  // Deprecation warning: legacy single-file layout (`.one/flows/<key>.flow.json`)
  if (flowFilePath.endsWith('.flow.json')) {
    const msg = `Workflow "${flow.key}" uses the deprecated single-file layout. Migrate to .one/flows/${flow.key}/flow.json (see: one guide flows).`;
    if (output.isAgentMode()) {
      output.json({ event: 'flow:deprecation', flowKey: flow.key, warning: msg });
    } else {
      console.error(pc.yellow(`⚠ ${msg}`));
    }
  }

  // Pre-flight: if the flow has bash steps, require --allow-bash upfront so
  // we fail fast instead of partway through a long run.
  if (!options.allowBash && flowRequiresBash(flow)) {
    const msg = `Workflow "${flow.key}" contains bash steps. Re-run with --allow-bash to permit shell execution.`;
    if (output.isAgentMode()) {
      output.json({ error: msg, requiresBash: true, flowKey: flow.key });
      process.exit(1);
    }
    output.error(msg);
  }

  // --stop-after: fail fast if the target step id doesn't exist (typo), so we
  // don't run a long flow only to never hit the stop point. See #97.
  if (options.stopAfter) {
    const ids = new Set<string>();
    walkSteps(flow.steps, s => { ids.add(s.id); });
    if (!ids.has(options.stopAfter)) {
      const msg = `--stop-after target "${options.stopAfter}" is not a step in workflow "${flow.key}". Known step ids: ${[...ids].join(', ')}`;
      if (output.isAgentMode()) {
        output.json({ error: msg, unknownStopAfter: options.stopAfter, stepIds: [...ids] });
        process.exit(1);
      }
      output.error(msg);
    }
  }

  const inputs = parseInputs(options.input || []);
  const resolvedInputs = await autoResolveConnectionInputs(flow, inputs, api);

  const runner = new FlowRunner(flow, resolvedInputs);
  const logPath = runner.getLogPath();
  const runId = runner.getRunId();

  // Set up SIGINT handler for pause
  const sigintHandler = () => {
    runner.requestPause();
    if (!output.isAgentMode()) {
      console.log(`\n${pc.yellow('Pausing after current step completes...')} (run ID: ${runId})`);
    }
  };
  process.on('SIGINT', sigintHandler);

  // Debug-mode captures (#97): the engine streams these as events; we hold the
  // last-seen payloads to render a focused summary after execution returns.
  let dryRunSteps: DryResolvedStep[] | undefined;
  let dryResolveTarget: DryResolvedStep | undefined;
  let stoppedAfter: string | undefined;

  const onEvent = (event: FlowEvent): void => {
    if (event.event === 'flow:dry-run') {
      dryRunSteps = event.steps as DryResolvedStep[] | undefined;
    } else if (event.event === 'step:dry-resolve') {
      dryResolveTarget = event as unknown as DryResolvedStep;
    } else if (event.event === 'flow:stopped') {
      stoppedAfter = event.stoppedAfter as string | undefined;
    }

    if (output.isAgentMode()) {
      output.json(event);
    } else if (options.verbose) {
      const ts = new Date().toISOString().split('T')[1].slice(0, 8);
      if (event.event === 'step:start') {
        console.log(`  ${pc.dim(ts)} ${pc.cyan('▶')} ${event.stepName} ${pc.dim(`(${event.type})`)}`);
      } else if (event.event === 'step:complete') {
        const status = event.status === 'success' ? pc.green('✓') : event.status === 'skipped' ? pc.dim('○') : pc.red('✗');
        console.log(`  ${pc.dim(ts)} ${status} ${event.stepId} ${pc.dim(`${event.durationMs}ms`)}`);
      } else if (event.event === 'step:error') {
        console.log(`  ${pc.dim(ts)} ${pc.red('✗')} ${event.stepId}: ${event.error}`);
      }
    }
  };

  const execSpinner = output.createSpinner();
  if (!options.verbose && !output.isAgentMode()) {
    execSpinner.start('Executing workflow...');
  }

  try {
    const context = await runner.execute(flow, api, permissions, actionIds, {
      dryRun: options.dryRun,
      mock: options.mock,
      verbose: options.verbose,
      allowBash: options.allowBash,
      skipValidation: options.skipValidation,
      stopAfter: options.stopAfter,
      rootDir,
      onEvent,
    });

    process.off('SIGINT', sigintHandler);

    if (!options.verbose && !output.isAgentMode()) {
      execSpinner.stop(stoppedAfter ? 'Workflow stopped' : dryRunSteps ? 'Dry run complete' : 'Workflow completed');
    }

    // --output-file: write the full result to disk (streamed) instead of
    // stdout, so a large aggregate result can't be truncated or blow the V8
    // string limit. stdout then carries only a compact pointer. See #87.
    const resultFile = options.outputFile
      ? await writeFlowResultFile(options.outputFile, { runId, logFile: logPath, status: 'success' }, context.steps)
      : undefined;

    const finalStatus = stoppedAfter ? 'stopped' : 'success';

    if (output.isAgentMode()) {
      const envelope: Record<string, unknown> = {
        event: 'workflow:result', runId, logFile: logPath, statePath: runner.getStatePath(), status: finalStatus,
      };
      if (resultFile) envelope.outputFile = resultFile;
      else envelope.steps = context.steps;
      if (options.dryRun) envelope.dryRun = true;
      if (stoppedAfter) envelope.stoppedAfter = stoppedAfter;
      output.json(envelope);
      return;
    }

    if (resultFile) {
      output.note(`Full result written to ${resultFile}`, 'Output');
    }

    // Plain --dry-run (no stop point): no steps ran — show the resolved
    // interpolations per step instead of a misleading "0 succeeded" summary. #97
    if (dryRunSteps && !stoppedAfter) {
      console.log();
      renderDryResolution(dryRunSteps);
      console.log();
      const missing = dryRunSteps.reduce((n, s) => n + s.references.filter(r => r.status === 'missing').length, 0);
      output.note(
        `Dry run — no steps executed. Resolved ${dryRunSteps.length} step(s)` +
        (missing > 0 ? `; ${pc.yellow(`${missing} unresolved input/env reference(s)`)}` : '') +
        `.\n${pc.dim('$.steps.* refs resolve at runtime — re-run with --stop-after=<stepId> to resolve them against real output.')}`,
        'Dry Run',
      );
      return;
    }

    // Print results summary
    const stepEntries = Object.entries(context.steps);
    const succeeded = stepEntries.filter(([, r]) => r.status === 'success').length;
    const failed = stepEntries.filter(([, r]) => r.status === 'failed').length;
    const skipped = stepEntries.filter(([, r]) => r.status === 'skipped').length;

    console.log();
    console.log(`  ${pc.green('✓')} ${succeeded} succeeded  ${failed > 0 ? pc.red(`✗ ${failed} failed`) : ''}  ${skipped > 0 ? pc.dim(`○ ${skipped} skipped`) : ''}`);
    console.log(`  ${pc.dim(`Run ID: ${runId}`)}`);
    console.log(`  ${pc.dim(`Log: ${logPath}`)}`);

    // --dry-run --stop-after: the steps before the target ran for real; show
    // the target's interpolations resolved against that real context. #97
    if (dryResolveTarget) {
      console.log();
      console.log(`  ${pc.dim(`Resolved (not executed) "${dryResolveTarget.stepId}":`)}`);
      renderDryResolution([dryResolveTarget]);
    }

    if (stoppedAfter) {
      output.note(
        `Stopped after step "${stoppedAfter}". Inspect step outputs with: ${pc.cyan(`one flow inspect ${runId}`)}`,
        'Stopped',
      );
    } else if (options.dryRun) {
      output.note('Dry run — no steps were executed', 'Dry Run');
    }
  } catch (error) {
    process.off('SIGINT', sigintHandler);
    if (!options.verbose && !output.isAgentMode()) {
      execSpinner.stop('Workflow failed');
    }

    const errorMsg = error instanceof Error ? error.message : String(error);

    if (output.isAgentMode()) {
      output.json({
        event: 'workflow:result',
        runId,
        logFile: logPath,
        status: 'failed',
        error: errorMsg,
      });
      process.exit(1);
    }

    console.log(`  ${pc.dim(`Run ID: ${runId}`)}`);
    console.log(`  ${pc.dim(`Log: ${logPath}`)}`);
    output.error(`Workflow failed: ${errorMsg}`);
  }
}

export async function flowListCommand(): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Workflow ')));

  const flows = listFlows();

  if (output.isAgentMode()) {
    output.json({ workflows: flows });
    return;
  }

  if (flows.length === 0) {
    output.note('No workflows found in .one/flows/\n\nCreate one with: one flow create', 'Workflows');
    return;
  }

  console.log();
  printTable(
    [
      { key: 'key', label: 'Key' },
      { key: 'name', label: 'Name' },
      { key: 'layout', label: 'Layout' },
      { key: 'inputCount', label: 'Inputs' },
      { key: 'stepCount', label: 'Steps' },
      { key: 'flags', label: 'Requires' },
    ],
    flows.map(f => ({
      key: f.group ? `${f.group}/${f.key}` : f.key,
      name: f.name,
      layout: f.layout,
      inputCount: String(f.inputCount),
      stepCount: String(f.stepCount),
      flags: f.requiresBash ? '--allow-bash' : '',
    })),
  );
  console.log();
}

export async function flowValidateCommand(keyOrPath: string): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Workflow ')));

  const spinner = output.createSpinner();
  spinner.start(`Validating "${keyOrPath}"...`);

  let flowData: unknown;
  let rootDir: string | undefined;
  try {
    // Prefer loadFlowWithMeta so we get rootDir for code-module syntax checks.
    // Fall back to a raw JSON read if the path doesn't resolve (e.g. malformed
    // flows that loadFlowWithMeta refuses to parse).
    try {
      const loaded = loadFlowWithMeta(keyOrPath);
      flowData = loaded.flow;
      rootDir = loaded.rootDir;
    } catch {
      const flowPath = resolveFlowPath(keyOrPath);
      const content = fs.readFileSync(flowPath, 'utf-8');
      flowData = JSON.parse(content);
      rootDir = path.dirname(flowPath);
    }
  } catch (err) {
    spinner.stop('Validation failed');
    output.error(`Could not read workflow: ${err instanceof Error ? err.message : String(err)}`);
  }

  const errors = validateFlow(flowData, rootDir);

  if (errors.length > 0) {
    spinner.stop('Validation failed');

    if (output.isAgentMode()) {
      output.json({ valid: false, errors });
      process.exit(1);
    }

    console.log();
    for (const e of errors) {
      console.log(`  ${pc.red('✗')} ${pc.dim(e.path)}: ${e.message}`);
    }
    console.log();
    output.error(`${errors.length} validation error(s) found`);
  }

  spinner.stop('Workflow is valid');

  if (output.isAgentMode()) {
    output.json({ valid: true, key: (flowData as Flow).key });
    return;
  }

  output.note(`Workflow "${(flowData as Flow).key}" passed all validation checks`, 'Valid');
}

export async function flowResumeCommand(runId: string): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Workflow ')));

  const state = FlowRunner.loadRunState(runId);
  if (!state) {
    output.error(`Run "${runId}" not found`);
  }

  if (state!.status !== 'paused' && state!.status !== 'failed') {
    output.error(`Run "${runId}" is ${state!.status} — can only resume paused or failed runs`);
  }

  const { apiKey, permissions, actionIds } = getConfig();
  const api = new OneApi(apiKey, getApiBase());

  let flow: Flow;
  let rootDir: string;
  try {
    const loaded = loadFlowWithMeta(state!.flowKey);
    flow = loaded.flow;
    rootDir = loaded.rootDir;
  } catch (err) {
    output.error(`Could not load workflow "${state!.flowKey}": ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const runner = FlowRunner.fromRunState(state!);

  const onEvent = (event: FlowEvent): void => {
    if (output.isAgentMode()) {
      output.json(event);
    }
  };

  const spinner = output.createSpinner();
  spinner.start(`Resuming run ${runId} (${state!.completedSteps.length} steps already completed)...`);

  try {
    const context = await runner.resume(flow, api, permissions, actionIds, { onEvent, rootDir });
    spinner.stop('Workflow completed');

    if (output.isAgentMode()) {
      output.json({
        event: 'workflow:result',
        runId,
        logFile: runner.getLogPath(),
        status: 'success',
        steps: context.steps,
      });
      return;
    }

    console.log(`  ${pc.green('✓')} Resumed and completed successfully`);
    console.log(`  ${pc.dim(`Log: ${runner.getLogPath()}`)}`);
  } catch (error) {
    spinner.stop('Resume failed');
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (output.isAgentMode()) {
      output.json({ event: 'workflow:result', runId, status: 'failed', error: errorMsg });
      process.exit(1);
    }

    output.error(`Resume failed: ${errorMsg}`);
  }
}

export async function flowRunsCommand(flowKey?: string): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Workflow ')));

  const runs = FlowRunner.listRuns(flowKey);

  if (output.isAgentMode()) {
    output.json({
      runs: runs.map(r => ({
        runId: r.runId,
        flowKey: r.flowKey,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        pausedAt: r.pausedAt,
        completedSteps: r.completedSteps.length,
      })),
    });
    return;
  }

  if (runs.length === 0) {
    output.note(flowKey ? `No runs found for workflow "${flowKey}"` : 'No workflow runs found', 'Runs');
    return;
  }

  console.log();
  printTable(
    [
      { key: 'runId', label: 'Run ID' },
      { key: 'flowKey', label: 'Workflow' },
      { key: 'status', label: 'Status' },
      { key: 'startedAt', label: 'Started' },
      { key: 'steps', label: 'Steps Done' },
    ],
    runs.map(r => ({
      runId: r.runId,
      flowKey: r.flowKey,
      status: colorStatus(r.status),
      startedAt: r.startedAt,
      steps: String(r.completedSteps.length),
    })),
  );
  console.log();
}

/**
 * Inspect a past (or in-progress) run's per-step outputs from its persisted
 * state file — post-mortem debugging without re-running the flow. The state
 * file is written incrementally as each step completes and is preserved on
 * failure, so it captures exactly how far the run got and what each step
 * produced. See #97.
 */
export async function flowInspectCommand(runId: string, options: { full?: boolean } = {}): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Workflow ')));

  const state = FlowRunner.loadRunState(runId);
  if (!state) {
    const msg = `No run found for id "${runId}". List runs with: one flow runs`;
    if (output.isAgentMode()) {
      output.json({ error: msg, runId });
      process.exit(1);
    }
    output.error(msg);
    return;
  }

  const statePath = FlowRunner.statePathFor(state.flowKey, state.runId);
  const stepEntries = Object.entries(state.context.steps || {});

  if (output.isAgentMode()) {
    output.json({
      runId: state.runId,
      flowKey: state.flowKey,
      status: state.status,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      pausedAt: state.pausedAt,
      currentStepId: state.currentStepId,
      inputs: state.inputs,
      steps: state.context.steps,
      statePath,
    });
    return;
  }

  console.log();
  console.log(`  ${pc.bold(state.flowKey)} ${pc.dim(`run ${state.runId}`)}  ${colorStatus(state.status)}`);
  console.log(`  ${pc.dim(`Started: ${state.startedAt}${state.completedAt ? `  ·  Ended: ${state.completedAt}` : ''}`)}`);
  if (state.currentStepId) console.log(`  ${pc.dim(`Current step: ${state.currentStepId}`)}`);
  console.log();

  if (stepEntries.length === 0) {
    output.note('No step outputs recorded yet for this run.', 'Steps');
  } else {
    for (const [id, result] of stepEntries) {
      const icon = result.status === 'success' ? pc.green('✓')
        : result.status === 'skipped' ? pc.dim('○')
        : result.status === 'timeout' ? pc.yellow('⧖')
        : pc.red('✗');
      const dur = result.durationMs !== undefined ? pc.dim(` ${result.durationMs}ms`) : '';
      const retries = result.retries ? pc.dim(` (${result.retries} retr${result.retries === 1 ? 'y' : 'ies'})`) : '';
      console.log(`  ${icon} ${id} ${pc.dim(`[${result.status}]`)}${dur}${retries}`);
      if (result.error) {
        console.log(`      ${pc.red('error')} ${result.error}${result.errorCode ? pc.dim(` (${result.errorCode})`) : ''}`);
      }
      if (result.output !== undefined) {
        const json = JSON.stringify(result.output, null, options.full ? 2 : 0) ?? String(result.output);
        const shown = options.full || json.length <= 240 ? json : `${json.slice(0, 239)}…  ${pc.dim('(--full for all)')}`;
        const indented = options.full ? shown.split('\n').map(l => `        ${l}`).join('\n') : `      ${pc.dim('output')} ${shown}`;
        console.log(indented);
      }
    }
  }

  console.log();
  console.log(`  ${pc.dim(`State: ${statePath}`)}`);
  console.log(`  ${pc.dim(`Log:   ${path.join('.one/flows/.logs', `${state.flowKey}-${state.runId}.log`)}`)}`);
  console.log();
}

function colorStatus(status: string): string {
  switch (status) {
    case 'completed': return pc.green(status);
    case 'running': return pc.cyan(status);
    case 'paused': return pc.yellow(status);
    case 'failed': return pc.red(status);
    default: return status;
  }
}

// ── Scaffold ──

const SCAFFOLD_TEMPLATES: Record<string, () => Record<string, unknown>> = {
  basic: () => ({
    key: 'my-workflow',
    name: 'My Workflow',
    description: 'A basic workflow with a single action step',
    version: '1',
    inputs: {},
    steps: [
      {
        id: 'step1',
        name: 'Execute action',
        type: 'action',
        action: {
          platform: 'PLATFORM_NAME',
          actionId: 'ACTION_ID_FROM_SEARCH',
          connection: { platform: 'PLATFORM_NAME' },
          data: {},
        },
      },
    ],
  }),
  conditional: () => ({
    key: 'my-conditional-workflow',
    name: 'Conditional Workflow',
    description: 'Fetch data, then branch based on results',
    version: '1',
    inputs: {},
    steps: [
      {
        id: 'fetch',
        name: 'Fetch data',
        type: 'action',
        action: {
          platform: 'PLATFORM_NAME',
          actionId: 'ACTION_ID_FROM_SEARCH',
          connection: { platform: 'PLATFORM_NAME' },
        },
      },
      {
        id: 'decide',
        name: 'Check results',
        type: 'condition',
        condition: {
          expression: '$.steps.fetch.response.data && $.steps.fetch.response.data.length > 0',
          then: [
            {
              id: 'handleFound',
              name: 'Handle found',
              type: 'transform',
              transform: { expression: '$.steps.fetch.response.data[0]' },
            },
          ],
          else: [
            {
              id: 'handleNotFound',
              name: 'Handle not found',
              type: 'transform',
              transform: { expression: "({ error: 'No results found' })" },
            },
          ],
        },
      },
    ],
  }),
  loop: () => ({
    key: 'my-loop-workflow',
    name: 'Loop Workflow',
    description: 'Fetch a list, then process each item',
    version: '1',
    inputs: {},
    steps: [
      {
        id: 'fetchList',
        name: 'Fetch items',
        type: 'action',
        action: {
          platform: 'PLATFORM_NAME',
          actionId: 'ACTION_ID_FROM_SEARCH',
          connection: { platform: 'PLATFORM_NAME' },
        },
      },
      {
        id: 'processItems',
        name: 'Process each item',
        type: 'loop',
        loop: {
          over: '$.steps.fetchList.response.data',
          as: 'item',
          steps: [
            {
              id: 'processItem',
              name: 'Process single item',
              type: 'transform',
              transform: { expression: '({ id: $.loop.item.id, processed: true })' },
            },
          ],
        },
      },
      {
        id: 'summary',
        name: 'Generate summary',
        type: 'transform',
        transform: { expression: '({ total: $.steps.fetchList.response.data.length })' },
      },
    ],
  }),
  ai: () => ({
    key: 'my-ai-workflow',
    name: 'AI Analysis Workflow',
    description: 'Fetch data, analyze with Claude, and send results',
    version: '1',
    inputs: {},
    steps: [
      {
        id: 'fetchData',
        name: 'Fetch raw data',
        type: 'action',
        action: {
          platform: 'PLATFORM_NAME',
          actionId: 'ACTION_ID_FROM_SEARCH',
          connection: { platform: 'PLATFORM_NAME' },
        },
      },
      {
        id: 'writeData',
        name: 'Write data for analysis',
        type: 'file-write',
        fileWrite: {
          path: '/tmp/workflow-data.json',
          content: '$.steps.fetchData.response',
        },
      },
      {
        id: 'analyze',
        name: 'Analyze with Claude',
        type: 'bash',
        bash: {
          command: "cat /tmp/workflow-data.json | claude --print 'Analyze this data and return JSON with: {\"summary\": \"...\", \"insights\": [...], \"recommendations\": [...]}. Return ONLY valid JSON.' --output-format json",
          timeout: 180000,
          parseJson: true,
        },
      },
      {
        id: 'formatResult',
        name: 'Format analysis output',
        type: 'code',
        code: {
          source: 'const a = $.steps.analyze.output;\nreturn {\n  summary: a.summary,\n  insights: a.insights,\n  recommendations: a.recommendations\n};',
        },
      },
    ],
  }),
};

export async function flowScaffoldCommand(template?: string): Promise<void> {
  const templateName = template || 'basic';
  const templateFn = SCAFFOLD_TEMPLATES[templateName];

  if (!templateFn) {
    const available = Object.keys(SCAFFOLD_TEMPLATES).join(', ');
    if (output.isAgentMode()) {
      output.json({ error: `Unknown template "${templateName}". Available: ${available}` });
      process.exit(1);
    }
    output.error(`Unknown template "${templateName}". Available: ${available}`);
  }

  const scaffold = templateFn();

  if (output.isAgentMode()) {
    output.json(scaffold);
    return;
  }

  console.log(JSON.stringify(scaffold, null, 2));
}
