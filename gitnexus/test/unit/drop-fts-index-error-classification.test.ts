/**
 * #2589: `dropFTSIndex` must tolerate only benign "nothing to drop"
 * `DROP_FTS_INDEX` failures and rethrow everything else — previously it
 * swallowed every error unconditionally, which could mask a genuinely
 * corrupted FTS index across analyze runs.
 *
 * `isBenignDropFtsIndexError` is pure string logic (no native connection
 * needed), so the classification itself is unit-tested directly, including
 * against the exact reported #2589 error text — a native repro of that
 * specific engine failure was not achieved during investigation, but the
 * classifier's behavior for it is still provable from the message alone.
 */
import { describe, expect, it } from 'vitest';
import { isBenignDropFtsIndexError, dropFTSIndex } from '../../src/core/lbug/lbug-adapter.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

describe('isBenignDropFtsIndexError', () => {
  it('is true for the FTS-extension/function-not-registered catalog error (probe-verified text)', () => {
    expect(
      isBenignDropFtsIndexError(
        "Catalog exception: function DROP_FTS_INDEX is not defined. This function exists in the FTS extension. You can install and load the extension by running 'INSTALL FTS; LOAD EXTENSION FTS;'.",
      ),
    ).toBe(true);
  });

  it('is true for the index-never-created binder error (probe-verified against the real dropFTSIndex path)', () => {
    expect(
      isBenignDropFtsIndexError(
        "Binder exception: Table File doesn't have an index with name file_fts.",
      ),
    ).toBe(true);
  });

  it('is false for the #2589 runtime inconsistency error (must surface, not be swallowed)', () => {
    expect(
      isBenignDropFtsIndexError(
        "Runtime exception: FTS index 'file_fts' is inconsistent: term 'wiki' is missing during delete.",
      ),
    ).toBe(false);
  });

  it('is false for an unrelated failure', () => {
    expect(isBenignDropFtsIndexError('Connection Exception: database is closed')).toBe(false);
  });

  it('is false for a genuine failure that merely mentions "Binder exception" mid-message (anchored, not a bare substring match)', () => {
    expect(
      isBenignDropFtsIndexError(
        'Runtime exception: internal state corrupted while processing Binder exception: recovery failed.',
      ),
    ).toBe(false);
  });
});

withTestLbugDB('drop-fts-index-benign-cases', (handle) => {
  describe('dropFTSIndex end-to-end benign cases (#2589)', () => {
    it('resolves cleanly when the named index was never created', async () => {
      void handle;
      const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');
      await executeQuery(
        `CREATE NODE TABLE IF NOT EXISTS DropProbe (id STRING PRIMARY KEY, content STRING)`,
      );
      await expect(dropFTSIndex('DropProbe', 'drop_probe_never_created')).resolves.toBeUndefined();
    }, 120_000);
  });
});
