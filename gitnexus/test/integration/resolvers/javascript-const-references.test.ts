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

  // The out-of-core path (#RV-2). Nothing in the suite exercised
  // `GITNEXUS_DISK_SCOPE_INDEX`, and that is where the module-level set was
  // being built from scope-STRIPPED files: it came out empty, which the filter
  // read as "no def is module-level" and used to drop every
  // `Const`/`Variable`/`Static` ACCESSES edge in the repo — including the ones
  // this suite exists to prove exist. It failed silently, on the path large
  // repos take, and no test could see it.
  //
  // Parity is the assertion: the seal is a memory optimization and must not
  // change a single edge.
  describe('under the out-of-core scope seal', () => {
    let sealed: PipelineResult;

    beforeAll(async () => {
      const prev = process.env.GITNEXUS_DISK_SCOPE_INDEX;
      process.env.GITNEXUS_DISK_SCOPE_INDEX = '1';
      try {
        sealed = await runPipelineFromRepo(
          path.join(FIXTURES, 'javascript-const-references'),
          () => {},
        );
      } finally {
        if (prev === undefined) delete process.env.GITNEXUS_DISK_SCOPE_INDEX;
        else process.env.GITNEXUS_DISK_SCOPE_INDEX = prev;
      }
    }, 60000);

    const sealedReaders = (): Set<string> =>
      new Set(
        getRelationships(sealed, 'ACCESSES')
          .filter((e) => e.target === 'DEFAULT_FETCH_LIMIT')
          .map((e) => e.source),
      );

    it('keeps the const edges the unsealed run produced', () => {
      expect([...sealedReaders()].sort()).toEqual([...readersOfConst()].sort());
    });

    it('still withholds the block-local edge', () => {
      // The filter must fail OPEN when scopes are unavailable, not be disabled:
      // the block-local exclusion is a correctness property, not an optimization.
      const toLocal = getRelationships(sealed, 'ACCESSES').filter(
        (e) => e.target === 'localScratchValue',
      );
      expect(toLocal).toEqual([]);
    });
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
