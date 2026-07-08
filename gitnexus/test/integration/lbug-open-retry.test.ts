/**
 * Integration tests: open-time lock-busy retry in `lbug-config.ts`.
 *
 * The lock IO exception raised by `local_file_system.cpp` happens
 * synchronously inside `new lbug.Database(...)`, before any query is
 * issued — so `withLbugDb`'s query-time retry cannot see it. These tests
 * exercise the construction-time retry wrapper directly by stubbing the
 * `Database` constructor.
 *
 * See: docs/plans/2026-05-08-002-fix-windows-lbug-lock-ci-flakes-plan.md
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _isTestFixturePathForTest as isTestFixturePath,
  isDbBusyError,
  isOpenRetryExhausted,
  openLbugConnection,
  waitForWindowsHandleRelease,
} from '../../src/core/lbug/lbug-config.js';

// ─── Minimal stub of the `lbug` module surface used by openLbugConnection ──

interface StubModuleControl {
  /** Errors thrown by sequential `new Database(...)` calls. `null` = success. */
  databaseThrows: Array<Error | null>;
  /** Number of times the `Database` constructor was invoked. */
  databaseCallCount: number;
  /** Number of times `db.close()` was called. */
  closeCallCount: number;
}

const makeStubLbug = (control: StubModuleControl) => {
  class FakeDatabase {
    constructor(_path: string, ..._rest: unknown[]) {
      control.databaseCallCount++;
      const next = control.databaseThrows.shift();
      if (next instanceof Error) throw next;
    }
    async close(): Promise<void> {
      control.closeCallCount++;
    }
  }
  class FakeConnection {
    constructor(_db: FakeDatabase) {}
    async close(): Promise<void> {}
  }
  return { Database: FakeDatabase, Connection: FakeConnection } as any;
};

describe('isDbBusyError', () => {
  it('matches the documented Windows lock-error wording', () => {
    expect(isDbBusyError(new Error('Could not set lock on file foo.lbug'))).toBe(true);
    expect(isDbBusyError(new Error('database is locked'))).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isDbBusyError(new Error('Cypher syntax error'))).toBe(false);
    expect(isDbBusyError(null)).toBe(false);
  });
});

describe('openLbugConnection — open-time lock-busy retry', () => {
  it('returns a handle when the constructor succeeds on the first try', async () => {
    const control: StubModuleControl = {
      databaseThrows: [null],
      databaseCallCount: 0,
      closeCallCount: 0,
    };
    const stub = makeStubLbug(control);
    const handle = await openLbugConnection(stub, '/some/path/lbug');
    expect(handle.db).toBeDefined();
    expect(handle.conn).toBeDefined();
    expect(control.databaseCallCount).toBe(1);
  });

  it('retries on busy/lock errors and succeeds on a later attempt', async () => {
    const control: StubModuleControl = {
      databaseThrows: [new Error('Could not set lock on file'), null],
      databaseCallCount: 0,
      closeCallCount: 0,
    };
    const stub = makeStubLbug(control);
    const handle = await openLbugConnection(stub, '/some/path/lbug');
    expect(handle.db).toBeDefined();
    expect(control.databaseCallCount).toBe(2);
  });

  it('exhausts the retry budget and rethrows the last error preserving its message', async () => {
    const lockErr = new Error('Could not set lock on file foo.lbug');
    const control: StubModuleControl = {
      // 5 attempts + production paths get no sweep retry, so 5 throws total.
      databaseThrows: [lockErr, lockErr, lockErr, lockErr, lockErr],
      databaseCallCount: 0,
      closeCallCount: 0,
    };
    const stub = makeStubLbug(control);
    await expect(openLbugConnection(stub, '/var/data/non-test/lbug')).rejects.toThrow(
      'Could not set lock on file foo.lbug',
    );
    expect(control.databaseCallCount).toBe(5);
  });

  it('tags the exhausted error so withLbugDb skips its outer retry', async () => {
    const lockErr = new Error('Could not set lock on file');
    const control: StubModuleControl = {
      databaseThrows: [lockErr, lockErr, lockErr, lockErr, lockErr],
      databaseCallCount: 0,
      closeCallCount: 0,
    };
    const stub = makeStubLbug(control);
    let caught: unknown;
    try {
      await openLbugConnection(stub, '/var/data/non-test/lbug');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isOpenRetryExhausted(caught)).toBe(true);
    expect(isOpenRetryExhausted(new Error('plain error'))).toBe(false);
    expect(isOpenRetryExhausted(null)).toBe(false);
    expect(isOpenRetryExhausted(undefined)).toBe(false);
  });

  it('does not retry non-busy errors', async () => {
    const syntaxErr = new Error('Cypher syntax error');
    const control: StubModuleControl = {
      databaseThrows: [syntaxErr],
      databaseCallCount: 0,
      closeCallCount: 0,
    };
    const stub = makeStubLbug(control);
    await expect(openLbugConnection(stub, '/some/path/lbug')).rejects.toThrow(
      'Cypher syntax error',
    );
    expect(control.databaseCallCount).toBe(1);
  });
});

