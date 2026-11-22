/**
 * R: `foo(x) <- v` calls the replacement function `` `foo<-` ``, never `foo`.
 *
 * A call lies in a replacement position when it is in the target chain of `<-`, `=`, `<<-` (left)
 * or `->`, `->>` (right), reached only through first arguments and the bases of `$`, `@`, `[`,
 * `[[`. Every call of the chain is recorded as a call of its setter; the getter half of a nested
 * form (`foo(bar(x)) <- 1` also reads `bar(x)`) has no edge: a missing edge, not a wrong one. Any
 * other argument stays an ordinary call, and so does the right-hand side.
 *
 * Fixture `r-replacement-calls/`: `scripts/e.R` defines a getter, a setter and (through the
 * getter) a decoy for `foo`, `bar`, `names` and `attr`; `scripts/s.R` the string-spelled and S4
 * setters that have no definition node; `scripts/q.R` qualified replacement calls into `pkga`
 * (exports `` `foo<-` `` in backticks), `pkgb` (quoted `"foo<-"`) and `pkgc` (getter only).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'r-replacement-calls'), () => {});
}, 120000);

/** `name:file` of every CALLS target out of the caller `source` in `file`, sorted. */
const targets = (source: string, file = 'scripts/e.R'): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.source === source && e.sourceFilePath === file)
    .map((e) => `${e.target}:${e.targetFilePath}`)
    .sort();

const FOO = 'foo:scripts/e.R';
const BAR = 'bar:scripts/e.R';
const NAMES = 'names:scripts/e.R';
const ATTR = 'attr:scripts/e.R';
const SET_FOO = '`foo<-`:scripts/e.R';
const SET_BAR = '`bar<-`:scripts/e.R';
const SET_NAMES = '`names<-`:scripts/e.R';
const SET_ATTR = '`attr<-`:scripts/e.R';

describe('a call in a replacement position is a call of the setter', () => {
  it.each([
    ['foo(x) <- 1', 'f_simple'],
    ['foo(x) = 1', 'f_eq'],
    ['foo(x) <<- 1', 'f_super'],
    ['1 -> foo(x)', 'f_right'],
    ['1 ->> foo(x)', 'f_right_super'],
  ])('%s: edge to `foo<-`, none to foo', (_form, caller) => {
    expect(targets(caller)).toEqual([SET_FOO]);
  });

  it('foo(bar(x)) <- 1: both setters, no getter (the inner getter edge is dropped)', () => {
    expect(targets('f_nested')).toEqual([SET_BAR, SET_FOO].sort());
  });

  it.each([
    ['foo(x)$a <- 1', 'f_dollar_on_call'],
    ['foo(x)[1] <- 2', 'f_index_on_call'],
  ])('%s: the call in the chain base is the setter', (_form, caller) => {
    expect(targets(caller)).toEqual([SET_FOO]);
  });

  it('foo(x)[bar(1)] <- 2: an index argument stays an ordinary call', () => {
    expect(targets('f_index_arg_of_call_base')).toEqual([BAR, SET_FOO].sort());
  });

  it('foo(x) <- bar(x): the setter plus the right-hand side call', () => {
    expect(targets('f_rhs_both')).toEqual([BAR, SET_FOO].sort());
  });

  it('foo(x, bar(1)) <- 1: a later argument stays an ordinary call', () => {
    expect(targets('f_extra_arg_call')).toEqual([BAR, SET_FOO].sort());
  });

  it('foo(x, bar(1)) <- bar(x): one ordinary call target for both bar calls, plus the setter', () => {
    expect(targets('f_second_arg_chain')).toEqual([BAR, SET_FOO].sort());
  });

  it('a call inside a function literal in the chain stays ordinary', () => {
    expect(targets('f_nested_function')).toEqual([BAR, SET_FOO].sort());
  });

  it('a backtick-spelled callee is still the setter', () => {
    expect(targets('f_backtick_getter')).toEqual([SET_FOO]);
  });

  it('names(x) <- v and attr(x, "a") <- v reach the setters, not the user-defined getters', () => {
    expect(targets('f_names')).toEqual([SET_NAMES]);
    expect(targets('f_names')).not.toContain(NAMES);
    expect(targets('f_attr')).toEqual([SET_ATTR]);
    expect(targets('f_attr')).not.toContain(ATTR);
  });
});

describe('shapes that are not replacement calls', () => {
  it('x[bar(1)] <- 1: the index call is an ordinary call of bar', () => {
    expect(targets('f_index_arg')).toEqual([BAR]);
  });

  it.each([
    ['x$a <- 1', 'f_dollar'],
    ['x[1] <- 2', 'f_idx'],
  ])('%s: no call site, no edge', (_form, caller) => {
    expect(targets(caller)).toEqual([]);
  });

  it('control: a plain read foo(x) calls foo', () => {
    expect(targets('f_plain_read')).toEqual([FOO]);
    expect(targets('f_rhs')).toEqual([FOO]);
    expect(targets('f_pipe_read')).toEqual([FOO]);
  });

  it('control: an explicit `foo<-`(x, 1) is unchanged', () => {
    expect(targets('f_explicit')).toEqual([SET_FOO]);
  });

  it('control: a string-spelled call "foo<-"(x, 1) has no edge, as before', () => {
    expect(targets('f_str_explicit')).toEqual([]);
  });
});

describe('setters with no definition node stay edge-free', () => {
  it('"baz<-" <- function(...) defines nothing: baz(x) <- 1 has no edge (not even to baz)', () => {
    expect(targets('g_string_setter', 'scripts/s.R')).toEqual([]);
  });

  it('setReplaceMethod("qux", ...) defines nothing: qux(x) <- 1 has no edge (not even to qux)', () => {
    expect(targets('g_s4_setter', 'scripts/s.R')).toEqual([]);
  });
});

describe('qualified replacement calls go through the export check of the setter name', () => {
  const q = (caller: string): string[] => targets(caller, 'scripts/q.R');

  it('control: pkga::foo(x) as a read binds pkga foo', () => {
    expect(q('q_read')).toEqual(['foo:pkga/R/f.R']);
  });

  it('pkga::foo(x) <- 1 binds pkga `foo<-` (export written with backticks)', () => {
    expect(q('q_backtick')).toEqual(['`foo<-`:pkga/R/f.R']);
  });

  it('1 -> pkga::foo(x) binds pkga `foo<-`', () => {
    expect(q('q_right')).toEqual(['`foo<-`:pkga/R/f.R']);
  });

  it('pkga::foo(pkga::foo(x)) <- 1 binds the one setter (both levels, one target)', () => {
    expect(q('q_nested')).toEqual(['`foo<-`:pkga/R/f.R']);
  });

  it('pkgb::foo(x) <- 1 binds pkgb `foo<-` (export written as "foo<-")', () => {
    expect(q('q_quoted')).toEqual(['`foo<-`:pkgb/R/f.R']);
  });

  it('pkgc::foo(x) <- 1: the setter is not exported, so the site is dropped (never the getter)', () => {
    expect(q('q_private')).toEqual([]);
  });

  it('pkgc:::foo(x) <- 1 reaches the unexported setter', () => {
    expect(q('q_private_triple')).toEqual(['`foo<-`:pkgc/R/f.R']);
  });
});
