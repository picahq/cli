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

### Parked features

- **Remote cloud skills (`one skills` CRUD)** — Removed in the unified skill onboarding PR. The command, API methods, types (`CloudSkill`), and skill-file parser were stripped out. Source files are preserved in git history if we want to bring this back later. The feature allowed managing AI skills stored in the One API via `one skills list/get/create/update/delete`.
