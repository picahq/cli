# Project vs. global config

The One CLI can be configured at two scopes:

- **Global** — `~/.one/config.json`. Applies everywhere the user runs `one`.
- **Project** — `~/.one/projects/<slug>/config.json`, where `<slug>` is the project root path with slashes replaced by dashes (e.g. `/Users/jane/acme` → `-Users-jane-acme`). Only applies when running `one` from inside that project folder.

**Resolution order:** env vars → `.onerc` in cwd → project config → global config. Project config wins when present; otherwise the CLI falls back to the global config.

## When to suggest project scope

Suggest project scope when the user wants any of the following for a specific folder only, without changing their default setup:

- A different One API key (e.g. sandbox workspace for a client project)
- A different set of connections / connection keys
- Different access control (permissions, scoped connections, knowledge-only mode)

## How to set it up

Do **not** hand-edit `.onerc` or config files. Walk the user through the interactive init:

```bash
cd /path/to/the/project
one init
```

When `init` asks "Where should this setup live?", pick **"This project only"**. Init will write the config to `~/.one/projects/<slug>/config.json` and everything else (skill install, MCP) stays untouched.

To see which config is currently active and the full fallback chain:

```bash
one --agent config path
```

To switch an existing project back to using the global config, delete its project config file — the CLI will automatically fall back to global on the next run.
