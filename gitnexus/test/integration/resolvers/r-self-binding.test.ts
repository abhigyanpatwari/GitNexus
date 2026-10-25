/**
 * R6: `self` inside a method is the instance of the class the method is written in.
 *
 * `self$m()` resolves through the class and its parents (`inherit =`), never to a free
 * function of the same name: R reads `m` off the object, so a top-level `m` is no candidate.
 * Where `self` is not an R6 instance (a free function, a parameter called `self`, an R6Class
 * call that is not assigned to a name) the call is left unresolved and the outcome says why.
 *
 * Fixture `r-self-binding/R/` (one repository, a case per file, `cN_` prefixes keep the names apart):
 *   - c1  inherited method, with a free function of that name in the same file (decoy)
 *   - c1b the same with the parent in another file
 *   - c2  inherited method, no decoy
 *   - c3  the class's own method, with a decoy
 *   - c4  self$m() where no class in the chain defines m, with a decoy
 *   - c5  inherited method, parent in another file, decoy in a third file
 *   - c6/c7/c8  private$m(), super$m() and obj$m() with decoys: no edge
 *   - c9  a free function, a parameter named self, a closure in a method, a missing method
 *   - c10 an R6Class call that is not assigned, a RefClass method
 *   - c11 the argument count differs from the method's formals
 *   - c12 a class name in backticks, an R6Class call inside a function, a dotted class name
 *   - c13 a file that binds self itself; c13b a file that reads a self bound in another file
 *   - c14 a method that writes through self (`self$x <- v` and its element and replacement forms)
 *     before calling through it, and one that rebinds self plainly (`self <- other()`)
 *   - c15 self$ reaches public members only: a private method of the class or a parent is not on
 *     self, and a child's private method does not hide a parent's public one
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

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'r-self-binding'), () => {});
}, 120000);

/** `label:target id` of every CALLS edge out of `source` in `file`, with its reason and confidence. */
const callsFrom = (source: string, file: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.source === source && e.sourceFilePath === file)
    .map((e) => `${e.rel.targetId}:${e.rel.reason}:${e.rel.confidence}`)
    .sort();

const targets = (source: string, file: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.source === source && e.sourceFilePath === file)
    .map((e) => e.rel.targetId)
    .sort();

const outcomesFor = (file: string, name: string) =>
  getResolutionOutcomes(result).filter((o) => o.filePath === file && o.name === name);

describe('R6 self$method() binds the enclosing class and its parents', () => {
  it.each([
    ['c1 inherited, decoy beside the hit', 'c1_run', 'R/c1.R', 'Method:R/c1.R:C1Base.c1_greet#0'],
    [
      'c1b inherited, parent in another file',
      'c1b_run',
      'R/c1b_child.R',
      'Method:R/c1b_base.R:C1bBase.c1b_greet#0',
    ],
    ['c2 inherited, no decoy', 'c2_run', 'R/c2.R', 'Method:R/c2.R:C2Base.c2_greet#0'],
    ['c3 own method, decoy', 'c3_run', 'R/c3.R', 'Method:R/c3.R:C3Child.c3_greet#0'],
    [
      'c5 inherited, parent in another file, decoy in a third',
      'c5_run',
      'R/c5_child.R',
      'Method:R/c5_base.R:C5Base.c5_greet#0',
    ],
    ['c9 a closure inside a method', 'c9_nested', 'R/c9.R', 'Method:R/c9.R:C9Holder.c9_own#0'],
    ['c11 fewer arguments than formals', 'c11_few', 'R/c11.R', 'Method:R/c11.R:C11Base.c11_two#2'],
    ['c11 more arguments than formals', 'c11_many', 'R/c11.R', 'Method:R/c11.R:C11Base.c11_none#0'],
    ['c11 a method taking ...', 'c11_spread', 'R/c11.R', 'Method:R/c11.R:C11Base.c11_dots'],
    [
      'c12 a class name in backticks',
      'c12_ticked_run',
      'R/c12.R',
      'Method:R/c12.R:`C12 Ticked`.c12_ticked_greet#0',
    ],
    [
      'c12 an R6Class call inside a function',
      'c12_inner_run',
      'R/c12.R',
      'Method:R/c12.R:function.c12_inner_greet@19:6#0',
    ],
    [
      'c13 a file that binds self: its free function reads that object',
      'c13_reads_global_self',
      'R/c13.R',
      'Method:R/c13.R:C13Global.c13_global_m#0',
    ],
    [
      'c14 self$x <- v, then an own method',
      'c14_run_own',
      'R/c14.R',
      'Method:R/c14.R:C14Child.c14_own#0',
    ],
    [
      'c14 self$x <- v, then an inherited method',
      'c14_run_inherited',
      'R/c14.R',
      'Method:R/c14.R:C14Base.c14_greet#0',
    ],
    ['c14 self$x[[i]] <- v', 'c14_run_elem', 'R/c14.R', 'Method:R/c14.R:C14Child.c14_own#0'],
    ['c14 self[["x"]] <- v', 'c14_run_dbl', 'R/c14.R', 'Method:R/c14.R:C14Child.c14_own#0'],
    ['c14 names(self$x) <- v', 'c14_run_repl', 'R/c14.R', 'Method:R/c14.R:C14Child.c14_own#0'],
    ['c15 a public method', 'c15_call_pub', 'R/c15.R', 'Method:R/c15.R:C15Child.c15_pub#0'],
    [
      'c15 a public parent method, not the private one of the same name in the child',
      'c15_call_shared',
      'R/c15.R',
      'Method:R/c15.R:C15Base.c15_shared#0',
    ],
    [
      'c15 a private method calling a public one through self',
      'c15_from_private',
      'R/c15.R',
      'Method:R/c15.R:C15Child.c15_pub#0',
    ],
  ])('%s', (_label, source, file, expected) => {
    expect(targets(source, file)).toEqual([expected]);
  });
});

