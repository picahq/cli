// Guide content — concise overview that routes agents to skill docs for details.
import { generateFlowGuide } from './flow-schema.js';

export const GUIDE_OVERVIEW = `# One CLI — Agent Guide

## Setup

1. Run \`one init\` to configure your API key
2. Run \`one add <platform>\` to connect platforms via OAuth
3. Run \`one --agent connection list\` to verify connections

## The --agent Flag

Always use \`--agent\` for machine-readable JSON output. It disables colors, spinners, and interactive prompts.

\`\`\`bash
one --agent <command>
\`\`\`

All commands return JSON. If an \`error\` key is present, the command failed.

## IMPORTANT: Read the guide before you act

Before using any feature, read its guide section first: \`one guide actions\`, \`one guide flows\`, or \`one guide relay\`. The guide teaches you the correct workflow, required fields, and common mistakes. Never guess — read the guide, then act.

## Features

### 1. Actions — Execute API calls on 200+ platforms
Search for actions, read their docs, and execute them. This is the core workflow.

**Quick start:**
\`\`\`bash
one --agent connection list                                    # See connected platforms
one --agent actions search <platform> "<query>" -t execute     # Find an action
one --agent actions knowledge <platform> <actionId>            # Read docs (REQUIRED)
one --agent actions execute <platform> <actionId> <key> -d '{}'  # Execute it
\`\`\`

**Parameter flags:**
- \`-d <json>\` — Request body (POST/PUT/PATCH)
- \`--path-vars <json>\` — URL path variables (e.g., \`{"userId": "me"}\`)
- \`--query-params <json>\` — Query parameters (arrays expand to repeated params)
- \`--form-url-encoded\` — Send as form data instead of JSON
- \`--dry-run\` — Preview request without executing

Do NOT pass path or query parameters in \`-d\` — use the correct flags.

### 2. Flows — Multi-step API workflows
Chain actions across platforms as JSON workflow files with conditions, loops, parallel execution, transforms, and AI analysis via bash steps.

**Quick start:**
\`\`\`bash
one --agent flow create <key> --definition '<json>'   # Create a workflow
one --agent flow validate <key>                       # Validate it
one --agent flow execute <key> -i param=value         # Execute it
one --agent flow list                                 # List all workflows
\`\`\`

**Key concepts:**
- Workflows are JSON files at \`.one/flows/<key>.flow.json\`
- 12 step types: action, transform, code, condition, loop, parallel, file-read, file-write, while, flow, paginate, bash
- Data wiring via selectors: \`$.input.param\`, \`$.steps.stepId.response\`, \`$.loop.item\`
- AI analysis via bash steps: \`claude --print\` with \`parseJson: true\`
- Use \`--allow-bash\` to enable bash steps, \`--mock\` for dry-run with mock responses

### 3. Relay — Webhook event forwarding between platforms
Receive webhooks from platforms (Stripe, GitHub, Airtable, Attio, Google Calendar) and forward event data to any connected platform using passthrough actions with Handlebars templates. No middleware, no code.

**Quick start:**
\`\`\`bash
one --agent relay event-types <platform>                        # See available events
one --agent relay create --connection-key <key> --create-webhook --event-filters '["event.type"]'
one --agent relay activate <id> --actions '[{"type":"passthrough","actionId":"...","connectionKey":"...","body":{...}}]'
one --agent relay list                                          # List endpoints
one --agent relay events --platform <p>                         # List received events
one --agent relay deliveries --endpoint-id <id>                 # Check delivery status
\`\`\`

**Key concepts:**
- \`passthrough\` actions map webhook fields to another platform's API using Handlebars: \`{{payload.data.object.email}}\`
- Template context: \`{{relayEventId}}\`, \`{{platform}}\`, \`{{eventType}}\`, \`{{payload}}\`, \`{{timestamp}}\`, \`{{connectionId}}\`
- \`--create-webhook\` auto-registers the webhook URL with the source platform
- Use \`actions knowledge\` to learn both the incoming payload shape AND the destination API shape before building templates

## Topics

Request specific sections:
- \`one guide overview\` — This section
- \`one guide actions\` — Actions reference (search, knowledge, execute)
- \`one guide flows\` — Workflow engine reference (step types, selectors, examples)
- \`one guide relay\` — Webhook relay reference (templates, passthrough actions)
- \`one guide all\` — Everything

## Important Notes

- **Always use \`--agent\` flag** for structured JSON output
- Platform names are always **kebab-case** (e.g., \`hub-spot\`, \`google-calendar\`)
- Always use the **exact action ID** from search results — don't guess
- Always read **knowledge** before executing any action
- Connection keys come from \`one connection list\` — don't hardcode them
`;

