import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isDriverFault, passesIntegrityCheck, backupPathFor } from './db.js';
import type { loadSqlite } from './sqlite-loader.js';

// Regression cover for #178: a Node ABI mismatch made openDatabase() treat a
// healthy database as corrupt, rename it to a fixed `<db>.bak` and write an
// empty replacement — destroying a 747MB live sync database. These tests pin
// the three guarantees that fix rests on, without needing the native module
// installed (better-sqlite3 is an optionalDependency and is frequently absent).

type Ctor = Awaited<ReturnType<typeof loadSqlite>>;

/** Minimal better-sqlite3 stand-in that records how it was constructed. */
function fakeCtor(behaviour: {
  throwOnOpen?: unknown;
  quickCheck?: unknown;
  onClose?: () => void;
}): { ctor: Ctor; calls: Array<{ path: string; opts: unknown }> } {
  const calls: Array<{ path: string; opts: unknown }> = [];
  const ctor = function (this: unknown, path: string, opts: unknown) {
    calls.push({ path, opts });
    if (behaviour.throwOnOpen) throw behaviour.throwOnOpen;
    return {
      pragma: (_stmt: string) => behaviour.quickCheck,
      close: () => behaviour.onClose?.(),
    };
  } as unknown as Ctor;
  return { ctor, calls };
}

describe('isDriverFault — environment faults must never be mistaken for corruption', () => {
  it('flags ERR_DLOPEN_FAILED by error code', () => {
    const err = Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' });
    assert.equal(isDriverFault(err), true);
  });

  it('flags the exact ABI-mismatch message from the #178 report', () => {
    const err = new Error(
      'The module was compiled against a different Node.js version using ' +
      'NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 127.',
    );
    assert.equal(isDriverFault(err), true);
  });

  it('flags a missing bindings file', () => {
    assert.equal(isDriverFault(new Error('Could not locate the bindings file. Tried: ...')), true);
  });

  it('flags platform loader failures (linux / macos / windows)', () => {
    assert.equal(isDriverFault(new Error('invalid ELF header')), true);
    assert.equal(isDriverFault(new Error('symbol not found in flat namespace')), true);
    assert.equal(isDriverFault(new Error('is not a valid Win32 application.')), true);
  });

  it('does NOT flag genuine file corruption', () => {
    assert.equal(isDriverFault(new Error('database disk image is malformed')), false);
    assert.equal(isDriverFault(new Error('file is not a database')), false);
    assert.equal(
      isDriverFault(Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' })),
      false,
    );
  });

  it('does not throw on non-Error inputs', () => {
    assert.equal(isDriverFault(undefined), false);
    assert.equal(isDriverFault(null), false);
    assert.equal(isDriverFault('some string'), false);
  });
});

describe('passesIntegrityCheck — only discard what SQLite calls damaged', () => {
  it('probes read-only so the check cannot mutate the file', () => {
    const { ctor, calls } = fakeCtor({ quickCheck: [{ quick_check: 'ok' }] });
    passesIntegrityCheck(ctor, '/tmp/x.db');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts, { readonly: true, fileMustExist: true });
  });

  it('returns true for a healthy database (row form)', () => {
    const { ctor } = fakeCtor({ quickCheck: [{ quick_check: 'ok' }] });
    assert.equal(passesIntegrityCheck(ctor, '/tmp/x.db'), true);
  });

  it('returns true for a healthy database (scalar form)', () => {
    const { ctor } = fakeCtor({ quickCheck: 'ok' });
    assert.equal(passesIntegrityCheck(ctor, '/tmp/x.db'), true);
  });

  it('returns false when SQLite reports damage', () => {
    const { ctor } = fakeCtor({ quickCheck: [{ quick_check: '*** in database main ***\nPage 4 is never used' }] });
    assert.equal(passesIntegrityCheck(ctor, '/tmp/x.db'), false);
  });

  it('returns false when the probe itself throws', () => {
    const { ctor } = fakeCtor({ throwOnOpen: new Error('file is not a database') });
    assert.equal(passesIntegrityCheck(ctor, '/tmp/x.db'), false);
  });

  it('closes the probe even when the verdict is not ok', () => {
    let closed = false;
    const { ctor } = fakeCtor({ quickCheck: [{ quick_check: 'malformed' }], onClose: () => { closed = true; } });
    passesIntegrityCheck(ctor, '/tmp/x.db');
    assert.equal(closed, true, 'probe handle must not leak');
  });
});

describe('backupPathFor — a repeat failure must not destroy the previous backup', () => {
  it('produces distinct paths for distinct times', () => {
    const a = backupPathFor('/data/gmail.db', new Date('2026-08-10T09:15:00.000Z'));
    const b = backupPathFor('/data/gmail.db', new Date('2026-08-10T09:16:00.000Z'));
    assert.notEqual(a, b, 'the old fixed .bak name is what made #178 unrecoverable on the second run');
  });

  it('keeps the original path as a prefix', () => {
    const p = backupPathFor('/data/gmail.db', new Date('2026-08-10T09:15:00.000Z'));
    assert.ok(p.startsWith('/data/gmail.db.bak.'), `unexpected shape: ${p}`);
  });

  it('contains no characters Windows forbids in a filename', () => {
    const p = backupPathFor('C:\\data\\gmail.db', new Date('2026-08-10T09:15:00.000Z'));
    const filename = p.slice(p.lastIndexOf('\\') + 1);
    for (const bad of ['<', '>', ':', '"', '|', '?', '*']) {
      assert.equal(filename.includes(bad), false, `backup filename must not contain "${bad}": ${filename}`);
    }
  });
});
