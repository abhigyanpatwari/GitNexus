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

  // Cross-file is NOT yet covered. The reference site exists (the capture
  // fires on `return DEFAULT_FETCH_LIMIT` in consumer.js, verified against the
  // raw query) and a CALL through the very same import statement resolves
  // (`consumerCall → pageSize`, reason `import-resolved`), so the gap is
  // specific to linking a value-kind def across the import edge. Prime
  // suspect: exported-def resolution is callable-only — `findExportedDefByName`
  // returns a def only when `def.type` is `Function`/`Method`
  // (scope/walkers.ts:1323) and its workspace fallback index is
  // `exportedCallableByName`. Both export spellings (`export const X` and
  // `export { X }`) fail identically, so it is not the export syntax.
  it.todo('emits an edge for the cross-file named-import reader');

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
