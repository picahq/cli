import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectRoot, getProjectSlug, resolveConfig } from './config.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv, type HomeEnvSnapshot } from '../test-support/home.js';

describe('getProjectSlug', () => {
  it('encodes a POSIX absolute path by replacing path separators', () => {
    assert.equal(getProjectSlug('/Users/jane/projects/acme'), '-Users-jane-projects-acme');
  });

  it('replaces the Windows drive-letter colon (INT-2828)', () => {
    // Pre-fix this produced `C:-Users-DeathStalker`, which mkdirSync
    // rejects on NTFS because `:` is forbidden inside a path component.
    const slug = getProjectSlug('C:\\Users\\DeathStalker');
    assert.equal(slug, 'C--Users-DeathStalker');
    assert.equal(slug.includes(':'), false, 'slug must not contain ":" on Windows');
  });

  it('replaces a colon anywhere in the path, not just the drive letter', () => {
    assert.equal(getProjectSlug('/tmp/some:weird/dir'), '-tmp-some-weird-dir');
  });

  it('handles mixed forward and backward slashes (Windows MSYS / WSL boundary)', () => {
    assert.equal(getProjectSlug('C:\\Users\\jane/projects'), 'C--Users-jane-projects');
  });

  it('replaces every Windows-forbidden character (< > : " | ? *)', () => {
    // None of these would normally appear in a path the CLI sees (Windows
    // forbids them in components), but stripping them defensively keeps
    // the slug a valid filename on any OS regardless of how it was
    // constructed.
    assert.equal(getProjectSlug('a<b>c:d"e|f?g*h'), 'a-b-c-d-e-f-g-h');
  });

  it('is idempotent — re-encoding an already-encoded slug is a no-op', () => {
    const slug = getProjectSlug('C:\\Users\\jane');
    assert.equal(getProjectSlug(slug), slug);
  });
});

// All tests below sandbox $HOME to a temp dir so they read/write under
// `<tmp>/.one/...` instead of the developer's real `~/.one/`. The config
// module deliberately resolves home-rooted paths lazily on every call
// (see the comment at the top of config.ts), so flipping HOME here is
// sufficient — no module reload required.

