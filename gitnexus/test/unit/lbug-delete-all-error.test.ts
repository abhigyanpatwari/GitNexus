/**
 * Unit tests for `classifyDeleteAllError` (lbug-config.ts) — the
 * benign-vs-rethrow classification behind `deleteAllRelationshipsOfType`
 * (lbug-adapter.ts), shared by the delete-before-rewrite family
 * (`deleteAllInjects` / `deleteAllCallSummaries` /
 * `deleteAllInterprocTaintPaths`).
 *
 * The branch is load-bearing: 'benign-missing-table' silently no-ops (a
 * freshly-initialized DB has no CodeRelation rows to clear), while EVERYTHING
 * else must be re-thrown by the caller — the only defense against the
 * subsequent re-extract writing duplicate rows (CodeRelation has no PK,
 * #2084 review P2-5). It is exercised here as a pure function because driving
 * a synthetic native failure through the real singleton connection would
 * break every later test in the shared integration suite (see the note in
 * test/integration/lbug-core-adapter.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { classifyDeleteAllError } from '../../src/core/lbug/lbug-config.js';

describe('classifyDeleteAllError', () => {
  it.each<[string, string]>([
    ['full missing-table phrasing', 'Binder exception: Table CodeRelation does not exist.'],
    ['bare does-not-exist', 'table does not exist'],
    ['no-table phrasing', 'Catalog exception: no table named CodeRelation'],
    ['not-found phrasing', 'CodeRelation not found in catalog'],
    ['not-exist phrasing (without "does")', 'Error: rel table CodeRelation not exist'],
    ['case-insensitive match', 'TABLE CODERELATION DOES NOT EXIST'],
  ])('classifies %s as benign-missing-table', (_label, message) => {
    expect(classifyDeleteAllError(new Error(message))).toBe('benign-missing-table');
  });

  it.each<[string, unknown]>([
    ['a closed connection', new Error('connection closed')],
    ['lock contention', new Error('Could not set lock on file: database is locked')],
    ['disk I/O failure', new Error('IO exception: failed to write WAL entry')],
    ['a generic native error', new Error('Runtime exception: unexpected null pointer')],
    ['a non-Error string throw', 'something went sideways'],
    ['a non-Error object throw (String() → "[object Object]")', { code: 'EIO' }],
    ['undefined (String() → "undefined")', undefined],
  ])('classifies %s as rethrow', (_label, err) => {
    expect(classifyDeleteAllError(err)).toBe('rethrow');
  });
});
