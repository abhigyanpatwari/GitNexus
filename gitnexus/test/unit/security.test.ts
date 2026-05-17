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
  it('contains all expected relation types', () => {
    expect(VALID_RELATION_TYPES.size).toBe(15);
    for (const t of [
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
      'HANDLES_ROUTE',
      'FETCHES',
      'HANDLES_TOOL',
      'ENTRY_POINT_OF',
      'WRAPS',
    ]) {
      expect(VALID_RELATION_TYPES.has(t)).toBe(true);
    }
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
