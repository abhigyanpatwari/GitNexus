/**
 * A1/A5 — property access on a PLAIN OBJECT LITERAL must be answerable.
 *
 * Verified root cause: `Property` definition nodes are created only for
 * DECLARED CLASS FIELDS. Object-literal keys mint no node, so `ACCESSES` has
 * no target and "who reads/writes this config field?" returns a confident
 * zero. Capture and emission are already correct and language-neutral — a
 * `read`/`write` site maps to `ACCESSES` for any resolved target — so this is
 * purely definition-node coverage plus receiver resolution.
 *
 * Two receiver shapes, deliberately separated:
 *   - through the holding variable (`exitRules.exitMinAtrMult`) — the receiver
 *     is typeable, so this must resolve precisely.
 *   - through an untyped param (`cfg.exitMinAtrMult`) — the option-bag shape
 *     that dominates idiomatic JS. Not precisely solvable without types;
 *     covered by name-based fallback at reduced confidence.
 *
 * STATUS — definition nodes DONE, edge resolution REMAINING.
 *
 * Done: object-literal keys bound to a variable now mint both halves — the
 * graph `Property` node (JAVASCRIPT_QUERIES) and the scope-resolution def
 * (languages/javascript/query.ts). A config field is findable by name where it
 * previously did not exist as a symbol at all.
 *
 * Remaining: the ACCESSES edges. The two receiver shapes need different
 * mechanisms and neither is implemented:
 *   - Through the holding variable (`exitRules.exitMinAtrMult`) the receiver is
 *     typeable, so it must resolve precisely — the Const holding the literal
 *     has to be typed to the literal's scope, the way `classScopeByDefId` maps
 *     a class def to its scope.
 *   - Through an untyped param (`cfg.exitMinAtrMult`) it is not typeable in
 *     plain JS and needs name-based matching — sanctioned for dynamic languages
 *     here (`fieldFallbackOnMethodLookup` defaults on, and the Vue provider
 *     documents it recovering plain-object-literal cases) but it must carry
 *     reduced confidence so precision is not overclaimed.
 *
 * TRAP, learned the hard way and recorded so the next reader does not repeat
 * it: under vitest the PARSE WORKER runs the BUILT `dist/` code, because
 * `parse-impl.ts` resolves `../workers/parse-worker.js`, which does not exist
 * under `src/`, and falls back to dist. Scope resolution runs from `src`. So a
 * change to TYPESCRIPT/JAVASCRIPT_QUERIES is invisible to tests until
 * `npm run build` — it reads exactly like a failed hypothesis.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('JavaScript plain-object property access (A1/A5)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-object-properties'),
      () => {},
    );
  }, 60000);

  const propertyNames = (): string[] =>
    Array.from(
      (result as unknown as { graph: { iterNodes(): Iterable<PropNode> } }).graph.iterNodes(),
    )
      .filter((n) => n.label === 'Property')
      .map((n) => String(n.properties.name));

  const readersOf = (field: string): string[] =>
    getRelationships(result, 'ACCESSES')
      .filter((e) => e.target === field)
      .map((e) => e.source);

  it('indexes object-literal keys as Property nodes', () => {
    const props = propertyNames();
    expect(props).toContain('exitMinAtrMult');
    expect(props).toContain('stopAtrMult');
  });

  it('gives every indexed key a distinct node, not one merged symbol', () => {
    const props = propertyNames().filter((n) => n === 'exitMinAtrMult' || n === 'stopAtrMult');
    expect(new Set(props).size).toBe(2);
  });

  it('emits ACCESSES for a read through the holding variable', () => {
    expect(readersOf('exitMinAtrMult')).toContain('readViaVariable');
  });

  it('emits ACCESSES for the property WRITE (A5)', () => {
    const writes = getRelationships(result, 'ACCESSES').filter(
      (e) => e.target === 'exitMinAtrMult' && (e.rel.reason ?? '').includes('write'),
    );
    expect(writes.map((e) => e.source)).toContain('tightenExit');
  });

  it('emits ACCESSES for a read through an untyped param (option bag)', () => {
    expect(readersOf('exitMinAtrMult')).toContain('applyRules');
  });

  it('marks a name-inferred edge at reduced confidence, not as precise', () => {
    const inferred = getRelationships(result, 'ACCESSES').filter(
      (e) => e.target === 'exitMinAtrMult' && (e.rel.reason ?? '').includes('unique-name'),
    );
    expect(inferred.length).toBeGreaterThan(0);
    for (const e of inferred) expect(e.rel.confidence).toBeLessThan(0.85);
  });
});

interface PropNode {
  readonly label: string;
  readonly properties: Record<string, unknown>;
}
