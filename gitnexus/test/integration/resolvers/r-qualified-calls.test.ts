/**
 * R `pkg::fn()` / `pkg:::fn()` qualified calls.
 *
 * Fixtures: `r-qualified-calls/` (package discovery completes: certainly-external
 * qualifiers exist), `r-qualified-calls-truncated/` (discovery stops at depth 3 and a
 * package nested deeper is invisible, so its locality is UNKNOWN) and
 * `r-qualified-calls-deep-fixtures/` (a `tests/testthat/fixtures` directory below the depth
 * limit holds no package, so discovery still counts as complete), `r-no-description/` (a
 * repo with no DESCRIPTION: discovery completes with zero packages, so every qualifier is
 * external) and `r-no-description-truncated/` (zero packages found, but a skipped subtree
 * hides one, so locality is UNKNOWN).
 *
 * The qualifier names the package:
 *   - exactly one definition of the name in a local package  -> precise binding (0.85);
 *   - two or more definitions in that package (same-file redefinition or across files)
 *     -> the site is dropped, no edge (every valid target is inside the named package);
 *   - certainly external package (discovery complete, not local) -> dropped, no edge;
 *   - local package with ZERO definitions (re-export), or UNKNOWN locality -> the site is
 *     kept: today's behaviour, unchanged;
 *   - the global-name-fallback veto allows a candidate inside the named package.
 *
 * Seven tests in `r.test.ts` and `r-namespace-imports.test.ts` that once documented the
 * earlier name-only behaviour (the qualifier discarded, the candidate guessed by name) now
 * assert the qualifier-aware result (each is marked "qualifier flip"). `pkgB::CleanData` (`r.test.ts` ~:99, ~:1211) stays green:
 * one definition, bound by import already.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, type PipelineResult, runPipelineFromRepo } from './helpers.js';

const summaries = (result: PipelineResult, sourceName: string, file: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.source === sourceName && e.sourceFilePath === file)
    .map((e) => `${e.target}:${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
    .sort();

/** One qualified-call caller and the edge set the qualifier must produce. */
interface Case {
  readonly title: string;
  readonly caller: string;
  readonly file: string;
  readonly after: readonly string[];
}

const L = 'caller/R/local_calls.R';
const LOCAL = 'locallib/R/functions.R';

