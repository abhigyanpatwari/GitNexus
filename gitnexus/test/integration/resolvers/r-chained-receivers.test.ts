/**
 * R: a call through a chained receiver (`a$b$c()`, `Cls$new()$m()`, `self$f$m()`) is reported as
 * an unresolved receiver, never bound to a free function or to a method of another class.
 *
 * R6 fields and method results carry no declared type, so the chain is never typed. The capture
 * layer mints the chain with the shared codec's `truncated` marker, which makes the shared
 * fold refuse it: the call has no edge and a `receiver-unresolved` outcome says why (the lower
 * bound `impact` reports). A chain whose base is not a plain variable (`get_user()$save()`,
 * `pkg::Cls$new()$m()`, `x[[1]]$f$m()`) mints no site at all: no edge and no outcome.
 *
 * Fixture `r-chained-receivers/R/`: `decoys.R` has free `c`, `m` and `save`; `models.R` an R6
 * `User` (with `save`), an unrelated `Other` (with `c` and `m`), `Cls` (with `m`) and `Holder`
 * (whose method calls `self$f$m()`); `callers.R` one caller per shape.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
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
  result = await runPipelineFromRepo(path.join(FIXTURES, 'r-chained-receivers'), () => {});
}, 120000);

/** Every CALLS target out of `source` in `file`, as its node id, sorted. */
const targets = (source: string, file = 'R/callers.R'): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.source === source && e.sourceFilePath === file)
    .map((e) => e.rel.targetId)
    .sort();

const lines = (file: string): string[] =>
  fs.readFileSync(path.join(FIXTURES, 'r-chained-receivers', file), 'utf8').split('\n');

/** 1-based line of the first line of `file` that contains `text`. */
const lineOf = (file: string, text: string): number => {
  const index = lines(file).findIndex((l) => l.includes(text));
  if (index < 0) throw new Error(`${text} not in ${file}`);
  return index + 1;
};

/** The dropped-site outcomes of `file`, in source order (every outcome here is a drop). */
const dropsIn = (file: string) =>
  getResolutionOutcomes(result)
    .flatMap((o) => (o.kind === 'suppressed' && o.filePath === file ? [o] : []))
    .sort((a, b) => a.range.startLine - b.range.startLine);

/** The outcomes recorded on one source line, as `reason:siteKind:name`. */
const outcomesAt = (file: string, line: number): string[] =>
  dropsIn(file)
    .filter((o) => o.range.startLine === line)
    .map((o) => `${o.reason}:${o.siteKind}:${o.name}`);

/** `reason:name` of every outcome in `file`, in source order. */
const outcomesIn = (file: string): string[] => dropsIn(file).map((o) => `${o.reason}:${o.name}`);

describe('a chain whose base is a variable: unresolved, with an outcome', () => {
  it.each([
    ['a$b$c()', 'a$b$c()', 'chain_dollar_dollar', 'c'],
    ['Cls$new()$m()', 'Cls$new()$m()', 'chain_new_call', 'm'],
    ['a$b$c$d$m()', 'a$b$c$d$m()', 'chain_deep', 'm'],
    ['u$next_user$save()', 'u$next_user$save()', 'chain_typed_base_chain', 'save'],
    // Shapes where a typed walk could succeed: a field initialised with a constructor.
    ['p$addr$save()', 'p$addr$save()', 'chain_field_instance', 'save'],
  ])('%s: no edge, one receiver-unresolved outcome', (_shape, text, caller, name) => {
    expect(targets(caller)).toEqual([]);
    expect(outcomesAt('R/callers.R', lineOf('R/callers.R', text))).toEqual([
      `receiver-unresolved:call:${name}`,
    ]);
  });

  it('p$me()$save(): the inner p$me() keeps its edge, the chained save() has an outcome and no edge', () => {
    expect(targets('chain_method_result')).toEqual(['Method:R/models.R:Person.me#0']);
    expect(outcomesAt('R/callers.R', lineOf('R/callers.R', 'p$me()$save()'))).toEqual([
      'receiver-unresolved:call:save',
    ]);
  });

  it('self$f$m() inside an R6 method: no edge, one receiver-unresolved outcome', () => {
    expect(targets('run', 'R/models.R')).toEqual([]);
    expect(outcomesAt('R/models.R', lineOf('R/models.R', 'self$f$m()'))).toEqual([
      'receiver-unresolved:call:m',
    ]);
  });

  it('no chained call reaches a free function or a method of another class', () => {
    const decoys = getRelationships(result, 'CALLS').filter(
      (e) =>
        e.sourceFilePath !== 'R/decoys.R' &&
        ['c', 'm'].includes(e.target) &&
        !e.rel.targetId.includes('Cls.m'),
    );
    expect(decoys.map((e) => `${e.source} -> ${e.rel.targetId}`)).toEqual([]);
  });
});

describe('control: a plain receiver typed through its constructor still resolves', () => {
  it('u$save() binds User.save exactly', () => {
    expect(targets('control')).toEqual(['Method:R/models.R:User.save#0']);
    expect(outcomesAt('R/callers.R', lineOf('R/callers.R', '  u$save()'))).toEqual([]);
  });

  it('a typed base followed by a plain call is unchanged (chain_typed_base)', () => {
    expect(targets('chain_typed_base')).toEqual(['Method:R/models.R:User.save#0']);
  });
});

describe('a chain with no variable base mints no site (invisible: no edge, no outcome)', () => {
  it.each([
    ['get_user()$save()', 'base_call'],
    ['pkg::Cls$new()$m()', 'base_namespace_new'],
    ['x[[1]]$f$m()', 'base_subset'],
    ['(x)$f$save()', 'base_paren'],
  ])('%s: no edge to the free decoy or to a class method, no outcome', (text, caller) => {
    expect(targets(caller)).toEqual([]);
    expect(outcomesAt('R/callers.R', lineOf('R/callers.R', text))).toEqual([]);
  });

  it('x[1]$save() (a subset receiver, not a chain) is not a site either', () => {
    expect(targets('base_subset_single')).toEqual([]);
    expect(outcomesAt('R/callers.R', lineOf('R/callers.R', 'x[1]$save()'))).toEqual([]);
  });

  it('the only outcomes in callers.R are the six chained calls with a variable base', () => {
    expect(outcomesIn('R/callers.R')).toEqual([
      'receiver-unresolved:c',
      'receiver-unresolved:m',
      'receiver-unresolved:save',
      'receiver-unresolved:m',
      'receiver-unresolved:save',
      'receiver-unresolved:save',
    ]);
  });
});
