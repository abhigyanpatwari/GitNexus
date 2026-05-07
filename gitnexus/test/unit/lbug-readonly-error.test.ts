/**
 * Regression Tests: read-only DB error discriminator (#1224)
 *
 * The MCP query pool opens LadybugDB read-only. Defensive callers of
 * `ensureFTSIndex` from that pool used to spam stderr with five
 * "Cannot execute write operations in a read-only database" warnings
 * per query because the cache was invalidated each time. The fix:
 * `ensureFTSIndex` now treats the read-only error as a no-op and
 * caches the key — but to do that it relies on a precise discriminator
 * that does NOT swallow lock / busy / "already exists" errors.
 *
 * This file unit-tests the discriminator directly so future refactors
 * keep the contract.
 */
import { describe, it, expect } from 'vitest';
import { isReadOnlyDbError } from '../../src/core/lbug/lbug-adapter.js';

describe('isReadOnlyDbError', () => {
  it('matches the canonical LadybugDB read-only message verbatim', () => {
    const err = new Error(
      'Connection exception: Cannot execute write operations in a read-only database!',
    );
    expect(isReadOnlyDbError(err)).toBe(true);
  });

  it('matches when the error is wrapped in additional prefix text', () => {
    const err = new Error(
      'Runtime exception: Cannot execute write operations in a read-only database',
    );
    expect(isReadOnlyDbError(err)).toBe(true);
  });

  it('is case-insensitive on the "read-only" substring', () => {
    expect(isReadOnlyDbError(new Error('Read-Only Database access denied'))).toBe(true);
  });

  it('accepts non-Error values (string, unknown) without throwing', () => {
    expect(isReadOnlyDbError('write rejected: read-only database')).toBe(true);
    expect(isReadOnlyDbError({ toString: () => 'read-only database' })).toBe(true);
    expect(isReadOnlyDbError(null)).toBe(false);
    expect(isReadOnlyDbError(undefined)).toBe(false);
  });

  it('does NOT match unrelated errors that the ensure path must still surface', () => {
    // Lock contention — handled separately by isDbBusyError; must not be
    // silenced by the read-only filter.
    expect(isReadOnlyDbError(new Error('Could not set lock on file'))).toBe(false);
    // "already exists" — the happy idempotent path inside createFTSIndex.
    expect(isReadOnlyDbError(new Error('Index file_fts already exists'))).toBe(false);
    // Schema-level problem.
    expect(isReadOnlyDbError(new Error('Table File does not exist'))).toBe(false);
    // Generic transient error.
    expect(isReadOnlyDbError(new Error('Connection refused'))).toBe(false);
  });
});
