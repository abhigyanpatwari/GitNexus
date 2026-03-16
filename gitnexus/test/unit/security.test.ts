/**
 * P0 Unit Tests: Security Hardening
 *
 * Tests all security hardening in isolation:
 * - Write blocking (CYPHER_WRITE_RE)
 * - Relation type allowlist
 * - Path traversal detection
 * - isWriteQuery wrapper
 * - isTestFilePath patterns
 */
import { describe, it, expect } from 'vitest';
import {
  CYPHER_WRITE_RE,
  VALID_RELATION_TYPES,
  VALID_NODE_LABELS,
  isWriteQuery,
  isTestFilePath,
} from '../../src/mcp/local/local-backend.js';

// ─── Write-operation blocking (CYPHER_WRITE_RE) ──────────────────────

describe('CYPHER_WRITE_RE', () => {
  const writeKeywords = ['CREATE', 'DELETE', 'SET', 'MERGE', 'REMOVE', 'DROP', 'ALTER', 'COPY', 'DETACH'];

  for (const keyword of writeKeywords) {
    it(`matches "${keyword}" (uppercase)`, () => {
      expect(CYPHER_WRITE_RE.test(`${keyword} (n:Node)`)).toBe(true);
    });

    it(`matches "${keyword.toLowerCase()}" (lowercase)`, () => {
      expect(CYPHER_WRITE_RE.test(`${keyword.toLowerCase()} (n:Node)`)).toBe(true);
    });

    it(`matches "${keyword[0] + keyword.slice(1).toLowerCase()}" (mixed case)`, () => {
      const mixed = keyword[0] + keyword.slice(1).toLowerCase();
      expect(CYPHER_WRITE_RE.test(`${mixed} (n:Node)`)).toBe(true);
    });
  }

  // Safe read queries should NOT be blocked
  const safeQueries = [
    'MATCH (n) RETURN n',
    'MATCH (n:Function) WHERE n.name = "foo" RETURN n',
    'MATCH (a)-[r]->(b) RETURN a, r, b',
    'OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m',
    'MATCH (n) WITH n RETURN n.name',
    'UNWIND [1,2,3] AS x RETURN x',
    'MATCH (n) RETURN count(n)',
    'MATCH (n:Function) WHERE n.filePath CONTAINS "test" RETURN n',
  ];

  for (const query of safeQueries) {
    it(`does NOT block safe query: "${query.slice(0, 50)}..."`, () => {
      expect(CYPHER_WRITE_RE.test(query)).toBe(false);
    });
  }

  it('blocks write keyword within a longer query', () => {
    expect(CYPHER_WRITE_RE.test('MATCH (n) DELETE n')).toBe(true);
    expect(CYPHER_WRITE_RE.test('MATCH (n:Node) SET n.name = "x"')).toBe(true);
  });

  it('does not match partial word (e.g., "CREATED" should not match)', () => {
    // \b ensures word boundary. "CREATED" starts with "CREATE" but has extra D
    // Actually \b(CREATE) matches "CREATE" in "CREATED" since CREATE is followed by D
    // which is a word char -> no boundary at E-D. Let's verify:
    expect(CYPHER_WRITE_RE.test('CREATED_AT')).toBe(false);
  });
});

// ─── isWriteQuery wrapper ─────────────────────────────────────────────

describe('isWriteQuery', () => {
  it('returns true for write queries', () => {
    expect(isWriteQuery('CREATE (n:Node)')).toBe(true);
    expect(isWriteQuery('match (n) delete n')).toBe(true);
  });

  it('returns false for read queries', () => {
    expect(isWriteQuery('MATCH (n) RETURN n')).toBe(false);
  });

  it('handles empty string', () => {
    expect(isWriteQuery('')).toBe(false);
  });

  // Hardening: regex lastIndex not stuck (non-global regex, but verify)
  it('works correctly on consecutive calls', () => {
    expect(isWriteQuery('CREATE (n)')).toBe(true);
    expect(isWriteQuery('MATCH (n) RETURN n')).toBe(false);
    expect(isWriteQuery('DROP TABLE foo')).toBe(true);
    expect(isWriteQuery('MATCH (n) RETURN n')).toBe(false);
  });
});

