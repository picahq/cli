# One CLI

One CLI to connect AI agents to every API on the internet.

One gives your AI agent authenticated access to 200+ platforms — Gmail, Slack, Shopify, HubSpot, Stripe, Notion, and everything else — through a single interface. No API keys to juggle, no OAuth flows to build, no request formats to memorize. Connect a platform once, and your agent can search for actions, read the docs, and execute API calls in seconds.

## Install

```bash
npx @picahq/cli@latest init
```

Or install globally:

```bash
npm install -g @picahq/cli
one init
```

`one init` walks you through setup: enter your [API key](https://app.withone.ai/settings/api-keys), pick your AI agents, and you're done. The MCP server gets installed automatically.

Requires Node.js 18+.

## Quick start

```bash
# Connect a platform
one add gmail

# See what you're connected to
one list

# Search for actions you can take
one actions search gmail "send email" -t execute

# Read the docs for an action
one actions knowledge gmail <actionId>

# Execute it
one actions execute gmail <actionId> <connectionKey> \
  -d '{"to": "jane@example.com", "subject": "Hello", "body": "Sent from my AI agent"}'
```

That's it. Five commands to go from zero to sending an email through Gmail's API — fully authenticated, correctly formatted, without touching a single OAuth token.

### Multi-step flows

Chain actions across platforms into reusable workflows:

```bash
# Create a flow that looks up a Stripe customer and sends a Gmail welcome email
one flow create welcome-customer --definition '{
  "key": "welcome-customer",
  "name": "Welcome New Customer",
  "version": "1",
  "inputs": {
    "stripeKey": { "type": "string", "required": true, "connection": { "platform": "stripe" } },
    "gmailKey": { "type": "string", "required": true, "connection": { "platform": "gmail" } },
    "email": { "type": "string", "required": true }
  },
  "steps": [
    { "id": "find", "name": "Find customer", "type": "action",
      "action": { "platform": "stripe", "actionId": "<actionId>", "connectionKey": "$.input.stripeKey",
        "data": { "query": "email:'\''{{$.input.email}}'\''" } } },
    { "id": "send", "name": "Send email", "type": "action",
      "if": "$.steps.find.response.data.length > 0",
      "action": { "platform": "gmail", "actionId": "<actionId>", "connectionKey": "$.input.gmailKey",
        "data": { "to": "{{$.input.email}}", "subject": "Welcome!", "body": "Thanks for joining." } } }
  ]
}'

# Validate it
one flow validate welcome-customer

# Run it — connection keys auto-resolve if you have one connection per platform
one flow execute welcome-customer -i email=jane@example.com
```

Flows are stored as JSON at `.one/flows/<key>.flow.json` and support conditions, loops, parallel steps, transforms, and more. Run `one guide flows` for the full reference.

## How it works

```
Your AI Agent
    ↓
  One CLI
    ↓
  One API (api.withone.ai/v1/passthrough)
    ↓
  Gmail / Slack / Shopify / HubSpot / Stripe / ...
```

Every API call routes through One's passthrough proxy. One injects the right credentials, handles rate limiting, and normalizes responses. You never see or manage raw OAuth tokens — your connection key is all you need.

## Commands

### `one init`

Set up your API key and install the MCP server into your AI agents.

```bash
one init
```

Supports Claude Code, Claude Desktop, Cursor, Windsurf, Codex, and Kiro. Installs globally by default, or per-project with `-p` so your team can share configs (each person uses their own API key).

If you've already set up, `one init` shows your current status and lets you update your key, install to more agents, or reconfigure.

| Flag | What it does |
|------|-------------|
| `-y` | Skip confirmations |
| `-g` | Install globally (default) |
| `-p` | Install for current project only |

### `one add <platform>`

Connect a new platform via OAuth.

```bash
one add shopify
one add hub-spot
one add gmail
```

Opens your browser, you authorize, done. The CLI polls until the connection is live. Platform names are kebab-case — run `one platforms` to see them all.

### `one list`

List your active connections with their status and connection keys.

```bash
one list
```

```
  ● gmail       operational   live::gmail::default::abc123
  ● slack       operational   live::slack::default::def456
  ● shopify     operational   live::shopify::default::ghi789
```

You need the connection key (rightmost column) when executing actions.

### `one platforms`

Browse all 200+ available platforms.

```bash
one platforms              # all platforms
one platforms -c "CRM"     # filter by category
one platforms --json       # machine-readable output
```

### `one actions search <platform> <query>`

Search for API actions on a connected platform using natural language.

```bash
one actions search shopify "list products"
one actions search hub-spot "create contact" -t execute
one actions search gmail "send email"
```

Returns the top 5 matching actions with their action IDs, HTTP methods, and paths. Use `-t execute` when you intend to run the action, or `-t knowledge` (default) when you want to learn about it or write code against it.

### `one actions knowledge <platform> <actionId>`

Get the full documentation for an action — parameters, validation rules, request/response structure, examples, and the exact API request format.

```bash
one actions knowledge shopify 67890abcdef
```

Always read the knowledge before executing. It tells you exactly what parameters are required, what format they need, and any platform-specific quirks.

### `one actions execute <platform> <actionId> <connectionKey>`

Execute an API action on a connected platform.

```bash
# Simple GET
one actions execute shopify <actionId> <connectionKey>

# POST with data
one actions execute hub-spot <actionId> <connectionKey> \
  -d '{"properties": {"email": "jane@example.com", "firstname": "Jane"}}'

# With path variables
one actions execute shopify <actionId> <connectionKey> \
  --path-vars '{"order_id": "12345"}'

# With query params
one actions execute stripe <actionId> <connectionKey> \
  --query-params '{"limit": "10"}'
```

| Option | What it does |
|--------|-------------|
| `-d, --data <json>` | Request body (POST, PUT, PATCH) |
| `--path-vars <json>` | Replace `{variables}` in the URL path |
| `--query-params <json>` | Query string parameters |
| `--headers <json>` | Additional request headers |
| `--form-data` | Send as multipart/form-data |
| `--form-url-encoded` | Send as application/x-www-form-urlencoded |

### `one guide [topic]`

Get the full CLI usage guide, designed for AI agents that only have the binary (no MCP, no IDE skills).

```bash
one guide                 # full guide (all topics)
one guide overview        # setup, --agent flag, discovery workflow
one guide actions         # search, knowledge, execute workflow
one guide flows           # multi-step API workflows

one --agent guide         # full guide as structured JSON
one --agent guide flows   # single topic as JSON
```

Topics: `overview`, `actions`, `flows`, `all` (default).

In agent mode (`--agent`), the JSON response includes the guide content and an `availableTopics` array so agents can discover what sections exist.

### `one flow create [key]`

Create a flow from a JSON definition. Flows are saved to `.one/flows/<key>.flow.json`.

```bash
# From a --definition flag
one flow create welcome-customer --definition '{"key":"welcome-customer","name":"Welcome","version":"1","inputs":{},"steps":[]}'

# From stdin
cat flow.json | one flow create

# Custom output path
one flow create my-flow --definition '...' -o ./custom/path.json
```

| Option | What it does |
|--------|-------------|
| `--definition <json>` | Flow definition as a JSON string |
| `-o, --output <path>` | Custom output path (default: `.one/flows/<key>.flow.json`) |

### `one flow execute <key>`

Execute a flow by key or file path. Pass inputs with repeatable `-i` flags.

```bash
# Execute with inputs
one flow execute welcome-customer \
  -i customerEmail=jane@example.com

# Dry run — validate and show plan without executing
one flow execute welcome-customer --dry-run -i customerEmail=jane@example.com

# Verbose — show each step as it runs
one flow execute welcome-customer -v -i customerEmail=jane@example.com
```

Connection inputs with a `connection` field in the flow definition are auto-resolved when the user has exactly one connection for that platform.

Press Ctrl+C during execution to pause — the run can be resumed later with `one flow resume <runId>`.

| Option | What it does |
|--------|-------------|
| `-i, --input <name=value>` | Input parameter (repeatable) |
| `--dry-run` | Validate and show execution plan without running |
| `-v, --verbose` | Show full request/response for each step |

### `one flow list`

List all flows saved in `.one/flows/`.

```bash
one flow list
```

### `one flow validate <key>`

Validate a flow JSON file against the schema.

```bash
one flow validate welcome-customer
```

### `one flow resume <runId>`

Resume a paused or failed flow run from where it left off.

```bash
one flow resume abc123
```

### `one flow runs [flowKey]`

List flow runs, optionally filtered by flow key.

```bash
one flow runs                    # all runs
one flow runs welcome-customer   # runs for a specific flow
```

### `one config`

Configure access control for the MCP server. Optional — full access is the default.

```bash
one config
```

| Setting | Options | Default |
|---------|---------|---------|
| Permission level | `admin` / `write` / `read` | `admin` |
| Connection scope | All or specific connections | All |
| Action scope | All or specific action IDs | All |
| Knowledge-only mode | Enable/disable execution | Off |

Settings propagate automatically to all installed agent configs.

## The workflow

The power of One is in the workflow. Every interaction follows the same pattern:

```
one list                    → What am I connected to?
one actions search          → What can I do?
one actions knowledge       → How do I do it?
one actions execute         → Do it.
```

This is the same workflow whether you're sending emails, creating CRM contacts, processing payments, managing inventory, or posting to Slack. One pattern, any platform.

For multi-step workflows that chain actions across platforms, use **flows**:

```
one actions knowledge       → Learn each action's schema
one flow create             → Define the workflow as JSON
one flow validate           → Check it
one flow execute            → Run it
```

Flows support conditions, loops, parallel execution, transforms, code steps, and file I/O. Run `one guide flows` for the full schema reference and examples.

## For AI agents

If you're an AI agent with only the `one` binary (no MCP server or IDE skills), start with `one --agent guide` to get the full usage guide as structured JSON. This teaches you the complete workflow, JSON schemas, selector syntax, and more — everything you need to bootstrap yourself.

If you're an AI agent using the One MCP server, the tools map directly:

| MCP Tool | CLI Command |
|----------|------------|
| `list_one_integrations` | `one list` + `one platforms` |
| `search_one_platform_actions` | `one actions search` |
| `get_one_action_knowledge` | `one actions knowledge` |
| `execute_one_action` | `one actions execute` |

The workflow is the same: list → search → knowledge → execute. Never skip the knowledge step — it contains required parameter info and platform-specific details that are critical for building correct requests.

## MCP server installation

`one init` handles this automatically. Here's where configs go:

| Agent | Global | Project |
|-------|--------|---------|
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Claude Desktop | Platform-specific app support dir | — |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | — |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` |
| Kiro | `~/.kiro/settings/mcp.json` | `.kiro/settings/mcp.json` |

Project configs can be committed to your repo. Each team member runs `one init` with their own API key.

## Development

```bash
npm run dev        # watch mode
npm run build      # production build
npm run typecheck  # type check
```
