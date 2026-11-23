/**
 * R: which packages a package's own code can reach through the unique-name guess (0.5).
 *
 * Code in `P/R/` resolves a free name through P's namespace, its imports (`importFrom()`,
 * `import()`), base, the global environment and the search path. A package that passes
 * `R CMD check` reaches another package Q only through its NAMESPACE imports or an attach
 * (`Depends:`, or a `library(Q)` it runs itself), so the guess is refused for calls that P's
 * declared dependencies cannot justify. Undeclared use is not impossible (it is a check NOTE,
 * and an attached sibling package may still answer it at run time): these rules make calls
 * unsupported for check-clean package code unresolved rather than guessed.
 *
 * - Rule A: a caller in `P/R/` (P has a readable NAMESPACE, with nothing hidden from the import
 *   or export reader) and a candidate in another package Q's `R/`: refused unless P has an
 *   `importFrom()` entry for the name (the importFrom rules then decide), `import(Q)`, Q in the
 *   transitive `Depends:` closure, or a `library(Q)` / `require(Q)` in the caller's file.
 * - Rule B: the same caller and a candidate in no package's `R/` (a loose script): refused
 *   unless P has an `importFrom()` entry for the name.
 * - Rule D: a caller under `P/tests/` and a candidate under `P/data-raw/` or `P/inst/`: refused,
 *   unless the caller's file calls `source()`, `system.file()` or `test_path()`.
 *
 * Scripts, tests reaching their own package and vignettes are left as they were.
 *
 * Fixture `r-package-visibility/`: pkgB exports `filter`, `lag`, `mutate`, `b_only`; pkgA
 * imports only dplyr; pkgC imports dplyr's `filter`; pkgD depends on pkgB; pkgE declares
 * nothing; pkgF depends on pkgD (so on pkgB); pkgG imports pkgB only under an `if`; pkgH
 * imports `b_only` from pkgB; pkgI imports all of pkgB except `lag`.
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

const GUESS = 'global-name-fallback:0.5';
const B = 'Function:pkgB/R/b.R';
const TESTS = 'pkgA/tests/testthat';

/** Every CALLS edge of the repository, by source node id: `targetId:reason:confidence`. */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  // Rule A: pkgA imports dplyr, not pkgB.
  'Function:pkgA/R/a.R:a_main': [],
  'Function:pkgA/R/a.R:a_ts': [],
  'Function:pkgA/R/a.R:a_mut': [],
  // Rule A: pkgE declares no dependency at all.
  'Function:pkgE/R/e.R:e_main': [],
  // Rule B: package code never sees a loose script's definitions.
  'Function:pkgE/R/e.R:e_loose': [],
  // A library(pkgB) in the caller's own file attaches pkgB.
  'Function:pkgE/R/e2.R:e_lib': [`${B}:b_only:import-resolved:0.85`],
  // Depends: pkgB, directly and through pkgD.
  'Function:pkgD/R/d.R:d_main': [`${B}:b_only:${GUESS}`],
  'Function:pkgF/R/f.R:f_main': [`${B}:b_only:${GUESS}`],
  // A conditional import(pkgB) is not read, so the rule cannot apply: the guess stays.
  'Function:pkgG/R/g.R:g_main': [`${B}:b_only:${GUESS}`],
  'Function:pkgH/R/h.R:h_main': [`${B}:b_only:import-resolved:0.85`],
  'Function:pkgI/R/i.R:i_main': [`${B}:b_only:${GUESS}`],
  // Rule D: tests/ never load data-raw/ or inst/ scripts by themselves.
  [`File:${TESTS}/test-a.R`]: [],
  [`Function:${TESTS}/test-a.R:t2`]: [],
  // Tests run in the package namespace (private names reachable); a loose script is unchanged.
  [`Function:${TESTS}/test-a.R:t3`]: [`Function:pkgA/R/a.R:a_priv:${GUESS}`],
  [`Function:${TESTS}/test-a.R:t4`]: [`Function:scripts/helpers.R:helper_loose:${GUESS}`],
  // Rule D exemption: the file sources, locates or builds a path to the script itself.
  [`Function:${TESTS}/test-source.R:t5`]: [`Function:pkgA/inst/scripts/tool.R:inst_fun:${GUESS}`],
  [`Function:${TESTS}/test-system-file.R:t6`]: [
    `Function:pkgA/inst/scripts/tool.R:inst_fun:${GUESS}`,
  ],
  [`Function:${TESTS}/test-test-path.R:t7`]: [`Function:pkgA/data-raw/prep.R:make_data:${GUESS}`],
  // (limit, R-10) vignettes count as inside the package, although they see exports only.
  'Function:pkgA/vignettes/v.R:v1': [`Function:pkgA/R/a.R:a_priv:${GUESS}`],
  // Scripts are left alone (documented).
  'Function:scripts/s_dplyr.R:s1': [`${B}:mutate:${GUESS}`],
  'Function:scripts/s_none.R:s2': [`${B}:b_only:${GUESS}`],
  'Function:scripts/s_none.R:s3': [`Function:scripts/helpers.R:helper_loose:${GUESS}`],
};

/** Every refused guess of the repository: `file:line:name`. */
const REFUSED: readonly string[] = [
  'pkgA/R/a.R:1:filter',
  'pkgA/R/a.R:2:lag',
  'pkgA/R/a.R:3:mutate',
  'pkgC/R/c.R:1:filter',
  'pkgE/R/e.R:1:b_only',
  'pkgE/R/e.R:2:helper_loose',
  `${TESTS}/test-a.R:1:make_data`,
  `${TESTS}/test-a.R:2:inst_fun`,
];

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'r-package-visibility'), () => {});
}, 120000);

const callsFrom = (sourceId: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.rel.sourceId === sourceId)
    .map((e) => `${e.rel.targetId}:${e.rel.reason}:${e.rel.confidence}`)
    .sort();

describe('R package visibility: the guess follows declared package dependencies', () => {
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

  it('records every refused guess as fallback-refused', () => {
    const refused = getResolutionOutcomes(result)
      .filter((o) => o.kind === 'fallback-refused')
      .map((o) => `${o.filePath}:${o.range.startLine}:${o.name}`);
    expect(refused.sort()).toEqual([...REFUSED].sort());
  });
});
