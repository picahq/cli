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

This walks you through:
1. Entering your Pica API key (validates it)
2. Choosing which AI agents to install the MCP server into
3. Choosing global vs project-level installation

Get your API key at [app.picaos.com/settings/api-keys](https://app.picaos.com/settings/api-keys).

Config is saved to `~/.pica/config.json`.

### Re-running init

If you already have a config, `pica init` shows your current setup instead of starting over:

```
 Pica

  Current Setup
  ──────────────────────────────────────────
  API Key:  sk_test_...9j-Y
  Config:   ~/.pica/config.json

  Agent           Global  Project
  ──────────────  ──────  ───────
  Claude Code     ● yes   ● yes
  Claude Desktop  ● yes   -
  Cursor          ○ no    ○ no
  Windsurf        -       -
  Codex           ● yes   ○ no

  - = not detected on this machine
```

Then it offers targeted actions based on what's missing:

- **Update API key** -- validates the new key, then re-installs to every agent that currently has the MCP (preserving global/project scopes)
- **Install MCP to more agents** -- only shows detected agents missing the MCP
- **Install MCP for this project** -- creates `.mcp.json` / `.cursor/mcp.json` / `.codex/config.toml` in cwd for agents that support project scope
- **Start fresh** -- full setup flow from scratch

Options that don't apply are hidden. If every detected agent already has the MCP globally, "Install MCP to more agents" won't appear.

### Init flags

| Flag | Effect |
|------|--------|
| `-y, --yes` | Skip confirmations |
| `-g, --global` | Install MCP globally (default, available in all projects) |
| `-p, --project` | Install MCP for this project only (creates config files in cwd) |

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

## Commands

| Command | Description |
|---------|-------------|
| `pica init` | Set up API key and install MCP |
| `pica add <platform>` | Connect a platform via OAuth |
| `pica list` | List connections with keys |
| `pica platforms` | Browse available platforms |

Every command supports `--json` for machine-readable output.

### Aliases

| Short | Full |
|-------|------|
| `pica ls` | `pica list` |
| `pica p` | `pica platforms` |

## How it works

All API calls route through Pica's passthrough proxy (`api.picaos.com/v1/passthrough`), which injects auth credentials, handles rate limiting, and normalizes responses. Your connection keys tell Pica which credentials to use. You never touch raw OAuth tokens.

## MCP installation

`pica init` writes MCP server configs into the following locations:

| Agent | Global config | Project config |
|-------|--------------|----------------|
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | n/a |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | n/a |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` |

Global installs make the MCP available everywhere. Project installs create config files in your current directory that can be committed and shared with your team (each team member needs their own API key).

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
    init.ts             # pica init (setup, status display, targeted actions)
    connection.ts       # pica add, pica list
    platforms.ts        # pica platforms
  lib/
    api.ts              # HTTP client for Pica API
    types.ts            # TypeScript interfaces
    config.ts           # ~/.pica/config.json read/write
    agents.ts           # Agent detection, MCP config, status reporting
    platforms.ts        # Platform search and fuzzy matching
    browser.ts          # Open browser for OAuth and API key pages
    table.ts            # Formatted table output
```
