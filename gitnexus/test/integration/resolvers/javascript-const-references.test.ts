/**
 * A2 — references to a module-scope `const` must produce edges.
 *
 * A constant read only as a BARE IDENTIFIER (`Math.max(LIMIT, n)`, a default
 * parameter value, `return LIMIT`) produced no reference site at all, so
 * "who uses this constant?" — the question behind every dead-code trim and
 * constants refactor — answered with a confident zero rather than "unknown".
 *
 * The registries already accept it (`FIELD_KINDS` includes `Const`) and the
 * scope query already declares it (`@declaration.const`), so this is about the
 * reference SITE existing: JS/TS captured only `@reference.read.member`, which
 * requires a receiver a bare identifier does not have.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('JavaScript module-scope const references (A2)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-const-references'),
      () => {},
    );
  }, 60000);

  const readersOfConst = (): Set<string> =>
    new Set(
      getRelationships(result, 'ACCESSES')
        .filter((e) => e.target === 'DEFAULT_FETCH_LIMIT')
        .map((e) => e.source),
    );

  it('emits ACCESSES from same-file readers of the const', () => {
    const readers = readersOfConst();
    // fetchAll reads it twice (default param + Math.max); pageSize returns it.
    expect(readers).toContain('fetchAll');
    expect(readers).toContain('pageSize');
  });

  it('emits an edge for the cross-file named-import reader', () => {
    expect(readersOfConst()).toContain('consumerLimit');
  });

  it('does not emit edges to block-local values', () => {
    // The cross-file pass resolves through finalized bindings, which include
    // Const/Variable — block-locals among them. Same-file hits are skipped so
    // an inert local cannot gain an edge and survive pruning.
    const toLocal = getRelationships(result, 'ACCESSES').filter(
      (e) => e.target === 'localScratchValue',
    );
    expect(toLocal).toEqual([]);
  });

  it('targets the Const node itself, not a same-named local', () => {
    const toConst = getRelationships(result, 'ACCESSES').filter(
      (e) => e.target === 'DEFAULT_FETCH_LIMIT',
    );
    expect(toConst.length).toBeGreaterThan(0);
    for (const e of toConst) {
      expect(e.targetLabel).toBe('Const');
      expect(e.targetFilePath).toContain('config.js');
    }
  });
});
