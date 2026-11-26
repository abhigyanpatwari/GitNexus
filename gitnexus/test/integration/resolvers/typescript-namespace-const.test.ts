/**
 * RV-9 — a const bound in a `Namespace` scope is module-level, not a local.
 *
 * The block-local filter added for A2 keeps a read of a block-scoped `const`
 * from minting an edge, because such an edge would retain exactly the inert
 * locals `pruneLocalSymbols` exists to drop. It decided "is this module-level?"
 * by asking `kind === 'Module'`, which is true of the file root and of nothing
 * else — so a value declared in a TS `namespace` (or a Rust `mod`, or a C++ /
 * C# namespace) was classified as a function-local and its reads were dropped.
 *
 * The feature simply did not work there. Reported as a gap rather than a
 * regression: no pre-existing edge was deleted, because the other languages'
 * read/write captures are member-shaped and target `Property`, not
 * `Const`/`Variable`/`Static`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('TypeScript namespace-scoped const references (RV-9)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-namespace-const'), () => {});
  }, 60000);

  const readersOf = (name: string): string[] =>
    getRelationships(result, 'ACCESSES')
      .filter((e) => e.target === name)
      .map((e) => e.source);

  it('emits an edge for a read of a namespace-scoped const', () => {
    expect(readersOf('NAMESPACED_MAX')).toContain('withinNamespace');
  });

  // The bound. A namespace nested in a function body is a local like anything
  // else declared there, so widening "module level" must not reach into one.
  it('still withholds an edge to a const in a function-local namespace', () => {
    expect(readersOf('innerLocalValue')).toEqual([]);
  });
});