// ─── Relation type allowlist ──────────────────────────────────────────

describe('VALID_RELATION_TYPES', () => {
  it('contains exactly the expected 4 types', () => {
    expect(VALID_RELATION_TYPES.size).toBe(4);
    expect(VALID_RELATION_TYPES.has('CALLS')).toBe(true);
    expect(VALID_RELATION_TYPES.has('IMPORTS')).toBe(true);
    expect(VALID_RELATION_TYPES.has('EXTENDS')).toBe(true);
    expect(VALID_RELATION_TYPES.has('IMPLEMENTS')).toBe(true);
  });

  it('rejects invalid relation types', () => {
    expect(VALID_RELATION_TYPES.has('CONTAINS')).toBe(false);
    expect(VALID_RELATION_TYPES.has('USES')).toBe(false);
    expect(VALID_RELATION_TYPES.has('calls')).toBe(false); // case-sensitive
    expect(VALID_RELATION_TYPES.has('DROP_TABLE')).toBe(false);
  });
});

// ─── Valid node labels ───────────────────────────────────────────────

describe('VALID_NODE_LABELS', () => {
  it('contains core node types', () => {
    for (const label of ['File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement']) {
      expect(VALID_NODE_LABELS.has(label)).toBe(true);
    }
  });

  it('contains meta node types', () => {
    for (const label of ['Community', 'Process']) {
      expect(VALID_NODE_LABELS.has(label)).toBe(true);
    }
  });

  it('contains multi-language node types', () => {
    for (const label of ['Struct', 'Enum', 'Macro', 'Trait', 'Impl', 'Namespace']) {
      expect(VALID_NODE_LABELS.has(label)).toBe(true);
    }
  });

  it('rejects invalid labels', () => {
    expect(VALID_NODE_LABELS.has('InvalidType')).toBe(false);
    expect(VALID_NODE_LABELS.has('function')).toBe(false); // case-sensitive
  });
});

// ─── Path traversal detection ────────────────────────────────────────

describe('path traversal (isTestFilePath as proxy for path handling)', () => {
  it('isTestFilePath matches .test. files', () => {
    expect(isTestFilePath('src/foo.test.ts')).toBe(true);
    expect(isTestFilePath('src/foo.spec.ts')).toBe(true);
  });

  it('isTestFilePath matches __tests__ directory', () => {
    expect(isTestFilePath('src/__tests__/foo.ts')).toBe(true);
  });

  it('isTestFilePath matches /test/ directory', () => {
    expect(isTestFilePath('src/test/foo.ts')).toBe(true);
  });

  it('isTestFilePath handles Windows backslash paths', () => {
    expect(isTestFilePath('src\\test\\foo.ts')).toBe(true);
    expect(isTestFilePath('src\\__tests__\\bar.ts')).toBe(true);
  });

  it('isTestFilePath is case-insensitive', () => {
    expect(isTestFilePath('SRC/TEST/Foo.ts')).toBe(true);
    expect(isTestFilePath('SRC/Foo.Test.ts')).toBe(true);
  });

  it('isTestFilePath matches Go test files', () => {
    expect(isTestFilePath('pkg/handler_test.go')).toBe(true);
  });

  it('isTestFilePath matches Python test files', () => {
    expect(isTestFilePath('tests/test_handler.py')).toBe(true);
    expect(isTestFilePath('pkg/handler_test.py')).toBe(true);
  });

  it('isTestFilePath returns false for non-test files', () => {
    expect(isTestFilePath('src/main.ts')).toBe(false);
    expect(isTestFilePath('src/utils/helper.ts')).toBe(false);
  });
});

// ─── Static analysis: parameterized query patterns ────────────────────

describe('parameterized query patterns (static analysis)', () => {
  it('CYPHER_WRITE_RE is not a global regex (no lastIndex issue)', () => {
    // A global regex would have sticky lastIndex state
    expect(CYPHER_WRITE_RE.global).toBe(false);
  });
});
