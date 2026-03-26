---
name: one-flow
description: |
  Build and execute multi-step API workflows that chain actions across platforms — like n8n/Zapier but file-based. Workflows are JSON files stored at `.one/flows/<key>.flow.json`.

  TRIGGER when the user wants to:
  - Create a multi-step workflow or automation (e.g., "create a workflow that looks up a customer in Stripe and sends them an email")
  - Chain multiple API actions together across platforms
  - Build a pipeline or sequence of API calls
  - Execute, validate, or manage existing workflows
  - Automate a process involving multiple connected platforms
  - Schedule or orchestrate a series of actions

  DO NOT TRIGGER for:
  - Single action execution (use one-actions skill instead)
  - Setting up One or installing MCP (that's `one init`)
  - Adding new connections (that's `one connection add`)
---

# One Workflows — Multi-Step API Workflows

<!-- Canonical flow schema: src/lib/flow-schema.ts (drives both validation and guide generation) -->

You have access to the One CLI's workflow engine, which lets you create and execute multi-step API workflows as JSON files. Workflows chain actions across platforms — e.g., look up a Stripe customer, then send them a welcome email via Gmail.

## 1. Overview

- Workflows are JSON files stored at `.one/flows/<key>.flow.json`
- All dynamic values (including connection keys) are declared as **inputs**
- Each workflow has a unique **key** used to reference and execute it
- Executed via `one --agent flow execute <key> -i name=value`

## 2. Building a Workflow — Step-by-Step Process

**You MUST follow this process to build a correct workflow:**

### Step 0: Design the workflow

Before touching any CLI commands, understand what you are building:

1. **Clarify the end goal.** What output does the user actually need? A report? A notification? An enriched dataset? Do not assume — ask if unclear.
2. **Map the full value chain.** List every step required to deliver that output at production quality. Fetching raw data is never the final step — ask yourself: "If I handed this raw API response to the user, would they be satisfied?" If no, you need analysis or enrichment steps.
3. **Identify where AI analysis is needed.** Any time raw data needs summarization, scoring, classification, comparison, or natural-language generation, plan a `bash` step using `claude --print`. See the AI-Augmented Patterns section below.
4. **Write the step sequence as a plain list** before constructing JSON. Example:
   - Fetch competitor pricing from API
   - Write data to temp file
   - Claude analyzes competitive positioning (bash step)
   - Parse Claude's JSON output (code step)
   - Send formatted report via email

**Common mistake:** Jumping straight to `one actions search` and building a workflow that only fetches and pipes raw data. The result is a shallow data dump, not a useful workflow. Always design first.

### Step 1: Discover connections

```bash
one --agent connection list
```

Find out which platforms are connected and get their connection keys.

### Step 2: For EACH API action needed, get the knowledge

```bash
# Find the action ID
one --agent actions search <platform> "<query>" -t execute

# Read the full docs — REQUIRED before adding to a workflow
one --agent actions knowledge <platform> <actionId>
```

**CRITICAL:** You MUST call `one actions knowledge` for every action you include in the workflow. The knowledge output tells you the exact request body structure, required fields, path variables, and query parameters. Without this, your workflow JSON will have incorrect data shapes.

### Step 3: Construct the workflow JSON

Using the knowledge gathered, build the workflow JSON with:
- All inputs declared (connection keys + user parameters)
- Each step with the correct actionId, platform, and data structure (from knowledge)
- Data wired between steps using `$.input.*` and `$.steps.*` selectors

### Step 4: Write the workflow file

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

## 3. Workflow JSON Schema Reference

```json
{
  "key": "welcome-customer",
  "name": "Welcome New Customer",
  "description": "Look up a Stripe customer and send them a welcome email via Gmail",
  "version": "1",
  "inputs": {
    "stripeConnectionKey": {
      "type": "string",
      "required": true,
      "description": "Stripe connection key from one connection list",
      "connection": { "platform": "stripe" }
    },
    "gmailConnectionKey": {
      "type": "string",
      "required": true,
      "description": "Gmail connection key from one connection list",
      "connection": { "platform": "gmail" }
    },
    "customerEmail": {
      "type": "string",
      "required": true,
      "description": "Customer email to look up"
    }
  },
  "steps": [
    {
      "id": "stepId",
      "name": "Human-readable label",
      "type": "action",
      "action": {
        "platform": "stripe",
        "actionId": "the-action-id-from-search",
        "connectionKey": "$.input.stripeConnectionKey",
        "data": {},
        "pathVars": {},
        "queryParams": {},
        "headers": {}
      }
    }
  ]
}
```

### Input declarations

| Field | Type | Description |
|---|---|---|
| `type` | string | `string`, `number`, `boolean`, `object`, `array` |
| `required` | boolean | Whether this input must be provided (default: true) |
| `default` | any | Default value if not provided |
| `description` | string | Human-readable description |
| `connection` | object | Connection metadata: `{ "platform": "gmail" }` — enables auto-resolution |

**Connection inputs** have a `connection` field. If the user has exactly one connection for that platform, the workflow engine auto-resolves it.

## 4. Selector Syntax Reference

| Pattern | Resolves To |
|---|---|
| `$.input.gmailConnectionKey` | Input value (including connection keys) |
| `$.input.customerEmail` | Any input parameter |
| `$.steps.stepId.response` | Full API response from a step |
| `$.steps.stepId.response.data[0].email` | Nested field with array index |
| `$.steps.stepId.response.data[*].id` | Wildcard — maps array to field |
| `$.env.MY_VAR` | Environment variable |
| `$.loop.item` | Current loop item |
| `$.loop.i` | Current loop index |
| `"Hello {{$.steps.getUser.response.data.name}}"` | String interpolation |

**Rules:**
- A value that is purely `$.xxx` resolves to the raw type (object, array, number)
- A string containing `{{$.xxx}}` does string interpolation (stringifies objects)
- Selectors inside objects/arrays are resolved recursively

## 5. Step Types Reference

### `action` — Execute a One API action

```json
{
  "id": "findCustomer",
  "name": "Search Stripe customers",
  "type": "action",
  "action": {
    "platform": "stripe",
    "actionId": "conn_mod_def::xxx::yyy",
    "connectionKey": "$.input.stripeConnectionKey",
    "data": {
      "query": "email:'{{$.input.customerEmail}}'"
    }
  }
}
```

### `transform` — Transform data with a JS expression

```json
{
  "id": "extractNames",
  "name": "Extract customer names",
  "type": "transform",
  "transform": {
    "expression": "$.steps.findCustomer.response.data.map(c => c.name)"
  }
}
```

The expression is evaluated with the full flow context as `$`.

### `code` — Run multi-line JavaScript

Unlike `transform` (single expression, implicit return), `code` runs a full function body with explicit `return`. Use it when you need variables, loops, try/catch, or `await`.

```json
{
  "id": "processData",
  "name": "Process and enrich data",
  "type": "code",
  "code": {
    "source": "const customers = $.steps.listCustomers.response.data;\nconst enriched = customers.map(c => ({\n  ...c,\n  tier: c.spend > 1000 ? 'gold' : 'silver'\n}));\nreturn enriched;"
  }
}
```

The `source` field contains a JS function body. The flow context is available as `$`. The function is async, so you can use `await`. The return value is stored as the step result.

### `condition` — If/then/else branching

```json
{
  "id": "checkFound",
  "name": "Check if customer was found",
  "type": "condition",
  "condition": {
    "expression": "$.steps.findCustomer.response.data.length > 0",
    "then": [
      { "id": "sendEmail", "name": "Send welcome email", "type": "action", "action": { "..." : "..." } }
    ],
    "else": [
      { "id": "logNotFound", "name": "Log not found", "type": "transform", "transform": { "expression": "'Customer not found'" } }
    ]
  }
}
```

### `loop` — Iterate over an array

```json
{
  "id": "processOrders",
  "name": "Process each order",
  "type": "loop",
  "loop": {
    "over": "$.steps.listOrders.response.data",
    "as": "order",
    "indexAs": "i",
    "maxIterations": 1000,
    "maxConcurrency": 5,
    "steps": [
      {
        "id": "createInvoice",
        "name": "Create invoice for order",
        "type": "action",
        "action": {
          "platform": "quickbooks",
          "actionId": "...",
          "connectionKey": "$.input.qbConnectionKey",
          "data": { "amount": "$.loop.order.total" }
        }
      }
    ]
  }
}
```

- `maxConcurrency` (optional): When set > 1, loop iterations run in parallel batches of that size. Default is sequential (1).

### `parallel` — Run steps concurrently

```json
{
  "id": "parallelLookups",
  "name": "Look up in parallel",
  "type": "parallel",
  "parallel": {
    "maxConcurrency": 5,
    "steps": [
      { "id": "getStripe", "name": "Get Stripe data", "type": "action", "action": { "...": "..." } },
      { "id": "getHubspot", "name": "Get HubSpot data", "type": "action", "action": { "...": "..." } }
    ]
  }
}
```

### `file-read` — Read from filesystem

```json
{
  "id": "readConfig",
  "name": "Read config file",
  "type": "file-read",
  "fileRead": { "path": "./data/config.json", "parseJson": true }
}
```

### `file-write` — Write to filesystem

```json
{
  "id": "writeResults",
  "name": "Save results",
  "type": "file-write",
  "fileWrite": {
    "path": "./output/results.json",
    "content": "$.steps.transform.output",
    "append": false
  }
}
```

### `while` — Condition-driven loop (do-while)

Iterates until a condition becomes falsy. The first iteration always runs (do-while semantics), then the condition is checked before each subsequent iteration. Useful for pagination.

```json
{
  "id": "paginate",
  "name": "Paginate through all pages",
  "type": "while",
  "while": {
    "condition": "$.steps.paginate.output.lastResult.nextPageToken != null",
    "maxIterations": 50,
    "steps": [
      {
        "id": "fetchPage",
        "name": "Fetch next page",
        "type": "action",
        "action": {
          "platform": "gmail",
          "actionId": "GMAIL_LIST_MESSAGES_ACTION_ID",
          "connectionKey": "$.input.gmailKey",
          "queryParams": {
            "pageToken": "$.steps.paginate.output.lastResult.nextPageToken"
          }
        }
      }
    ]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `condition` | string | JS expression evaluated before each iteration (after iteration 0) |
| `maxIterations` | number | Safety cap, default: 100 |
| `steps` | FlowStep[] | Steps to execute each iteration |

The step output contains `lastResult` (last step's output from most recent iteration), `iteration` (count), and `results` (array of all iteration outputs). Reference via `$.steps.<id>.output.lastResult`.

### `flow` — Execute a sub-flow

Loads and executes another saved flow, enabling flow composition. Circular flows are detected and blocked.

```json
{
  "id": "processCustomer",
  "name": "Run customer enrichment flow",
  "type": "flow",
  "flow": {
    "key": "enrich-customer",
    "inputs": {
      "email": "$.steps.getCustomer.response.email",
      "connectionKey": "$.input.hubspotConnectionKey"
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `key` | string | Flow key or path (supports selectors) |
| `inputs` | object | Input values mapped to the sub-flow's declared inputs (supports selectors) |

The step output contains all sub-flow step results. The full sub-flow context is available via `$.steps.<id>.response`.

### `paginate` — Auto-collect paginated API results

Automatically pages through a paginated API, collecting all results into a single array.

```json
{
  "id": "allMessages",
  "name": "Fetch all Gmail messages",
  "type": "paginate",
  "paginate": {
    "action": {
      "platform": "gmail",
      "actionId": "GMAIL_LIST_MESSAGES_ACTION_ID",
      "connectionKey": "$.input.gmailKey",
      "queryParams": { "maxResults": 100 }
    },
    "pageTokenField": "nextPageToken",
    "resultsField": "messages",
    "inputTokenParam": "queryParams.pageToken",
    "maxPages": 10
  }
}
```

| Field | Type | Description |
|---|---|---|
| `action` | FlowActionConfig | The API action to call (same format as action steps) |
| `pageTokenField` | string | Dot-path in the API response to the next page token |
| `resultsField` | string | Dot-path in the API response to the results array |
| `inputTokenParam` | string | Dot-path in the action config where the page token is injected |
| `maxPages` | number | Maximum pages to fetch, default: 10 |

Output is the concatenated results array. Response includes `{ pages, totalResults, results }`.

### `bash` — Execute shell commands

Runs a shell command. **Requires `--allow-bash` flag** for security.

```json
{
  "id": "analyzeData",
  "name": "Analyze data with Claude",
  "type": "bash",
  "bash": {
    "command": "claude --print 'Analyze: {{$.steps.fetchData.response}}' --output-format json",
    "timeout": 180000,
    "parseJson": true
  }
}
```

| Field | Type | Description |
|---|---|---|
| `command` | string | Shell command to execute (supports selectors and interpolation) |
| `timeout` | number | Timeout in ms, default: 30000 |
| `parseJson` | boolean | Parse stdout as JSON, default: false |
| `cwd` | string | Working directory (supports selectors) |
| `env` | object | Additional environment variables |

Output is stdout (trimmed, or parsed as JSON if `parseJson` is true). Response includes `{ stdout, stderr, exitCode }`.

**Security:** Bash steps are blocked by default. Pass `--allow-bash` to `one flow execute` to enable them.

## 6. Error Handling

### `onError` strategies

```json
{
  "id": "riskyStep",
  "name": "Might fail",
  "type": "action",
  "onError": {
    "strategy": "retry",
    "retries": 3,
    "retryDelayMs": 1000
  },
  "action": { "...": "..." }
}
```

| Strategy | Behavior |
|---|---|
| `fail` | Stop the flow immediately (default) |
| `continue` | Mark step as failed, continue to next step |
| `retry` | Retry up to N times with delay |
| `fallback` | On failure, execute a different step |

### Conditional execution

Skip a step based on previous results:

```json
{
  "id": "sendEmail",
  "name": "Send email only if customer found",
  "type": "action",
  "if": "$.steps.findCustomer.response.data.length > 0",
  "action": { "...": "..." }
}
```

## 7. Updating Existing Workflows

To modify an existing workflow:

1. Read the workflow JSON file at `.one/flows/<key>.flow.json`
2. Understand its current structure
3. Use `one --agent actions knowledge <platform> <actionId>` for any new actions
4. Modify the JSON (add/remove/update steps, change data mappings, add inputs)
5. Write back the updated workflow file
6. Validate: `one --agent flow validate <key>`

## 8. Complete Examples

### Example 1: Simple 2-step — Search Stripe customer, send Gmail email

```json
{
  "key": "welcome-customer",
  "name": "Welcome New Customer",
  "description": "Look up a Stripe customer and send them a welcome email",
  "version": "1",
  "inputs": {
    "stripeConnectionKey": {
      "type": "string",
      "required": true,
      "description": "Stripe connection key",
      "connection": { "platform": "stripe" }
    },
    "gmailConnectionKey": {
      "type": "string",
      "required": true,
      "description": "Gmail connection key",
      "connection": { "platform": "gmail" }
    },
    "customerEmail": {
      "type": "string",
      "required": true,
      "description": "Customer email to look up"
    }
  },
  "steps": [
    {
      "id": "findCustomer",
      "name": "Search for customer in Stripe",
      "type": "action",
      "action": {
        "platform": "stripe",
        "actionId": "STRIPE_SEARCH_CUSTOMERS_ACTION_ID",
        "connectionKey": "$.input.stripeConnectionKey",
        "data": {
          "query": "email:'{{$.input.customerEmail}}'"
        }
      }
    },
    {
      "id": "sendWelcome",
      "name": "Send welcome email via Gmail",
      "type": "action",
      "if": "$.steps.findCustomer.response.data && $.steps.findCustomer.response.data.length > 0",
      "action": {
        "platform": "gmail",
        "actionId": "GMAIL_SEND_EMAIL_ACTION_ID",
        "connectionKey": "$.input.gmailConnectionKey",
        "data": {
          "to": "{{$.input.customerEmail}}",
          "subject": "Welcome, {{$.steps.findCustomer.response.data[0].name}}!",
          "body": "Thank you for being a customer. We're glad to have you!"
        }
      }
    }
  ]
}
```

### Example 2: Conditional — Check if HubSpot contact exists, create or update

```json
{
  "key": "sync-hubspot-contact",
  "name": "Sync Contact to HubSpot",
  "description": "Check if a contact exists in HubSpot, create if new or update if existing",
  "version": "1",
  "inputs": {
    "hubspotConnectionKey": {
      "type": "string",
      "required": true,
      "connection": { "platform": "hub-spot" }
    },
    "email": { "type": "string", "required": true },
    "firstName": { "type": "string", "required": true },
    "lastName": { "type": "string", "required": true }
  },
  "steps": [
    {
      "id": "searchContact",
      "name": "Search for existing contact",
      "type": "action",
      "action": {
        "platform": "hub-spot",
        "actionId": "HUBSPOT_SEARCH_CONTACTS_ACTION_ID",
        "connectionKey": "$.input.hubspotConnectionKey",
        "data": {
          "filterGroups": [{ "filters": [{ "propertyName": "email", "operator": "EQ", "value": "$.input.email" }] }]
        }
      }
    },
    {
      "id": "createOrUpdate",
      "name": "Create or update contact",
      "type": "condition",
      "condition": {
        "expression": "$.steps.searchContact.response.total > 0",
        "then": [
          {
            "id": "updateContact",
            "name": "Update existing contact",
            "type": "action",
            "action": {
              "platform": "hub-spot",
              "actionId": "HUBSPOT_UPDATE_CONTACT_ACTION_ID",
              "connectionKey": "$.input.hubspotConnectionKey",
              "pathVars": { "contactId": "$.steps.searchContact.response.results[0].id" },
              "data": {
                "properties": { "firstname": "$.input.firstName", "lastname": "$.input.lastName" }
              }
            }
          }
        ],
        "else": [
          {
            "id": "createContact",
            "name": "Create new contact",
            "type": "action",
            "action": {
              "platform": "hub-spot",
              "actionId": "HUBSPOT_CREATE_CONTACT_ACTION_ID",
              "connectionKey": "$.input.hubspotConnectionKey",
              "data": {
                "properties": { "email": "$.input.email", "firstname": "$.input.firstName", "lastname": "$.input.lastName" }
              }
            }
          }
        ]
      }
    }
  ]
}
```

### Example 3: Loop — Iterate over Shopify orders, create invoices

```json
{
  "key": "shopify-to-invoices",
  "name": "Shopify Orders to Invoices",
  "description": "Fetch recent Shopify orders and create an invoice for each",
  "version": "1",
  "inputs": {
    "shopifyConnectionKey": {
      "type": "string",
      "required": true,
      "connection": { "platform": "shopify" }
    },
    "qbConnectionKey": {
      "type": "string",
      "required": true,
      "connection": { "platform": "quick-books" }
    }
  },
  "steps": [
    {
      "id": "listOrders",
      "name": "List recent Shopify orders",
      "type": "action",
      "action": {
        "platform": "shopify",
        "actionId": "SHOPIFY_LIST_ORDERS_ACTION_ID",
        "connectionKey": "$.input.shopifyConnectionKey",
        "queryParams": { "status": "any", "limit": "50" }
      }
    },
    {
      "id": "createInvoices",
      "name": "Create invoice for each order",
      "type": "loop",
      "loop": {
        "over": "$.steps.listOrders.response.orders",
        "as": "order",
        "indexAs": "i",
        "steps": [
          {
            "id": "createInvoice",
            "name": "Create QuickBooks invoice",
            "type": "action",
            "onError": { "strategy": "continue" },
            "action": {
              "platform": "quick-books",
              "actionId": "QB_CREATE_INVOICE_ACTION_ID",
              "connectionKey": "$.input.qbConnectionKey",
              "data": {
                "Line": [
                  {
                    "Amount": "$.loop.order.total_price",
                    "Description": "Shopify Order #{{$.loop.order.order_number}}"
                  }
                ]
              }
            }
          }
        ]
      }
    },
    {
      "id": "summary",
      "name": "Generate summary",
      "type": "transform",
      "transform": {
        "expression": "({ totalOrders: $.steps.listOrders.response.orders.length, processed: $.steps.createInvoices.output.length })"
      }
    }
  ]
}
```

### Example 4: AI-Augmented — Fetch CRM data, analyze with Claude, email report

This example demonstrates the **file-write → bash → code** pattern. Instead of just piping raw data, it uses Claude to perform competitive analysis and delivers an actionable report.

```json
{
  "key": "competitor-analysis",
  "name": "AI Competitor Analysis",
  "description": "Fetch deals from HubSpot, analyze competitive landscape with Claude, email the report",
  "version": "1",
  "inputs": {
    "hubspotConnectionKey": {
      "type": "string",
      "required": true,
      "connection": { "platform": "hub-spot" }
    },
    "gmailConnectionKey": {
      "type": "string",
      "required": true,
      "connection": { "platform": "gmail" }
    },
    "reportEmail": {
      "type": "string",
      "required": true,
      "description": "Email address to send the analysis report to"
    }
  },
  "steps": [
    {
      "id": "fetchDeals",
      "name": "Fetch recent deals from HubSpot",
      "type": "action",
      "action": {
        "platform": "hub-spot",
        "actionId": "HUBSPOT_LIST_DEALS_ACTION_ID",
        "connectionKey": "$.input.hubspotConnectionKey",
        "queryParams": { "limit": "100" }
      }
    },
    {
      "id": "writeDeals",
      "name": "Write deals data for Claude analysis",
      "type": "file-write",
      "fileWrite": {
        "path": "/tmp/competitor-analysis-deals.json",
        "content": "$.steps.fetchDeals.response"
      }
    },
    {
      "id": "analyzeCompetitors",
      "name": "Claude analyzes competitive landscape",
      "type": "bash",
      "bash": {
        "command": "cat /tmp/competitor-analysis-deals.json | claude --print 'You are a competitive intelligence analyst. Analyze these CRM deals and return a JSON object with: {\"totalDeals\": number, \"competitorMentions\": [{\"competitor\": \"name\", \"count\": number, \"winRate\": number, \"commonObjections\": [\"...\"]}], \"summary\": \"2-3 paragraph executive summary\", \"recommendations\": [\"actionable items\"]}. Return ONLY valid JSON.' --output-format json",
        "timeout": 180000,
        "parseJson": true
      }
    },
    {
      "id": "formatReport",
      "name": "Format analysis into email body",
      "type": "code",
      "code": {
        "source": "const a = $.steps.analyzeCompetitors.output;\nconst competitors = a.competitorMentions.map(c => `- ${c.competitor}: ${c.count} mentions, ${c.winRate}% win rate. Objections: ${c.commonObjections.join(', ')}`).join('\\n');\nreturn {\n  subject: `Competitive Analysis — ${a.totalDeals} deals analyzed`,\n  body: `${a.summary}\\n\\nCompetitor Breakdown:\\n${competitors}\\n\\nRecommendations:\\n${a.recommendations.map((r, i) => `${i+1}. ${r}`).join('\\n')}`\n};"
      }
    },
    {
      "id": "sendReport",
      "name": "Email the analysis report",
      "type": "action",
      "action": {
        "platform": "gmail",
        "actionId": "GMAIL_SEND_EMAIL_ACTION_ID",
        "connectionKey": "$.input.gmailConnectionKey",
        "data": {
          "to": "{{$.input.reportEmail}}",
          "subject": "{{$.steps.formatReport.output.subject}}",
          "body": "{{$.steps.formatReport.output.body}}"
        }
      }
    }
  ]
}
```

Execute with:
```bash
one --agent flow execute competitor-analysis --allow-bash -i reportEmail=team@company.com
```

## 9. AI-Augmented Workflow Patterns

Use this pattern whenever raw API data needs analysis, summarization, scoring, classification, or natural-language generation. This is the difference between a shallow data pipe and a workflow that delivers real value.

### The file-write → bash → code pattern

**Step A: `file-write`** — Write raw data to a temp file. API responses are often too large to inline into a shell command.

```json
{
  "id": "writeData",
  "name": "Write raw data for analysis",
  "type": "file-write",
  "fileWrite": {
    "path": "/tmp/{{$.input.flowKey}}-data.json",
    "content": "$.steps.fetchData.response"
  }
}
```

**Step B: `bash`** — Call `claude --print` to analyze the data. This is where intelligence happens.

```json
{
  "id": "analyze",
  "name": "AI analysis",
  "type": "bash",
  "bash": {
    "command": "cat /tmp/{{$.input.flowKey}}-data.json | claude --print 'You are a [domain] analyst. Analyze this data and return JSON with: {\"summary\": \"...\", \"insights\": [...], \"score\": 0-100, \"recommendations\": [...]}. Return ONLY valid JSON, no markdown.' --output-format json",
    "timeout": 180000,
    "parseJson": true
  }
}
```

**Step C: `code`** — Parse and structure the AI output for downstream steps.

```json
{
  "id": "formatResult",
  "name": "Structure analysis for output",
  "type": "code",
  "code": {
    "source": "const analysis = $.steps.analyze.output;\nreturn {\n  report: `Summary: ${analysis.summary}\\n\\nInsights:\\n${analysis.insights.map((insight, i) => `${i+1}. ${insight}`).join('\\n')}`,\n  score: analysis.score\n};"
  }
}
```

### When to use this pattern

- **Use it** when the user expects analysis, not raw data (e.g., "analyze my competitors", "qualify these leads", "summarize these reviews")
- **Use it** when data from one API needs intelligent transformation before being sent to another (e.g., generating a personalized email based on CRM data)
- **Don't use it** for simple field mapping or filtering — use `transform` or `code` steps instead

### Prompt engineering tips for bash steps

- **Request JSON output** so downstream code steps can parse it — include `Return ONLY valid JSON, no markdown.` in the prompt and use `--output-format json`
- **Be specific about the analysis** — "Score each lead 0-100 based on company size, role seniority, and engagement recency" beats "analyze these leads"
- **Include domain context** — "You are a B2B sales analyst" produces better results than a generic prompt
- **Keep prompts focused** — one analysis task per bash step; chain multiple bash steps for multi-stage analysis

### Concurrency and timeout guidance

- **Always set `timeout` to at least `180000` (3 minutes)** for bash steps calling `claude --print`. The default 30s bash timeout will fail on nearly all AI analysis tasks. Claude typically needs 60-90s, and under resource contention this can double.
- **Run Claude-heavy flows sequentially, not in parallel.** Each `claude --print` spawns a separate process. Running multiple flows with bash+Claude steps concurrently causes resource contention and timeout failures — even when individual prompts are small. If orchestrating multiple AI workflows, execute them one at a time.
- **If a bash+Claude step times out**, the cause is almost always the timeout value or concurrent execution — not prompt size. Increase the timeout and ensure no other Claude-heavy flows are running before assuming the prompt needs to be reduced.

## 10. CLI Commands Reference

```bash
# Create a workflow
one --agent flow create <key> --definition '<json>'

# List all workflows
one --agent flow list

# Validate a workflow
one --agent flow validate <key>

# Execute a workflow
one --agent flow execute <key> -i connectionKey=value -i param=value

# Execute with dry run (validate only)
one --agent flow execute <key> --dry-run -i connectionKey=value

# Execute with mock mode (dry-run + mock API responses, runs transforms/code normally)
one --agent flow execute <key> --dry-run --mock -i connectionKey=value

# Execute with bash steps enabled
one --agent flow execute <key> --allow-bash -i connectionKey=value

# Execute with verbose output
one --agent flow execute <key> -v -i connectionKey=value

# List workflow runs
one --agent flow runs [flowKey]

# Resume a paused/failed run
one --agent flow resume <runId>
```

## Important Notes

- **Always use `--agent` flag** for structured JSON output
- **Always call `one actions knowledge`** before adding an action step to a workflow
- Platform names are **kebab-case** (e.g., `hub-spot`, not `HubSpot`)
- Connection keys are **inputs**, not hardcoded — makes workflows portable and shareable
- Use `$.input.*` for input values, `$.steps.*` for step results
- Action IDs in examples (like `STRIPE_SEARCH_CUSTOMERS_ACTION_ID`) are placeholders — always use `one actions search` to find the real IDs
- **Parallel step outputs** are accessible both by index (`$.steps.parallelStep.output[0]`) and by substep ID (`$.steps.substepId.response`)
- **Loop step outputs** include iteration details via `$.steps.myLoop.response.iterations[0].innerStepId.response`
- **Code steps** support `await require('crypto')`, `await require('buffer')`, `await require('url')`, `await require('path')` — `fs`, `http`, `child_process`, etc. are blocked
- **Bash steps** require `--allow-bash` flag for security
- **State is persisted** after every step completion — resume picks up where it left off
