/**
 * Temp-directory lifecycle for pipeline-level integration tests.
 *
 * The pipeline mutates the repo it is handed (parse caches, `.gitnexus/`), so
 * these tests each run against a throwaway copy of a fixture. Every consumer
 * had hand-rolled the SAME three parts — a `string[]` of created dirs, a
 * `mkdtempSync` that pushes onto it, and an `afterAll` that `rmSync`s the lot.
 * Extracted at the fourth consumer (`pipeline-pdg`, `pipeline-pdg-streaming`,
 * `interproc-taint`, `pdg-chained-receiver-callees`); the copies had already
 * drifted — `pipeline-pdg` registered two cleanup hooks over one array.
 *
 * Only the LIFECYCLE is shared, deliberately: seeding differs per test (a
 * recursive fixture copy, a single file, an inline-written source, or nothing
 * at all), so `dir()` hands back an empty registered directory and the caller
 * fills it however it likes. `fromFixture()` is the common case.
 *
 * `createTempDirPool` calls `afterAll` itself, so it must be called from a
 * test file's module scope (not from this module's top level — ESM caching
 * would register the hook once, for whichever file imported it first).
 * Directories are registered at creation, before any seeding runs, so a
 * fixture copy or a pipeline run that throws still leaves them cleaned up.
 *
 * Cleanup is best-effort PER DIRECTORY — see `removeTempDirs`. Every one of the
 * hand-rolled copies looped bare `rmSync` calls, so the first failure aborted
 * the removal of every directory after it; consolidating them made that one
 * loop the single point of failure for four suites.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll } from 'vitest';

export interface TempDirPool {
  /** A fresh empty temp dir, registered for cleanup. Seed it yourself. */
  dir(): string;
  /** A fresh temp dir seeded with a recursive copy of `fixture`. */
  fromFixture(fixture: string): string;
}

/** Removes one registered directory. A seam, so the failure path is testable. */
export type TempDirRemover = (dir: string) => void;

/** Reports one cleanup failure. A seam, for the same reason. */
export type CleanupWarner = (message: string) => void;

/**
 * `force` suppresses only `ENOENT`. A handle a pipeline test left open on the
 * directory surfaces on Windows as `EBUSY`/`EPERM`, which `force` does not
 * suppress — hence `maxRetries`, Node's own mitigation for exactly that class
 * (it retries `EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`/`EPERM` with a linear
 * backoff). The retries only ever run on the failing path.
 *
 * Exported so the cleanup pin can inject a failure for ONE directory while the
 * others still go through the removal that actually ships — a proof against a
 * stand-in `fs.rmSync` call in the test would not be one.
 */
export const removeTempDirRecursive: TempDirRemover = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
};

const warnToConsole: CleanupWarner = (message) => {
  console.warn(message);
};

/**
 * Remove every registered directory, best-effort: one failure must not abort
 * the removal of the directories after it.
 *
 * WARN — not throw, not swallow. Throwing would fail an otherwise green suite
 * over housekeeping the OS reclaims anyway, and it would do so from `afterAll`,
 * where it reads as a test failure and buries the real result. Swallowing is
 * its own hazard: a systematic leak (a runner whose tmpdir keeps filling) would
 * then be invisible, with nothing naming the suite responsible. A warning
 * carrying the path costs nothing on the happy path, and the path's `mkdtemp`
 * prefix is per-pool, so it names the suite that made it.
 *
 * Exported so the failure path can be pinned by injecting a throwing `remove`:
 * a real `EBUSY` is not reproducible on demand, and a test that waited for one
 * would be non-deterministic. The `afterAll` below calls exactly this function,
 * so that pin is over the loop that actually ships.
 */
export function removeTempDirs(
  dirs: readonly string[],
  remove: TempDirRemover = removeTempDirRecursive,
  warn: CleanupWarner = warnToConsole,
): void {
  for (const dir of dirs) {
    try {
      remove(dir);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(`[temp-dir-pool] could not remove ${dir}: ${reason}`);
    }
  }
}

/**
 * Create a pool of temp directories that are removed after the calling test
 * file finishes. `prefix` is the `mkdtemp` prefix (e.g. `'gn-pdg-'`), kept
 * per-pool so a leaked directory still names the suite that made it.
 */
export function createTempDirPool(prefix: string): TempDirPool {
  const created: string[] = [];

  const dir = (): string => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(made);
    return made;
  };

  afterAll(() => {
    removeTempDirs(created);
  });

  return {
    dir,
    fromFixture(fixture: string): string {
      const made = dir();
      fs.cpSync(fixture, made, { recursive: true });
      return made;
    },
  };
}
