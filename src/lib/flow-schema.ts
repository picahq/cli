/**
 * Flow Schema Descriptor — Single Source of Truth
 *
 * This file defines the runtime schema for flow definitions.
 * Both the validator (flow-validator.ts) and the guide generator
 * derive their behavior from this descriptor.
 *
 * If you add a new step type to FlowStepType in flow-types.ts,
 * you MUST add a corresponding entry here — the build will fail otherwise.
 */

import type { FlowStepType } from './flow-types.js';

// ── Field Descriptor Types ──

export interface FieldDescriptor {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown';
  required: boolean;
  description: string;
  pattern?: RegExp;
  enum?: readonly string[];
  stepsArray?: boolean; // true = recursive FlowStep[] array
}

export interface StepTypeDescriptor {
  type: FlowStepType;
  configKey: string; // the JS property name on FlowStep (e.g. 'fileRead' for 'file-read')
  description: string;
  fields: Record<string, FieldDescriptor>;
  example: Record<string, unknown>;
}

export interface FlowSchemaDescriptor {
  flowFields: Record<string, FieldDescriptor>;
  inputFields: Record<string, FieldDescriptor>;
  stepCommonFields: Record<string, FieldDescriptor>;
  stepTypes: StepTypeDescriptor[];
  errorStrategies: readonly string[];
  validInputTypes: readonly string[];
}

// ── The Schema ──

