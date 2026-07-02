/**
 * P0 Unit Tests: Security Hardening
 *
 * Tests security-related utility helpers in isolation:
 * - Relation type allowlist
 * - Path traversal detection
 * - isTestFilePath patterns
 */
import { describe, it, expect } from 'vitest';
import {
  VALID_RELATION_TYPES,
  VALID_NODE_LABELS,
  isTestFilePath,
} from '../../src/mcp/local/local-backend.js';

// ─── Relation type allowlist ──────────────────────────────────────────

describe('VALID_RELATION_TYPES', () => {
  // The expected types are declared once here; the size assertion derives from
  // the array length so adding a new type only requires appending to this list.
  const EXPECTED_RELATION_TYPES = [
    'CALLS',
    'IMPORTS',
    'EXTENDS',
    'IMPLEMENTS',
    'HAS_METHOD',
    'HAS_PROPERTY',
    'METHOD_OVERRIDES',
    'OVERRIDES',
    'METHOD_IMPLEMENTS',
    'ACCESSES',
    // USES is an emitted edge type (emit-references.ts) used in the default
    // impact relTypes + context queries; added to the allowlist in F5.
    'USES',
    'HANDLES_ROUTE',
    'FETCHES',
    'HANDLES_TOOL',
    'ENTRY_POINT_OF',
    'WRAPS',
    // Spring DI @Autowired collection injection (#2200)
    'INJECTS',
  ] as const;

  it('contains all expected relation types', () => {
    expect(VALID_RELATION_TYPES.size).toBe(EXPECTED_RELATION_TYPES.length);
    for (const t of EXPECTED_RELATION_TYPES) {
      expect(VALID_RELATION_TYPES.has(t)).toBe(true);
    }
  });

  it('rejects invalid relation types', () => {
    expect(VALID_RELATION_TYPES.has('CONTAINS')).toBe(false);
    expect(VALID_RELATION_TYPES.has('calls')).toBe(false); // case-sensitive
    expect(VALID_RELATION_TYPES.has('DROP_TABLE')).toBe(false);
  });

  it('taint edge types stay OUT of the impact allow-list (#2083 M3 KTD9a)', () => {
    // impact's BFS traverses symbol space; TAINTED/SANITIZES live in
    // block-space (BasicBlock→BasicBlock) and would be unreachable noise
    // there. The `explain` tool is the dedicated taint consumer. Pinned
    // explicitly so a future "add all emitted types" sweep can't drag them in.
    expect(VALID_RELATION_TYPES.has('TAINTED')).toBe(false);
    expect(VALID_RELATION_TYPES.has('SANITIZES')).toBe(false);
  });

  it('TAINT_PATH stays OUT of the impact allow-list (#2084 M4 KTD9a)', () => {
    // Cross-function TAINT_PATH (Function→Function) is the interprocedural
    // analogue of TAINTED — surfaced ONLY via `explain` (its interprocedural
    // findings), never impact()'s BFS. Pinned so a future allow-all sweep
    // can't drag it in — the size assertion tracks EXPECTED_RELATION_TYPES.
    expect(VALID_RELATION_TYPES.has('TAINT_PATH')).toBe(false);
    // Size should match the expected types list — not a hardcoded number.
    expect(VALID_RELATION_TYPES.size).toBe(EXPECTED_RELATION_TYPES.length);
  });

  it('CDG control-dependence edge types stay OUT of the impact allow-list (#2085 M5)', () => {
    // CDG and POST_DOMINATE are BasicBlock→BasicBlock (block space), like the
    // taint substrate — they must not enter impact()'s symbol-space BFS. Pinned
    // explicitly (not just via the EXPECTED_RELATION_TYPES-derived size guard)
    // so a future "add all emitted types" sweep can't drag them in, mirroring
    // the TAINTED/TAINT_PATH pins.
    expect(VALID_RELATION_TYPES.has('CDG')).toBe(false);
    expect(VALID_RELATION_TYPES.has('POST_DOMINATE')).toBe(false);
    // REACHING_DEF is the other BasicBlock→BasicBlock PDG edge (#2086 impact
    // PDG mode traverses it directly, never through impact's symbol-space BFS).
    // Pinned alongside CDG/POST_DOMINATE so an allow-all sweep can't drag it in.
    expect(VALID_RELATION_TYPES.has('REACHING_DEF')).toBe(false);
  });
});

// ─── Valid node labels ───────────────────────────────────────────────

describe('VALID_NODE_LABELS', () => {
  it('contains core node types', () => {
    for (const label of [
      'File',
      'Folder',
      'Function',
      'Class',
      'Interface',
      'Method',
      'CodeElement',
    ]) {
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
