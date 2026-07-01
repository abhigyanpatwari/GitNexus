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
import { skipUnlessFtsAvailable } from '../helpers/fts-availability.js';
import { SUPPORTED_FTS_STEMMERS } from '../../src/core/search/fts-indexes.js';

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