describe('openLbugConnection — stale-sidecar sweep (test fixtures only)', () => {
  let fixtureDir: string;
  let dbPath: string;

  beforeEach(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-sweep-'));
    dbPath = path.join(fixtureDir, 'lbug');
  });

  afterEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  });

  it('sweeps stale .wal/.lock for a recognized test fixture path and retries once', async () => {
    await fs.writeFile(dbPath + '.wal', 'stale');
    await fs.writeFile(dbPath + '.lock', 'stale');

    const lockErr = new Error('Could not set lock on file');
    const control: StubModuleControl = {
      // 5 retries throw, then sweep + 1 final attempt succeeds (6 total).
      databaseThrows: [lockErr, lockErr, lockErr, lockErr, lockErr, null],
      databaseCallCount: 0,
      closeCallCount: 0,
    };
    const stub = makeStubLbug(control);

    const handle = await openLbugConnection(stub, dbPath);
    expect(handle.db).toBeDefined();
    expect(control.databaseCallCount).toBe(6);

    // Sidecars removed by the sweep
    await expect(fs.access(dbPath + '.wal')).rejects.toThrow();
    await expect(fs.access(dbPath + '.lock')).rejects.toThrow();
  });

  it('does not sweep production paths even if they share the prefix', async () => {
    // A non-tmp dir that *starts* with the prefix must still be rejected.
    const lockErr = new Error('Could not set lock on file');
    const control: StubModuleControl = {
      databaseThrows: [lockErr, lockErr, lockErr, lockErr, lockErr],
      databaseCallCount: 0,
      closeCallCount: 0,
    };
    const stub = makeStubLbug(control);

    // Path is outside os.tmpdir() so the predicate must reject it.
    await expect(openLbugConnection(stub, '/var/data/gitnexus-lbug-fake/lbug')).rejects.toThrow(
      'Could not set lock on file',
    );
    expect(control.databaseCallCount).toBe(5); // no sweep retry
  });

  it('handles missing sidecars gracefully (ENOENT swallowed, retry runs)', async () => {
    // No .wal or .lock pre-created — sweep ENOENTs both, then succeeds.
    const lockErr = new Error('Could not set lock on file');
    const control: StubModuleControl = {
      databaseThrows: [lockErr, lockErr, lockErr, lockErr, lockErr, null],
      databaseCallCount: 0,
      closeCallCount: 0,
    };
    const stub = makeStubLbug(control);

    const handle = await openLbugConnection(stub, dbPath);
    expect(handle.db).toBeDefined();
    expect(control.databaseCallCount).toBe(6);
  });

  it('sweep retry that throws a different error preserves the original lock error', async () => {
    // 5 lock errors, then sweep fires, then post-sweep throws an unrelated
    // error. The user-actionable signal is "lock retries exhausted" — the
    // post-sweep error must NOT shadow the original lock message.
    const lockErr = new Error('Could not set lock on file foo.lbug');
    const unrelatedErr = new Error('Schema validation error during open');
    const control: StubModuleControl = {
      databaseThrows: [lockErr, lockErr, lockErr, lockErr, lockErr, unrelatedErr],
      databaseCallCount: 0,
      closeCallCount: 0,
    };
    const stub = makeStubLbug(control);

    let caught: Error | undefined;
    try {
      await openLbugConnection(stub, dbPath);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toBe('Could not set lock on file foo.lbug');
    expect(control.databaseCallCount).toBe(6); // sweep retry did fire
  });
});