function withSandbox(): {
  tmpDir: string;
  homeDir: string;
  writeProjectConfig: (absDir: string, content: object) => void;
  writeGlobalConfig: (content: object) => void;
} {
  // The sandbox root IS the sandboxed home, so every fixture these tests
  // create lives under it. On Windows `os.tmpdir()` is itself inside the real
  // home (%LOCALAPPDATA%\Temp), so a fixture created as a *sibling* of the
  // sandbox home escapes it: getProjectRoot's walk climbs past the fake home,
  // reaches the developer's real `~/.one`, and adopts it as the project root.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-config-test-'));
  const homeDir = tmpDir;
  setHomeTo(homeDir);

  const projectsDir = path.join(homeDir, '.one', 'projects');

  return {
    tmpDir,
    homeDir,
    writeProjectConfig(absDir, content) {
      const slug = getProjectSlug(absDir);
      const dir = path.join(projectsDir, slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(content));
    },
    writeGlobalConfig(content) {
      fs.mkdirSync(path.join(homeDir, '.one'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.one', 'config.json'), JSON.stringify(content));
    },
  };
}

describe('getProjectRoot', () => {
  let tmpDir: string;
  let homeDir: string;
  let originalHome: HomeEnvSnapshot;
  let originalCwd: string;

  beforeEach(() => {
    originalHome = snapshotHomeEnv();
    originalCwd = process.cwd();
    ({ tmpDir, homeDir } = withSandbox());
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restoreHomeEnv(originalHome);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('returns the nearest ancestor that contains .git', () => {
    const repo = path.join(tmpDir, 'repo');
    const leaf = path.join(repo, 'sub', 'leaf');
    fs.mkdirSync(leaf, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    assert.equal(getProjectRoot(leaf), repo);
  });

  it('returns the nearest ancestor that contains package.json', () => {
    const repo = path.join(tmpDir, 'repo');
    const leaf = path.join(repo, 'sub');
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    assert.equal(getProjectRoot(leaf), repo);
  });

  it('treats .one as a project marker', () => {
    const dir = path.join(tmpDir, 'project');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, '.one'));
    assert.equal(getProjectRoot(dir), dir);
  });

  it('nested .one wins over a parent .git (lets monorepo subprojects opt in)', () => {
    const repo = path.join(tmpDir, 'monorepo');
    const nested = path.join(repo, 'services', 'frontend');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(nested, '.one'));
    assert.equal(
      getProjectRoot(nested),
      nested,
      'walking up from nested should stop at nested because of its .one',
    );
  });

  it('falls back to cwd when no marker exists in any ancestor', () => {
    const dir = path.join(tmpDir, 'orphan', 'sub');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(getProjectRoot(dir), dir);
  });

  it('does not treat $HOME as a project root when ~/.one exists (the CLI config dir)', () => {
    // Incident: cwd was a marker-less dir under $HOME. The walk reached
    // $HOME, matched ~/.one — the CLI's own config directory — and the
    // project config landed under the home-dir slug, shadowing the
    // global config for everything under $HOME.
    fs.mkdirSync(path.join(homeDir, '.one'));
    const dir = path.join(homeDir, 'projects', 'agent');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(getProjectRoot(dir), dir, 'should fall back to cwd, not $HOME');
  });

  it('does not treat $HOME as a project root via .git or package.json either', () => {
    // A dotfiles repo (~/.git) or stray ~/package.json is common and
    // must not promote all of $HOME to one project. Scope-for-all-of-
    // home is what the global config is for.
    fs.mkdirSync(path.join(homeDir, '.git'));
    fs.writeFileSync(path.join(homeDir, 'package.json'), '{}');
    const dir = path.join(homeDir, 'projects', 'agent');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(getProjectRoot(dir), dir);
  });

  it('still detects a marked project root below $HOME', () => {
    fs.mkdirSync(path.join(homeDir, '.one'));
    const repo = path.join(homeDir, 'projects', 'repo');
    const leaf = path.join(repo, 'sub');
    fs.mkdirSync(leaf, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    assert.equal(getProjectRoot(leaf), repo);
  });
});

describe('resolveConfig', () => {
  let tmpDir: string;
  let originalHome: HomeEnvSnapshot;
  let originalCwd: string;
  let writeProjectConfig: (absDir: string, content: object) => void;
  let writeGlobalConfig: (content: object) => void;

  beforeEach(() => {
    originalHome = snapshotHomeEnv();
    originalCwd = process.cwd();
    ({ tmpDir, writeProjectConfig, writeGlobalConfig } = withSandbox());
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restoreHomeEnv(originalHome);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('reads cwd-slug config even when cwd has no marker (orphan-config fix)', () => {
    // Pre-existing bug: parent has .git, so getProjectRoot returns the
    // parent, and the old resolver only checked the parent slug + walked
    // strictly above cwd — never checking cwd's own slug. A config keyed
    // to cwd was invisible.
    const repo = path.join(tmpDir, 'workspace');
    const nested = path.join(repo, 'sub', 'leaf');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    writeProjectConfig(nested, { apiKey: 'sk_nested' });
    process.chdir(nested);

    const resolved = resolveConfig();
    assert.equal(resolved.scope, 'project');
    assert.equal(resolved.projectRoot, nested);
    assert.equal(resolved.config?.apiKey, 'sk_nested');
  });

  it('picks the nested-slug config when nested dir has .one and configs exist at both levels', () => {
    const repo = path.join(tmpDir, 'monorepo');
    const nested = path.join(repo, 'services', 'frontend');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(nested, '.one'));
    writeProjectConfig(nested, { apiKey: 'sk_nested' });
    writeProjectConfig(repo, { apiKey: 'sk_parent' });
    process.chdir(nested);

    const resolved = resolveConfig();
    assert.equal(resolved.scope, 'project');
    assert.equal(resolved.projectRoot, nested);
    assert.equal(resolved.config?.apiKey, 'sk_nested');
  });

  it('preserves existing behavior: parent-only config still resolves for a nested cwd', () => {
    const repo = path.join(tmpDir, 'repo');
    const nested = path.join(repo, 'sub');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    writeProjectConfig(repo, { apiKey: 'sk_parent' });
    process.chdir(nested);

    const resolved = resolveConfig();
    assert.equal(resolved.scope, 'project');
    assert.equal(resolved.projectRoot, repo);
    assert.equal(resolved.config?.apiKey, 'sk_parent');
  });

  it('cwd-slug config wins over parent-slug config (closer is more specific)', () => {
    const repo = path.join(tmpDir, 'repo');
    const nested = path.join(repo, 'sub');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    writeProjectConfig(nested, { apiKey: 'sk_nested' });
    writeProjectConfig(repo, { apiKey: 'sk_parent' });
    process.chdir(nested);

    const resolved = resolveConfig();
    assert.equal(resolved.scope, 'project');
    assert.equal(resolved.projectRoot, nested);
    assert.equal(resolved.config?.apiKey, 'sk_nested');
  });

  it('falls back to global, but reports the marker-detected root for diagnostics', () => {
    const repo = path.join(tmpDir, 'repo');
    const nested = path.join(repo, 'sub');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    writeGlobalConfig({ apiKey: 'sk_global' });
    process.chdir(nested);

    const resolved = resolveConfig();
    assert.equal(resolved.scope, 'global');
    assert.equal(
      resolved.projectRoot,
      repo,
      'global fallback should still report where a project config *would* live',
    );
    assert.equal(resolved.config?.apiKey, 'sk_global');
  });

  it('returns null scope when no config exists anywhere', () => {
    const repo = path.join(tmpDir, 'repo');
    const nested = path.join(repo, 'sub');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    process.chdir(nested);

    const resolved = resolveConfig();
    assert.equal(resolved.scope, null);
    assert.equal(resolved.config, null);
    assert.equal(resolved.projectRoot, repo);
  });
});