export const GUIDE_ACTIONS = `# One Actions — Reference

## Workflow: search → knowledge → execute

Always follow this sequence. Never skip the knowledge step.

### 1. List Connections

\`\`\`bash
one --agent connection list
\`\`\`

Returns platforms, status, connection keys, and tags.

### 2. Search Actions

\`\`\`bash
one --agent actions search <platform> "<query>" -t execute
\`\`\`

- Use \`-t execute\` when the user wants to perform an action
- Use \`-t knowledge\` (default) for documentation/code generation
- Returns up to 5 matching actions with IDs, methods, and paths

### 3. Get Knowledge

\`\`\`bash
one --agent actions knowledge <platform> <actionId>
\`\`\`

Returns full API docs: required fields, validation rules, request structure. **REQUIRED before execute.** The output includes a CLI PARAMETER MAPPING section showing which flags to use.

### 4. Execute

\`\`\`bash
one --agent actions execute <platform> <actionId> <connectionKey> [options]
\`\`\`

**Flags:**
- \`-d, --data <json>\` — Request body (POST/PUT/PATCH)
- \`--path-vars <json>\` — Path variables: \`{"userId": "me"}\`
- \`--query-params <json>\` — Query params: \`{"limit": "10"}\`
  - Arrays expand to repeated params: \`{"metadataHeaders": ["From", "Subject"]}\`
- \`--headers <json>\` — Additional headers
- \`--form-data\` / \`--form-url-encoded\` — Alternative content types
- \`--dry-run\` — Preview without executing

**Do NOT** pass path or query parameters in \`-d\`. Use the correct flags.

## Error Handling

All errors return JSON: \`{"error": "message"}\`. Check the \`error\` key.

## Notes

- Platform names are **kebab-case** (e.g., \`hub-spot\`)
- JSON flags use single quotes around the JSON to avoid shell escaping
- If search returns no results, try broader queries
- Access control settings from \`one config\` may restrict execution
`;

// Flow guide is generated from the schema descriptor in flow-schema.ts.
// This ensures documentation always matches the actual type definitions.
export const GUIDE_FLOWS = generateFlowGuide();

export const GUIDE_RELAY = `# One Relay — Reference

## Overview

Webhook relay receives events from platforms (Stripe, GitHub, Airtable, Attio, Google Calendar) and forwards them to any connected platform using passthrough actions with Handlebars templates.

## Commands

\`\`\`bash
one --agent relay event-types <platform>          # List available events
one --agent relay create --connection-key <key> --create-webhook --event-filters '["event.type"]'
one --agent relay activate <id> --actions '<json>' # Add forwarding actions
one --agent relay list                             # List endpoints
one --agent relay get <id>                         # Get endpoint details
one --agent relay update <id> --actions '<json>'   # Update endpoint
one --agent relay delete <id>                      # Delete endpoint
one --agent relay events --platform <p>            # List received events
one --agent relay event <id>                       # Get event with payload
one --agent relay deliveries --endpoint-id <id>    # Check delivery status
\`\`\`

## Building a Relay

1. **Discover connections** — identify source and destination platforms
2. **Get event types** — \`one --agent relay event-types <platform>\`
3. **Get source knowledge** — understand the incoming webhook payload shape (\`{{payload.*}}\` paths)
4. **Get destination knowledge** — understand the outgoing API body shape
5. **Create endpoint** — with \`--create-webhook\` and \`--event-filters\`
6. **Activate** — with passthrough action mapping source fields to destination fields

## Template Context

| Variable | Description |
|----------|-------------|
| \`{{relayEventId}}\` | Unique event UUID |
| \`{{platform}}\` | Source platform (e.g., \`stripe\`) |
| \`{{eventType}}\` | Event type (e.g., \`customer.created\`) |
| \`{{payload}}\` | Full incoming webhook body |
| \`{{timestamp}}\` | When the event was received |
| \`{{connectionId}}\` | Source connection UUID |
| \`{{json payload}}\` | Embed full payload as JSON string |

Access nested fields: \`{{payload.data.object.email}}\`

## Action Types

**passthrough** (primary) — forward to another platform's API:
\`\`\`json
{
  "type": "passthrough",
  "actionId": "<action-id>",
  "connectionKey": "<dest-connection-key>",
  "body": { "channel": "#alerts", "text": "New customer: {{payload.data.object.name}}" },
  "eventFilters": ["customer.created"]
}
\`\`\`

**url** — forward raw event to a URL:
\`\`\`json
{"type": "url", "url": "https://your-app.com/webhook", "eventFilters": ["customer.created"]}
\`\`\`

**agent** — send to an agent:
\`\`\`json
{"type": "agent", "agentId": "<uuid>", "eventFilters": ["customer.created"]}
\`\`\`

## Supported Source Platforms

Airtable, Attio, GitHub, Google Calendar, Stripe

Any connected platform can be a destination via passthrough actions.

## Debugging

1. \`relay get <id>\` — verify endpoint is active with actions configured
2. \`relay events --platform <p>\` — check events are arriving
3. \`relay deliveries --event-id <id>\` — check delivery status and errors
4. \`relay event <id>\` — inspect full payload to verify template paths
`;

