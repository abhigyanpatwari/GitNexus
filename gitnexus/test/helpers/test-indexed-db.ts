import { describe, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  createIndexedDbFixture,
  type IndexedDBHandle,
  type WithTestLbugDBOptions,
} from './indexed-db-fixture.js';
export type { IndexedDBHandle, WithTestLbugDBOptions, FTSIndexDef } from './indexed-db-fixture.js';

export function withTestLbugDB(
  prefix: string,
  fn: (handle: IndexedDBHandle) => void,
  options?: WithTestLbugDBOptions,
): void {
  const fixture = createIndexedDbFixture(prefix, options);
  let ftsSkipWarned = false;
  // Wrap in describe to scope beforeAll/afterAll — prevents lifecycle
  // collisions when multiple withTestLbugDB calls share the same file.
  describe(`withTestLbugDB(${prefix})`, () => {
    beforeAll(fixture.setup, options?.timeout ?? 120_000);
    // Skip FTS-dependent suites when the extension could not be loaded or
    // installed on this machine. Without this, tests would assert against a
    // missing index and fail. Warn once so the skip is visible, not silent.
    beforeEach((ctx) => {
      if (fixture.ftsUnavailable()) {
        if (!ftsSkipWarned) {
          ftsSkipWarned = true;
          console.warn(
            `[withTestLbugDB(${prefix})] Skipping FTS-dependent tests — the LadybugDB ` +
              `FTS extension is unavailable (LOAD failed and it could not be installed).`,
          );
        }
        ctx.skip();
      }
    });
    // Explicit timeout: KuzuDB's C++ destructor can hang on Windows during
    // native resource cleanup.  The vitest hookTimeout (120s) should apply
    // automatically, but some vitest versions fall back to testTimeout (30s)
    // for afterAll.  Pass 120s explicitly to avoid CI flakes on Windows.
    afterAll(fixture.cleanup, 120_000);
    fn(fixture.handle);
  });
}