describe('R qualified calls: discovery completes (r-qualified-calls)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-qualified-calls'), () => {});
  }, 60000);

  const cases: readonly Case[] = [
    {
      title: 'wrapper self-loop: tidy() forwarding to locallib::tidy() binds to itself',
      caller: 'tidy',
      file: L,
      after: [`tidy:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'same-file decoy: locallib::decoy_fn() binds to the decoy defined in the caller file',
      caller: 'local_user',
      file: L,
      after: [`decoy_fn:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'package directory name differs from DESCRIPTION Package: (renamed_impl -> renamed)',
      caller: 'renamed_user',
      file: L,
      after: ['compute_it:renamed_impl/R/compute.R:import-resolved:0.85'],
    },
    {
      title: 'pkg:::name reaches an unexported definition of the named local package',
      caller: 'internal_user',
      file: L,
      after: ['hidden:locallib/R/internal.R:import-resolved:0.85'],
    },
    {
      title: 'quoted qualifier "locallib"::quoted_fn()',
      caller: 'quoted_user',
      file: L,
      after: [`quoted_fn:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'backticked qualifier `locallib`::backticked_fn()',
      caller: 'backticked_user',
      file: L,
      after: [`backticked_fn:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'spaced qualifier locallib ::: spaced_fn()',
      caller: 'spaced_user',
      file: L,
      after: ['spaced_fn:locallib/R/internal.R:import-resolved:0.85'],
    },
    {
      title: 'importFrom(altlib, shared) decoy: the qualifier names locallib',
      caller: 'importfrom_decoy_user',
      file: L,
      after: [`shared:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'library(altlib) decoy in a script: the qualifier names locallib',
      caller: 'run.R',
      file: 'caller/scripts/run.R',
      after: [`libshared:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'duplicate definitions, same-file redefinition in duplib (decoy in the caller file)',
      caller: 'dup_same_file_user',
      file: 'caller/R/duplicate_calls.R',
      after: [],
    },
    {
      title: 'duplicate definitions across two files of duplib (decoy in the caller file)',
      caller: 'dup_cross_file_user',
      file: 'caller/R/duplicate_calls.R',
      after: [],
    },
    {
      title: 'certainly external dplyr::filter() with a same-file decoy',
      caller: 'external_same_file_user',
      file: 'caller/R/external_calls.R',
      after: [],
    },
    {
      title: 'certainly external dplyr::mutate() colliding with a definition in another package',
      caller: 'external_other_pkg_user',
      file: 'caller/R/external_calls.R',
      after: [],
    },
    {
      title: 'certainly external dplyr:::internal_helper() with a same-file decoy',
      caller: 'external_internal_user',
      file: 'caller/R/external_calls.R',
      after: [],
    },
  ];

  for (const c of cases) {
    describe(c.title, () => {
      it(`${c.caller}: the qualifier decides the edge`, () => {
        expect(summaries(result, c.caller, c.file)).toEqual([...c.after]);
      });
    });
  }

  describe('local package with zero definitions of the name (re-export): site kept', () => {
    // locallib re-exports reexp_fn from provlib. The design keeps the site, and the R4 veto
    // must keep allowing a candidate outside the named package when that package defines
    // nothing of that name (same allowance the importFrom veto already has). Permanent.
    it('keeps the 0.5 fallback edge to the origin package', () => {
      expect(summaries(result, 'reexport_user', L)).toEqual([
        'reexp_fn:provlib/R/prov.R:global-name-fallback:0.5',
      ]);
    });
  });

  describe('callers outside the case table', () => {
    it('emits no CALLS edge out of the caller package from any other source', () => {
      const callers = new Set(
        getRelationships(result, 'CALLS')
          .filter((e) => e.sourceFilePath.startsWith('caller/'))
          .map((e) => e.source),
      );
      // Dropped callers (external, duplicate-definition) have no edge, so only a subset check holds.
      const known = new Set([...cases.map((c) => c.caller), 'reexport_user']);
      expect([...callers].filter((s) => !known.has(s))).toEqual([]);
    });
  });
});

describe('R qualified calls: discovery truncated (r-qualified-calls-truncated)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'r-qualified-calls-truncated'),
      () => {},
    );
  }, 60000);

  const F = 'caller/R/calls.R';

  // Permanent: locality is UNKNOWN, so the sites are kept and today's edges must not change.
  it('keeps the same-file edge of a qualifier naming a package invisible to discovery', () => {
    // invisiblepkg lives in deep/a/b/c/impl (depth 5, directory name != Package:). Nothing shows
    // it is local, and nothing shows it is external: today's scope-chain edge stays.
    expect(summaries(result, 'unknown_user', F)).toEqual([`unk_fn:${F}:local-call:0.85`]);
  });

  it('does not treat a qualifier as certainly external while discovery is truncated', () => {
    expect(summaries(result, 'truncated_external_user', F)).toEqual([
      `filter:${F}:local-call:0.85`,
    ]);
  });

  describe('package without DESCRIPTION whose files sit under <pkg>/R/', () => {
    const PATH_FN = 'deep/a/b/c/pathpkg/R/p.R';

    // Local through the path segment (no DESCRIPTION), exactly one definition -> precise.
    it('path_local_user: bound to the pathpkg definition, not the same-file decoy', () => {
      expect(summaries(result, 'path_local_user', F)).toEqual([
        `path_fn:${PATH_FN}:import-resolved:0.85`,
      ]);
    });
  });
});

describe('R qualified calls: skipped directory without a package (r-qualified-calls-deep-fixtures)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'r-qualified-calls-deep-fixtures'),
      () => {},
    );
  }, 60000);

  const F = 'caller/R/calls.R';

  // Headline case: the depth-3 skip of tests/testthat/fixtures must not make `dplyr` unknown.
  it('drops dplyr::filter() instead of binding it to the same-file decoy filter()', () => {
    expect(summaries(result, 'external_user', F)).toEqual([]);
  });

  it('still binds a qualifier naming the discovered package precisely', () => {
    expect(summaries(result, 'own_user', F)).toEqual([
      'own_fn:caller/R/util.R:import-resolved:0.85',
    ]);
  });
});

describe('R qualified calls: no DESCRIPTION anywhere (r-no-description)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-no-description'), () => {});
  }, 60000);

  // Discovery completed and found zero packages, so no qualifier can name a local package.
  it('drops dplyr::filter() instead of binding it to a same-named function elsewhere', () => {
    expect(summaries(result, 'run_ext', 'R/b.R')).toEqual([]);
  });

  it('drops dplyr::mutate() called from a script instead of binding it to R/a.R', () => {
    expect(summaries(result, 'run_same', 'scripts/run.R')).toEqual([]);
  });

  it('drops dplyr::select() instead of binding it to the same-file decoy', () => {
    expect(summaries(result, 'run_decoy', 'scripts/run.R')).toEqual([]);
  });
});

describe('R qualified calls: no package found and discovery truncated (r-no-description-truncated)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-no-description-truncated'), () => {});
  }, 60000);

  // Permanent guard: zero packages found, but a skipped subtree hides one, so the
  // qualifier is not provably external and today's name guess must stay.
  it('keeps the name-guess edge while discovery is truncated', () => {
    expect(summaries(result, 'run_ext', 'R/b.R')).toEqual([
      'filter:R/a.R:global-name-fallback:0.5',
    ]);
  });
});
