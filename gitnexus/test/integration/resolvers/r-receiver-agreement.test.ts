/**
 * R: a constructor types a receiver only when every binding of the name in its frame agrees.
 *
 * `x <- T$new()` types `x` as `T` only when the frame (the file's top level or a function; the
 * braces of `local({...})` belong to the enclosing frame) binds `x` to nothing but `T$new()`.
 * Another class, any other value, a formal, a `for` variable, `rm(x)`, `assign("x", ...)` or a
 * replacement call on `x` (`class(x) <- v`) leaves `x` untyped. `NULL`, a constant and a field
 * write through `x` (`x$a <- v`, `x[["a"]] <- v`, `names(x$a) <- v`) are neutral. `<<-` and `->>`
 * bind in the enclosing frames, never in their own: `x <<- User$new(); x$save()` in a function
 * leaves `x` free there, so the call is not typed.
 *
 * Every lost edge becomes no edge, never a different one: the untyped receiver records no outcome
 * (INVISIBLE). Rows marked (limit) pin a result that is lost although R would make the call
 * (a2, n1), or a wrong edge the rule does not see (b6 and m8, erroring code or `with()`; q1, a
 * rebinding in another file: frames are per file).
 *
 * Fixture `r-receiver-agreement/` (no DESCRIPTION): R6 `User` and `Address` both define `save`;
 * `R/free.R` has a free `save` (a decoy that must never be reached) and an untyped `other()`.
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

const USER_SAVE = 'Method:R/models.R:User.save#0:import-resolved:0.85';
const OTHER = 'Function:R/free.R:other:global-name-fallback:0.5';

/** Every CALLS edge of the repository, by source node id: `targetId:reason:confidence`. */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  // script.R: one function per cell.
  'Function:R/script.R:a1': [],
  'Function:R/script.R:a2': [], // (limit) last wins, User.save in R
  'Function:R/script.R:b1': [OTHER],
  'Function:R/script.R:b2': [USER_SAVE], // NULL is neutral (the call errors in R)
  'Function:R/script.R:b3': [],
  'Function:R/script.R:b4': [],
  'Function:R/script.R:b5': [OTHER, USER_SAVE], // `<<-` leaves the local User
  'Function:R/script.R:b6': [USER_SAVE], // (limit) with() is not modelled: a wrong edge kept
  'Function:R/script.R:c1': [],
  'Function:R/script.R:c2': [],
  'Function:R/script.R:d1': [],
  'Function:R/script.R:d2': [USER_SAVE],
  'Function:R/script.R:e1': [USER_SAVE],
  'Function:R/script.R:e2': [USER_SAVE],
  'Function:R/script.R:e4': [],
  'Function:R/script.R:e5': [USER_SAVE],
  'Function:R/script.R:fw1': [USER_SAVE],
  'Function:R/script.R:fw2': [USER_SAVE],
  'Function:R/script.R:fw3': [USER_SAVE],
  'Function:R/script.R:rp1': [],
  'Function:R/script.R:as1': [OTHER],
  'Function:R/script.R:sa1': [],
  // modlevel.R: the module `u` is rebound by m6's `<<-`.
  'Function:R/modlevel.R:m1': [],
  'Function:R/modlevel.R:m2': [OTHER],
  'Function:R/modlevel.R:m3': [OTHER],
  'Function:R/modlevel.R:m4': [],
  'Function:R/modlevel.R:m5': [],
  'Function:R/modlevel.R:m6': [OTHER],
  'Function:R/modlevel.R:m7': [], // (limit) unresolved only through m6's `<<-`; with() not modelled
  'Function:R/modlevel.R:m9': [OTHER],
  // modlevel2.R
  'File:R/modlevel2.R': [OTHER],
  'Function:R/modlevel2.R:n1': [], // (limit) right for calls after load
  'Function:R/modlevel2.R:n2': [],
  'Function:R/modlevel2.R:k1': [USER_SAVE],
  'Function:R/modlevel2.R:m8': [USER_SAVE], // (limit) a local constant walks out to the module type
  // otherfile.R and otherfile-reset.R
  'Function:R/otherfile.R:o1': [],
  'Function:R/otherfile.R:q1': ['Method:R/models.R:Db.query#0:import-resolved:0.85'], // (limit)
  'Function:R/otherfile-reset.R:reset': [OTHER],
  // toplevel.R: two module-level constructors of different classes.
  'File:R/toplevel.R': [],
};

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'r-receiver-agreement'), () => {});
}, 120000);

const callsFrom = (sourceId: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.rel.sourceId === sourceId)
    .map((e) => `${e.rel.targetId}:${e.rel.reason}:${e.rel.confidence}`)
    .sort();

describe('R receiver typing: every binding of the name in its frame must agree', () => {
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

  it('never reaches the free save() decoy or a method of the wrong class', () => {
    const wrong = getRelationships(result, 'CALLS').filter(
      (e) => e.rel.targetId === 'Function:R/free.R:save' || e.target === 'Address.save',
    );
    expect(wrong.map((e) => `${e.rel.sourceId} -> ${e.rel.targetId}`)).toEqual([]);
  });

  it('an untyped receiver records no outcome (INVISIBLE): no site is suppressed', () => {
    const suppressed = getResolutionOutcomes(result).filter((o) => o.kind === 'suppressed');
    expect(suppressed.map((o) => `${o.filePath}:${o.range.startLine}:${o.name}`)).toEqual([]);
  });
});
