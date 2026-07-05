/**
 * Integration Tests: lbug-adapter busy/lock retry logic
 *
 * Tests isDbBusyError() detection and withLbugDb() retry behaviour
 * using the real LadybugDB via withTestLbugDB lifecycle.
 *
 * Follows existing lbug integration test patterns (lbug-core-adapter,
 * lbug-pool, lbug-pool-stability).
 */
import { describe, it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

// ─── isDbBusyError ────────────────────────────────────────────────────────

// Pure-function tests — no DB needed, but grouped here for cohesion
// with the retry logic they guard.
import { isDbBusyError, openLbugConnection } from '../../src/core/lbug/lbug-config.js';

describe('isDbBusyError', () => {
  it('returns true for "busy" errors (case-insensitive)', () => {
    expect(isDbBusyError(new Error('Database is BUSY'))).toBe(true);
    expect(isDbBusyError(new Error('busy'))).toBe(true);
    expect(isDbBusyError('resource busy')).toBe(true);
  });

  it('returns true for "lock" errors', () => {
    expect(isDbBusyError(new Error('Could not set lock on file'))).toBe(true);
    expect(isDbBusyError(new Error('database is locked'))).toBe(true);
    expect(isDbBusyError(new Error('LOCK'))).toBe(true);
  });

  it('returns true for "already in use" errors', () => {
    expect(isDbBusyError(new Error('file already in use by another process'))).toBe(true);
    expect(isDbBusyError('already in use')).toBe(true);
  });

  it('returns true for "only one write transaction at a time" errors', () => {
    expect(
      isDbBusyError(new Error('Only one write transaction at a time is allowed in the system.')),
    ).toBe(true);
    expect(isDbBusyError('only one write transaction at a time is allowed in the system.')).toBe(
      true,
    );
  });

  it('returns true for "could not set lock" errors', () => {
    expect(isDbBusyError(new Error('Could not set lock on the database file'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isDbBusyError(new Error('Table not found'))).toBe(false);
    expect(isDbBusyError(new Error('Connection refused'))).toBe(false);
    expect(isDbBusyError(new Error('Syntax error in Cypher query'))).toBe(false);
    expect(isDbBusyError(null)).toBe(false);
    expect(isDbBusyError(undefined)).toBe(false);
  });

  // Documented behavior for lock-shaped strings: the matcher is intentionally
  // broad because in graph-DB contexts these are all transient. If LadybugDB
  // ever surfaces a non-transient lock-shaped error (e.g., a recovery-time
  // "lock file missing"), tighten the matcher and add a negative test here
  // rather than raising the retry budget.
  it('treats other lock-shaped errors as transient (current intentional behavior)', () => {
    expect(isDbBusyError(new Error('deadlock detected'))).toBe(true);
    expect(isDbBusyError(new Error('unlock failed'))).toBe(true);
    expect(isDbBusyError(new Error('lock contention'))).toBe(true);
    expect(isDbBusyError(new Error('Could not open lock file'))).toBe(true);
  });

  it('handles non-Error values gracefully', () => {
    expect(isDbBusyError('BUSY error')).toBe(true);
    expect(isDbBusyError(42)).toBe(false);
    expect(isDbBusyError({ message: 'locked' })).toBe(false); // plain object not Error
  });
});

// ─── openLbugConnection construction-time retry ────────────────────────────

// Minimal stub of the `lbug` module surface used by openLbugConnection.
// Duplicated locally (see lbug-open-retry.test.ts's makeStubLbug) rather
// than shared, matching this codebase's existing per-test-file convention.
interface StubModuleControl {
  databaseThrows: Array<Error | null>;
  databaseCallCount: number;
}

const makeStubLbug = (control: StubModuleControl) => {
  class FakeDatabase {
    constructor(_path: string, ..._rest: unknown[]) {
      control.databaseCallCount++;
      const next = control.databaseThrows.shift();
      if (next instanceof Error) throw next;
    }
    async close(): Promise<void> {}
  }
  class FakeConnection {
    constructor(_db: FakeDatabase) {}
    async close(): Promise<void> {}
  }
  return { Database: FakeDatabase, Connection: FakeConnection } as any;
};

describe('openLbugConnection — write-transaction contention retry', () => {
  it('retries on write-transaction contention and succeeds on a later attempt', async () => {
    const control: StubModuleControl = {
      databaseThrows: [
        new Error('Only one write transaction at a time is allowed in the system.'),
        null,
      ],
      databaseCallCount: 0,
    };
    const stub = makeStubLbug(control);
    const handle = await openLbugConnection(stub, '/some/path/lbug');
    expect(handle.db).toBeDefined();
    expect(control.databaseCallCount).toBe(2);
  });
});

// ─── withLbugDb retry integration tests ───────────────────────────────────

withTestLbugDB('lock-retry', (handle) => {
  describe('withLbugDb retry behaviour', () => {
    it('returns the operation result on success', async () => {
      const { withLbugDb } = await import('../../src/core/lbug/lbug-adapter.js');
      const result = await withLbugDb(handle.dbPath, async () => 'ok');
      expect(result).toBe('ok');
    });

    it('retries on BUSY error and succeeds on later attempt', async () => {
      const { withLbugDb } = await import('../../src/core/lbug/lbug-adapter.js');
      let callCount = 0;
      const result = await withLbugDb(handle.dbPath, async () => {
        callCount++;
        if (callCount === 1) throw new Error('database is BUSY');
        return 'recovered';
      });

      expect(result).toBe('recovered');
      expect(callCount).toBe(2);
    });

    it('retries on LadybugDB single-writer transaction contention', async () => {
      const { withLbugDb } = await import('../../src/core/lbug/lbug-adapter.js');
      let callCount = 0;
      const result = await withLbugDb(handle.dbPath, async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Only one write transaction at a time is allowed in the system.');
        }
        return 'recovered';
      });

      expect(result).toBe('recovered');
      expect(callCount).toBe(2);
    });

    it('propagates non-BUSY errors immediately without retrying', async () => {
      const { withLbugDb } = await import('../../src/core/lbug/lbug-adapter.js');
      let callCount = 0;
      await expect(
        withLbugDb(handle.dbPath, async () => {
          callCount++;
          throw new Error('Syntax error in Cypher');
        }),
      ).rejects.toThrow('Syntax error in Cypher');

      expect(callCount).toBe(1); // no retry for non-BUSY errors
    });

    it('throws after max retry attempts', async () => {
      const { withLbugDb } = await import('../../src/core/lbug/lbug-adapter.js');
      let callCount = 0;
      await expect(
        withLbugDb(handle.dbPath, async () => {
          callCount++;
          throw new Error('Could not set lock');
        }),
      ).rejects.toThrow('Could not set lock');

      // Matches DB_LOCK_RETRY_ATTEMPTS in lbug-adapter.ts. If that budget
      // changes, this assertion — not this comment — is the source of truth.
      expect(callCount).toBe(3);
    });

    it('throws after max retry attempts on write-transaction contention', async () => {
      const { withLbugDb } = await import('../../src/core/lbug/lbug-adapter.js');
      let callCount = 0;
      await expect(
        withLbugDb(handle.dbPath, async () => {
          callCount++;
          throw new Error('Only one write transaction at a time is allowed in the system.');
        }),
      ).rejects.toThrow('Only one write transaction at a time is allowed in the system.');

      // Matches DB_LOCK_RETRY_ATTEMPTS in lbug-adapter.ts. If that budget
      // changes, this assertion — not this comment — is the source of truth.
      expect(callCount).toBe(3);
    });
  });
});
