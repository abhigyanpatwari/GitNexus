/**
 * R: braces evaluated in an environment of their own are block scopes.
 *
 * `local({...})`, `with(data, {...})`, `within(data, {...})`, testthat's `test_that(desc, {...})`
 * and `describe()` / `it()` evaluate their braces in a new environment, so a function defined
 * inside is visible in those braces only:
 *
 * - a call in the same braces resolves to the block-local definition;
 * - a call from another block or another file does not reach it (`fallback-refused`, never the
 *   0.5 guess), and a constructor-typed local of one `test_that` block types no receiver in the
 *   next one;
 * - `withr::with_options(...)` and `suppressWarnings({...})` evaluate their braces in the
 *   caller's frame, so a definition there stays reachable.
 *
 * (limit) A block-local definition still counts toward the uniqueness of the name: a call in
 * another block of a name that is also defined at top level elsewhere (`stubonly()`,
 * `outerh()` after `local({ outerh <- ... })`) gets no edge, where R calls the top-level
 * definition. A lost edge, not a wrong one; functions nested in functions behave the same.
 *
 * Fixture `r-block-scopes/` (no DESCRIPTION): `R/real.R` holds the top-level definitions,
 * `R/inner.R` a `local()` inside a function, `tests/testthat/` the blocks.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

const T = 'tests/testthat';
const GUESS = 'global-name-fallback:0.5';

/** Every CALLS edge of the repository, by source node id: `targetId:reason:confidence`. */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  // Block "a" calls its own stub (same block); block "b" reaches nothing (limit, see header).
  [`File:${T}/test-a.R`]: [`Function:${T}/test-a.R:mockme:local-call:0.85`],
  // (limit) block "b" of test-c.R calls `stubonly()`: no edge, neither to block "a"'s stub nor
  // to R/real.R.
  [`File:${T}/test-c.R`]: [],
  // (limit) `outerh` of the local() is not in e1's frame; R calls R/real.R's.
  'Function:R/inner.R:e1': [],
  // Block-local definitions of another file: refused.
  [`Function:${T}/test-b.R:b1`]: [],
  [`Function:${T}/test-b.R:b2`]: [],
  [`Function:${T}/test-b.R:b3`]: [],
  [`Function:${T}/test-b.R:b6`]: [],
  [`Function:${T}/test-b.R:b7`]: [],
  [`Function:${T}/test-b.R:b8`]: [],
  // Braces evaluated in the caller's frame: the guess stays.
  [`Function:${T}/test-b.R:b4`]: [`Function:${T}/test-a.R:withr_helper:${GUESS}`],
  [`Function:${T}/test-b.R:b5`]: [`Function:${T}/test-a.R:sw_helper:${GUESS}`],
  // `u` typed in block "a" types `u$save()` there and not `u$greet()` in block "b".
  [`File:${T}/test-types.R`]: ['Method:R/models.R:User.save#0:import-resolved:0.85'],
};

/** Every refused guess of the repository: `file:line:name`. */
const REFUSED: readonly string[] = [
  `${T}/test-b.R:1:desc_helper`,
  `${T}/test-b.R:2:loc_helper`,
  `${T}/test-b.R:3:with_helper`,
  `${T}/test-b.R:6:build_fixture`,
  `${T}/test-b.R:7:within_helper`,
  `${T}/test-b.R:8:ns_helper`,
];

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'r-block-scopes'), () => {});
}, 120000);

const callsFrom = (sourceId: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.rel.sourceId === sourceId)
    .map((e) => `${e.rel.targetId}:${e.rel.reason}:${e.rel.confidence}`)
    .sort();

describe('R block scopes: local(), with(), within(), test_that(), describe() and it()', () => {
  it.each(Object.entries(EXPECTED))('%s', (sourceId, expected) => {
    expect(callsFrom(sourceId)).toEqual([...expected].sort());
  });

  it('the table lists every CALLS edge of the repository', () => {
    const sources = [...new Set(getRelationships(result, 'CALLS').map((e) => e.rel.sourceId))];
    const withEdges = Object.entries(EXPECTED)
      .filter(([, targets]) => targets.length > 0)
      .map(([sourceId]) => sourceId);
    expect(sources.sort()).toEqual(withEdges.sort());
  });

  it('records the calls of another file block-local definitions as fallback-refused', () => {
    const refused = getResolutionOutcomes(result)
      .filter((o) => o.kind === 'fallback-refused')
      .map((o) => `${o.filePath}:${o.range.startLine}:${o.name}`);
    expect(refused.sort()).toEqual([...REFUSED].sort());
  });

  it('keeps every block-local definition as a Function node', () => {
    const names = [...result.graph.iterNodes()]
      .filter((n) => n.label === 'Function' && n.properties.filePath === `${T}/test-a.R`)
      .map((n) => n.properties.name)
      .sort();
    expect(names).toEqual(
      [
        'build_fixture',
        'desc_helper',
        'loc_helper',
        'mockme',
        'ns_helper',
        'sw_helper',
        'with_helper',
        'within_helper',
        'withr_helper',
      ].sort(),
    );
  });
});
