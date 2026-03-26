## One CLI — Development Guide

### Publishing a new version

Do NOT run `npm publish` directly. The release is automated via GitHub.

1. Create a branch (e.g., `release/1.13.10`)
2. Update the version in `package.json`
3. Run `npm install` so `package-lock.json` updates
4. Commit both files, push, and create a PR to `main`
5. Once merged to `main`, create a **release tag** in GitHub for that version
6. The GitHub release triggers the automated deploy to npm

### Branch workflow

Always create a branch and PR for changes — do not commit directly to `main`.
