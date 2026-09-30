/**
 * R `pkg::fn()` / `pkg:::fn()` qualified calls (fork #7): failing-first characterisation.
 *
 * Fixtures: `r-qualified-calls/` (package discovery completes: certainly-external
 * qualifiers exist) and `r-qualified-calls-truncated/` (discovery stops at depth 3, so a
 * package nested deeper is invisible and its locality is UNKNOWN).
 *
 * Design being pinned (plan step 3): the qualifier names the package.
 *   - exactly one definition of the name in a local package  -> precise binding (0.85);
 *   - two or more definitions in that package (same-file redefinition or across files)
 *     -> the site is dropped, no edge (every valid target is inside the named package);
 *   - certainly external package (discovery complete, not local) -> dropped, no edge;
 *   - local package with ZERO definitions (re-export), or UNKNOWN locality -> the site is
 *     kept: today's behaviour, unchanged;
 *   - the global-name-fallback veto (R4) allows a candidate inside the named package.
 *
 * Test kinds in this file (all green at this commit; none can pass for the wrong reason):
 *   - plain `it`                      behaviour that holds before AND after step 3 (permanent);
 *   - `it.fails('TARGET ...')`        the behaviour step 3 must produce; flip to `it` at step 3;
 *   - `it('TEMPORARY-PIN ...')`       today's actual result for the SAME edge, so the `it.fails`
 *                                     above cannot pass merely because the edge is absent or a
 *                                     fixture broke. Remove (or invert) at step 3.
 *
 * Existing tests that flip at step 3 (NOT edited in this commit; re-derived by re-running
 * the suite against a temporary spike that implements the design):
 *   r.test.ts (integration/resolvers)
 *    :844  'resolves it by the 0.5 global-name-fallback (the qualifier is unused)'
 *          now ['global-name-fallback:0.5']  -> after ['import-resolved:0.85']  (pkgother::ext_fn, one def)
 *    :854  'documents current name-only behaviour (fork #7)'  (ns_amb_user, pkgother::amb_stage)
 *          now ['amb_stage:pkgmain/R/a.R:local-call']  -> after ['amb_stage:pkgother/R/e.R:import-resolved']
 *    :864  'documents current name-only behaviour (fork #7)'  (ns_amb2_user, two packages one def each)
 *          now callsFrom = []  -> after ['amb_only'] (two edges: pkgother/R/e.R and pkgthird/R/t.R,
 *          pkgthird has no DESCRIPTION: local through its `pkgthird/R/` path)
 *    :1181 inside 'records every refusal as fallback-refused ...' (:1177)
 *          now ['dup_ext', 'mutate', 'mutate']  -> after ['dup_ext', 'mutate'] (the qualified
 *          legacyscore::mutate() is no longer refused; the bare mutate_user() refusal stays)
 *    :1186 'documents current name-only behaviour after importFrom() binding (fork #7)' (qualified_user)
 *          now ['tidy_scores:scorelib/R/s.R:import-resolved:0.85'] (false edge)
 *          -> after ['tidy_scores:legacyscore/R/l.R:import-resolved:0.85']
 *    :1195 'documents current name-only behaviour (fork #7): a correct qualified edge is refused
 *          by the veto' (:1199 is its expect; qualified_mutate_user)
 *          now [] -> after ['mutate:legacyscore/R/l.R:import-resolved:0.85']
 *   scope-resolution/r/r-namespace-imports.test.ts (unit)
 *    :976  T11 isRGlobalNameFallbackPlausible for legacyscore::mutate with candidate in legacyscore
 *          now false -> after true (R4 allows a candidate inside the named package)
 * Stay green (verified): r.test.ts :99 'resolves cross-package pkgB::CleanData call' and the
 * `pkgB::CleanData` importFrom test (~:1211): one definition, bound by import already.
 * No existing fixture expects an edge from a duplicate-definition qualified call.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, type PipelineResult, runPipelineFromRepo } from './helpers.js';

const summaries = (result: PipelineResult, sourceName: string, file: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.source === sourceName && e.sourceFilePath === file)
    .map((e) => `${e.target}:${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
    .sort();

/** One qualified-call caller and the edge set it has today and must have after step 3. */
interface Case {
  readonly title: string;
  readonly caller: string;
  readonly file: string;
  /** Actual edge set at this commit (asserted by the TEMPORARY-PIN test). */
  readonly today: readonly string[];
  /** Edge set the design must produce (asserted by the `it.fails` test). */
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
      today: [`tidy:${L}:local-call:0.85`],
      after: [`tidy:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'same-file decoy: locallib::decoy_fn() binds to the decoy defined in the caller file',
      caller: 'local_user',
      file: L,
      today: [`decoy_fn:${L}:local-call:0.85`],
      after: [`decoy_fn:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'package directory name differs from DESCRIPTION Package: (renamed_impl -> renamed)',
      caller: 'renamed_user',
      file: L,
      today: [`compute_it:${L}:local-call:0.85`],
      after: ['compute_it:renamed_impl/R/compute.R:import-resolved:0.85'],
    },
    {
      title: 'pkg:::name reaches an unexported definition of the named local package',
      caller: 'internal_user',
      file: L,
      today: ['hidden:locallib/R/internal.R:global-name-fallback:0.5'],
      after: ['hidden:locallib/R/internal.R:import-resolved:0.85'],
    },
    {
      title: 'quoted qualifier "locallib"::quoted_fn()',
      caller: 'quoted_user',
      file: L,
      today: [`quoted_fn:${LOCAL}:global-name-fallback:0.5`],
      after: [`quoted_fn:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'backticked qualifier `locallib`::backticked_fn()',
      caller: 'backticked_user',
      file: L,
      today: [`backticked_fn:${LOCAL}:global-name-fallback:0.5`],
      after: [`backticked_fn:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'spaced qualifier locallib ::: spaced_fn()',
      caller: 'spaced_user',
      file: L,
      today: ['spaced_fn:locallib/R/internal.R:global-name-fallback:0.5'],
      after: ['spaced_fn:locallib/R/internal.R:import-resolved:0.85'],
    },
    {
      title: 'importFrom(altlib, shared) decoy: the qualifier names locallib',
      caller: 'importfrom_decoy_user',
      file: L,
      today: ['shared:altlib/R/alt.R:import-resolved:0.85'],
      after: [`shared:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'library(altlib) decoy in a script: the qualifier names locallib',
      caller: 'run.R',
      file: 'caller/scripts/run.R',
      today: ['libshared:altlib/R/alt.R:import-resolved:0.85'],
      after: [`libshared:${LOCAL}:import-resolved:0.85`],
    },
    {
      title: 'duplicate definitions, same-file redefinition in duplib (decoy in the caller file)',
      caller: 'dup_same_file_user',
      file: 'caller/R/duplicate_calls.R',
      today: ['twice:caller/R/duplicate_calls.R:local-call:0.85'],
      after: [],
    },
    {
      title: 'duplicate definitions across two files of duplib (decoy in the caller file)',
      caller: 'dup_cross_file_user',
      file: 'caller/R/duplicate_calls.R',
      today: ['across:caller/R/duplicate_calls.R:local-call:0.85'],
      after: [],
    },
    {
      title: 'certainly external dplyr::filter() with a same-file decoy',
      caller: 'external_same_file_user',
      file: 'caller/R/external_calls.R',
      today: ['filter:caller/R/external_calls.R:local-call:0.85'],
      after: [],
    },
    {
      title: 'certainly external dplyr::mutate() colliding with a definition in another package',
      caller: 'external_other_pkg_user',
      file: 'caller/R/external_calls.R',
      today: ['mutate:provlib/R/prov.R:global-name-fallback:0.5'],
      after: [],
    },
    {
      title: 'certainly external dplyr:::internal_helper() with a same-file decoy',
      caller: 'external_internal_user',
      file: 'caller/R/external_calls.R',
      today: ['internal_helper:caller/R/external_calls.R:local-call:0.85'],
      after: [],
    },
  ];

  for (const c of cases) {
    describe(c.title, () => {
      // TEMPORARY-PIN (remove or invert at step 3): today's actual edges for this caller.
      it(`TEMPORARY-PIN ${c.caller}: current edges (qualifier discarded)`, () => {
        expect(summaries(result, c.caller, c.file)).toEqual([...c.today]);
      });

      // TARGET (step 3): flip to `it`. Fails today because the qualifier is ignored.
      it.fails(`TARGET ${c.caller}: the qualifier decides the edge`, () => {
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
      // Step 3 removes the dropped callers' edges, so only a subset check holds before and after.
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

    // TEMPORARY-PIN (remove or invert at step 3).
    it('TEMPORARY-PIN path_local_user: current edge goes to the same-file decoy', () => {
      expect(summaries(result, 'path_local_user', F)).toEqual([`path_fn:${F}:local-call:0.85`]);
    });

    // TARGET (step 3): local through the path segment, exactly one definition -> precise.
    it.fails('TARGET path_local_user: bound to the pathpkg definition', () => {
      expect(summaries(result, 'path_local_user', F)).toEqual([
        `path_fn:${PATH_FN}:import-resolved:0.85`,
      ]);
    });
  });
});
