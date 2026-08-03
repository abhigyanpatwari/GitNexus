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
    for (const d of created) fs.rmSync(d, { recursive: true, force: true });
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
