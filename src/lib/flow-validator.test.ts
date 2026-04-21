import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlowSchema } from './flow-validator.js';
import type { Flow } from './flow-types.js';

const baseAction = {
  id: 'doIt',
  name: 'Do it',
  type: 'action' as const,
};

function makeFlow(actionPatch: Record<string, unknown>): Flow {
  return {
    key: 'test-flow',
    name: 'Test',
    inputs: {},
    steps: [{ ...baseAction, action: actionPatch as any } as any],
  } as Flow;
}

const errorPathContains = (errors: { path: string; message: string }[], path: string): boolean =>
  errors.some(e => e.path === path);

const errorMessageContains = (
  errors: { path: string; message: string }[],
  needle: string,
): boolean => errors.some(e => e.message.includes(needle));

describe('validateFlowSchema action connection form', () => {
  it('accepts an action step with `connection: { platform }`', () => {
    const flow = makeFlow({
      platform: 'gmail',
      actionId: 'conn_mod_def::abc',
      connection: { platform: 'gmail' },
    });
    const errors = validateFlowSchema(flow);
    assert.equal(
      errors.length,
      0,
      `expected no errors, got: ${JSON.stringify(errors)}`,
    );
  });

  it('accepts an action step with `connection: { platform, tag }`', () => {
    const flow = makeFlow({
      platform: 'gmail',
      actionId: 'conn_mod_def::abc',
      connection: { platform: 'gmail', tag: 'work@example.com' },
    });
    const errors = validateFlowSchema(flow);
    assert.equal(errors.length, 0);
  });

  it('accepts a legacy `connectionKey` string', () => {
    const flow = makeFlow({
      platform: 'gmail',
      actionId: 'conn_mod_def::abc',
      connectionKey: 'live::gmail::default::abc',
    });
    const errors = validateFlowSchema(flow);
    assert.equal(errors.length, 0);
  });

  it('rejects when both `connectionKey` and `connection` are set', () => {
    const flow = makeFlow({
      platform: 'gmail',
      actionId: 'conn_mod_def::abc',
      connectionKey: 'live::gmail::default::abc',
      connection: { platform: 'gmail' },
    });
    const errors = validateFlowSchema(flow);
    assert.ok(errorMessageContains(errors, 'set exactly one'));
  });

  it('rejects when neither is set', () => {
    const flow = makeFlow({
      platform: 'gmail',
      actionId: 'conn_mod_def::abc',
    });
    const errors = validateFlowSchema(flow);
    assert.ok(errorMessageContains(errors, 'must set "connection'));
  });

  it('rejects an unknown field inside the connection ref (catches typos like `tags` plural)', () => {
    const flow = makeFlow({
      platform: 'gmail',
      actionId: 'conn_mod_def::abc',
      connection: { platform: 'gmail', tags: 'work@example.com' },
    });
    const errors = validateFlowSchema(flow);
    assert.ok(errorPathContains(errors, 'steps[0].action.connection.tags'));
    assert.ok(errorMessageContains(errors, 'Unknown field "tags"'));
  });

  it('rejects a non-string `tag`', () => {
    const flow = makeFlow({
      platform: 'gmail',
      actionId: 'conn_mod_def::abc',
      connection: { platform: 'gmail', tag: 123 },
    });
    const errors = validateFlowSchema(flow);
    assert.ok(errorPathContains(errors, 'steps[0].action.connection.tag'));
  });

  it('treats an empty-string `connectionKey` as not-set (so `connection` must be present)', () => {
    const flow = makeFlow({
      platform: 'gmail',
      actionId: 'conn_mod_def::abc',
      connectionKey: '',
    });
    const errors = validateFlowSchema(flow);
    assert.ok(errorMessageContains(errors, 'must set "connection'));
  });

  it('applies the same rules to a paginate step\'s inner action', () => {
    const flow: Flow = {
      key: 'test-flow',
      name: 'Test',
      inputs: {},
      steps: [
        {
          id: 'page',
          name: 'Page through',
          type: 'paginate',
          paginate: {
            action: {
              platform: 'gmail',
              actionId: 'conn_mod_def::abc',
              // both forms set — should be rejected
              connectionKey: 'live::gmail::default::abc',
              connection: { platform: 'gmail' },
            } as any,
            pageTokenField: 'nextPageToken',
            resultsField: 'items',
            inputTokenParam: 'pageToken',
          },
        } as any,
      ],
    } as Flow;
    const errors = validateFlowSchema(flow);
    assert.ok(errorMessageContains(errors, 'set exactly one'));
  });
});
