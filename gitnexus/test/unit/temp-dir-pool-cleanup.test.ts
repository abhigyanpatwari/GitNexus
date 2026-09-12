/**
 * `temp-dir-pool`'s `afterAll` used to loop bare `rmSync` calls, so the FIRST
 * failure aborted the removal of every directory registered after it. `force`
 * suppresses only `ENOENT`; a handle a pipeline test left open surfaces on
 * Windows as `EBUSY`/`EPERM`, which it does not suppress. Four suites share the
 * helper, so one such failure leaked a whole run's worth of directories.
 *
 * The failure is injected rather than provoked: a real `EBUSY` is not
 * reproducible on demand, and a test that opened a handle and hoped would be
 * non-deterministic. The middle directory of a real triple is failed while the
 * other two go through `removeTempDirRecursive` — the removal that actually
 * ships — so the proof is that real directories on disk are gone, not that a
 * spy was called.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createTempDirPool,
  removeTempDirs,
  removeTempDirRecursive,
  type TempDirRemover,
} from '../helpers/temp-dir-pool.js';

/** The shape Windows produces when something still holds the directory open. */
const throwsEbusy: TempDirRemover = (dir) => {
  throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${dir}'`), { code: 'EBUSY' });
};

const removesNothing: TempDirRemover = () => {};

/**
 * Records every path the loop hands it, then defers to a per-path outcome —
 * a table lookup rather than a branch, so which directory fails is data.
 */
function scriptedRemover(
  attempted: string[],
  outcomes: ReadonlyMap<string, TempDirRemover>,
  fallback: TempDirRemover,
): TempDirRemover {
  return (dir) => {
    attempted.push(dir);
    (outcomes.get(dir) ?? fallback)(dir);
  };
}

const madeHere: string[] = [];

function makeRealDir(): string {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-temp-pool-unit-'));
  madeHere.push(made);
  // A non-empty directory: `recursive` is the part `force` cannot stand in for.
  fs.writeFileSync(path.join(made, 'seed.txt'), 'seed');
  return made;
}

// Whatever a failing row leaves behind is this file's own litter.
afterAll(() => {
  removeTempDirs(madeHere);
});

describe('removeTempDirs — cleanup is best-effort per directory', () => {
  it('a failing directory does not abort the removal of the ones after it', () => {
    const dirs = ['/pool/first', '/pool/blocked', '/pool/last'];
    const attempted: string[] = [];
    const warnings: string[] = [];

    removeTempDirs(
      dirs,
      scriptedRemover(attempted, new Map([['/pool/blocked', throwsEbusy]]), removesNothing),
      (message) => {
        warnings.push(message);
      },
    );

    // Every directory was still attempted — the loop did not stop at the throw.
    expect(attempted).toEqual(dirs);
    // One warning, naming the directory AND the reason: a silent swallow would
    // hide a systematic leak with nothing pointing at the suite responsible.
    expect(warnings).toEqual([
      expect.stringMatching(/^\[temp-dir-pool\] could not remove \/pool\/blocked: EBUSY\b/),
    ]);
  });

  it('really removes the other directories from disk when one fails', () => {
    const first = makeRealDir();
    const blocked = makeRealDir();
    const last = makeRealDir();
    const warnings: string[] = [];

    removeTempDirs(
      [first, blocked, last],
      scriptedRemover([], new Map([[blocked, throwsEbusy]]), removeTempDirRecursive),
      (message) => {
        warnings.push(message);
      },
    );

    // `blocked` survives because its removal was the injected failure; `last`
    // is gone because the loop carried on past it. Against the old bare-`rmSync`
    // loop this line is never even reached — the throw escapes `removeTempDirs`
    // and `last` is left on disk.
    expect([first, blocked, last].map((d) => fs.existsSync(d))).toEqual([false, true, false]);
    expect(warnings).toHaveLength(1);
  });

  it('does not throw when every directory fails', () => {
    const warnings: string[] = [];

    // The whole point of warning instead of rethrowing: a Windows CI run that
    // could not remove ANY of its temp directories must still report the suite
    // result it actually produced.
    removeTempDirs(['/pool/a', '/pool/b'], throwsEbusy, (message) => {
      warnings.push(message);
    });

    expect(warnings).toHaveLength(2);
  });
});

// The pin above is over `removeTempDirs`; this one is over the wiring, so the
// two cannot drift into a tested function plus an untested copy of the loop.
// The nested suite is declared BEFORE the assertion, and vitest runs a suite's
// tasks in declaration order — so its `afterAll` has already run by then.
const pooled: string[] = [];

describe('createTempDirPool — afterAll removes what the pool handed out', () => {
  describe('a pool whose owning suite finishes first', () => {
    const pool = createTempDirPool('gn-temp-pool-wiring-');

    it('hands out directories that exist', () => {
      pooled.push(pool.dir(), pool.dir());
      expect(pooled.map((d) => fs.existsSync(d))).toEqual([true, true]);
    });
  });

  it('has removed every one of them once that suite is done', () => {
    // Explicit, so a nested suite that never ran cannot make this vacuous.
    expect(pooled).toHaveLength(2);
    expect(pooled.map((d) => fs.existsSync(d))).toEqual([false, false]);
  });
});
