# One Workflows — Multi-Step API Workflows

Workflows chain actions across platforms as JSON files stored at `.one/flows/<key>.flow.json`. Like n8n/Zapier but file-based.

## Building a Workflow

### Step 0: Design first

Before touching CLI commands:
1. Clarify the end goal — what output does the user need?
2. Map every step required to deliver that output
3. Identify where AI analysis is needed (summarization, scoring, classification)
4. Write the step sequence as a plain list before constructing JSON

Common mistake: jumping straight to `actions search` and building a raw data pipe. Design first.

### Step 1: Discover connections

```bash
one --agent connection list
```

### Step 2: Get knowledge for EACH action

```bash
one --agent actions search <platform> "<query>" -t execute
one --agent actions knowledge <platform> <actionId>
```

You MUST call knowledge for every action in the workflow — it tells you the exact body structure, required fields, and path variables.

### Step 3: Build the workflow JSON

### Step 4: Create

```bash
one --agent flow create <key> --definition '<json>'
```

Or write directly to `.one/flows/<key>.flow.json`.

### Step 5: Validate

```bash
one --agent flow validate <key>
```

### Step 6: Execute

```bash
one --agent flow execute <key> -i connectionKey=xxx -i param=value
```

## Workflow JSON Schema

```json
{
  "key": "welcome-customer",
  "name": "Welcome New Customer",
  "description": "Look up Stripe customer, send welcome email",
  "version": "1",
  "inputs": {
    "stripeConnectionKey": {
      "type": "string",
      "required": true,
      "description": "Stripe connection key",
      "connection": { "platform": "stripe" }
    },
    "customerEmail": {
      "type": "string",
      "required": true
    }
  },
  "steps": [...]
}
```

### Input Fields

| Field | Description |
|---|---|
| `type` | `string`, `number`, `boolean`, `object`, `array` |
| `required` | Whether input must be provided (default: true) |
| `default` | Default value if not provided |
| `description` | Human-readable description |
| `connection` | `{ "platform": "gmail" }` — enables auto-resolution |

Connection inputs with a `connection` field auto-resolve if the user has exactly one connection for that platform.

## Selector Syntax

| Pattern | Resolves To |
|---|---|
| `$.input.connectionKey` | Input value |
| `$.steps.stepId.response` | Full API response from a step |
| `$.steps.stepId.response.data[0].email` | Nested field with array index |
| `$.steps.stepId.response.data[*].id` | Wildcard — maps array to field |
| `$.env.MY_VAR` | Environment variable |
| `$.loop.item` | Current loop item |
| `$.loop.i` | Current loop index |
| `"Hello {{$.steps.getUser.response.data.name}}"` | String interpolation |

A pure `$.xxx` value resolves to the raw type. A string containing `{{$.xxx}}` does string interpolation.

### Selectors vs expressions

Selectors in data fields (`data`, `queryParams`, `pathVars`, `connectionKey`) are **dot-path lookups only** — they do not support JavaScript operators like `||` or `&&`. For default values, use the `default` field on the input definition:

```json
{
  "inputs": {
    "maxResults": { "type": "number", "default": 10 }
  }
}
```

The `if`, `unless`, `condition.expression`, `while.condition`, `transform.expression`, and `code.source` fields **do** support full JavaScript expressions (e.g., `$.input.email && $.input.email.length > 0`).

## Step Types

### `action` — Execute a One API action

```json
{
  "id": "findCustomer",
  "type": "action",
  "action": {
    "platform": "stripe",
    "actionId": "conn_mod_def::xxx::yyy",
    "connectionKey": "$.input.stripeConnectionKey",
    "data": { "query": "email:'{{$.input.customerEmail}}'" }
  }
}
```

### `transform` — JS expression (implicit return)

```json
{
  "id": "extractNames",
  "type": "transform",
  "transform": { "expression": "$.steps.findCustomer.response.data.map(c => c.name)" }
}
```

### `code` — Multi-line JS (explicit return, async, supports await)

```json
{
  "id": "processData",
  "type": "code",
  "code": {
    "source": "const customers = $.steps.list.response.data;\nreturn customers.map(c => ({...c, tier: c.spend > 1000 ? 'gold' : 'silver'}));"
  }
}
```

### `condition` — If/then/else branching

```json
{
  "id": "checkFound",
  "type": "condition",
  "condition": {
    "expression": "$.steps.find.response.data.length > 0",
    "then": [{ "id": "sendEmail", "type": "action", "action": {...} }],
    "else": [{ "id": "logNotFound", "type": "transform", "transform": { "expression": "'Not found'" } }]
  }
}
```

### `loop` — Iterate over an array

```json
{
  "id": "processOrders",
  "type": "loop",
  "loop": {
    "over": "$.steps.listOrders.response.orders",
    "as": "order",
    "maxConcurrency": 5,
    "steps": [...]
  }
}
```