export const FLOW_SCHEMA: FlowSchemaDescriptor = {
  errorStrategies: ['fail', 'continue', 'retry', 'fallback'] as const,
  validInputTypes: ['string', 'number', 'boolean', 'object', 'array'] as const,

  flowFields: {
    key:         { type: 'string', required: true, description: 'Unique kebab-case identifier', pattern: /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ },
    name:        { type: 'string', required: true, description: 'Human-readable flow name' },
    description: { type: 'string', required: false, description: 'What this flow does' },
    version:     { type: 'string', required: false, description: 'Semver or arbitrary version string' },
    inputs:      { type: 'object', required: true, description: 'Input declarations (Record<string, InputDeclaration>)' },
    steps:       { type: 'array', required: true, description: 'Ordered array of steps', stepsArray: true },
  },

  inputFields: {
    type:        { type: 'string', required: true, description: 'Data type: string, number, boolean, object, array', enum: ['string', 'number', 'boolean', 'object', 'array'] },
    required:    { type: 'boolean', required: false, description: 'Whether this input must be provided' },
    default:     { type: 'unknown', required: false, description: 'Default value if not provided' },
    description: { type: 'string', required: false, description: 'Human-readable description' },
    connection:  { type: 'object', required: false, description: 'Connection metadata: { platform: "gmail" } — enables auto-resolution' },
  },

  stepCommonFields: {
    id:     { type: 'string', required: true, description: 'Unique step identifier (used in selectors)' },
    name:   { type: 'string', required: true, description: 'Human-readable step label' },
    type:   { type: 'string', required: true, description: 'Step type (determines which config object is required)' },
    if:     { type: 'string', required: false, description: 'JS expression — skip step if falsy' },
    unless: { type: 'string', required: false, description: 'JS expression — skip step if truthy' },
  },

  stepTypes: [
    {
      type: 'action',
      configKey: 'action',
      description: 'Execute a platform API action',
      fields: {
        platform:      { type: 'string', required: true, description: 'Platform name (kebab-case)' },
        actionId:      { type: 'string', required: true, description: 'Action ID from `actions search`' },
        connectionKey: { type: 'string', required: true, description: 'Connection key (use $.input selector)' },
        data:          { type: 'object', required: false, description: 'Request body (POST/PUT/PATCH)' },
        pathVars:      { type: 'object', required: false, description: 'URL path variables' },
        queryParams:   { type: 'object', required: false, description: 'Query parameters' },
        headers:       { type: 'object', required: false, description: 'Additional headers' },
      },
      example: {
        id: 'findCustomer', name: 'Search Stripe customers', type: 'action',
        action: {
          platform: 'stripe',
          actionId: 'conn_mod_def::xxx::yyy',
          connectionKey: '$.input.stripeConnectionKey',
          data: { query: "email:'{{$.input.customerEmail}}'" },
        },
      },
    },
    {
      type: 'transform',
      configKey: 'transform',
      description: 'Single JS expression with implicit return',
      fields: {
        expression: { type: 'string', required: true, description: 'JS expression evaluated with flow context as $' },
      },
      example: {
        id: 'extractNames', name: 'Extract customer names', type: 'transform',
        transform: { expression: '$.steps.findCustomer.response.data.map(c => c.name)' },
      },
    },
    {
      type: 'code',
      configKey: 'code',
      description: 'Multi-line async JS with explicit return',
      fields: {
        source: { type: 'string', required: true, description: 'JS function body (flow context as $, supports await)' },
      },
      example: {
        id: 'processData', name: 'Process and enrich data', type: 'code',
        code: { source: 'const items = $.steps.fetch.response.data;\nreturn items.filter(i => i.active);' },
      },
    },
    {
      type: 'condition',
      configKey: 'condition',
      description: 'If/then/else branching',
      fields: {
        expression: { type: 'string', required: true, description: 'JS expression — truthy runs then, falsy runs else' },
        then:       { type: 'array', required: true, description: 'Steps to run when true', stepsArray: true },
        else:       { type: 'array', required: false, description: 'Steps to run when false', stepsArray: true },
      },
      example: {
        id: 'checkFound', name: 'Check if customer exists', type: 'condition',
        condition: {
          expression: '$.steps.search.response.data.length > 0',
          then: [{ id: 'notify', name: 'Send notification', type: 'action', action: { platform: 'slack', actionId: '...', connectionKey: '$.input.slackKey', data: { text: 'Found!' } } }],
          else: [{ id: 'logMiss', name: 'Log not found', type: 'transform', transform: { expression: "'Not found'" } }],
        },
      },
    },
    {
      type: 'loop',
      configKey: 'loop',
      description: 'Iterate over an array with optional concurrency',
      fields: {
        over:           { type: 'string', required: true, description: 'Selector resolving to an array' },
        as:             { type: 'string', required: true, description: 'Variable name for current item ($.loop.<as>)' },
        indexAs:        { type: 'string', required: false, description: 'Variable name for index' },
        steps:          { type: 'array', required: true, description: 'Steps to run per iteration', stepsArray: true },
        maxIterations:  { type: 'number', required: false, description: 'Safety cap (default: no limit)' },
        maxConcurrency: { type: 'number', required: false, description: 'Parallel batch size (default: 1 = sequential)' },
      },
      example: {
        id: 'processOrders', name: 'Process each order', type: 'loop',
        loop: {
          over: '$.steps.listOrders.response.data', as: 'order',
          steps: [{ id: 'createInvoice', name: 'Create invoice', type: 'action', action: { platform: 'stripe', actionId: '...', connectionKey: '$.input.stripeKey', data: { amount: '$.loop.order.total' } } }],
        },
      },
    },
    {
      type: 'parallel',
      configKey: 'parallel',
      description: 'Run steps concurrently',
      fields: {
        steps:          { type: 'array', required: true, description: 'Steps to run in parallel', stepsArray: true },
        maxConcurrency: { type: 'number', required: false, description: 'Max concurrent steps (default: 5)' },
      },
      example: {
        id: 'lookups', name: 'Parallel data lookups', type: 'parallel',
        parallel: {
          steps: [
            { id: 'getStripe', name: 'Get Stripe data', type: 'action', action: { platform: 'stripe', actionId: '...', connectionKey: '$.input.stripeKey' } },
            { id: 'getSlack', name: 'Get Slack data', type: 'action', action: { platform: 'slack', actionId: '...', connectionKey: '$.input.slackKey' } },
          ],
        },
      },
    },
    {
      type: 'file-read',
      configKey: 'fileRead',
      description: 'Read a file (optional JSON parse)',
      fields: {
        path:      { type: 'string', required: true, description: 'File path to read' },
        parseJson: { type: 'boolean', required: false, description: 'Parse contents as JSON (default: false)' },
      },
      example: {
        id: 'readConfig', name: 'Read config file', type: 'file-read',
        fileRead: { path: './data/config.json', parseJson: true },
      },
    },
    {
      type: 'file-write',
      configKey: 'fileWrite',
      description: 'Write or append to a file',
      fields: {
        path:    { type: 'string', required: true, description: 'File path to write' },
        content: { type: 'unknown', required: true, description: 'Content to write (supports selectors)' },
        append:  { type: 'boolean', required: false, description: 'Append instead of overwrite (default: false)' },
      },
      example: {
        id: 'writeResults', name: 'Save results', type: 'file-write',
        fileWrite: { path: './output/results.json', content: '$.steps.transform.output' },
      },
    },
    {
      type: 'while',
      configKey: 'while',
      description: 'Do-while loop with condition check',
      fields: {
        condition:     { type: 'string', required: true, description: 'JS expression checked before each iteration (after first)' },
        steps:         { type: 'array', required: true, description: 'Steps to run each iteration', stepsArray: true },
        maxIterations: { type: 'number', required: false, description: 'Safety cap (default: 100)' },
      },
      example: {
        id: 'paginate', name: 'Paginate through pages', type: 'while',
        while: {
          condition: '$.steps.paginate.output.lastResult.nextPageToken != null',
          maxIterations: 50,
          steps: [{ id: 'fetchPage', name: 'Fetch next page', type: 'action', action: { platform: 'gmail', actionId: '...', connectionKey: '$.input.gmailKey' } }],
        },
      },
    },
    {
      type: 'flow',
      configKey: 'flow',
      description: 'Execute a sub-flow (supports composition)',
      fields: {
        key:    { type: 'string', required: true, description: 'Flow key or path of the sub-flow' },
        inputs: { type: 'object', required: false, description: 'Inputs to pass to the sub-flow (supports selectors)' },
      },
      example: {
        id: 'enrich', name: 'Run enrichment sub-flow', type: 'flow',
        flow: { key: 'enrich-customer', inputs: { email: '$.steps.getCustomer.response.email' } },
      },
    },
    {
      type: 'paginate',
      configKey: 'paginate',
      description: 'Auto-paginate API results into a single array',
      fields: {
        action:          { type: 'object', required: true, description: 'Action config (same shape as action step: platform, actionId, connectionKey)' },
        pageTokenField:  { type: 'string', required: true, description: 'Dot-path in response to next page token' },
        resultsField:    { type: 'string', required: true, description: 'Dot-path in response to results array' },
        inputTokenParam: { type: 'string', required: true, description: 'Dot-path in action config where page token is injected' },
        maxPages:        { type: 'number', required: false, description: 'Max pages to fetch (default: 10)' },
      },
      example: {
        id: 'allMessages', name: 'Fetch all Gmail messages', type: 'paginate',
        paginate: {
          action: { platform: 'gmail', actionId: '...', connectionKey: '$.input.gmailKey', queryParams: { maxResults: 100 } },
          pageTokenField: 'nextPageToken', resultsField: 'messages', inputTokenParam: 'queryParams.pageToken', maxPages: 10,
        },
      },
    },
    {
      type: 'bash',
      configKey: 'bash',
      description: 'Shell command (requires --allow-bash)',
      fields: {
        command:   { type: 'string', required: true, description: 'Shell command to execute (supports selectors)' },
        timeout:   { type: 'number', required: false, description: 'Timeout in ms (default: 30000)' },
        parseJson: { type: 'boolean', required: false, description: 'Parse stdout as JSON (default: false)' },
        cwd:       { type: 'string', required: false, description: 'Working directory (supports selectors)' },
        env:       { type: 'object', required: false, description: 'Additional environment variables' },
      },
      example: {
        id: 'analyze', name: 'Analyze with Claude', type: 'bash',
        bash: {
          command: "cat /tmp/data.json | claude --print 'Analyze this data' --output-format json",
          timeout: 180000, parseJson: true,
        },
      },
    },
  ],
};

