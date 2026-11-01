/**
 * R: calls of an S4 generator (`Circle <- setClass("Circle", ...)`) and of a plain function of the
 * same name. Characterisation cells: they pin today's behaviour, and no generator-specific rule
 * exists. A call of the name is resolved as any free call.
 *
 * - (limit, R-18) `library(geo); Circle(r = 1)` in a script binds a same-named plain function of
 *   another script at 0.5, although R calls geo's generator: the guess crosses load units. The
 *   same holds for the S4 generic `area(c)` against a plain `area` of a script.
 * - Bioconductor idiom (bare `setClass("Circle", ...)` plus `Circle <- function(r) new(...)`):
 *   the call reaches the constructor function, which is right.
 * - Collate order: in one package, `R/a.R` assigns the generator and `R/b.R` a plain function of
 *   the same name. `b.R` is loaded later and wins, so the 0.5 edge to `b.R` is right. This is why
 *   no rule vetoes a plain function that shares its name with a generator.
 *
 * Fixtures under `r-s4-generator/`, one repository each.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

const GUESS = 'global-name-fallback:0.5';

/** Every CALLS edge of each repository, by source node id: `targetId:reason:confidence`. */
const CASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  generator: {
    // (limit, R-18) the generic `area` and the generator `Circle` of geo are not reached.
    'Function:scripts/use.R:g1': [`Function:scripts/legacy.R:area:${GUESS}`],
    'Function:scripts/use.R:g2': [`Function:scripts/legacy2.R:Circle:${GUESS}`],
    'Function:scripts/nolib.R:g3': [`Function:scripts/legacy.R:area:${GUESS}`],
  },
  'control-scripts': {
    'Function:scripts/c.R:k': [`Function:scripts/b.R:Circle:${GUESS}`],
  },
  'control-package': {
    'Function:scripts/use.R:k': ['Function:geo/R/b.R:Circle:import-resolved:0.85'],
  },
  'collate-order': {
    // Correct: b.R collates after a.R, so its Circle is the binding R calls.
    'Function:geo/R/c.R:k': [`Function:geo/R/b.R:Circle:${GUESS}`],
  },
};

describe.each(Object.entries(CASES))('R S4 generator calls: %s', (fixture, expected) => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-s4-generator', fixture), () => {});
  }, 120000);

  it('has exactly the pinned CALLS edges', () => {
    const actual: Record<string, string[]> = {};
    for (const e of getRelationships(result, 'CALLS')) {
      (actual[e.rel.sourceId] ??= []).push(`${e.rel.targetId}:${e.rel.reason}:${e.rel.confidence}`);
    }
    for (const targets of Object.values(actual)) targets.sort();
    expect(actual).toEqual(expected);
  });
});
