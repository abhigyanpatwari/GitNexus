/**
 * R: an ordinary assignment binds its name in the function's own frame, so a call of that name
 * inside the function no longer reaches a top-level function of the same name.
 * `f <- function(x) { helper <- identity; helper(x) }` calls the local `identity`, not `helper()`.
 *
 * The binding is flow-insensitive (a call before the assignment, or a conditional assignment, is
 * left unresolved: the name may or may not be bound there) and counts only values that can be a
 * function: a function literal is a real definition (it keeps resolving to itself) and a constant
 * is skipped by R at a call (it keeps reaching the outer function). `<<-` assigns outward and
 * binds nothing here.
 *
 * Fixture `r-assignment-locals/scripts/d.R` (callers `dN_f`, N is the probe case of the review
 * repro) with a package `pkga` that exports its own `helper`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

const OUTER_HELPER = 'Function:scripts/d.R:helper';
const PKGA_HELPER = 'Function:pkga/R/a.R:helper';

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'r-assignment-locals'), () => {});
}, 120000);

/** Target ids of every CALLS edge out of `source` in the caller file, sorted. */
const targets = (source: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.source === source && e.sourceFilePath === 'scripts/d.R')
    .map((e) => e.rel.targetId)
    .sort();

describe('a local assignment of a function-capable value binds the name', () => {
  it.each([
    ['d1 `<-` of an identifier', 'd1_f'],
    ['d2 `=`', 'd2_f'],
    ['d3 `<-` of a call result', 'd3_f'],
    ['d5 conditional assignment', 'd5_f'],
    ['d7 right assignment `->`', 'd7_f'],
  ])('%s: no edge to the outer helper', (_label, caller) => {
    expect(targets(caller)).not.toContain(OUTER_HELPER);
  });

  it('d3 keeps the edge to the function the right-hand side calls', () => {
    expect(targets('d3_f')).toEqual(['Function:scripts/d.R:some_fn']);
  });

  it('d16 a closure reading the enclosing function local does not reach the outer helper', () => {
    expect(targets('d16_g')).toEqual([]);
    expect(targets('d16_f')).toEqual([expect.stringContaining('d16_g')]);
  });

  it('d4 a call before the assignment is left unresolved (flow-insensitive, documented)', () => {
    expect(targets('d4_f')).toEqual([]);
  });
});

describe('controls: assignments that do not bind a callable local', () => {
  it('d6 a function literal is a real definition: the call reaches the inner function', () => {
    const edges = targets('d6_f');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatch(/^Function:scripts\/d\.R:function\.helper@/);
  });

  it('d13 a constant is skipped by R at a call: the outer function stays the target', () => {
    expect(targets('d13_f')).toEqual([OUTER_HELPER]);
  });

  it('d15 `<<-` assigns outward and binds nothing here: the outer function stays the target', () => {
    expect(targets('d15_f')).toEqual([OUTER_HELPER]);
  });

  it('d9 a parameter keeps stopping the walk', () => {
    expect(targets('d9_f')).toEqual([]);
  });
});

describe('qualified calls inside a function that assigns the same name', () => {
  // Needs the qualified hit to outrank the lexical name claim (the shared-pass step that follows).
  it.fails('d11 `pkga::helper(x)` binds the package function and nothing else', () => {
    expect(targets('d11_f')).toEqual([PKGA_HELPER]);
  });

  it('d12 neither `pkga::missing(x)` (not exported) nor the shadowed bare `missing(x)` gets an edge', () => {
    expect(targets('d12_f')).toEqual([]);
  });
});
