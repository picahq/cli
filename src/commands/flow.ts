import pc from 'picocolors';
import { getApiKey, getAccessControlFromAllSources } from '../lib/config.js';
import { OneApi } from '../lib/api.js';
import * as output from '../lib/output.js';
import { printTable } from '../lib/table.js';
import { validateFlow } from '../lib/flow-validator.js';
import { FlowRunner, loadFlow, listFlows, saveFlow, resolveFlowPath } from '../lib/flow-runner.js';
import type { Flow, FlowEvent } from '../lib/flow-types.js';
import type { PermissionLevel } from '../lib/types.js';
import fs from 'node:fs';

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
  output.intro(pc.bgCyan(pc.black(' One Flow ')));

  let flow: Flow;

  if (options.definition) {
    // Parse from JSON string or stdin
    try {
      flow = JSON.parse(options.definition) as Flow;
    } catch {
      output.error('Invalid JSON in --definition');
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
    output.error('Interactive flow creation not yet supported. Use --definition <json> or pipe JSON via stdin.');
  }

  // Override key if provided as arg
  if (key) {
    flow!.key = key;
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

  const flowPath = saveFlow(flow!, options.output);

  if (output.isAgentMode()) {
    output.json({ created: true, key: flow!.key, path: flowPath });
    return;
  }

  output.note(`Flow "${flow!.name}" saved to ${flowPath}`, 'Created');
  output.outro(`Validate: ${pc.cyan(`one flow validate ${flow!.key}`)}\nExecute:  ${pc.cyan(`one flow execute ${flow!.key}`)}`);
}

export async function flowExecuteCommand(
  keyOrPath: string,
  options: { input?: string[]; dryRun?: boolean; verbose?: boolean },
): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Flow ')));

  const { apiKey, permissions, actionIds } = getConfig();
  const api = new OneApi(apiKey);

  const spinner = output.createSpinner();
  spinner.start(`Loading flow "${keyOrPath}"...`);

  let flow: Flow;
  try {
    flow = loadFlow(keyOrPath);
  } catch (err) {
    spinner.stop('Flow not found');
    output.error(err instanceof Error ? err.message : String(err));
    return; // unreachable — output.error exits
  }

  spinner.stop(`Flow: ${flow.name} (${flow.steps.length} steps)`);

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

  const onEvent = (event: FlowEvent): void => {
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
    execSpinner.start('Executing flow...');
  }

  try {
    const context = await runner.execute(flow, api, permissions, actionIds, {
      dryRun: options.dryRun,
      verbose: options.verbose,
      onEvent,
    });

    process.off('SIGINT', sigintHandler);

    if (!options.verbose && !output.isAgentMode()) {
      execSpinner.stop('Flow completed');
    }

    if (output.isAgentMode()) {
      output.json({
        event: 'flow:result',
        runId,
        logFile: logPath,
        status: 'success',
        steps: context.steps,
      });
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

    if (options.dryRun) {
      output.note('Dry run — no steps were executed', 'Dry Run');
    }
  } catch (error) {
    process.off('SIGINT', sigintHandler);
    if (!options.verbose && !output.isAgentMode()) {
      execSpinner.stop('Flow failed');
    }

    const errorMsg = error instanceof Error ? error.message : String(error);

    if (output.isAgentMode()) {
      output.json({
        event: 'flow:result',
        runId,
        logFile: logPath,
        status: 'failed',
        error: errorMsg,
      });
      process.exit(1);
    }

    console.log(`  ${pc.dim(`Run ID: ${runId}`)}`);
    console.log(`  ${pc.dim(`Log: ${logPath}`)}`);
    output.error(`Flow failed: ${errorMsg}`);
  }
}

export async function flowListCommand(): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Flow ')));

  const flows = listFlows();

  if (output.isAgentMode()) {
    output.json({ flows });
    return;
  }

  if (flows.length === 0) {
    output.note('No flows found in .one/flows/\n\nCreate one with: one flow create', 'Flows');
    return;
  }

  console.log();
  printTable(
    [
      { key: 'key', label: 'Key' },
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'inputCount', label: 'Inputs' },
      { key: 'stepCount', label: 'Steps' },
    ],
    flows.map(f => ({
      key: f.key,
      name: f.name,
      description: f.description || '',
      inputCount: String(f.inputCount),
      stepCount: String(f.stepCount),
    })),
  );
  console.log();
}

export async function flowValidateCommand(keyOrPath: string): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Flow ')));

  const spinner = output.createSpinner();
  spinner.start(`Validating "${keyOrPath}"...`);

  let flowData: unknown;
  try {
    const flowPath = resolveFlowPath(keyOrPath);
    const content = fs.readFileSync(flowPath, 'utf-8');
    flowData = JSON.parse(content);
  } catch (err) {
    spinner.stop('Validation failed');
    output.error(`Could not read flow: ${err instanceof Error ? err.message : String(err)}`);
  }

  const errors = validateFlow(flowData);

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

  spinner.stop('Flow is valid');

  if (output.isAgentMode()) {
    output.json({ valid: true, key: (flowData as Flow).key });
    return;
  }

  output.note(`Flow "${(flowData as Flow).key}" passed all validation checks`, 'Valid');
}

export async function flowResumeCommand(runId: string): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Flow ')));

  const state = FlowRunner.loadRunState(runId);
  if (!state) {
    output.error(`Run "${runId}" not found`);
  }

  if (state!.status !== 'paused' && state!.status !== 'failed') {
    output.error(`Run "${runId}" is ${state!.status} — can only resume paused or failed runs`);
  }

  const { apiKey, permissions, actionIds } = getConfig();
  const api = new OneApi(apiKey);

  let flow: Flow;
  try {
    flow = loadFlow(state!.flowKey);
  } catch (err) {
    output.error(`Could not load flow "${state!.flowKey}": ${err instanceof Error ? err.message : String(err)}`);
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
    const context = await runner.resume(flow, api, permissions, actionIds, { onEvent });
    spinner.stop('Flow completed');

    if (output.isAgentMode()) {
      output.json({
        event: 'flow:result',
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
      output.json({ event: 'flow:result', runId, status: 'failed', error: errorMsg });
      process.exit(1);
    }

    output.error(`Resume failed: ${errorMsg}`);
  }
}

export async function flowRunsCommand(flowKey?: string): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One Flow ')));

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
    output.note(flowKey ? `No runs found for flow "${flowKey}"` : 'No flow runs found', 'Runs');
    return;
  }

  console.log();
  printTable(
    [
      { key: 'runId', label: 'Run ID' },
      { key: 'flowKey', label: 'Flow' },
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

function colorStatus(status: string): string {
  switch (status) {
    case 'completed': return pc.green(status);
    case 'running': return pc.cyan(status);
    case 'paused': return pc.yellow(status);
    case 'failed': return pc.red(status);
    default: return status;
  }
}
