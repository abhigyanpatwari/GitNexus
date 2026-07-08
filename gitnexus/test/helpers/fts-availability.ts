export const FTS_UNAVAILABLE_NOTE =
  'FTS extension unavailable (load-only policy; LOAD failed on this machine)';

/**
 * Dynamically skip an FTS-primitive test when the extension cannot load.
 * `ctx.skip()` aborts the test, so callers should `await` this first thing.
 *
 * Honors GITNEXUS_REQUIRE_FTS=1 the same way `withTestLbugDB` does (see
 * test/helpers/test-indexed-db.ts): when CI sets it, an unavailable extension is
 * a HARD FAILURE, never a silent skip — otherwise these FTS-primitive tests
 * (registered in LBUG_NATIVE, so they run on the ubuntu/macOS/windows jobs that
 * all set GITNEXUS_REQUIRE_FTS=1) could vanish from a green run. Offline/local
 * runs (no env var) still skip gracefully (#2299).
 *
 * Self-sufficient under sharding: the default load path is `load-only`, so these
 * primitives only pass when *some other* test already installed FTS into the
 * shared home. That co-location is not guaranteed once the cross-platform suite
 * is sharded (a load-only file can land in a shard with no installer sibling —
 * exactly what broke `lbug-core-adapter` on shard 2/3). So under REQUIRE_FTS we
 * install-on-miss with `auto` (LOAD-first, then one bounded network INSTALL),
 * matching `withTestIndexedDB`, before treating it as a hard failure.
 */
export const skipUnlessFtsAvailable = async (ctx: {
  skip: (note?: string) => void;
}): Promise<void> => {
  const { loadFTSExtension } = await import('../../src/core/lbug/lbug-adapter.js');
  if (await loadFTSExtension()) return;
  if (process.env.GITNEXUS_REQUIRE_FTS === '1') {
    // Not pre-installed in this (possibly-sharded) CI VM — install it once, then
    // it stays available for the rest of this file's tests. `auto` is LOAD-first
    // so a pre-installed extension still costs no network.
    if (await loadFTSExtension(undefined, { policy: 'auto' })) return;
    throw new Error(
      'FTS extension is required (GITNEXUS_REQUIRE_FTS=1) but could not be loaded or installed. ' +
        'FTS-dependent tests must not be silently skipped in CI — install/repair the LadybugDB ' +
        'FTS extension (see `gitnexus doctor`) or unset GITNEXUS_REQUIRE_FTS for offline/local runs.',
    );
  }
  ctx.skip(FTS_UNAVAILABLE_NOTE);
};

/**
 * Skip a structural FTS test when a required on-disk artifact (the installed
 * extension file, the native addon) is not resolvable — but HARD-FAIL under
 * GITNEXUS_REQUIRE_FTS=1 (#2299, #2383 F6d) so it never silently vanishes from a
 * green CI run. Used by tests that inspect the extension *file* directly and so
 * need its path rather than a loaded connection (skipUnlessFtsAvailable needs an
 * initialized LadybugDB, which those tests do not set up).
 */
export const requireFtsResourceOrSkip = (
  ctx: { skip: (note?: string) => void },
  resource: string | null,
  note: string,
): void => {
  if (resource) return;
  if (process.env.GITNEXUS_REQUIRE_FTS === '1') {
    throw new Error(
      `${note} is required (GITNEXUS_REQUIRE_FTS=1) but was not found on this machine. ` +
        'FTS-dependent tests must not be silently skipped in CI — install/repair the LadybugDB ' +
        'FTS extension (see `gitnexus doctor`) or unset GITNEXUS_REQUIRE_FTS for offline/local runs.',
    );
  }
  ctx.skip(`${note} unavailable`);
};
