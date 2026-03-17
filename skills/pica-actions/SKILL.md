---
name: pica-actions
description: |
  Use the Pica CLI to interact with 200+ third-party platforms (Gmail, Slack, HubSpot, Shopify, etc.) through their APIs. This skill handles the full workflow: listing connections, searching for available actions, reading action documentation, and executing API calls against connected platforms.

  TRIGGER when the user wants to:
  - List their connected platforms or connections (e.g., "what platforms am I connected to", "show my connections")
  - Search for what they can do on a platform (e.g., "what can I do with Gmail", "find Shopify actions for creating products", "search HubSpot for contacts")
  - Understand how an API action works before using it (e.g., "how do I send an email with Gmail", "show me the docs for this action")
  - Execute an action on a connected platform (e.g., "send an email via Gmail", "create a contact in HubSpot", "list my Shopify orders", "fetch my calendar events")
  - Anything involving third-party platform integrations, API calls to external services through Pica, or using connected apps

  DO NOT TRIGGER for:
  - Setting up Pica or installing MCP (that's `pica init`)
  - Configuring access control (that's `pica config`)
  - Adding new connections (that's `pica connection add`)
---

# Pica Actions CLI Workflow

You have access to the Pica CLI which lets you interact with 200+ third-party platforms through their APIs. The CLI handles authentication, request building, and execution through Pica's passthrough proxy.

## The Workflow

Always follow this sequence — each step builds on the previous one:

1. **List connections** to see what platforms the user has connected
2. **Search actions** to find the right API action for what the user wants to do
3. **Get knowledge** to understand the action's parameters, requirements, and structure
4. **Execute** the action with the correct parameters

Never skip the knowledge step before executing — it contains critical information about required parameters, validation rules, and request structure that you need to build a correct request.

## Commands

### 1. List Connections

```bash
pica --agent connection list
```

Returns JSON with all connected platforms, their status, and connection keys. You need the **connection key** for executing actions, and the **platform name** (kebab-case) for searching actions.

Output format:
```json
{"connections": [{"platform": "gmail", "state": "active", "key": "conn_abc123"}, ...]}
```

### 2. Search Actions

```bash
pica --agent actions search <platform> <query>
```

Search for actions on a specific platform using natural language. Returns JSON with up to 5 matching actions including their action IDs, HTTP methods, and paths.

- `<platform>` — Platform name in kebab-case exactly as shown in the connections list (e.g., `gmail`, `shopify`, `hub-spot`)
- `<query>` — Natural language description of what you want to do (e.g., `"send email"`, `"list contacts"`, `"create order"`)

Options:
- `-t, --type <execute|knowledge>` — Use `execute` when the user wants to perform an action, `knowledge` when they want documentation or want to write code. Defaults to `knowledge`.

Example:
```bash
pica --agent actions search gmail "send email" -t execute
```

Output format:
```json
{"actions": [{"_id": "abc123", "title": "Send Email", "tags": [...], "method": "POST", "path": "/messages/send"}, ...]}
```

### 3. Get Action Knowledge

```bash
pica --agent actions knowledge <platform> <actionId>
```

Get comprehensive documentation for an action including parameters, requirements, validation rules, request/response structure, and examples. Returns JSON with the full API knowledge and HTTP method.

Always call this before executing — it tells you exactly what parameters are required and how to structure the request.

Example:
```bash
pica --agent actions knowledge gmail 67890abcdef
```

Output format:
```json
{"knowledge": "...full API documentation and guidance...", "method": "POST"}
```

### 4. Execute Action

```bash
pica --agent actions execute <platform> <actionId> <connectionKey> [options]
```

Execute an action on a connected platform. Returns JSON with the request details and response data. You must have retrieved the knowledge for this action first.

- `<platform>` — Platform name in kebab-case
- `<actionId>` — Action ID from the search results
- `<connectionKey>` — Connection key from `pica connection list`

Options:
- `-d, --data <json>` — Request body as JSON string (for POST, PUT, PATCH)
- `--path-vars <json>` — Path variables as JSON (for URLs with `{id}` placeholders)
- `--query-params <json>` — Query parameters as JSON
- `--headers <json>` — Additional headers as JSON
- `--form-data` — Send as multipart/form-data instead of JSON
- `--form-url-encoded` — Send as application/x-www-form-urlencoded

Examples:
```bash
# Simple GET request
pica --agent actions execute shopify <actionId> <connectionKey>

# POST with data
pica --agent actions execute hub-spot <actionId> <connectionKey> \
  -d '{"properties": {"email": "jane@example.com", "firstname": "Jane"}}'

# With path variables and query params
pica --agent actions execute shopify <actionId> <connectionKey> \
  --path-vars '{"order_id": "12345"}' \
  --query-params '{"limit": "10"}'
```

Output format:
```json
{"request": {"method": "POST", "url": "https://..."}, "response": {...}}
```

## Error Handling

All errors return JSON in agent mode:
```json
{"error": "Error message here"}
```

Parse the output as JSON. If the `error` key is present, the command failed — report the error message to the user.

## Important Notes

- **Always use `--agent` flag** — it produces structured JSON output without spinners, colors, or interactive prompts
- Platform names are always **kebab-case** (e.g., `hub-spot` not `HubSpot`, `ship-station` not `ShipStation`)
- Always use the **exact action ID** from search results — don't guess or construct them
- Always read the knowledge output carefully — it tells you which parameters are required vs optional, what format they need to be in, and any caveats specific to that API
- JSON values passed to `-d`, `--path-vars`, `--query-params`, and `--headers` must be valid JSON strings (use single quotes around the JSON to avoid shell escaping issues)
- If search returns no results, try broader queries (e.g., `"list"` instead of `"list active premium customers"`)
- The execute command respects access control settings configured via `pica config` — if execution is blocked, the user may need to adjust their permissions
