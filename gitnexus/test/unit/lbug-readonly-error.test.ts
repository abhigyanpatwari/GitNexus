/**
 * Regression Tests: read-only DB error discriminator (#1224)
 *
 * The MCP query pool opens LadybugDB read-only. A write there surfaces
 * "Cannot execute write operations in a read-only database". The
 * discriminator must stay precise so lock / busy / "already exists"
 * errors are not swallowed.
 *
 * This file unit-tests the discriminator directly so future refactors
 * keep the contract.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { isReadOnlyDbError } from '../../src/core/lbug/lbug-adapter.js';

const adapterSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/core/lbug/lbug-adapter.ts'),
  'utf8',
);

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

  it('detects a read-only error wrapped as a `cause` (#2068 — pool-adapter wrapper)', () => {
    // The pool adapter rethrows native read-only failures as a friendly
    // message with the original error preserved on `cause`. Detection must see
    // through the wrapper so the MCP/HTTP handlers surface their curated message.
    const wrapped = new Error('Write operations are not allowed. The pool adapter is read-only.', {
      cause: new Error('Cannot execute write operations in a read-only database!'),
    });
    expect(isReadOnlyDbError(wrapped)).toBe(true);
  });

  it('does NOT match a wrapper whose cause chain is unrelated', () => {
    const wrapped = new Error('Query failed', { cause: new Error('Connection refused') });
    expect(isReadOnlyDbError(wrapped)).toBe(false);
  });

  it('terminates on a cyclic cause chain without hanging', () => {
    const a = new Error('boom a') as Error & { cause?: unknown };
    const b = new Error('boom b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isReadOnlyDbError(a)).toBe(false);
  });

  it('stops cleanly on a non-Error cause', () => {
    const wrapped = new Error('outer', { cause: 'just a string' });
    expect(isReadOnlyDbError(wrapped)).toBe(false);
  });

  it('does NOT match unrelated errors that create/drop must still surface', () => {
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

  it('has no production ensureFTSIndex residue (#1500)', () => {
    expect(adapterSource).not.toContain('ensureFTSIndex');
    expect(adapterSource).toContain('export const createFTSIndex');
    const start = adapterSource.indexOf('export const createFTSIndex');
    const nextExport = adapterSource.indexOf('\nexport const', start + 1);
    const createBody = adapterSource.slice(start, nextExport);
    expect(createBody).toContain("includes('already exists')");
    expect(createBody).not.toContain('isReadOnlyDbError');
  });
});