// ── Compile-time guarantee: every FlowStepType has a descriptor ──

const _coveredTypes: Record<FlowStepType, true> = Object.fromEntries(
  FLOW_SCHEMA.stepTypes.map(st => [st.type, true as const]),
) as Record<FlowStepType, true>;
void _coveredTypes; // suppress unused warning

// ── Lookup helpers ──

const _stepTypeMap = new Map<string, StepTypeDescriptor>(
  FLOW_SCHEMA.stepTypes.map(st => [st.type, st]),
);

export function getStepTypeDescriptor(type: string): StepTypeDescriptor | undefined {
  return _stepTypeMap.get(type);
}

export function getValidStepTypes(): string[] {
  return FLOW_SCHEMA.stepTypes.map(st => st.type);
}

/** Returns config keys that contain nested steps arrays (for recursive traversal). */
export function getNestedStepsKeys(): { configKey: string; fieldName: string }[] {
  const result: { configKey: string; fieldName: string }[] = [];
  for (const st of FLOW_SCHEMA.stepTypes) {
    for (const [fieldName, fd] of Object.entries(st.fields)) {
      if (fd.stepsArray) {
        result.push({ configKey: st.configKey, fieldName });
      }
    }
  }
  return result;
}

// ── Guide Generator ──

export function generateFlowGuide(): string {
  const validTypes = getValidStepTypes();
  const sections: string[] = [];

  // Header
  sections.push(`# One Flows — Reference

## Overview

Workflows are JSON files at \`.one/flows/<key>.flow.json\` that chain actions across platforms.

## Commands

\`\`\`bash
one --agent flow create <key> --definition '<json>'   # Create (or --definition @file.json)
one --agent flow create <key> --definition @flow.json  # Create from file
one --agent flow list                                  # List
one --agent flow validate <key>                        # Validate
one --agent flow execute <key> -i name=value           # Execute
one --agent flow execute <key> --dry-run --mock        # Test with mock data
one --agent flow execute <key> --allow-bash            # Enable bash steps
one --agent flow runs [flowKey]                        # List past runs
one --agent flow resume <runId>                        # Resume failed run
one --agent flow scaffold [template]                   # Generate a starter template
\`\`\`

You can also write the JSON file directly to \`.one/flows/<key>.flow.json\` — this is often easier than passing large JSON via --definition.

## Building a Workflow

1. **Design first** — clarify the end goal, map the full value chain, identify where AI analysis is needed
2. **Discover connections** — \`one --agent connection list\`
3. **Get knowledge** for every action — \`one --agent actions knowledge <platform> <actionId>\`
4. **Construct JSON** — declare inputs, wire steps with selectors
5. **Validate** — \`one --agent flow validate <key>\`
6. **Execute** — \`one --agent flow execute <key> -i param=value\``);

  // Flow JSON Schema
  sections.push(`## Flow JSON Schema

\`\`\`json
{
  "key": "my-workflow",
  "name": "My Workflow",
  "description": "What this flow does",
  "version": "1",
  "inputs": {
    "connectionKey": {
      "type": "string",
      "required": true,
      "description": "Platform connection key",
      "connection": { "platform": "stripe" }
    },
    "param": {
      "type": "string",
      "required": true,
      "description": "A user parameter"
    }
  },
  "steps": [
    {
      "id": "stepId",
      "name": "Human-readable step name",
      "type": "action",
      "action": {
        "platform": "stripe",
        "actionId": "conn_mod_def::xxx::yyy",
        "connectionKey": "$.input.connectionKey",
        "data": { "query": "{{$.input.param}}" }
      }
    }
  ]
}
\`\`\`

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|`);

  for (const [name, fd] of Object.entries(FLOW_SCHEMA.flowFields)) {
    sections.push(`| \`${name}\` | ${fd.type} | ${fd.required ? 'yes' : 'no'} | ${fd.description} |`);
  }

  sections.push(`
### Input declarations

| Field | Type | Required | Description |
|-------|------|----------|-------------|`);

  for (const [name, fd] of Object.entries(FLOW_SCHEMA.inputFields)) {
    sections.push(`| \`${name}\` | ${fd.type} | ${fd.required ? 'yes' : 'no'} | ${fd.description} |`);
  }

  // Step common fields
  sections.push(`
### Step fields (all steps)

Every step MUST have \`id\`, \`name\`, and \`type\`. The \`type\` determines which config object is required.

| Field | Type | Required | Description |
|-------|------|----------|-------------|`);

  for (const [name, fd] of Object.entries(FLOW_SCHEMA.stepCommonFields)) {
    sections.push(`| \`${name}\` | ${fd.type} | ${fd.required ? 'yes' : 'no'} | ${fd.description} |`);
  }

  sections.push(`| \`onError\` | object | no | Error handling: \`{ "strategy": "${FLOW_SCHEMA.errorStrategies.join(' | ')}", "retries": 3, "retryDelayMs": 1000 }\` |`);

  // Step types table
  sections.push(`
## Step Types

**IMPORTANT:** Each step type requires a config object nested under a specific key. The type name and config key differ for some types (noted below).

| Type | Config Key | Description |
|------|-----------|-------------|`);

  for (const st of FLOW_SCHEMA.stepTypes) {
    const keyNote = st.type !== st.configKey ? ` ⚠️` : '';
    sections.push(`| \`${st.type}\` | \`${st.configKey}\`${keyNote} | ${st.description} |`);
  }

  // Per-step-type reference
  sections.push(`\n## Step Type Reference`);

  for (const st of FLOW_SCHEMA.stepTypes) {
    sections.push(`\n### \`${st.type}\` — ${st.description}`);

    if (st.type !== st.configKey) {
      sections.push(`\n> **Note:** Type is \`"${st.type}"\` but config key is \`"${st.configKey}"\` (camelCase).`);
    }

    sections.push(`\n| Field | Type | Required | Description |
|-------|------|----------|-------------|`);

    for (const [name, fd] of Object.entries(st.fields)) {
      sections.push(`| \`${name}\` | ${fd.type} | ${fd.required ? 'yes' : 'no'} | ${fd.description} |`);
    }

    sections.push(`\n\`\`\`json\n${JSON.stringify(st.example, null, 2)}\n\`\`\``);
  }

  // Selectors
  sections.push(`
## Selectors

| Pattern | Resolves To |
|---------|-------------|
| \`$.input.paramName\` | Input value |
| \`$.steps.stepId.response\` | Full API response |
| \`$.steps.stepId.response.data[0].email\` | Nested field |
| \`$.steps.stepId.response.data[*].id\` | Wildcard array map |
| \`$.env.MY_VAR\` | Environment variable |
| \`$.loop.item\` / \`$.loop.i\` | Loop iteration |
| \`"Hello {{$.steps.getUser.response.name}}"\` | String interpolation |

### When to use bare selectors vs \`{{...}}\` interpolation

- **Bare selectors** (\`$.input.x\`): Use for fields the engine resolves directly — \`connectionKey\`, \`over\`, \`path\`, \`expression\`, \`condition\`, and any field where the entire value is a single selector. The resolved value keeps its original type (object, array, number).
- **Interpolation** (\`{{$.input.x}}\`): Use inside string values where the selector is embedded in text — e.g., \`"Hello {{$.steps.getUser.response.name}}"\`. The resolved value is always stringified. Use this in \`data\`, \`pathVars\`, and \`queryParams\` when mixing selectors with literal text.
- **Rule of thumb**: If the value is purely a selector, use bare. If it's a string containing a selector, use \`{{...}}\`.

### \`output\` vs \`response\` on step results

Every completed step produces both \`output\` and \`response\`:
- **Action steps**: \`response\` is the raw API response. \`output\` is the same as \`response\`.
- **Code/transform steps**: \`output\` is the return value. \`response\` is an alias for \`output\`.
- **In practice**: Use \`$.steps.stepId.response\` for action steps (API data) and \`$.steps.stepId.output\` for code/transform steps (computed data). Both work interchangeably, but using the semantically correct one makes flows easier to read.

## Error Handling

\`\`\`json
{"onError": {"strategy": "retry", "retries": 3, "retryDelayMs": 1000}}
\`\`\`

Strategies: \`${FLOW_SCHEMA.errorStrategies.join('\`, \`')}\`

Conditional execution: \`"if": "$.steps.prev.response.data.length > 0"\`

## Input Connection Auto-Resolution

When an input has \`"connection": { "platform": "stripe" }\`, the flow engine can automatically resolve the connection key at execution time. If the user has exactly one connection for that platform, the engine fills in the key without requiring \`-i connectionKey=...\`. If multiple connections exist, the user must specify which one. This is metadata for tooling — it does not affect the flow JSON structure, but it makes execution more convenient.

## Complete Example: Fetch Data, Transform, Notify

\`\`\`json
{
  "key": "contacts-to-slack",
  "name": "CRM Contacts Summary to Slack",
  "description": "Fetch recent contacts from CRM, build a summary, post to Slack",
  "version": "1",
  "inputs": {
    "crmConnectionKey": {
      "type": "string",
      "required": true,
      "description": "CRM platform connection key",
      "connection": { "platform": "attio" }
    },
    "slackConnectionKey": {
      "type": "string",
      "required": true,
      "description": "Slack connection key",
      "connection": { "platform": "slack" }
    },
    "slackChannel": {
      "type": "string",
      "required": true,
      "description": "Slack channel name or ID"
    }
  },
  "steps": [
    {
      "id": "fetchContacts",
      "name": "Fetch recent contacts",
      "type": "action",
      "action": {
        "platform": "attio",
        "actionId": "ATTIO_LIST_PEOPLE_ACTION_ID",
        "connectionKey": "$.input.crmConnectionKey",
        "queryParams": { "limit": "10" }
      }
    },
    {
      "id": "buildSummary",
      "name": "Build formatted summary",
      "type": "code",
      "code": {
        "source": "const contacts = $.steps.fetchContacts.response.data || [];\\nconst lines = contacts.map((c, i) => \`\${i+1}. \${c.name || 'Unknown'} — \${c.email || 'no email'}\`);\\nreturn { summary: \`Found \${contacts.length} contacts:\\n\${lines.join('\\n')}\` };"
      }
    },
    {
      "id": "notifySlack",
      "name": "Post summary to Slack",
      "type": "action",
      "action": {
        "platform": "slack",
        "actionId": "SLACK_SEND_MESSAGE_ACTION_ID",
        "connectionKey": "$.input.slackConnectionKey",
        "data": {
          "channel": "$.input.slackChannel",
          "text": "{{$.steps.buildSummary.output.summary}}"
        }
      }
    }
  ]
}
\`\`\`

Note: Action IDs above are placeholders. Always use \`one --agent actions search <platform> "<query>"\` to find real IDs.

## AI-Augmented Pattern

For workflows that need analysis/summarization, use the file-write → bash → code pattern:

1. \`file-write\` — save data to temp file
2. \`bash\` — \`claude --print\` analyzes it (\`parseJson: true\`, \`timeout: 180000\`)
3. \`code\` — parse and structure the output

Set timeout to at least 180000ms (3 min). Run Claude-heavy flows sequentially, not in parallel.

## Notes

- Connection keys are **inputs**, not hardcoded
- Action IDs in examples are placeholders — always use \`actions search\`
- Code steps allow \`crypto\`, \`buffer\`, \`url\`, \`path\` — \`fs\`, \`http\`, \`child_process\` are blocked
- Bash steps require \`--allow-bash\` flag
- State is persisted after every step — resume picks up where it left off`);

  return sections.join('\n');
}
