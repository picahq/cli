# One Workflows — Multi-Step API Workflows

Workflows chain actions across platforms. Like n8n/Zapier but file-based.

## Before you execute a flow you did NOT author — READ THIS

Nothing about a flow's runtime requirements is guessable from its name. Before `flow execute`, do one of these:

1. **Recommended:** `one --agent flow list` — the JSON output includes `requiresBash`, `usesCodeModules`, `inputs` (with `autoResolvable`), `stepTypes`, and the flow's `description`. Fastest path to knowing what you need.
2. Read the flow's `description` field from the JSON. Authors are required (see "Author conventions" below) to state `--allow-bash` requirements and non-auto-resolving inputs there.
3. `one --agent flow execute <key> --dry-run` to see resolved inputs and step plan without side effects.

If you skip this, you will hit errors like *"Workflow X contains bash steps. Re-run with --allow-bash."* — the CLI pre-flights and fails fast, but the error is entirely avoidable by reading first.

## Author conventions — write flows that are safe to execute blind

The `description` field is the contract with future executors. It MUST state:

- **`--allow-bash` if any step is type `bash`.** e.g. *"Fetches recent Gmail and summarizes with Claude Haiku. Requires `--allow-bash`."*
- **Every input that does NOT have a `connection` hint.** Connection inputs auto-resolve when exactly one matching connection exists; everything else must be passed via `-i name=value`.
- **Any files/directories the flow writes to.**

If a flow's description doesn't tell you how to run it, treat that as a bug in the flow and fix it.

**Storage layout:**

- **Folder layout (REQUIRED for new flows):** `.one/flows/<key>/flow.json`, with an optional `lib/` subfolder for `.mjs` code modules. Like a skill — the folder groups the spec with its helper code, so the whole flow is shareable. **Always create new flows here.**
- **Legacy single-file layout (DEPRECATED):** `.one/flows/<key>.flow.json`. Still loads and runs for backward compatibility, but do not create new flows in this layout. When touching an existing single-file flow, migrate it: move `<key>.flow.json` to `<key>/flow.json` and extract any non-trivial `code.source` blocks into `<key>/lib/*.mjs` modules.

`one flow create` always writes the folder layout.

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

Or write directly to `.one/flows/<key>/flow.json` (folder layout) or the legacy `.one/flows/<key>.flow.json`.

### Code modules (`lib/` folder)

A `code` step can reference an external `.mjs` module instead of inlining JS as a JSON string:

```
.one/flows/my-flow/
├── flow.json
└── lib/
    └── process-data.mjs
```

```js
// lib/process-data.mjs
const $ = JSON.parse(await new Response(process.stdin).text());
const items = $.steps.fetch.response.data ?? [];
process.stdout.write(JSON.stringify(items.filter(i => i.active)));
```

```json
{
  "id": "processData",
  "name": "Process",
  "type": "code",
  "code": { "module": "lib/process-data.mjs" }
}
```

The module runs as a child `node` process: the flow context `$` is piped to stdin as JSON, and stdout is parsed as JSON and used as the step's output. Modules have full Node APIs available (unlike inline `code.source`, which is sandboxed). Use `code.module` for anything non-trivial; keep `code.source` for one-liners.

Whatever JSON a module writes to stdout becomes both `$.steps.<id>.output` and `$.steps.<id>.response` (aliases). Downstream steps can reference either.

### Migrating a legacy single-file flow

If you touch an existing `.one/flows/<key>.flow.json`, migrate it:

1. `mkdir -p .one/flows/<key>/lib`
2. `mv .one/flows/<key>.flow.json .one/flows/<key>/flow.json`
3. Extract non-trivial `code.source` blocks into `lib/<step-id>.mjs` and swap the step config from `{ "source": "..." }` to `{ "module": "lib/<step-id>.mjs" }`. One-liners can stay inline.
4. `one --agent flow validate <key>`
5. Execute and confirm behavior is unchanged.

**Inline source → module translation.** Inline `code.source` is an async function body where `$` is in scope and you `return` the result. A module reads `$` from stdin and writes the result to stdout. Mechanical transform:

Before (inline):
```js
const items = $.steps.fetch.response.data;
return { active: items.filter(i => i.active) };
```

After (`lib/<step-id>.mjs`):
```js
const $ = JSON.parse(await new Response(process.stdin).text());
const items = $.steps.fetch.response.data;
process.stdout.write(JSON.stringify({ active: items.filter(i => i.active) }));
```

Two rules: (1) prepend the stdin-read line, (2) replace `return X` with `process.stdout.write(JSON.stringify(X))`.

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