describe('R6 self$method(): the edge it gets', () => {
  it('c1 is an in-file MRO hit at the receiver-call confidence, c1b a cross-file one', () => {
    expect(callsFrom('c1_run', 'R/c1.R')).toEqual(['Method:R/c1.R:C1Base.c1_greet#0:global:0.85']);
    expect(callsFrom('c1b_run', 'R/c1b_child.R')).toEqual([
      'Method:R/c1b_base.R:C1bBase.c1b_greet#0:import-resolved:0.85',
    ]);
  });

  it('c14 a write through self keeps the receiver-call confidence', () => {
    expect(callsFrom('c14_run_own', 'R/c14.R')).toEqual([
      'Method:R/c14.R:C14Child.c14_own#0:global:0.85',
    ]);
    expect(callsFrom('c14_run_inherited', 'R/c14.R')).toEqual([
      'Method:R/c14.R:C14Base.c14_greet#0:global:0.85',
    ]);
  });

  it('c15 a public parent method is an in-file MRO hit, past the child private one', () => {
    expect(callsFrom('c15_call_shared', 'R/c15.R')).toEqual([
      'Method:R/c15.R:C15Base.c15_shared#0:global:0.85',
    ]);
  });
});

describe('R6 self$method() with a dotted class name gets no receiver lookup', () => {
  // The shared receiver pass reads a dotted type name (`C12.DChild`) as a qualified one and does
  // not walk its parents, so a lexically visible free function of the name could be bound. R
  // refuses the lookup for a dotted class name (`suppressReceiverLookup`): the call is
  // unresolved, which also gives up the own method's correct edge (R-13).
  it.each([
    ['c12 own method', 'c12_dotted_run', 'c12_dotted_greet', 6],
    ['c12 inherited', 'c12_dinh_run', 'c12_dinh', 32],
    ['c12 missing', 'c12_dmissing_run', 'c12_dmissing', 33],
  ])('%s: no edge, receiver-unresolved', (_label, source, name, line) => {
    expect(targets(source, 'R/c12.R')).toEqual([]);
    const suppressed = outcomesFor('R/c12.R', name).filter((o) => o.kind === 'suppressed');
    expect(
      suppressed.map((o) => `${o.range.startLine}:${o.kind === 'suppressed' ? o.reason : ''}`),
    ).toEqual([`${line}:receiver-unresolved`]);
  });
});

