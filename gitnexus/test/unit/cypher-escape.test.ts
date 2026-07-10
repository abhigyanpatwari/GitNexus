/**
 * Unit coverage for `escapeCypherString` (#2409 review).
 *
 * LadybugDB's Cypher parser rejects SQL-style `''` quote doubling — a
 * doubled-quote literal is a PARSER ERROR, not an escaped quote — so
 * every call site that used `.replace(/'/g, "''")` produced a query that
 * never parsed (verified live against a real DB; the end-to-end proof for
 * the writeback path is the quoted-path case in
 * test/integration/lbug-delete-nodes-for-files.test.ts). These tests pin
 * the backslash-escape contract shared by the writeback, augmentation,
 * embedding, and wiki query builders.
 */
import { describe, it, expect } from 'vitest';
import { escapeCypherString } from '../../src/core/lbug/cypher-escape.js';

describe('escapeCypherString', () => {
  it('passes through values with nothing to escape', () => {
    expect(escapeCypherString('src/plain/file.ts')).toBe('src/plain/file.ts');
    expect(escapeCypherString('')).toBe('');
  });

  it('backslash-escapes single quotes (NOT SQL-style doubling)', () => {
    expect(escapeCypherString("src/we'ird.ts")).toBe("src/we\\'ird.ts");
    expect(escapeCypherString("it's a 'test'")).toBe("it\\'s a \\'test\\'");
  });

  it('escapes backslashes, and does so BEFORE quotes (order-sensitive)', () => {
    expect(escapeCypherString('a\\b')).toBe('a\\\\b');
    // A pre-escaped-looking input must not collapse: \' → \\\' (escaped
    // backslash + escaped quote), proving the backslash pass ran first.
    expect(escapeCypherString("a\\'b")).toBe("a\\\\\\'b");
  });

  it('never emits SQL-style doubled quotes', () => {
    expect(escapeCypherString("we'ird")).not.toContain("''");
  });
});