type GuideTopic = 'overview' | 'actions' | 'flows' | 'relay' | 'all';

const TOPICS: { topic: GuideTopic; description: string }[] = [
  { topic: 'overview', description: 'Setup, features, and quick start for each' },
  { topic: 'actions', description: 'Search, read docs, and execute platform actions' },
  { topic: 'flows', description: 'Build and execute multi-step workflows' },
  { topic: 'relay', description: 'Receive webhooks and forward to other platforms' },
  { topic: 'all', description: 'Complete guide (all topics combined)' },
];

export function getGuideContent(topic: GuideTopic): { title: string; content: string } {
  switch (topic) {
    case 'overview':
      return { title: 'One CLI — Agent Guide: Overview', content: GUIDE_OVERVIEW };
    case 'actions':
      return { title: 'One CLI — Agent Guide: Actions', content: GUIDE_ACTIONS };
    case 'flows':
      return { title: 'One CLI — Agent Guide: Workflows', content: GUIDE_FLOWS };
    case 'relay':
      return { title: 'One CLI — Agent Guide: Relay', content: GUIDE_RELAY };
    case 'all':
      return {
        title: 'One CLI — Agent Guide: Complete',
        content: [GUIDE_OVERVIEW, GUIDE_ACTIONS, GUIDE_FLOWS, GUIDE_RELAY].join('\n---\n\n'),
      };
  }
}

export function getAvailableTopics(): { topic: string; description: string }[] {
  return TOPICS;
}

// Platform demo actions (used by onboard)
export const PLATFORM_DEMO_ACTIONS: Record<string, { description: string; query: string }> = {
  'gmail': { description: 'List recent emails', query: 'list messages' },
  'google-calendar': { description: 'List upcoming events', query: 'list events' },
  'slack': { description: 'List channels', query: 'list channels' },
  'shopify': { description: 'List products', query: 'list products' },
  'hub-spot': { description: 'List contacts', query: 'list contacts' },
  'github': { description: 'List repositories', query: 'list repos' },
  'stripe': { description: 'List customers', query: 'list customers' },
  'notion': { description: 'Search pages', query: 'search' },
  'airtable': { description: 'List bases', query: 'list bases' },
  'linear': { description: 'List issues', query: 'list issues' },
};

export function getWorkflowExamples(connectedPlatforms: string[]): string[] {
  const examples: string[] = [];
  const has = (p: string) => connectedPlatforms.includes(p);

  if (has('gmail') && has('slack')) examples.push('Gmail → Slack: Forward important emails to a channel');
  if (has('stripe') && has('slack')) examples.push('Stripe → Slack: Notify on new payments');
  if (has('shopify') && has('gmail')) examples.push('Shopify → Gmail: Send order confirmation emails');
  if (has('hub-spot') && has('gmail')) examples.push('HubSpot → Gmail: Auto-email new leads');
  if (has('github') && has('slack')) examples.push('GitHub → Slack: Notify on new issues/PRs');

  if (examples.length === 0) {
    examples.push('Connect 2+ platforms to unlock cross-platform workflows');
    examples.push('Example: Stripe + Slack → Notify on new payments');
    examples.push('Example: Gmail + HubSpot → Auto-create contacts from emails');
  }

  return examples;
}
