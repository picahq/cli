# Pica CLI

One CLI to connect AI agents to every API on the internet.

Pica gives your AI agent authenticated access to 200+ platforms — Gmail, Slack, Shopify, HubSpot, Stripe, Notion, and everything else — through a single interface. No API keys to juggle, no OAuth flows to build, no request formats to memorize. Connect a platform once, and your agent can search for actions, read the docs, and execute API calls in seconds.

## Install

```bash
npx @picahq/cli@latest init
```

Or install globally:

```bash
npm install -g @picahq/cli
pica init
```

`pica init` walks you through setup: enter your [API key](https://app.picaos.com/settings/api-keys), pick your AI agents, and you're done. The MCP server gets installed automatically.

Requires Node.js 18+.

## Quick start

```bash
# Connect a platform
pica add gmail

# See what you're connected to
pica list

# Search for actions you can take
pica actions search gmail "send email" -t execute

# Read the docs for an action
pica actions knowledge gmail <actionId>

# Execute it
pica actions execute gmail <actionId> <connectionKey> \
  -d '{"to": "jane@example.com", "subject": "Hello", "body": "Sent from my AI agent"}'
```

That's it. Five commands to go from zero to sending an email through Gmail's API — fully authenticated, correctly formatted, without touching a single OAuth token.

### Multi-step flows

Chain actions across platforms into reusable workflows:

```bash
# Create a flow that looks up a Stripe customer and sends a Gmail welcome email
pica flow create welcome-customer --definition '{
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
pica flow validate welcome-customer

# Run it — connection keys auto-resolve if you have one connection per platform
pica flow execute welcome-customer -i email=jane@example.com
```

Flows are stored as JSON at `.one/flows/<key>.flow.json` and support conditions, loops, parallel steps, transforms, and more. Run `pica guide flows` for the full reference.

## How it works

```
Your AI Agent
    ↓
  Pica CLI
    ↓
  Pica API (api.picaos.com/v1/passthrough)
    ↓
  Gmail / Slack / Shopify / HubSpot / Stripe / ...
```

Every API call routes through Pica's passthrough proxy. Pica injects the right credentials, handles rate limiting, and normalizes responses. You never see or manage raw OAuth tokens — your connection key is all you need.

## Commands

### `pica init`

Set up your API key and install the MCP server into your AI agents.

```bash
pica init
```

Supports Claude Code, Claude Desktop, Cursor, Windsurf, Codex, and Kiro. Installs globally by default, or per-project with `-p` so your team can share configs (each person uses their own API key).

If you've already set up, `pica init` shows your current status and lets you update your key, install to more agents, or reconfigure.

| Flag | What it does |
|------|-------------|
| `-y` | Skip confirmations |
| `-g` | Install globally (default) |
| `-p` | Install for current project only |

### `pica add <platform>`

Connect a new platform via OAuth.

```bash
pica add shopify
pica add hub-spot
pica add gmail
```

Opens your browser, you authorize, done. The CLI polls until the connection is live. Platform names are kebab-case — run `pica platforms` to see them all.

### `pica list`

List your active connections with their status and connection keys.

```bash
pica list
```

```
  ● gmail       operational   live::gmail::default::abc123
  ● slack       operational   live::slack::default::def456
  ● shopify     operational   live::shopify::default::ghi789
```

You need the connection key (rightmost column) when executing actions.

### `pica platforms`

Browse all 200+ available platforms.

```bash
pica platforms              # all platforms
pica platforms -c "CRM"     # filter by category
pica platforms --json       # machine-readable output
```

### `pica actions search <platform> <query>`

Search for API actions on a connected platform using natural language.

```bash
pica actions search shopify "list products"
pica actions search hub-spot "create contact" -t execute
pica actions search gmail "send email"
```

Returns the top 5 matching actions with their action IDs, HTTP methods, and paths. Use `-t execute` when you intend to run the action, or `-t knowledge` (default) when you want to learn about it or write code against it.

### `pica actions knowledge <platform> <actionId>`

Get the full documentation for an action — parameters, validation rules, request/response structure, examples, and the exact API request format.

```bash
pica actions knowledge shopify 67890abcdef
```

Always read the knowledge before executing. It tells you exactly what parameters are required, what format they need, and any platform-specific quirks.

### `pica actions execute <platform> <actionId> <connectionKey>`

Execute an API action on a connected platform.

```bash
# Simple GET
pica actions execute shopify <actionId> <connectionKey>

# POST with data
pica actions execute hub-spot <actionId> <connectionKey> \
  -d '{"properties": {"email": "jane@example.com", "firstname": "Jane"}}'

# With path variables
pica actions execute shopify <actionId> <connectionKey> \
  --path-vars '{"order_id": "12345"}'

# With query params
pica actions execute stripe <actionId> <connectionKey> \
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

### `pica guide [topic]`

Get the full CLI usage guide, designed for AI agents that only have the binary (no MCP, no IDE skills).

```bash
pica guide                 # full guide (all topics)
pica guide overview        # setup, --agent flag, discovery workflow
pica guide actions         # search, knowledge, execute workflow
pica guide flows           # multi-step API workflows

pica --agent guide         # full guide as structured JSON
pica --agent guide flows   # single topic as JSON
```

Topics: `overview`, `actions`, `flows`, `all` (default).

In agent mode (`--agent`), the JSON response includes the guide content and an `availableTopics` array so agents can discover what sections exist.

### `pica flow create [key]`

Create a flow from a JSON definition. Flows are saved to `.one/flows/<key>.flow.json`.

```bash
# From a --definition flag
pica flow create welcome-customer --definition '{"key":"welcome-customer","name":"Welcome","version":"1","inputs":{},"steps":[]}'

# From stdin
cat flow.json | pica flow create

# Custom output path
pica flow create my-flow --definition '...' -o ./custom/path.json
```

| Option | What it does |
|--------|-------------|
| `--definition <json>` | Flow definition as a JSON string |
| `-o, --output <path>` | Custom output path (default: `.one/flows/<key>.flow.json`) |

### `pica flow execute <key>`

Execute a flow by key or file path. Pass inputs with repeatable `-i` flags.

```bash
# Execute with inputs
pica flow execute welcome-customer \
  -i customerEmail=jane@example.com

# Dry run — validate and show plan without executing
pica flow execute welcome-customer --dry-run -i customerEmail=jane@example.com

# Verbose — show each step as it runs
pica flow execute welcome-customer -v -i customerEmail=jane@example.com
```

Connection inputs with a `connection` field in the flow definition are auto-resolved when the user has exactly one connection for that platform.

Press Ctrl+C during execution to pause — the run can be resumed later with `pica flow resume <runId>`.

| Option | What it does |
|--------|-------------|
| `-i, --input <name=value>` | Input parameter (repeatable) |
| `--dry-run` | Validate and show execution plan without running |
| `-v, --verbose` | Show full request/response for each step |

### `pica flow list`

List all flows saved in `.one/flows/`.

```bash
pica flow list
```

### `pica flow validate <key>`

Validate a flow JSON file against the schema.

```bash
pica flow validate welcome-customer
```

### `pica flow resume <runId>`

Resume a paused or failed flow run from where it left off.

```bash
pica flow resume abc123
```

### `pica flow runs [flowKey]`

List flow runs, optionally filtered by flow key.

```bash
pica flow runs                    # all runs
pica flow runs welcome-customer   # runs for a specific flow
```

### `pica config`

Configure access control for the MCP server. Optional — full access is the default.

```bash
pica config
```

| Setting | Options | Default |
|---------|---------|---------|
| Permission level | `admin` / `write` / `read` | `admin` |
| Connection scope | All or specific connections | All |
| Action scope | All or specific action IDs | All |
| Knowledge-only mode | Enable/disable execution | Off |

Settings propagate automatically to all installed agent configs.

## The workflow

The power of Pica is in the workflow. Every interaction follows the same pattern:

```
pica list                    → What am I connected to?
pica actions search          → What can I do?
pica actions knowledge       → How do I do it?
pica actions execute         → Do it.
```

This is the same workflow whether you're sending emails, creating CRM contacts, processing payments, managing inventory, or posting to Slack. One pattern, any platform.

For multi-step workflows that chain actions across platforms, use **flows**:

```
pica actions knowledge       → Learn each action's schema
pica flow create             → Define the workflow as JSON
pica flow validate           → Check it
pica flow execute            → Run it
```

Flows support conditions, loops, parallel execution, transforms, code steps, and file I/O. Run `pica guide flows` for the full schema reference and examples.

## For AI agents

If you're an AI agent with only the `pica` binary (no MCP server or IDE skills), start with `pica --agent guide` to get the full usage guide as structured JSON. This teaches you the complete workflow, JSON schemas, selector syntax, and more — everything you need to bootstrap yourself.

If you're an AI agent using the Pica MCP server, the tools map directly:

| MCP Tool | CLI Command |
|----------|------------|
| `list_pica_integrations` | `pica list` + `pica platforms` |
| `search_pica_platform_actions` | `pica actions search` |
| `get_pica_action_knowledge` | `pica actions knowledge` |
| `execute_pica_action` | `pica actions execute` |

The workflow is the same: list → search → knowledge → execute. Never skip the knowledge step — it contains required parameter info and platform-specific details that are critical for building correct requests.

## MCP server installation

`pica init` handles this automatically. Here's where configs go:

| Agent | Global | Project |
|-------|--------|---------|
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Claude Desktop | Platform-specific app support dir | — |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | — |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` |
| Kiro | `~/.kiro/settings/mcp.json` | `.kiro/settings/mcp.json` |

Project configs can be committed to your repo. Each team member runs `pica init` with their own API key.

## Development

```bash
npm run dev        # watch mode
npm run build      # production build
npm run typecheck  # type check
```
