## One CLI — Development Guide

### Publishing a new version

Do NOT run `npm publish` directly. The release is automated via GitHub.

1. Create a branch (e.g., `release/1.13.10`)
2. Update the version in `package.json`
3. Run `npm install` so `package-lock.json` updates
4. Commit both files, push, and create a PR to `main`
5. Once merged to `main`, create a **release tag** in GitHub for that version
6. The GitHub release triggers the automated deploy to npm

### Version bump checklist

Every feature PR must include a version bump before shipping:

1. Bump `version` in `package.json` (semver: patch for fixes, minor for features, major for breaking)
2. Run `npm install` so `package-lock.json` updates
3. Commit both `package.json` and `package-lock.json` in the same PR

Do NOT forget this — the PR cannot be released without it.

### Branch workflow

Always create a branch and PR for changes — do not commit directly to `main`.

### Documentation-first development

When making any feature change, **always update documentation as part of the implementation**:

1. `src/lib/guide-content.ts` — CLI guide content (`one guide <topic>`)
2. `skills/one/SKILL.md` — Agent-facing skill documentation
3. `README.md` — User-facing command reference
4. `src/index.ts` — Help text and command descriptions

Agent experience is the highest priority. Agents rely on accurate documentation to use the CLI correctly. Stale docs = broken agent workflows.

### Writing tests — home-directory isolation is mandatory

Anything that touches config, cache, memory, telemetry, skills, or schedules
resolves its paths from the home directory. Tests **must** sandbox it, and
setting `process.env.HOME` is NOT sufficient — `os.homedir()` follows `$HOME`
on POSIX but reads `USERPROFILE` on Windows and ignores `HOME` entirely.

Use the shared helper, which sets `ONE_HOME`, `HOME`, and `USERPROFILE`:

```ts
import { withTempHome } from '../test-support/home.js';

const home = withTempHome();
beforeEach(() => home.setup());
afterEach(() => home.teardown());
```

Rules:

1. **Never call `os.homedir()` in `src/`.** Use `homeDir()` from `lib/home.ts`.
2. **Never bind a home-rooted path at module load** (`const DIR = join(homeDir(), '.one')`).
   That captures the value at import time and defeats every override. Use a
   function or a getter.
3. Call `assertHomeIsSandboxed()` at the top of any test that writes.

This is not hypothetical: the suite previously read and wrote the developer's
real `~/.one` on Windows — injecting fabricated events into the live telemetry
send-queue and failing ~29 assertions against whatever config happened to be
installed.

### Running tests

`npm test` runs `scripts/run-tests.mjs`, which discovers test files itself.
Do **not** change it back to `tsx --test "src/**/*.test.ts"` — runner-side glob
expansion only exists in Node 21+, so on Node 18/20 (both inside our declared
`engines.node: >=18`) that pattern matches nothing and exits 0 having run
nothing at all.

CI (`.github/workflows/ci.yml`) runs typecheck + tests on Node 18/20/22 across
ubuntu and windows on every PR. Windows coverage is deliberate — the isolation
bug above was invisible everywhere else.

### Parked features

- **Remote cloud skills (`one skills` CRUD)** — Removed in the unified skill onboarding PR. The command, API methods, types (`CloudSkill`), and skill-file parser were stripped out. Source files are preserved in git history if we want to bring this back later. The feature allowed managing AI skills stored in the One API via `one skills list/get/create/update/delete`.
