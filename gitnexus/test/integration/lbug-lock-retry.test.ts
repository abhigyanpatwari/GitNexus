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
import { isDbBusyError } from '../../src/core/lbug/lbug-adapter.js';

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

  it('handles non-Error values gracefully', () => {
    expect(isDbBusyError('BUSY error')).toBe(true);
    expect(isDbBusyError(42)).toBe(false);
    expect(isDbBusyError({ message: 'locked' })).toBe(false); // plain object not Error
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

      // DB_LOCK_RETRY_ATTEMPTS = 3 (default in the implementation)
      expect(callCount).toBe(3);
    });
  });
});
