import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectRoot, resolveConfig } from './config.js';

// All tests sandbox $HOME to a temp dir so they read/write under
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-config-test-'));
  const homeDir = path.join(tmpDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;

  const projectsDir = path.join(homeDir, '.one', 'projects');

  return {
    tmpDir,
    homeDir,
    writeProjectConfig(absDir, content) {
      const slug = absDir.replace(/[\\/]/g, '-');
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
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    ({ tmpDir } = withSandbox());
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
});

describe('resolveConfig', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let writeProjectConfig: (absDir: string, content: object) => void;
  let writeGlobalConfig: (content: object) => void;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    ({ tmpDir, writeProjectConfig, writeGlobalConfig } = withSandbox());
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
