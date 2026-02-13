# pica

CLI for managing Pica integrations. Connect to 200+ platforms, discover their APIs, and execute actions from the terminal.

## Install

```bash
npm install
npm run build
npm link
```

Requires Node.js 18+.

## Setup

```bash
pica init
```

This prompts for your Pica API key, saves it to `~/.pica/config.json`, and installs the MCP server into your AI agents (Claude Code, Claude Desktop, Cursor, Windsurf).

Get your API key at [app.picaos.com/settings/api-keys](https://app.picaos.com/settings/api-keys).

## Usage

### Connect a platform

```bash
pica add gmail
```

Opens a browser to complete OAuth. The CLI polls until the connection is live.

### List connections

```bash
pica list
```

```
  ● gmail      operational
    live::gmail::default::abc123
  ● slack      operational
    live::slack::default::def456
```

### Browse platforms

```bash
pica platforms
pica platforms -c "CRM"
```

### Search actions

Find available API actions on any connected platform:

```bash
pica search gmail "send email"
pica search slack "post message"
pica search stripe "list payments"
```

```
  POST    /gmail/v1/users/{{userId}}/messages/send
         Send Message
         conn_mod_def::ABC123::XYZ789
```

### Read API docs

```bash
pica actions knowledge <actionId>
pica actions k <actionId> --full    # no truncation
```

Shows method, path, path variables, parameter schemas, and request/response examples.

### Execute an action

```bash
pica exec <actionId> \
  -c live::gmail::default::abc123 \
  -d '{"to": "test@example.com", "subject": "Hello", "body": "Hi there"}' \
  -p userId=me
```

If you omit flags, the CLI prompts interactively:
- Auto-selects the connection if only one exists for the platform
- Prompts for each `{{path variable}}` not provided via `-p`
- Prompts for the request body on POST/PUT/PATCH if `-d` is missing

## Commands

| Command | Description |
|---------|-------------|
| `pica init` | Set up API key and install MCP |
| `pica add <platform>` | Connect a platform via OAuth |
| `pica list` | List connections with keys |
| `pica platforms` | Browse available platforms |
| `pica search <platform> [query]` | Search for actions |
| `pica actions knowledge <id>` | Get API docs for an action |
| `pica exec <id>` | Execute an action |

Every command supports `--json` for machine-readable output.

### Aliases

| Short | Full |
|-------|------|
| `pica ls` | `pica list` |
| `pica p` | `pica platforms` |
| `pica a search` | `pica actions search` |
| `pica a k` | `pica actions knowledge` |
| `pica a x` | `pica actions execute` |

## How it works

All API calls route through Pica's passthrough proxy (`api.picaos.com/v1/passthrough`), which injects auth credentials, handles rate limiting, and normalizes responses. Your connection keys tell Pica which credentials to use. You never touch raw OAuth tokens.

## Development

```bash
npm run dev        # watch mode
npm run build      # production build
npm run typecheck  # type check without emitting
```

## Project structure

```
src/
  index.ts              # Commander setup and command registration
  commands/
    init.ts             # pica init (API key + MCP setup)
    connection.ts       # pica add, pica list
    platforms.ts        # pica platforms
    actions.ts          # pica search, actions knowledge, exec
  lib/
    api.ts              # HTTP client for Pica API
    types.ts            # TypeScript interfaces
    actions.ts          # Action ID normalization, path variable helpers
    config.ts           # ~/.pica/config.json read/write
    agents.ts           # MCP config for Claude, Cursor, Windsurf
    platforms.ts        # Platform search and fuzzy matching
    browser.ts          # Open browser for OAuth and API key pages
```