describe('isTestFixturePath — production-safety guard', () => {
  it('accepts a fixture under os.tmpdir with a recognized prefix on the immediate parent', () => {
    const tmp = os.tmpdir();
    expect(isTestFixturePath(path.join(tmp, 'gitnexus-lbug-XXX', 'lbug'))).toBe(true);
    expect(isTestFixturePath(path.join(tmp, 'gitnexus-test-YYY', 'lbug'))).toBe(true);
  });

  it('rejects production paths even with a matching prefix', () => {
    expect(isTestFixturePath('/var/data/gitnexus-lbug-fake/lbug')).toBe(false);
    expect(isTestFixturePath('/home/user/gitnexus-test-foo/lbug')).toBe(false);
  });

  it('rejects path traversal attempts that resolve outside tmpdir', () => {
    const tmp = os.tmpdir();
    const traversal = path.join(tmp, 'gitnexus-lbug-x', '..', '..', 'etc', 'passwd');
    expect(isTestFixturePath(traversal)).toBe(false);
  });

  it('rejects when the immediate parent does not match even if a deeper ancestor does', () => {
    // Tightening: ancestor walk would have allowed nested paths under
    // `<tmp>/gitnexus-lbug-x/inner/lbug` to satisfy the predicate. We
    // require the immediate parent to match.
    const tmp = os.tmpdir();
    expect(isTestFixturePath(path.join(tmp, 'gitnexus-lbug-x', 'inner', 'lbug'))).toBe(false);
  });

  it('handles tmpdir trailing-separator gracefully', () => {
    // Some Windows TMP configs return a trailing separator; the predicate
    // strips it before the prefix check so fixtures still match.
    const tmp = os.tmpdir();
    const fixture = path.join(tmp, 'gitnexus-lbug-trailing', 'lbug');
    // Whether or not os.tmpdir() itself has a trailing separator,
    // the predicate must accept legit fixtures.
    expect(isTestFixturePath(fixture)).toBe(true);
  });

  it('rejects unrelated prefixes in tmpdir', () => {
    const tmp = os.tmpdir();
    expect(isTestFixturePath(path.join(tmp, 'random-dir', 'lbug'))).toBe(false);
    expect(isTestFixturePath(path.join(tmp, 'malicious', 'lbug'))).toBe(false);
  });
});

describe('waitForWindowsHandleRelease', () => {
  let fixtureDir: string;
  let dbPath: string;

  beforeEach(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-probe-'));
    dbPath = path.join(fixtureDir, 'lbug');
  });

  afterEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns true when the file exists and is openable', async () => {
    await fs.writeFile(dbPath, 'fake-db-content');
    const released = await waitForWindowsHandleRelease(dbPath);
    expect(released).toBe(true);
  });

  it('returns true when the file does not exist (ENOENT is non-lock)', async () => {
    // No fs.writeFile — path does not exist. Probe should bail to true,
    // not retry, since ENOENT is not a lock code.
    const released = await waitForWindowsHandleRelease(dbPath);
    expect(released).toBe(true);
  });

  it('does not leak the file handle when close succeeds', async () => {
    // Smoke test: 50 sequential probes with a real file. If close were
    // skipped, fd usage would climb. We rely on test process not OOMing
    // as the simplest indicator; fd table caps catch egregious leaks.
    await fs.writeFile(dbPath, 'fake-db-content');
    for (let i = 0; i < 50; i++) {
      await waitForWindowsHandleRelease(dbPath);
    }
  });
});
