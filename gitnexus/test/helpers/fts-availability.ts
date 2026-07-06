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
 */
export const skipUnlessFtsAvailable = async (ctx: {
  skip: (note?: string) => void;
}): Promise<void> => {
  const { loadFTSExtension } = await import('../../src/core/lbug/lbug-adapter.js');
  if (await loadFTSExtension()) return;
  if (process.env.GITNEXUS_REQUIRE_FTS === '1') {
    throw new Error(
      'FTS extension is required (GITNEXUS_REQUIRE_FTS=1) but could not be loaded or installed. ' +
        'FTS-dependent tests must not be silently skipped in CI — install/repair the LadybugDB ' +
        'FTS extension (see `gitnexus doctor`) or unset GITNEXUS_REQUIRE_FTS for offline/local runs.',
    );
  }
  ctx.skip(FTS_UNAVAILABLE_NOTE);
};
