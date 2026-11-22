/**
 * R qualified calls and `library()` against a package NAMESPACE.
 *
 * Fixtures (each subdirectory of `r-qualified-exports/` is its own repository):
 *   - `main/`: packages `exp` (NAMESPACE exports `shown` only), `nons` (no NAMESPACE),
 *     `unr` (a conditional `export`, so its export list is unreadable), `oth` and `imp`;
 *   - `root/`: a root-level package (DESCRIPTION at the repository root) with a nested one;
 *   - `nested/`: a package inside a package;
 *   - `decoy/`: the caller defines its own `fmt` and qualifies calls to other packages' `fmt`.
 *
 * The rules under test (docs/languages/r-provider.md):
 *   - `pkg::name()` binds a definition only when `pkg` exports it (or the caller is inside
 *     `pkg`'s directory tree); `pkg:::name()` binds it regardless;
 *   - `pkg::name()` where `pkg` defines no `name` never falls back to a same-file or other
 *     package's `name`: a re-export via `importFrom` resolves to its origin, anything else
 *     leaves the site unresolved;
 *   - `library(pkg)` brings in only the exported names of a package that has a NAMESPACE;
 *   - the unique-name guess (`global-name-fallback`, 0.5) skips a name that a readable NAMESPACE
 *     proves private, unless the caller is inside that package's directory tree.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getResolutionOutcomes,
  type PipelineResult,
  runPipelineFromRepo,
} from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

const summaries = (result: PipelineResult, source: string, file: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.source === source && e.sourceFilePath === file)
    .map((e) => `${e.target}:${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
    .sort();

/** `line:kind` of every resolution outcome recorded in `file`, in source order. */
const outcomeKinds = (result: PipelineResult, file: string): string[] =>
  getResolutionOutcomes(result).flatMap((o) =>
    o.filePath === file && 'range' in o ? [`${o.range.startLine}:${o.kind}`] : [],
  );

const run = (sub: string): Promise<PipelineResult> =>
  runPipelineFromRepo(path.join(FIXTURES, 'r-qualified-exports', sub), () => {});

describe('R exports: packages with a NAMESPACE, without one, and with an unreadable one (main)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await run('main');
  }, 120000);

  const HIDDEN = 'hidden:exp/R/a.R';
  const cases: readonly (readonly [string, string, string, readonly string[]])[] = [
    // (a) a qualifier names a package that does not define the name
    ['a1 exp::ghost() with a same-file decoy', 'a1_call', 'scripts/qual.R', []],
    [
      'a1 control: exp::shown()',
      'a1_ctrl',
      'scripts/qual.R',
      ['shown:exp/R/a.R:import-resolved:0.85'],
    ],
    ['a3 exp:::ghost() with a same-file decoy', 'a3_call', 'scripts/qual.R', []],
    ['a4 exp::missing(), only package oth defines it', 'a4_call', 'scripts/a4.R', []],
    // (b) private names
    ['b1 library(exp); hidden()', 'b1_hidden', 'scripts/lib.R', []],
    [
      'b1 control: library(exp); shown()',
      'b1_shown',
      'scripts/lib.R',
      ['shown:exp/R/a.R:import-resolved:0.85'],
    ],
    ['b2 exp::hidden()', 'b2_call', 'scripts/priv.R', []],
    [
      'b3 exp:::hidden() reaches the private definition',
      'b3_call',
      'scripts/priv.R',
      [`${HIDDEN}:import-resolved:0.85`],
    ],
    [
      'b4 hidden() from inside exp/R (no library(exp))',
      'inner_bare',
      'exp/R/b.R',
      [`${HIDDEN}:global-name-fallback:0.5`],
    ],
    [
      'b4 exp::hidden() from inside exp/R',
      'inner_qual',
      'exp/R/b.R',
      [`${HIDDEN}:import-resolved:0.85`],
    ],
    ['b5 importFrom(exp, hidden) in another package', 'b5_call', 'imp/R/i.R', []],
    ['b6 bare hidden() from a script', 'b6_call', 'scripts/priv.R', []],
    ['b7 bare hidden() from another package', 'b7_call', 'oth/R/o.R', []],
    // no NAMESPACE: every top-level name stays visible
    [
      'nons: library(nons); nhidden()',
      'n_lib',
      'scripts/nons_lib.R',
      ['nhidden:nons/R/n.R:import-resolved:0.85'],
    ],
    [
      'nons::nhidden()',
      'n_qual',
      'scripts/nons_qual.R',
      ['nhidden:nons/R/n.R:import-resolved:0.85'],
    ],
    [
      'nons:::nhidden()',
      'n_tri',
      'scripts/nons_qual.R',
      ['nhidden:nons/R/n.R:import-resolved:0.85'],
    ],
    [
      'nons: bare nhidden()',
      'n_bare',
      'scripts/nons_bare.R',
      ['nhidden:nons/R/n.R:global-name-fallback:0.5'],
    ],
    // unreadable NAMESPACE: the strict rule for precise tiers, the lenient one for the guess
    ['unr::unr_cond() (not provably exported)', 'unr_q', 'scripts/unr_qual.R', []],
    [
      'unr::unr_shown() control',
      'unr_q_pub',
      'scripts/unr_qual.R',
      ['unr_shown:unr/R/u.R:import-resolved:0.85'],
    ],
    [
      'library(unr); unr_cond(): no import edge, the guess survives',
      'unr_l',
      'scripts/unr_lib.R',
      ['unr_cond:unr/R/u.R:global-name-fallback:0.5'],
    ],
    [
      'library(unr); unr_shown() control',
      'unr_l_pub',
      'scripts/unr_lib.R',
      ['unr_shown:unr/R/u.R:import-resolved:0.85'],
    ],
    [
      'unr: bare unr_cond() keeps the 0.5 guess',
      'unr_b',
      'scripts/unr_bare.R',
      ['unr_cond:unr/R/u.R:global-name-fallback:0.5'],
    ],
    // package tree (tests/ and inst/ are inside the package)
    [
      'exp/tests: library(exp); hidden()',
      'tree_tests',
      'exp/tests/testthat/test-x.R',
      [`${HIDDEN}:global-name-fallback:0.5`],
    ],
    ['exp/inst: hidden()', 'tree_inst', 'exp/inst/x.R', [`${HIDDEN}:global-name-fallback:0.5`]],
    // Known losses and gaps (docs/languages/r-ingestion-gaps.md): pinned as they are today.
    // R-03: R puts the names of a sourced file in the global environment, so `hidden()` binds
    // in R; the private-name veto does not know about source().
    ['R-03 source() of a private package file; hidden()', 'src_hidden', 'scripts/src.R', []],
    // R-12: the library() filter works on names; a class reached as a receiver type through the
    // IMPORTS edge of library(exp) is not filtered, although ResultSet is not exported.
    [
      'R-12 library(exp); ResultSet$new() then rs$count() (private class)',
      'rs_user',
      'scripts/rs_user.R',
      ['count:exp/R/rs.R:import-resolved:0.85'],
    ],
  ];

  for (const [title, source, file, after] of cases) {
    it(`${title}`, () => {
      expect(summaries(result, source, file)).toEqual([...after]);
    });
  }

  it('R-04 a dropped qualified site records no outcome (only the bare hidden() guess is refused, on line 3)', () => {
    // exp::ghost(), exp:::ghost() (qual.R) and exp::hidden() (priv.R line 1) are dropped silently.
    expect(outcomeKinds(result, 'scripts/qual.R')).toEqual([]);
    expect(outcomeKinds(result, 'scripts/priv.R')).toEqual(['3:fallback-refused']);
  });

  it('emits no edge to a private definition from outside the package tree, except through ":::"', () => {
    const toHidden = getRelationships(result, 'CALLS')
      .filter((e) => e.target === 'hidden' && e.targetFilePath === 'exp/R/a.R')
      .filter((e) => !e.sourceFilePath.startsWith('exp/'))
      .map((e) => e.source);
    expect(toHidden).toEqual(['b3_call']);
  });
});

