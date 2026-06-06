/**
 * Issue #88 — Go interface methods not indexed.
 *
 * Status: RESOLVED by existing code at
 *   gitnexus/src/core/ingestion/workers/go-relationships.ts:411-450
 *   (`collectGoMethodsFromAST`).
 *
 * The walker visits every `method_declaration` node. For methods that
 * declare a receiver, it attributes the method to the owning Struct.
 * For methods WITHOUT a receiver (interface methods), it walks up the
 * AST to the enclosing `type_declaration > type_spec > interface_type`
 * and sets `ownerId = generateId('Interface', filePath:name)`.
 *
 * This test re-verifies that path on the existing `go-implements/`
 * fixture (which defines `Namer`, `MultiMethoder`, `Reader`, `Closer`,
 * and the embedded `ReadCloser` interface). It is a regression guard:
 * if anyone breaks the parent-walk in `collectGoMethodsFromAST`, this
 * test fails before the production code can ship a silent regression.
 *
 * Scope guard (per design doc m-2 fix): all assertions are scoped to
 * the fixture's own `main.go` to avoid cross-fixture ambiguity if the
 * test runner ever shares an in-memory graph.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

/** Scoped to this fixture's main.go — keeps the test hermetic. */
const MAIN_GO = 'main.go';

const interfaceMethods = (
  result: PipelineResult,
  interfaceName: string,
): string[] =>
  getRelationships(result, 'HAS_METHOD')
    .filter(e =>
      e.source === interfaceName
      && e.sourceLabel === 'Interface'
      && e.targetLabel === 'Method'
      && e.sourceFilePath.endsWith(MAIN_GO),
    )
    .map(e => e.target)
    .sort();

describe('Issue #88 — Go interface methods are indexed (regression guard)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-implements'),
      () => {},
    );
  }, 60000);

  it('Namer interface exposes its single GetName method', () => {
    expect(interfaceMethods(result, 'Namer')).toEqual(['GetName']);
  });

  it('MultiMethoder interface exposes BOTH GetName and GetID', () => {
    expect(interfaceMethods(result, 'MultiMethoder')).toEqual(['GetID', 'GetName']);
  });

  it('Reader interface exposes its single Read method', () => {
    expect(interfaceMethods(result, 'Reader')).toEqual(['Read']);
  });

  it('Closer interface exposes its single Close method', () => {
    expect(interfaceMethods(result, 'Closer')).toEqual(['Close']);
  });

  it('ReadCloser (interface embedding, no direct methods) has ZERO HAS_METHOD edges', () => {
    // ReadCloser is `interface { Reader; Closer }` — it has no direct
    // method_declaration children. The walker must NOT synthesize Method
    // defs for the embedded interfaces' methods. Only the leaf interfaces
    // (Reader, Closer) own the methods.
    //
    // M5 strengthening: a bare `expect([])` is vacuously true — it would
    // also pass if `collectFileTypeInfo` were naively flattened to copy
    // the embedded methods onto the parent. Cross-reference the positive
    // assertions above (Reader→[Read], Closer→[Close]) and assert all
    // three together in one place: ReadCloser is empty, Reader owns Read,
    // Closer owns Close. If a refactor breaks ownership attribution,
    // one of these three assertions will fail with a specific signal.
    expect(interfaceMethods(result, 'ReadCloser')).toEqual([]);
    expect(interfaceMethods(result, 'Reader')).toEqual(['Read']);
    expect(interfaceMethods(result, 'Closer')).toEqual(['Close']);
    // Belt-and-suspenders: confirm the three sets are disjoint. A bug
    // that double-counts a method into multiple interfaces would not
    // be caught by the per-interface toEqual checks alone.
    const allMethods = [
      ...interfaceMethods(result, 'ReadCloser'),
      ...interfaceMethods(result, 'Reader'),
      ...interfaceMethods(result, 'Closer'),
    ];
    expect(new Set(allMethods).size).toBe(allMethods.length);
  });
});
