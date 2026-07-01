/**
 * Re-validation for issue #2338 (LadybugDB 0.18.0 bump, plan U2): confirms the
 * FTS extension bundled with the pinned `@ladybugdb/core` version still
 * accepts every entry in `SUPPORTED_FTS_STEMMERS`, not just the default
 * `porter` — the existing FTS integration tests only ever exercise `porter`.
 *
 * Each stemmer gets its own FTS index name so `createFTSIndex`'s
 * per-(table,indexName) cache can't mask a rejection by short-circuiting on
 * an earlier stemmer's success.
 */
import { describe, it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { SUPPORTED_FTS_STEMMERS } from '../../src/core/search/fts-indexes.js';

const FTS_UNAVAILABLE_NOTE =
  'FTS extension unavailable (load-only policy; not pre-installed on this machine)';

/**
 * Honors GITNEXUS_REQUIRE_FTS=1 the same way `withTestLbugDB` and
 * `lbug-core-adapter.test.ts` do: CI sets it, so an unavailable extension is a
 * hard failure, never a silent skip. Offline/local runs (no env var) skip
 * gracefully (#2299).
 */
const skipUnlessFtsAvailable = async (ctx: { skip: (note?: string) => void }): Promise<void> => {
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

withTestLbugDB('fts-stemmer-sweep', () => {
  describe('every SUPPORTED_FTS_STEMMERS entry is accepted by the bundled extension (#2338)', () => {
    it.for([...SUPPORTED_FTS_STEMMERS].sort())(
      'CREATE_FTS_INDEX accepts stemmer "%s"',
      async (stemmer, ctx) => {
        await skipUnlessFtsAvailable(ctx);
        const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');
        await expect(
          createFTSIndex('File', `sweep_${stemmer}`, ['name'], stemmer),
        ).resolves.toBeUndefined();
      },
    );
  });
});