describe('R exports: a root-level package with a nested package (root)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await run('root');
  }, 120000);

  it('a script outside every nested package is inside the root package tree: private name binds', () => {
    expect(summaries(result, 'root_script', 'scripts/s.R')).toEqual([
      'rhidden:R/r.R:global-name-fallback:0.5',
    ]);
  });

  it('a nested package is outside the root package tree: private name vetoed', () => {
    expect(summaries(result, 'sub_fn', 'sub/R/s.R')).toEqual([]);
  });
});

describe('R exports: a package inside a package (nested)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await run('nested');
  }, 120000);

  it('a file under outer/inner/R claims inner, not outer: outer private name vetoed', () => {
    expect(summaries(result, 'i_calls_outer', 'outer/inner/R/i.R')).toEqual([]);
  });

  it('inner private name from inner stays visible', () => {
    expect(summaries(result, 'i_calls_own', 'outer/inner/R/i.R')).toEqual([
      'ihidden:outer/inner/R/i.R:local-call:0.85',
    ]);
  });

  it('outer private name from outer stays visible', () => {
    expect(summaries(result, 'o_in', 'outer/R/o.R')).toEqual([
      'ohidden:outer/R/o.R:local-call:0.85',
    ]);
  });
});

describe('R exports: qualified decoy ladder (decoy)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await run('decoy');
  }, 120000);

  const F = 'scripts/s.R';

  it('(i) pkga re-exports fmt from a local origin with one definition: edge to the origin, never the caller fmt', () => {
    expect(summaries(result, 'l_reexport', F)).toEqual(['fmt:other/R/o.R:import-resolved:0.85']);
  });

  it('(i) the re-export origin is an external package: no edge', () => {
    expect(summaries(result, 'l_ext_origin', F)).toEqual([]);
  });

  it('(i) the re-export origin defines fmt twice: no edge', () => {
    expect(summaries(result, 'l_dup_origin', F)).toEqual([]);
  });

  it('(ii) an external qualifier: no edge (control)', () => {
    expect(summaries(result, 'l_external', F)).toEqual([]);
  });

  it('R-04 the dropped qualified sites (external, duplicate origin, external origin, two hops) record no outcome', () => {
    expect(outcomeKinds(result, F)).toEqual([]);
  });

  it('R-11 a re-export of a re-export (two hops): no edge, one hop only', () => {
    // pkgh re-exports fmt from pkga, which itself only re-exports it from other.
    expect(summaries(result, 'l_two_hop', F)).toEqual([]);
  });
});
