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
import { cleanupTempDirSync } from './test-db.js';

export interface TempDirPool {
  /** A fresh empty temp dir, registered for cleanup. Seed it yourself. */
  dir(): string;
  /** A fresh temp dir seeded with a recursive copy of `fixture`. */
  fromFixture(fixture: string): string;
}

/** Removes one registered directory. A seam, so the failure path is testable. */
export type TempDirRemover = (dir: string) => void;

/** Reports one cleanup failure. A seam, for the same reason. */
type CleanupWarner = (message: string) => void;

/**
 * Delegates to `cleanupTempDirSync`, the repo's existing Windows-lock-aware
 * remover — do NOT re-roll `fs.rmSync` here. It already encodes the whole
 * problem this pool hit: `force` suppresses only `ENOENT`, while a handle a
 * pipeline test left open surfaces as `EBUSY`/`EPERM`, so it retries 5× with a
 * 100–400 ms backoff and then swallows exactly the Windows lock codes and
 * `ENOTEMPTY` — rethrowing anything else, so a genuine bug still surfaces
 * through `removeTempDirs`' per-directory catch below.
 *
 * A second copy here had already drifted from it on both knobs that matter
 * (3 retries at 50 ms, and warn-on-everything), which is how one half of the
 * suite ends up green-with-a-warning on the same `EBUSY` the other half fails on.
 *
 * Exported so the cleanup pin can inject a failure for ONE directory while the
 * others still go through the removal that actually ships — a proof against a
 * stand-in `fs.rmSync` call in the test would not be one.
 */
export const removeTempDirRecursive: TempDirRemover = (dir) => {
  cleanupTempDirSync(dir);
};

// Node's console methods are bound, so this can be the default directly.
const warnToConsole: CleanupWarner = console.warn;

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