### `parallel` — Run steps concurrently

Use when fetching from 2+ independent data sources before combining results. Each substep must have the full step schema (`id`, `name`, `type`, and type-specific config).

```json
{
  "id": "fetchAll",
  "name": "Fetch email and calendar data in parallel",
  "type": "parallel",
  "parallel": {
    "maxConcurrency": 5,
    "steps": [
      {
        "id": "fetchEmails",
        "name": "Fetch recent emails",
        "type": "action",
        "action": {
          "platform": "gmail",
          "actionId": "conn_mod_def::GmailListMessages::xxx",
          "connectionKey": "$.input.gmailKey",
          "pathVars": { "userId": "me" },
          "queryParams": { "maxResults": 10 }
        }
      },
      {
        "id": "fetchEvents",
        "name": "Fetch today's calendar events",
        "type": "action",
        "action": {
          "platform": "google-calendar",
          "actionId": "conn_mod_def::CalendarListEvents::xxx",
          "connectionKey": "$.input.calendarKey",
          "pathVars": { "calendarId": "primary" },
          "queryParams": { "maxResults": 10 }
        }
      }
    ]
  }
}
```

After a parallel step, access each substep's output by its `id`: `$.steps.fetchEmails.response`, `$.steps.fetchEvents.response`.

### `file-read` / `file-write` — Filesystem access

```json
{ "id": "read", "type": "file-read", "fileRead": { "path": "./data/config.json", "parseJson": true } }
{ "id": "write", "type": "file-write", "fileWrite": { "path": "./output/results.json", "content": "$.steps.transform.output" } }
```

### `while` — Condition-driven loop (do-while)

```json
{
  "id": "paginate",
  "type": "while",
  "while": {
    "condition": "$.steps.paginate.output.lastResult.nextPageToken != null",
    "maxIterations": 50,
    "steps": [...]
  }
}
```

### `flow` — Execute a sub-flow

```json
{
  "id": "enrich",
  "type": "flow",
  "flow": { "key": "enrich-customer", "inputs": { "email": "$.steps.get.response.email" } }
}
```

### `paginate` — Auto-collect paginated results

```json
{
  "id": "allMessages",
  "type": "paginate",
  "paginate": {
    "action": { "platform": "gmail", "actionId": "...", "connectionKey": "$.input.gmailKey" },
    "pageTokenField": "nextPageToken",
    "resultsField": "messages",
    "inputTokenParam": "queryParams.pageToken",
    "maxPages": 10
  }
}
```

### `bash` — Shell commands (requires `--allow-bash`)

```json
{
  "id": "analyze",
  "type": "bash",
  "bash": { "command": "cat /tmp/data.json | claude --print 'Analyze this' --output-format json", "timeout": 180000, "parseJson": true }
}
```

## Error Handling

```json
{ "onError": { "strategy": "retry", "retries": 3, "retryDelayMs": 1000 } }
```

Strategies: `fail` (default), `continue`, `retry`, `fallback`.

Conditional execution: `"if": "$.steps.find.response.data.length > 0"`

## AI-Augmented Patterns

### When to use parallel steps

Use `parallel` when your workflow fetches from 2+ independent data sources before combining them. Common patterns:
- Fetch Gmail + Calendar + Sheets → compile into daily briefing
- Search Exa + scrape with Firecrawl → merge research data
- Query BigQuery + list Google Drive files → combine for analysis

Each substep inside `parallel.steps` must have the full step schema: `id`, `name`, `type`, and the type-specific config (`action`, `code`, etc.). Follow a parallel step with a `code` or `transform` step to combine the results.

### file-write -> bash -> code

When raw data needs analysis, use this pattern:
1. `file-write` — save data to temp file (API responses are too large to inline)
2. `bash` — call `claude --print` to analyze (set timeout to 180000+, use `--output-format json`)
3. `code` — parse and structure the AI output for downstream steps

## CLI Commands

```bash
one --agent flow create <key> --definition '<json>'
one --agent flow list
one --agent flow validate <key>
one --agent flow execute <key> -i key=value
one --agent flow execute <key> --dry-run -i key=value
one --agent flow execute <key> --dry-run --mock -i key=value
one --agent flow execute <key> --allow-bash -i key=value
one --agent flow runs [flowKey]
one --agent flow resume <runId>
```

## Important Notes

- Connection keys are inputs, not hardcoded — makes workflows portable
- Action IDs in examples are placeholders — always use `actions search` to find real IDs
- Code steps support `require('crypto')`, `require('buffer')`, `require('url')`, `require('path')` — `fs`, `http`, `child_process` are blocked
- Bash steps require `--allow-bash` flag
- State is persisted after every step — resume picks up where it left off
- For bash+Claude steps, always set timeout to 180000+ and run sequentially (not in parallel)