describe('R6 self$method() never reaches a free function', () => {
  it.each([
    ['c4 no such method, decoy', 'c4_run', 'R/c4.R'],
    ['c6 private$secret() with a decoy', 'c6_run', 'R/c6_c7_c8.R'],
    ['c7 super$greet()', 'c7_greet', 'R/c6_c7_c8.R'],
    ['c8 obj$greet() with a decoy', 'c8_use', 'R/c6_c7_c8.R'],
    ['c9 a free function using self', 'c9_free', 'R/c9.R'],
    ['c9 a parameter named self', 'c9_param', 'R/c9.R'],
    ['c9 a method that does not exist', 'c9_missing', 'R/c9.R'],
    ['c14 self$x <- v, then a method that does not exist', 'c14_run_missing', 'R/c14.R'],
    ['c15 a private parent method through self', 'c15_call_hidden', 'R/c15.R'],
    ['c15 a private own method through self', 'c15_call_mine', 'R/c15.R'],
    ['c15 private$m() (private$ is not modelled)', 'c15_priv_mine', 'R/c15.R'],
  ])('%s: no edge', (_label, source, file) => {
    expect(callsFrom(source, file)).toEqual([]);
  });

  it('c10 an R6Class call that is not assigned, and a RefClass method, give self no class and no decoy edge', () => {
    expect(getRelationships(result, 'CALLS').filter((e) => e.target === 'c10_other')).toEqual([]);
  });

  it('no CALLS edge targets a free function the cases use as a decoy (dotted class names aside)', () => {
    const decoys = new Set([
      'c1_greet',
      'c1b_greet',
      'c3_greet',
      'c4_nothere',
      'c5_greet',
      'c6_secret',
      'c8_greet',
      'c9_nothere',
      'c10_other',
      'c11_two',
      'c11_dots',
      'c11_none',
      'c14_own',
      'c14_greet',
      'c14_nothere',
      'c15_hidden',
      'c15_mine',
      'c15_shared',
    ]);
    expect(
      getRelationships(result, 'CALLS')
        .filter((e) => decoys.has(e.target) && e.targetLabel === 'Function')
        .map((e) => `${e.source} -> ${e.target}`),
    ).toEqual([]);
  });
});

describe('R6 self$method() that cannot be bound is an outcome, not silence', () => {
  it.each([['c9 a free function', 'R/c9.R', 'c9_nothere', 'receiver-owned-but-unbound']])(
    '%s',
    (_label, file, name, reason) => {
      const suppressed = outcomesFor(file, name).filter((o) => o.kind === 'suppressed');
      expect(suppressed.map((o) => (o.kind === 'suppressed' ? o.reason : ''))).toContain(reason);
    },
  );

  it.each([
    ['c4', 'R/c4.R', 'c4_nothere', 4],
    ['c9 a method that does not exist', 'R/c9.R', 'c9_nothere', 12],
    ['c14 self$x <- v, then a method that does not exist', 'R/c14.R', 'c14_nothere', 24],
    [
      'c14 self <- C14Base$new(): typed as the parent, which lacks the method',
      'R/c14.R',
      'c14_own',
      44,
    ],
    ['c15 a private parent method is not on self', 'R/c15.R', 'c15_hidden', 16],
    ['c15 a private own method is not on self', 'R/c15.R', 'c15_mine', 17],
  ])(
    '%s: a typed self whose class and parents lack the method is a suppressed lookup with no candidate',
    (_label, file, name, line) => {
      // The outcome label is `member-lookup-ambiguous`: the only suppression a language can ask
      // for without a shared-code change; "member not found" would be exact.
      const outcomes = outcomesFor(file, name).filter(
        (o) => 'range' in o && o.range.startLine === line,
      );
      expect(outcomes.map((o) => [o.kind, o.kind === 'suppressed' ? o.reason : ''])).toEqual([
        ['suppressed', 'member-lookup-ambiguous'],
      ]);
      expect(outcomes.every((o) => o.kind === 'suppressed' && o.candidateIds.length === 0)).toBe(
        true,
      );
    },
  );

  it('c10 an unassigned R6Class and a RefClass method: self is owned and untyped', () => {
    const reasons = outcomesFor('R/c10_unassigned.R', 'c10_other').map((o) =>
      o.kind === 'suppressed' ? o.reason : o.kind,
    );
    expect(reasons).toEqual(['receiver-owned-but-unbound', 'receiver-owned-but-unbound']);
  });

  it('c14 a plain `self <- other()` in a method rebinds self: owned and untyped, no edge', () => {
    expect(targets('c14_rebind', 'R/c14.R')).toEqual(['Function:R/c14.R:c14_other']);
    const reasons = outcomesFor('R/c14.R', 'c14_own')
      .filter((o) => 'range' in o && o.range.startLine === 40)
      .map((o) => (o.kind === 'suppressed' ? o.reason : o.kind));
    expect(reasons).toEqual(['receiver-owned-but-unbound']);
  });

  it('c13 a file that binds self records no suppression for its free function', () => {
    expect(outcomesFor('R/c13.R', 'c13_global_m')).toEqual([]);
  });

  it('c13b a self bound in another file is not followed (limit): no edge, self is owned but unbound', () => {
    expect(targets('c13b_reads_global_self', 'R/c13b_reader.R')).toEqual([]);
    expect(
      outcomesFor('R/c13b_reader.R', 'c13_global_m').map((o) =>
        o.kind === 'suppressed' ? o.reason : o.kind,
      ),
    ).toEqual(['receiver-owned-but-unbound']);
  });
});
