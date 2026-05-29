# Project vs. global config

The One CLI can be configured at two scopes:

- **Global** — `~/.one/config.json`. Applies everywhere the user runs `one`.
- **Project** — `~/.one/projects/<slug>/config.json`, where `<slug>` is the project root path with path separators (and any character Windows forbids in a path component) replaced by dashes (e.g. `/Users/jane/acme` → `-Users-jane-acme`; on Windows, `C:\Users\jane\acme` → `C--Users-jane-acme`). Only applies when running `one` from inside that project folder.

**Detecting the project root.** The CLI walks up from cwd looking for `.one`, `.git`, or `package.json` and treats the nearest hit as the project root — `.one` is checked first so a monorepo subproject can opt into being its own root with `mkdir .one`. Without a `.one` opt-in, every cwd under a parent `.git`/`package.json` shares one project config keyed by that parent.

**Resolution order:** env vars → `.onerc` in cwd → project config → global config. The project lookup walks from cwd up — the nearest ancestor that has a config under `~/.one/projects/<slug>/config.json` wins, so cwd's own slug is checked before any parent's.

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

**Monorepo / nested project.** If the target dir is *inside* another repo (i.e. a parent already has `.git` or `package.json`), the slug used by `init` would otherwise resolve to that parent. To scope a config to the nested dir specifically, run `mkdir .one` in that dir before `one init` — the empty `.one/` directory marks it as its own project root, and the config will be keyed by the nested dir's slug.

To see which config is currently active and the full fallback chain:

```bash
one --agent config path
```

To switch an existing project back to using the global config, delete its project config file — the CLI will automatically fall back to global on the next run.
