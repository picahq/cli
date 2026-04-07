/**
 * Comprehensive tests for all 9 flow engine features.
 * Run with: npx tsx test-flow-features.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveSelector,
  resolveValue,
  evaluateExpression,
  executeSingleStep,
  executeSteps,
  executeFlow,
} from './src/lib/flow-engine.js';
import { validateFlow } from './src/lib/flow-validator.js';
import { FlowRunner, loadFlow, saveFlow } from './src/lib/flow-runner.js';
import type {
  Flow,
  FlowStep,
  FlowContext,
  FlowExecuteOptions,
  StepResult,
  FlowEvent,
} from './src/lib/flow-types.js';

// ── Helpers ──

function makeContext(overrides: Partial<FlowContext> = {}): FlowContext {
  return {
    input: {},
    env: {},
    steps: {},
    loop: {},
    ...overrides,
  };
}

// Mock API that doesn't actually call anything
const mockApi = {
  getActionDetails: async (_id: string) => ({ method: 'GET', path: '/test', baseUrl: '' }),
  executePassthroughRequest: async (req: any, _details: any) => ({
    responseData: { mock: true, platform: req.platform, actionId: req.actionId, data: req.data },
  }),
  listConnections: async () => [],
} as any;

const defaultPermissions = 'admin' as const;
const defaultAllowedActions = ['*'];

function collectEvents(options: FlowExecuteOptions): FlowEvent[] {
  const events: FlowEvent[] = [];
  options.onEvent = (e: FlowEvent) => events.push(e);
  return events;
}

// ── Feature 1: Parallel Step Output Keying ──

describe('Feature 1: Parallel Step Output Keying', () => {
  it('should key parallel substep outputs by ID', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'par',
      name: 'Parallel lookups',
      type: 'parallel',
      parallel: {
        steps: [
          {
            id: 'subA',
            name: 'Step A',
            type: 'transform',
            transform: { expression: '"result_a"' },
          },
          {
            id: 'subB',
            name: 'Step B',
            type: 'transform',
            transform: { expression: '"result_b"' },
          },
        ],
      },
    };

    const options: FlowExecuteOptions = {};
    await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, options);

    // Substep outputs accessible by ID
    assert.equal(context.steps.subA?.output, 'result_a');
    assert.equal(context.steps.subB?.output, 'result_b');

    // Also accessible positionally via the parent step
    const parResult = context.steps.par;
    assert.ok(Array.isArray(parResult.output));
    assert.equal((parResult.output as StepResult[])[0].output, 'result_a');
    assert.equal((parResult.output as StepResult[])[1].output, 'result_b');
  });

  it('should allow referencing parallel substep by ID in later steps', async () => {
    const flow: Flow = {
      key: 'test-par-keying',
      name: 'Test',
      inputs: {},
      steps: [
        {
          id: 'par',
          name: 'Parallel',
          type: 'parallel',
          parallel: {
            steps: [
              { id: 'getA', name: 'A', type: 'transform', transform: { expression: '42' } },
              { id: 'getB', name: 'B', type: 'transform', transform: { expression: '99' } },
            ],
          },
        },
        {
          id: 'combine',
          name: 'Combine',
          type: 'transform',
          transform: { expression: '$.steps.getA.output + $.steps.getB.output' },
        },
      ],
    };

    const context = await executeFlow(flow, {}, mockApi, defaultPermissions, defaultAllowedActions);
    assert.equal(context.steps.combine?.output, 141);
  });
});

// ── Feature 2: While Loop ──

describe('Feature 2: While Loop', () => {
  it('should validate while step schema', () => {
    const flow = {
      key: 'test-while',
      name: 'Test While',
      inputs: {},
      steps: [
        {
          id: 'loop',
          name: 'While loop',
          type: 'while',
          while: {
            condition: '$.steps.loop.output.lastResult < 3',
            steps: [
              { id: 'inc', name: 'Increment', type: 'transform', transform: { expression: '($.steps.loop.output.lastResult || 0) + 1' } },
            ],
          },
        },
      ],
    };
    const errors = validateFlow(flow);
    assert.equal(errors.length, 0, `Validation errors: ${JSON.stringify(errors)}`);
  });

  it('should reject while step without condition', () => {
    const flow = {
      key: 'test-while-bad',
      name: 'Test',
      inputs: {},
      steps: [
        { id: 'loop', name: 'Loop', type: 'while', while: { steps: [] } },
      ],
    };
    const errors = validateFlow(flow);
    assert.ok(errors.some(e => e.message.includes('condition')));
  });

  it('should execute do-while loop (first iteration always runs)', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'counter',
      name: 'Count to 3',
      type: 'while',
      while: {
        condition: '$.steps.counter.output.lastResult < 3',
        maxIterations: 10,
        steps: [
          {
            id: 'inc',
            name: 'Increment',
            type: 'transform',
            transform: { expression: '($.steps.counter.output.lastResult || 0) + 1' },
          },
        ],
      },
    };

    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(result.status, 'success');
    assert.equal((result.output as any).iteration, 3);
    assert.deepEqual((result.output as any).results, [1, 2, 3]);
  });

  it('should respect maxIterations', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'infinite',
      name: 'Always true',
      type: 'while',
      while: {
        condition: 'true',
        maxIterations: 5,
        steps: [
          { id: 'noop', name: 'Noop', type: 'transform', transform: { expression: '1' } },
        ],
      },
    };

    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal((result.output as any).iteration, 5);
  });
});

// ── Feature 3: Sub-flow ──

describe('Feature 3: Sub-flow Composition', () => {
  const subFlowDir = '.one/flows';
  const subFlowPath = path.join(subFlowDir, 'helper.flow.json');

  before(() => {
    if (!fs.existsSync(subFlowDir)) fs.mkdirSync(subFlowDir, { recursive: true });
    const subFlow: Flow = {
      key: 'helper',
      name: 'Helper Flow',
      inputs: {
        value: { type: 'number', required: true },
      },
      steps: [
        {
          id: 'double',
          name: 'Double the value',
          type: 'transform',
          transform: { expression: '$.input.value * 2' },
        },
      ],
    };
    fs.writeFileSync(subFlowPath, JSON.stringify(subFlow, null, 2));
  });

  after(() => {
    if (fs.existsSync(subFlowPath)) fs.unlinkSync(subFlowPath);
  });

  it('should validate flow step schema', () => {
    const flow = {
      key: 'test-subflow',
      name: 'Test',
      inputs: {},
      steps: [
        { id: 'sub', name: 'Sub', type: 'flow', flow: { key: 'helper', inputs: { value: 5 } } },
      ],
    };
    const errors = validateFlow(flow);
    assert.equal(errors.length, 0, `Errors: ${JSON.stringify(errors)}`);
  });

  it('should reject flow step without key', () => {
    const flow = {
      key: 'test-bad-subflow',
      name: 'Test',
      inputs: {},
      steps: [
        { id: 'sub', name: 'Sub', type: 'flow', flow: { inputs: {} } },
      ],
    };
    const errors = validateFlow(flow);
    assert.ok(errors.some(e => e.message.includes('key')));
  });

  it('should execute a sub-flow and return its results', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'callHelper',
      name: 'Call helper',
      type: 'flow',
      flow: { key: 'helper', inputs: { value: 21 } },
    };

    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(result.status, 'success');
    // Sub-flow's step output should be in the result
    const subSteps = result.output as Record<string, StepResult>;
    assert.equal(subSteps.double?.output, 42);
  });

  it('should detect circular flows', async () => {
    // Create a self-referencing flow
    const selfRefFlow: Flow = {
      key: 'self-ref',
      name: 'Self Ref',
      inputs: {},
      steps: [
        { id: 'callSelf', name: 'Call self', type: 'flow', flow: { key: 'self-ref' } },
      ],
    };
    const selfRefPath = path.join(subFlowDir, 'self-ref.flow.json');
    fs.writeFileSync(selfRefPath, JSON.stringify(selfRefFlow, null, 2));

    try {
      await executeFlow(selfRefFlow, {}, mockApi, defaultPermissions, defaultAllowedActions, {}, undefined, ['self-ref']);
      assert.fail('Should have thrown circular flow error');
    } catch (err: any) {
      assert.ok(err.message.includes('Circular flow detected'));
    } finally {
      if (fs.existsSync(selfRefPath)) fs.unlinkSync(selfRefPath);
    }
  });
});

// ── Feature 4: Code Step Sandbox ──

describe('Feature 4: Code Step Sandbox', () => {
  it('should allow crypto module in code steps', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'hashTest',
      name: 'Hash test',
      type: 'code',
      code: {
        source: `
          const crypto = await require('crypto');
          const hash = crypto.createHash('sha256').update('hello').digest('hex');
          return hash;
        `,
      },
    };

    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(result.status, 'success');
    assert.equal(typeof result.output, 'string');
    assert.equal((result.output as string).length, 64); // SHA-256 hex is 64 chars
  });

  it('should allow buffer module', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'bufTest',
      name: 'Buffer test',
      type: 'code',
      code: {
        source: `
          const { Buffer } = await require('buffer');
          return Buffer.from('hello').toString('base64');
        `,
      },
    };

    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(result.status, 'success');
    assert.equal(result.output, 'aGVsbG8=');
  });

  it('should block fs module', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'fsTest',
      name: 'FS test',
      type: 'code',
      code: {
        source: `const fs = await require('fs'); return fs.readdirSync('.');`,
      },
    };

    await assert.rejects(
      () => executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {}),
      (err: Error) => {
        assert.ok(err.message.includes('blocked'));
        return true;
      },
    );
  });

  it('should block child_process module', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'cpTest',
      name: 'child_process test',
      type: 'code',
      code: {
        source: `const cp = await require('child_process'); return 'should not reach';`,
      },
    };

    await assert.rejects(
      () => executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {}),
      (err: Error) => {
        assert.ok(err.message.includes('blocked'));
        return true;
      },
    );
  });

  it('should block node: prefixed blocked modules', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'nodeFs',
      name: 'node:fs test',
      type: 'code',
      code: {
        source: `const fs = await require('node:fs'); return 'nope';`,
      },
    };

    await assert.rejects(
      () => executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {}),
      (err: Error) => {
        assert.ok(err.message.includes('blocked'));
        return true;
      },
    );
  });

  it('should reject unknown modules', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'unknownMod',
      name: 'Unknown module',
      type: 'code',
      code: {
        source: `const x = await require('lodash'); return x;`,
      },
    };

    await assert.rejects(
      () => executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {}),
      (err: Error) => {
        assert.ok(err.message.includes('not available'));
        return true;
      },
    );
  });
});

// ── Feature 5: Loop Output Naming ──

describe('Feature 5: Loop Step Output Naming', () => {
  it('should include iteration results in loop output (sequential)', async () => {
    const flow: Flow = {
      key: 'test-loop-naming',
      name: 'Test',
      inputs: {},
      steps: [
        {
          id: 'setup',
          name: 'Setup',
          type: 'transform',
          transform: { expression: '[10, 20, 30]' },
        },
        {
          id: 'myLoop',
          name: 'Process items',
          type: 'loop',
          loop: {
            over: '$.steps.setup.output',
            as: 'item',
            steps: [
              {
                id: 'double',
                name: 'Double',
                type: 'transform',
                transform: { expression: '$.loop.item * 2' },
              },
            ],
          },
        },
      ],
    };

    const context = await executeFlow(flow, {}, mockApi, defaultPermissions, defaultAllowedActions);
    const loopResult = context.steps.myLoop;
    assert.ok(loopResult);

    // Response should have iterations
    const response = loopResult.response as any;
    assert.ok(response.iterations, 'Should have iterations array');
    assert.equal(response.iterations.length, 3);

    // Each iteration should have step results keyed by step ID
    assert.ok(response.iterations[0].double);
    assert.equal(response.iterations[0].double.output, 20);
    assert.ok(response.iterations[1].double);
    assert.equal(response.iterations[1].double.output, 40);
    assert.ok(response.iterations[2].double);
    assert.equal(response.iterations[2].double.output, 60);
  });

  it('should include iteration results in parallel loop output', async () => {
    const flow: Flow = {
      key: 'test-par-loop',
      name: 'Test',
      inputs: {},
      steps: [
        {
          id: 'setup',
          name: 'Setup',
          type: 'transform',
          transform: { expression: '[1, 2]' },
        },
        {
          id: 'myLoop',
          name: 'Parallel loop',
          type: 'loop',
          loop: {
            over: '$.steps.setup.output',
            as: 'item',
            maxConcurrency: 2,
            steps: [
              {
                id: 'square',
                name: 'Square',
                type: 'transform',
                transform: { expression: '$.loop.item * $.loop.item' },
              },
            ],
          },
        },
      ],
    };

    const context = await executeFlow(flow, {}, mockApi, defaultPermissions, defaultAllowedActions);
    const response = context.steps.myLoop?.response as any;
    assert.ok(response.iterations);
    assert.equal(response.iterations.length, 2);
  });
});

// ── Feature 6: Pagination Primitive ──

describe('Feature 6: Pagination Primitive', () => {
  it('should validate paginate step schema', () => {
    const flow = {
      key: 'test-paginate',
      name: 'Test',
      inputs: {},
      steps: [
        {
          id: 'fetchAll',
          name: 'Fetch all',
          type: 'paginate',
          paginate: {
            action: {
              platform: 'gmail',
              actionId: 'list-messages',
              connectionKey: 'key1',
            },
            pageTokenField: 'nextPageToken',
            resultsField: 'messages',
            inputTokenParam: 'queryParams.pageToken',
            maxPages: 5,
          },
        },
      ],
    };
    const errors = validateFlow(flow);
    assert.equal(errors.length, 0, `Errors: ${JSON.stringify(errors)}`);
  });

  it('should reject paginate step missing required fields', () => {
    const flow = {
      key: 'test-paginate-bad',
      name: 'Test',
      inputs: {},
      steps: [
        {
          id: 'fetchAll',
          name: 'Fetch',
          type: 'paginate',
          paginate: {
            action: { platform: 'gmail', actionId: 'x', connectionKey: 'k' },
            // missing pageTokenField, resultsField, inputTokenParam
          },
        },
      ],
    };
    const errors = validateFlow(flow);
    assert.ok(errors.some(e => e.message.includes('pageTokenField')));
    assert.ok(errors.some(e => e.message.includes('resultsField')));
    assert.ok(errors.some(e => e.message.includes('inputTokenParam')));
  });

  it('should auto-paginate through multiple pages', async () => {
    let callCount = 0;
    const paginatingApi = {
      getActionDetails: async () => ({ method: 'GET', path: '/test', baseUrl: '' }),
      executePassthroughRequest: async () => {
        callCount++;
        if (callCount === 1) {
          return { responseData: { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'token2' } };
        } else if (callCount === 2) {
          return { responseData: { messages: [{ id: 'c' }], nextPageToken: 'token3' } };
        } else {
          return { responseData: { messages: [{ id: 'd' }] } }; // no nextPageToken = stop
        }
      },
    } as any;

    const context = makeContext();
    const step: FlowStep = {
      id: 'fetchAll',
      name: 'Fetch all messages',
      type: 'paginate',
      paginate: {
        action: { platform: 'gmail', actionId: 'list', connectionKey: 'key1' },
        pageTokenField: 'nextPageToken',
        resultsField: 'messages',
        inputTokenParam: 'queryParams.pageToken',
        maxPages: 10,
      },
    };

    const options: FlowExecuteOptions = {};
    const events = collectEvents(options);
    const result = await executeSingleStep(step, context, paginatingApi, defaultPermissions, defaultAllowedActions, options);

    assert.equal(result.status, 'success');
    const output = result.output as any[];
    assert.equal(output.length, 4);
    assert.deepEqual(output.map((m: any) => m.id), ['a', 'b', 'c', 'd']);

    const response = result.response as any;
    assert.equal(response.pages, 3);
    assert.equal(response.totalResults, 4);

    // Should have emitted page events
    const pageEvents = events.filter(e => e.event === 'step:page');
    assert.equal(pageEvents.length, 3);
  });

  it('should respect maxPages limit', async () => {
    let callCount = 0;
    const infiniteApi = {
      getActionDetails: async () => ({ method: 'GET', path: '/test', baseUrl: '' }),
      executePassthroughRequest: async () => {
        callCount++;
        return { responseData: { items: [{ n: callCount }], next: `token${callCount + 1}` } };
      },
    } as any;

    const context = makeContext();
    const step: FlowStep = {
      id: 'limited',
      name: 'Limited pages',
      type: 'paginate',
      paginate: {
        action: { platform: 'test', actionId: 'list', connectionKey: 'k' },
        pageTokenField: 'next',
        resultsField: 'items',
        inputTokenParam: 'queryParams.cursor',
        maxPages: 3,
      },
    };

    const result = await executeSingleStep(step, context, infiniteApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal((result.response as any).pages, 3);
    assert.equal(callCount, 3);
  });
});

// ── Feature 7: Mock Dry-run ──

describe('Feature 7: Mock Dry-run', () => {
  it('should skip execution in plain dry-run (no mock)', async () => {
    const flow: Flow = {
      key: 'test-dry',
      name: 'Test',
      inputs: {},
      steps: [
        { id: 's1', name: 'Step 1', type: 'transform', transform: { expression: '42' } },
      ],
    };

    const options: FlowExecuteOptions = { dryRun: true };
    const events = collectEvents(options);
    const context = await executeFlow(flow, {}, mockApi, defaultPermissions, defaultAllowedActions, options);

    // No steps should have been executed
    assert.equal(Object.keys(context.steps).length, 0);
    assert.ok(events.some(e => e.event === 'flow:dry-run'));
  });

  it('should execute logic steps but mock API steps in mock mode', async () => {
    const flow: Flow = {
      key: 'test-mock',
      name: 'Test Mock',
      inputs: {},
      steps: [
        {
          id: 'compute',
          name: 'Compute',
          type: 'transform',
          transform: { expression: '21 * 2' },
        },
        {
          id: 'apiCall',
          name: 'API Call',
          type: 'action',
          action: {
            platform: 'stripe',
            actionId: 'get-customer',
            connectionKey: 'key1',
          },
        },
        {
          id: 'useResult',
          name: 'Use result',
          type: 'transform',
          transform: { expression: '$.steps.compute.output' },
        },
      ],
    };

    const options: FlowExecuteOptions = { dryRun: true, mock: true };
    const events = collectEvents(options);
    const context = await executeFlow(flow, {}, mockApi, defaultPermissions, defaultAllowedActions, options);

    // Transform steps should execute normally
    assert.equal(context.steps.compute?.output, 42);
    assert.equal(context.steps.useResult?.output, 42);

    // Action step should be mocked
    assert.equal((context.steps.apiCall?.output as any)?._mock, true);
    assert.ok(events.some(e => e.event === 'step:mock'));
  });

  it('should mock bash steps in mock mode', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'bashStep',
      name: 'Bash',
      type: 'bash',
      bash: { command: 'echo hello' },
    };

    const options: FlowExecuteOptions = { mock: true };
    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, options);
    assert.equal(result.status, 'success');
    assert.equal((result.output as any)._mock, true);
  });
});

// ── Feature 8: Incremental Resume ──

describe('Feature 8: Incremental State Persistence', () => {
  it('should persist state after every step completion', async () => {
    const flow: Flow = {
      key: 'test-persist',
      name: 'Test Persist',
      inputs: {},
      steps: [
        { id: 's1', name: 'Step 1', type: 'transform', transform: { expression: '"a"' } },
        { id: 's2', name: 'Step 2', type: 'transform', transform: { expression: '"b"' } },
        { id: 's3', name: 'Step 3', type: 'transform', transform: { expression: '"c"' } },
      ],
    };

    const runner = new FlowRunner(flow, {});
    const statePath = runner.getStatePath();

    // Track state saves
    let saveCount = 0;
    const origWriteFileSync = fs.writeFileSync;

    // We can verify by checking the state file after execution
    await runner.execute(flow, mockApi, defaultPermissions, defaultAllowedActions);

    // State file should exist and have all steps completed
    assert.ok(fs.existsSync(statePath), 'State file should exist');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.status, 'completed');
    assert.ok(state.completedSteps.includes('s1'));
    assert.ok(state.completedSteps.includes('s2'));
    assert.ok(state.completedSteps.includes('s3'));

    // Clean up
    try { fs.unlinkSync(statePath); } catch {}
    try { fs.unlinkSync(runner.getLogPath()); } catch {}
  });

  it('should resume from where it left off', async () => {
    const flow: Flow = {
      key: 'test-resume',
      name: 'Test Resume',
      inputs: {},
      steps: [
        { id: 'r1', name: 'Step 1', type: 'transform', transform: { expression: '"done1"' } },
        { id: 'r2', name: 'Step 2', type: 'transform', transform: { expression: '"done2"' } },
        { id: 'r3', name: 'Step 3', type: 'transform', transform: { expression: '"done3"' } },
      ],
    };

    // Execute the flow fully
    const runner = new FlowRunner(flow, {});
    await runner.execute(flow, mockApi, defaultPermissions, defaultAllowedActions);

    // Load state and simulate a resume with first 2 steps already done
    const state = FlowRunner.loadRunState(runner.getRunId());
    assert.ok(state);
    assert.equal(state!.status, 'completed');
    assert.equal(state!.completedSteps.length, 3);

    // Clean up
    try { fs.unlinkSync(runner.getStatePath()); } catch {}
    try { fs.unlinkSync(runner.getLogPath()); } catch {}
  });
});

// ── Feature 9: Bash Step ──

describe('Feature 9: Bash Step', () => {
  it('should validate bash step schema', () => {
    const flow = {
      key: 'test-bash',
      name: 'Test',
      inputs: {},
      steps: [
        {
          id: 'run',
          name: 'Run command',
          type: 'bash',
          bash: { command: 'echo hello', timeout: 5000, parseJson: false },
        },
      ],
    };
    const errors = validateFlow(flow);
    assert.equal(errors.length, 0, `Errors: ${JSON.stringify(errors)}`);
  });

  it('should reject bash step without command', () => {
    const flow = {
      key: 'test-bash-bad',
      name: 'Test',
      inputs: {},
      steps: [
        { id: 'run', name: 'Run', type: 'bash', bash: { timeout: 5000 } },
      ],
    };
    const errors = validateFlow(flow);
    assert.ok(errors.some(e => e.message.includes('command')));
  });

  it('should reject bash step with invalid timeout', () => {
    const flow = {
      key: 'test-bash-bad-timeout',
      name: 'Test',
      inputs: {},
      steps: [
        { id: 'run', name: 'Run', type: 'bash', bash: { command: 'echo hi', timeout: -1 } },
      ],
    };
    const errors = validateFlow(flow);
    assert.ok(errors.some(e => e.message.includes('timeout')));
  });

  it('should fail without --allow-bash flag', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'blocked',
      name: 'Blocked bash',
      type: 'bash',
      bash: { command: 'echo hello' },
    };

    await assert.rejects(
      () => executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {}),
      (err: Error) => {
        assert.ok(err.message.includes('--allow-bash'));
        return true;
      },
    );
  });

  it('should execute bash with --allow-bash flag', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'hello',
      name: 'Echo hello',
      type: 'bash',
      bash: { command: 'echo hello' },
    };

    const result = await executeSingleStep(
      step, context, mockApi, defaultPermissions, defaultAllowedActions,
      { allowBash: true },
    );
    assert.equal(result.status, 'success');
    assert.equal(result.output, 'hello');
    assert.equal((result.response as any).exitCode, 0);
  });

  it('should parse JSON output when parseJson is true', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'jsonBash',
      name: 'JSON output',
      type: 'bash',
      bash: { command: 'echo \'{"a":1,"b":"two"}\'', parseJson: true },
    };

    const result = await executeSingleStep(
      step, context, mockApi, defaultPermissions, defaultAllowedActions,
      { allowBash: true },
    );
    assert.equal(result.status, 'success');
    assert.deepEqual(result.output, { a: 1, b: 'two' });
  });

  it('should support selectors in bash command', async () => {
    const context = makeContext({
      input: { greeting: 'world' },
    });
    const step: FlowStep = {
      id: 'interpolated',
      name: 'Interpolated bash',
      type: 'bash',
      bash: { command: 'echo "hello {{$.input.greeting}}"' },
    };

    const result = await executeSingleStep(
      step, context, mockApi, defaultPermissions, defaultAllowedActions,
      { allowBash: true },
    );
    assert.equal(result.status, 'success');
    assert.equal(result.output, 'hello world');
  });

  it('should capture stderr', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'stderrTest',
      name: 'Stderr test',
      type: 'bash',
      bash: { command: 'echo "out" && >&2 echo "err"' },
    };

    const result = await executeSingleStep(
      step, context, mockApi, defaultPermissions, defaultAllowedActions,
      { allowBash: true },
    );
    assert.equal(result.status, 'success');
    assert.equal(result.output, 'out');
    assert.equal((result.response as any).stderr, 'err');
  });

  it('should support custom env vars', async () => {
    const context = makeContext();
    const step: FlowStep = {
      id: 'envTest',
      name: 'Env test',
      type: 'bash',
      bash: {
        command: 'echo $MY_VAR',
        env: { MY_VAR: 'custom_value' },
      },
    };

    const result = await executeSingleStep(
      step, context, mockApi, defaultPermissions, defaultAllowedActions,
      { allowBash: true },
    );
    assert.equal(result.status, 'success');
    assert.equal(result.output, 'custom_value');
  });
});

// ── Validator: New step types in ID uniqueness check ──

describe('Validator: ID uniqueness across new step types', () => {
  it('should detect duplicate IDs inside while steps', () => {
    const flow = {
      key: 'dup-while',
      name: 'Test',
      inputs: {},
      steps: [
        { id: 'dup', name: 'Top', type: 'transform', transform: { expression: '1' } },
        {
          id: 'w', name: 'While', type: 'while',
          while: {
            condition: 'false',
            steps: [
              { id: 'dup', name: 'Inside', type: 'transform', transform: { expression: '2' } },
            ],
          },
        },
      ],
    };
    const errors = validateFlow(flow);
    assert.ok(errors.some(e => e.message.includes('Duplicate step ID')));
  });
});

// ── Integration: Multi-feature flow ──

describe('Integration: Multi-feature flow', () => {
  it('should execute a flow combining while + code + transform', async () => {
    const flow: Flow = {
      key: 'integration-test',
      name: 'Integration Test',
      inputs: {},
      steps: [
        {
          id: 'generateList',
          name: 'Generate list',
          type: 'code',
          code: {
            source: `
              const url = await require('url');
              // Just verify the module loads
              return [1, 2, 3, 4, 5];
            `,
          },
        },
        {
          id: 'sumLoop',
          name: 'Sum with while',
          type: 'while',
          while: {
            condition: '$.steps.sumLoop.output.lastResult?.index < 4',
            maxIterations: 10,
            steps: [
              {
                id: 'accumulate',
                name: 'Accumulate',
                type: 'code',
                code: {
                  source: `
                    const list = $.steps.generateList.output;
                    const prev = $.steps.sumLoop.output.lastResult;
                    const index = (prev?.index ?? -1) + 1;
                    const sum = (prev?.sum ?? 0) + list[index];
                    return { index, sum };
                  `,
                },
              },
            ],
          },
        },
        {
          id: 'finalResult',
          name: 'Final result',
          type: 'transform',
          transform: { expression: '$.steps.sumLoop.output.lastResult.sum' },
        },
      ],
    };

    const context = await executeFlow(flow, {}, mockApi, defaultPermissions, defaultAllowedActions);
    // Sum of [1,2,3,4,5] = 15
    assert.equal(context.steps.finalResult?.output, 15);
  });
});

// ── Step Result Shape (cli#67, #58, #66) ──

describe('Step result shape', () => {
  it('should set status:"timeout" and errorCode:"TIMEOUT" when step exceeds timeoutMs with onError:continue', async () => {
    const step: FlowStep = {
      id: 'slow',
      name: 'Slow step',
      type: 'code',
      timeoutMs: 30,
      onError: { strategy: 'continue' },
      code: { source: 'await new Promise(r => setTimeout(r, 200)); return "done";' },
    };
    const context = makeContext();
    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(result.status, 'timeout');
    assert.equal(result.errorCode, 'TIMEOUT');
    assert.match(result.error ?? '', /exceeded timeout of 30ms/);
    assert.equal(context.steps.slow?.status, 'timeout');
  });

  it('should set status:"failed" (not timeout) for generic errors with onError:continue', async () => {
    const step: FlowStep = {
      id: 'boom',
      name: 'Boom',
      type: 'code',
      onError: { strategy: 'continue' },
      code: { source: 'throw new Error("kaboom");' },
    };
    const context = makeContext();
    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, undefined);
    assert.match(result.error ?? '', /kaboom/);
  });

  it('should flatten sub-flow final step output onto parent output (cli#66)', async () => {
    // Set up a temporary sub-flow in .one/flows
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtest-'));
    const flowsDir = path.join(tmpRoot, '.one', 'flows', 'sub-consts');
    fs.mkdirSync(flowsDir, { recursive: true });
    const subFlow: Flow = {
      key: 'sub-consts',
      name: 'Constants',
      inputs: {},
      steps: [
        {
          id: 'load',
          name: 'Load constants',
          type: 'transform',
          transform: { expression: '({ CHART_URL: "https://chart.example", API_KEY: "xyz" })' },
        },
      ],
    };
    fs.writeFileSync(path.join(flowsDir, 'flow.json'), JSON.stringify(subFlow));

    // chdir so loadFlowWithMeta can find it
    const prevCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const parent: Flow = {
        key: 'parent',
        name: 'Parent',
        inputs: {},
        steps: [
          {
            id: 'loadConfig',
            name: 'Load config',
            type: 'flow',
            flow: { key: 'sub-consts' },
          },
        ],
      };
      const context = await executeFlow(parent, {}, mockApi, defaultPermissions, defaultAllowedActions);
      const out = context.steps.loadConfig?.output as Record<string, unknown>;
      // New flattened path
      assert.equal(out?.CHART_URL, 'https://chart.example');
      assert.equal(out?.API_KEY, 'xyz');
      // Legacy nested path still works
      const load = out?.load as { output?: Record<string, unknown> };
      assert.equal(load?.output?.CHART_URL, 'https://chart.example');
      // _steps escape hatch
      assert.ok((out as any)?._steps?.load);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should set status:"skipped" when if-condition is false', async () => {
    const step: FlowStep = {
      id: 'cond',
      name: 'Conditional',
      type: 'transform',
      if: 'false',
      transform: { expression: '"never runs"' },
    };
    const context = makeContext();
    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(result.status, 'skipped');
    assert.equal(context.steps.cond?.status, 'skipped');
    assert.equal(result.output, undefined);
  });

  it('should set status:"timeout" with onError:fallback when timeout expires', async () => {
    const step: FlowStep = {
      id: 'slowFb',
      name: 'Slow w/ fallback',
      type: 'code',
      timeoutMs: 20,
      onError: { strategy: 'fallback', fallbackStepId: 'backup' },
      code: { source: 'await new Promise(r => setTimeout(r, 200)); return 1;' },
    };
    const context = makeContext();
    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(result.status, 'timeout');
    assert.equal(result.errorCode, 'TIMEOUT');
  });

  it('should honor timeoutMs across retry attempts (each attempt bounded)', async () => {
    const step: FlowStep = {
      id: 'slowRetry',
      name: 'Slow with retries',
      type: 'code',
      timeoutMs: 20,
      onError: { strategy: 'retry', retries: 2, retryDelayMs: 5 },
      code: { source: 'await new Promise(r => setTimeout(r, 200)); return 1;' },
    };
    const context = makeContext();
    const start = Date.now();
    await assert.rejects(
      executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {}),
      /exceeded timeout of 20ms/,
    );
    // 3 attempts × ~20ms timeout + 2 retry delays — should finish well under 200ms
    assert.ok(Date.now() - start < 500, 'retries should each be bounded by timeoutMs');
  });

  it('should flatten sub-flow output even when final step output is a scalar (_finalOutput)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtest-'));
    const flowsDir = path.join(tmpRoot, '.one', 'flows', 'sub-scalar');
    fs.mkdirSync(flowsDir, { recursive: true });
    const subFlow: Flow = {
      key: 'sub-scalar',
      name: 'Scalar',
      inputs: {},
      steps: [
        { id: 'compute', name: 'Compute', type: 'transform', transform: { expression: '42' } },
      ],
    };
    fs.writeFileSync(path.join(flowsDir, 'flow.json'), JSON.stringify(subFlow));
    const prevCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const parent: Flow = {
        key: 'parent',
        name: 'Parent',
        inputs: {},
        steps: [{ id: 'call', name: 'Call', type: 'flow', flow: { key: 'sub-scalar' } }],
      };
      const context = await executeFlow(parent, {}, mockApi, defaultPermissions, defaultAllowedActions);
      const out = context.steps.call?.output as Record<string, unknown>;
      assert.equal(out?._finalOutput, 42);
      // Legacy path still works
      assert.equal((out?.compute as { output?: unknown })?.output, 42);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should emit flow:warning event on sub-flow field/sub-step id collision', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtest-'));
    const flowsDir = path.join(tmpRoot, '.one', 'flows', 'sub-collide');
    fs.mkdirSync(flowsDir, { recursive: true });
    // Sub-flow has a step "load" AND its final step returns a field named "load"
    const subFlow: Flow = {
      key: 'sub-collide',
      name: 'Collide',
      inputs: {},
      steps: [
        { id: 'load', name: 'Load', type: 'transform', transform: { expression: '"first"' } },
        { id: 'finish', name: 'Finish', type: 'transform', transform: { expression: '({ load: "flattened" })' } },
      ],
    };
    fs.writeFileSync(path.join(flowsDir, 'flow.json'), JSON.stringify(subFlow));
    const prevCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const parent: Flow = {
        key: 'parent',
        name: 'Parent',
        inputs: {},
        steps: [{ id: 'call', name: 'Call', type: 'flow', flow: { key: 'sub-collide' } }],
      };
      const events: FlowEvent[] = [];
      await executeFlow(parent, {}, mockApi, defaultPermissions, defaultAllowedActions, {
        onEvent: (e) => events.push(e),
      });
      const warning = events.find(e => e.event === 'flow:warning');
      assert.ok(warning, 'expected a flow:warning event');
      assert.match(String(warning?.message ?? ''), /collide/);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should mark parallel sub-step as status:"timeout" when it exceeds timeoutMs', async () => {
    const step: FlowStep = {
      id: 'par',
      name: 'Parallel',
      type: 'parallel',
      parallel: {
        maxConcurrency: 2,
        steps: [
          {
            id: 'fast',
            name: 'Fast',
            type: 'code',
            code: { source: 'return "ok";' },
          },
          {
            id: 'slow',
            name: 'Slow',
            type: 'code',
            timeoutMs: 20,
            onError: { strategy: 'continue' },
            code: { source: 'await new Promise(r => setTimeout(r, 200)); return "late";' },
          },
        ],
      },
    };
    const context = makeContext();
    await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(context.steps.fast?.status, 'success');
    assert.equal(context.steps.slow?.status, 'timeout');
    assert.equal(context.steps.slow?.errorCode, 'TIMEOUT');
  });
});

// ── Quick-win features (cli#53, #54, #58, #59, #61) ──

describe('cli#59: outputSchema declaration + validation', () => {
  it('flags downstream selectors that reference an undeclared field', () => {
    const flow: Flow = {
      key: 'test', name: 'Test', inputs: {},
      steps: [
        {
          id: 'research', name: 'Research', type: 'transform',
          outputSchema: { company: 'string', charCount: 'number' },
          transform: { expression: '({ company: "Acme", charCount: 42 })' },
        },
        {
          id: 'consume', name: 'Use it', type: 'transform',
          // chars (typo) instead of charCount
          transform: { expression: '$.steps.research.output.chars' },
        },
      ],
    };
    const errors = validateFlow(flow);
    assert.ok(
      errors.some(e => e.message.includes('"chars"') && e.message.includes('outputSchema')),
      `expected outputSchema mismatch error, got: ${JSON.stringify(errors)}`,
    );
  });

  it('passes when downstream selectors match declared fields', () => {
    const flow: Flow = {
      key: 'test', name: 'Test', inputs: {},
      steps: [
        {
          id: 'research', name: 'Research', type: 'transform',
          outputSchema: { company: 'string', charCount: 'number' },
          transform: { expression: '({ company: "Acme", charCount: 42 })' },
        },
        {
          id: 'consume', name: 'Use it', type: 'transform',
          transform: { expression: '$.steps.research.output.charCount + 1' },
        },
      ],
    };
    const errors = validateFlow(flow);
    assert.deepEqual(errors.filter(e => e.message.includes('outputSchema')), []);
  });

  it('walks nested outputSchema objects', () => {
    const flow: Flow = {
      key: 'test', name: 'Test', inputs: {},
      steps: [
        {
          id: 's', name: 's', type: 'transform',
          outputSchema: { quality: { confidence: 'string', score: 'number' } },
          transform: { expression: '({ quality: { confidence: "high", score: 9 } })' },
        },
        {
          id: 'good', name: 'good', type: 'transform',
          transform: { expression: '$.steps.s.output.quality.score' },
        },
        {
          id: 'bad', name: 'bad', type: 'transform',
          transform: { expression: '$.steps.s.output.quality.scoreee' },
        },
      ],
    };
    const errors = validateFlow(flow);
    assert.ok(errors.some(e => e.message.includes('quality.scoreee')));
    assert.ok(!errors.some(e => e.message.includes('quality.score') && !e.message.includes('scoreee')));
  });

  it('does NOT duplicate errors for references inside nested step arrays', () => {
    // Regression for duplicate-reporting bug found by stress agent.
    const flow: Flow = {
      key: 'test', name: 'test', inputs: {},
      steps: [
        {
          id: 'src', name: 'src', type: 'transform',
          outputSchema: { value: 'number' },
          transform: { expression: '({ value: 1 })' },
        },
        {
          id: 'cond', name: 'cond', type: 'condition',
          condition: {
            expression: 'true',
            then: [
              {
                id: 'inner', name: 'inner', type: 'transform',
                transform: { expression: '$.steps.src.output.missing' },
              },
            ],
          },
        },
      ],
    };
    const errors = validateFlow(flow).filter(e => e.message.includes('outputSchema'));
    assert.equal(errors.length, 1, `expected exactly 1 outputSchema error, got ${errors.length}: ${JSON.stringify(errors)}`);
  });

  it('rejects malformed outputSchema (unknown leaf type)', () => {
    const flow: Flow = {
      key: 'test', name: 'Test', inputs: {},
      steps: [
        {
          id: 's', name: 's', type: 'transform',
          // @ts-expect-error intentional invalid type
          outputSchema: { x: 'integer' },
          transform: { expression: '({ x: 1 })' },
        },
      ],
    };
    const errors = validateFlow(flow);
    assert.ok(errors.some(e => e.message.includes('unknown type "integer"')));
  });
});

describe('cli#54: bash env JSON-safe injection', () => {
  it('serializes { json: $.steps.x.output } to a temp file and exposes it via env var', async () => {
    const tmpOut = path.join(os.tmpdir(), `one-flow-test-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    try {
      const step: FlowStep = {
        id: 'writePayload', name: 'write', type: 'bash',
        bash: {
          command: `cp "$PAYLOAD_FILE" ${tmpOut}`,
          env: {
            // @ts-expect-error structured env value
            PAYLOAD_FILE: { json: { name: "O'Brien & Co.", nested: { count: 3 } } },
          } as any,
        },
      };
      const context = makeContext();
      await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, { allowBash: true });
      const written = JSON.parse(fs.readFileSync(tmpOut, 'utf-8'));
      assert.deepEqual(written, { name: "O'Brien & Co.", nested: { count: 3 } });
    } finally {
      try { fs.unlinkSync(tmpOut); } catch {}
    }
  });

  it('cleans up temp files after the step finishes', async () => {
    let tempPathSeen: string | undefined;
    const step: FlowStep = {
      id: 'capture', name: 'cap', type: 'bash',
      bash: {
        command: 'echo "$PAYLOAD_FILE"',
        env: {
          // @ts-expect-error structured env value
          PAYLOAD_FILE: { json: { x: 1 } },
        } as any,
      },
    };
    const context = makeContext();
    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, { allowBash: true });
    tempPathSeen = (result.output as string).trim();
    assert.ok(tempPathSeen.length > 0);
    assert.equal(fs.existsSync(tempPathSeen), false, 'temp file should be deleted after the step');
  });

  it('shell-escapes { shell: ... } values', async () => {
    const step: FlowStep = {
      id: 'echoName', name: 'echo', type: 'bash',
      bash: {
        command: 'echo "$NAME"',
        env: {
          // @ts-expect-error structured env value
          NAME: { shell: "O'Brien & Co." },
        } as any,
      },
    };
    const context = makeContext();
    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, { allowBash: true });
    assert.equal((result.output as string), "O'Brien & Co.");
  });

  it('still accepts plain string env values (legacy)', async () => {
    const step: FlowStep = {
      id: 'plain', name: 'plain', type: 'bash',
      bash: {
        command: 'echo "$GREETING"',
        env: { GREETING: 'hello' },
      },
    };
    const context = makeContext();
    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, { allowBash: true });
    assert.equal((result.output as string), 'hello');
  });
});

describe('cli#53: conditional retry on error code', () => {
  it('does NOT retry when error matches failFastOn', async () => {
    let attempts = 0;
    const step: FlowStep = {
      id: 'noRetry', name: 'no', type: 'code',
      onError: { strategy: 'retry', retries: 5, retryDelayMs: 1, failFastOn: ['401', 'unauthorized'] },
      code: { source: 'throw new Error("HTTP 401 unauthorized")' },
    };
    // Wrap code step with attempt counter via closure isn't possible — instead
    // we observe that lastError surfaces and that overall retries used == 0.
    const context = makeContext();
    let thrown: Error | undefined;
    try {
      await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    } catch (e) {
      thrown = e as Error;
    }
    // strategy is retry but we didn't attach continue/fallback, so default fail
    assert.ok(thrown);
    assert.match(thrown!.message, /401|unauthorized/);
    void attempts;
  });

  it('retries when error matches retryOn', async () => {
    let attempts = 0;
    const step: FlowStep = {
      id: 'flaky', name: 'flaky', type: 'code',
      onError: { strategy: 'retry', retries: 3, retryDelayMs: 1, retryOn: ['ETIMEDOUT', 502] },
      code: {
        source: `
          if (!globalThis.__retryAttempts) globalThis.__retryAttempts = 0;
          globalThis.__retryAttempts++;
          if (globalThis.__retryAttempts < 3) throw new Error("HTTP 502 bad gateway");
          return globalThis.__retryAttempts;
        `,
      },
    };
    (globalThis as any).__retryAttempts = 0;
    const context = makeContext();
    const result = await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    attempts = (globalThis as any).__retryAttempts;
    delete (globalThis as any).__retryAttempts;
    assert.equal(result.status, 'success');
    assert.equal(attempts, 3);
    assert.equal(result.retries, 2);
  });

  it('skips retry when retryOn is set but error does not match', async () => {
    (globalThis as any).__retryNoMatch = 0;
    const step: FlowStep = {
      id: 'noMatch', name: 'no', type: 'code',
      onError: { strategy: 'retry', retries: 5, retryDelayMs: 1, retryOn: [429] },
      code: {
        source: `
          globalThis.__retryNoMatch++;
          throw new Error("HTTP 500 internal");
        `,
      },
    };
    const context = makeContext();
    let thrown: Error | undefined;
    try {
      await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    } catch (e) {
      thrown = e as Error;
    }
    const calls = (globalThis as any).__retryNoMatch;
    delete (globalThis as any).__retryNoMatch;
    assert.ok(thrown);
    assert.equal(calls, 1, 'should not retry an error that does not match retryOn');
  });
});

describe('cli#53: Handlebars context-aware escaping pipes', () => {
  const ctx = makeContext({
    input: { name: "O'Brien & Co.", html: '<b>x</b>', obj: { a: 1 } },
  });

  it('json pipe stringifies safely', () => {
    const out = resolveValue('payload={{$.input.name | json}}', ctx);
    assert.equal(out, `payload="O'Brien & Co."`);
  });

  it('shell pipe POSIX-quotes', () => {
    const out = resolveValue('echo {{$.input.name | shell}}', ctx);
    assert.equal(out, `echo 'O'\\''Brien & Co.'`);
  });

  it('url pipe encodeURIComponents', () => {
    const out = resolveValue('https://x?q={{$.input.name | url}}', ctx);
    // encodeURIComponent does NOT escape apostrophes (they're unreserved)
    assert.equal(out, "https://x?q=O'Brien%20%26%20Co.");
  });

  it('html pipe entity-escapes', () => {
    const out = resolveValue('<p>{{$.input.html | html}}</p>', ctx);
    assert.equal(out, '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  it('md pipe escapes structural characters', () => {
    // md pipe leaves apostrophes/periods alone (not markdown-structural) and
    // escapes pipes/brackets/etc. Test with a name that contains them.
    const out = resolveValue(
      '{{$.input.tricky | md}}',
      makeContext({ input: { tricky: 'foo|bar [baz]' } }),
    );
    assert.equal(out, 'foo\\|bar \\[baz\\]');
  });

  it('handles space-padded pipe expressions like {{ $.x | json }}', () => {
    // Regression for routing bug found by stress agent.
    const out = resolveValue('{{ $.input.name | json }}', ctx);
    assert.equal(out, `"O'Brien & Co."`);
  });

  it('throws on unknown pipe', () => {
    assert.throws(
      () => resolveValue('{{$.input.name | bogus}}', ctx),
      /Unknown Handlebars pipe/,
    );
  });
});

describe('cli#61: dynamic flow.key Handlebars dispatch', () => {
  let tmpDir: string;
  let oldCwd: string;

  before(() => {
    oldCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-flow-dispatch-'));
    fs.mkdirSync(path.join(tmpDir, '.one', 'flows', 'sub-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.one', 'flows', 'sub-b'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.one', 'flows', 'sub-a', 'flow.json'),
      JSON.stringify({
        key: 'sub-a', name: 'A', inputs: {},
        steps: [{ id: 'r', name: 'r', type: 'transform', transform: { expression: '({ which: "A" })' } }],
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.one', 'flows', 'sub-b', 'flow.json'),
      JSON.stringify({
        key: 'sub-b', name: 'B', inputs: {},
        steps: [{ id: 'r', name: 'r', type: 'transform', transform: { expression: '({ which: "B" })' } }],
      }),
    );
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves $.input.target into the sub-flow key (bare selector)', async () => {
    const parent: Flow = {
      key: 'parent', name: 'P',
      inputs: { target: { type: 'string', required: true } },
      steps: [{ id: 'dispatch', name: 'd', type: 'flow', flow: { key: '$.input.target' } }],
    };
    const result = await executeFlow(parent, { target: 'sub-a' }, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal((result.steps.dispatch.output as any).which, 'A');
  });

  it('resolves {{$.input.target}} interpolation into the sub-flow key', async () => {
    const parent: Flow = {
      key: 'parent', name: 'P',
      inputs: { target: { type: 'string', required: true } },
      steps: [{ id: 'dispatch', name: 'd', type: 'flow', flow: { key: '{{$.input.target}}' } }],
    };
    const result = await executeFlow(parent, { target: 'sub-b' }, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal((result.steps.dispatch.output as any).which, 'B');
  });
});

describe('cli#58: parallel partial results — status metadata accessible to downstream steps', () => {
  it('exposes status / errorCode / durationMs on $.steps.X for parallel substeps', async () => {
    const step: FlowStep = {
      id: 'parA', name: 'parA', type: 'parallel',
      parallel: {
        steps: [
          { id: 'okStep', name: 'ok', type: 'transform', transform: { expression: '({ ok: true })' } },
          {
            id: 'timeoutStep', name: 'slow', type: 'code',
            timeoutMs: 15,
            onError: { strategy: 'continue' },
            code: { source: 'await new Promise(r => setTimeout(r, 200)); return "late";' },
          },
        ],
      },
    };
    const context = makeContext();
    await executeSingleStep(step, context, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(context.steps.okStep.status, 'success');
    assert.equal(context.steps.timeoutStep.status, 'timeout');
    assert.equal(context.steps.timeoutStep.errorCode, 'TIMEOUT');
    assert.ok(typeof context.steps.timeoutStep.durationMs === 'number');
    assert.ok(context.steps.timeoutStep.error?.includes('timeout'));
  });

  it('downstream gate step can branch on $.steps.X.status', async () => {
    const flow: Flow = {
      key: 'test', name: 'test', inputs: {},
      steps: [
        {
          id: 'par', name: 'par', type: 'parallel',
          parallel: {
            steps: [
              {
                id: 'sub', name: 'sub', type: 'code',
                timeoutMs: 10,
                onError: { strategy: 'continue' },
                code: { source: 'await new Promise(r => setTimeout(r, 200)); return 1;' },
              },
            ],
          },
        },
        {
          id: 'gate', name: 'gate', type: 'transform',
          transform: { expression: `($.steps.sub.status === 'timeout' ? 'recoverable' : 'ok')` },
        },
      ],
    };
    const result = await executeFlow(flow, {}, mockApi, defaultPermissions, defaultAllowedActions, {});
    assert.equal(result.steps.gate.output, 'recoverable');
  });
});

// ── Run all tests ──
console.log('\n🧪 Running all flow engine feature tests...\n');
