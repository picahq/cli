---
name: pica-flow
description: |
  Build and execute multi-step API workflows (flows) that chain actions across platforms — like n8n/Zapier but file-based. Flows are JSON files stored at `.one/flows/<key>.flow.json`.

  TRIGGER when the user wants to:
  - Create a multi-step workflow or automation (e.g., "create a flow that looks up a customer in Stripe and sends them an email")
  - Chain multiple API actions together across platforms
  - Build a pipeline or sequence of API calls
  - Execute, validate, or manage existing flows
  - Automate a process involving multiple connected platforms
  - Schedule or orchestrate a series of actions

  DO NOT TRIGGER for:
  - Single action execution (use pica-actions skill instead)
  - Setting up Pica or installing MCP (that's `pica init`)
  - Adding new connections (that's `pica connection add`)
---

# Pica Flow — Multi-Step API Workflows

You have access to the Pica CLI's flow engine, which lets you create and execute multi-step API workflows as JSON files. Flows chain actions across platforms — e.g., look up a Stripe customer, then send them a welcome email via Gmail.

## 1. Overview

- Flows are JSON files stored at `.one/flows/<key>.flow.json`
- All dynamic values (including connection keys) are declared as **inputs**
- Each flow has a unique **key** used to reference and execute it
- Executed via `pica --agent flow execute <key> -i name=value`

## 2. Building a Flow — Step-by-Step Process

**You MUST follow this process to build a correct flow:**

### Step 1: Discover connections

```bash
pica --agent connection list
```

Find out which platforms are connected and get their connection keys.

### Step 2: For EACH API action needed, get the knowledge

```bash
# Find the action ID
pica --agent actions search <platform> "<query>" -t execute

# Read the full docs — REQUIRED before adding to a flow
pica --agent actions knowledge <platform> <actionId>
```

**CRITICAL:** You MUST call `pica actions knowledge` for every action you include in the flow. The knowledge output tells you the exact request body structure, required fields, path variables, and query parameters. Without this, your flow JSON will have incorrect data shapes.

### Step 3: Construct the flow JSON

Using the knowledge gathered, build the flow JSON with:
- All inputs declared (connection keys + user parameters)
- Each step with the correct actionId, platform, and data structure (from knowledge)
- Data wired between steps using `$.input.*` and `$.steps.*` selectors

### Step 4: Write the flow file

```bash
pica --agent flow create <key> --definition '<json>'
```

Or write directly to `.one/flows/<key>.flow.json`.

### Step 5: Validate

```bash
pica --agent flow validate <key>
```

### Step 6: Execute

```bash
pica --agent flow execute <key> -i connectionKey=xxx -i param=value
```

## 3. Flow JSON Schema Reference

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
      "description": "Stripe connection key from pica connection list",
      "connection": { "platform": "stripe" }
    },
    "gmailConnectionKey": {
      "type": "string",
      "required": true,
      "description": "Gmail connection key from pica connection list",
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

**Connection inputs** have a `connection` field. If the user has exactly one connection for that platform, the engine auto-resolves it.

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

### `action` — Execute a Pica API action

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

## 7. Updating Existing Flows

To modify an existing flow:

1. Read the flow JSON file at `.one/flows/<key>.flow.json`
2. Understand its current structure
3. Use `pica --agent actions knowledge <platform> <actionId>` for any new actions
4. Modify the JSON (add/remove/update steps, change data mappings, add inputs)
5. Write back the updated flow file
6. Validate: `pica --agent flow validate <key>`

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

## CLI Commands Reference

```bash
# Create a flow
pica --agent flow create <key> --definition '<json>'

# List all flows
pica --agent flow list

# Validate a flow
pica --agent flow validate <key>

# Execute a flow
pica --agent flow execute <key> -i connectionKey=value -i param=value

# Execute with dry run (validate only)
pica --agent flow execute <key> --dry-run -i connectionKey=value

# Execute with verbose output
pica --agent flow execute <key> -v -i connectionKey=value

# List flow runs
pica --agent flow runs [flowKey]

# Resume a paused/failed run
pica --agent flow resume <runId>
```

## Important Notes

- **Always use `--agent` flag** for structured JSON output
- **Always call `pica actions knowledge`** before adding an action step to a flow
- Platform names are **kebab-case** (e.g., `hub-spot`, not `HubSpot`)
- Connection keys are **inputs**, not hardcoded — makes flows portable and shareable
- Use `$.input.*` for input values, `$.steps.*` for step results
- Action IDs in examples (like `STRIPE_SEARCH_CUSTOMERS_ACTION_ID`) are placeholders — always use `pica actions search` to find the real IDs
