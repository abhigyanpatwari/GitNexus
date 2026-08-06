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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBenignDropFtsIndexError, dropFTSIndex } from '../../src/core/lbug/lbug-adapter.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { createTempDir } from '../helpers/test-db.js';
import {
  resetExtensionState,
  resolveAnalyzeInstallPolicy,
} from '../../src/core/lbug/extension-loader.js';

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

/**
 * #2841: "function DROP_FTS_INDEX is not defined" is benign only when there is
 * nothing to drop. When the index is LIVE, that same message means the drop did
 * not happen and cannot happen — every later insert/delete against the table
 * dies at bind time with an engine error that never mentions FTS. The message
 * classifier stays pure (it cannot know whether an index exists); the liveness
 * question is settled inside `dropFTSIndex`, on the error path only.
 */
describe('dropFTSIndex with the FTS extension unloaded (#2841)', () => {
  const TABLE = 'DropProbe2841';
  const LIVE_INDEX = 'drop_probe_2841_live';
  let ftsAvailable = true;
  /**
   * Mutable holder rather than `probe: … | undefined` + `probe!.dbPath`: the
   * non-null assertion was a lint warning, and the alternative (a runtime guard
   * in every consumer) would put branching into the test path. `beforeAll`
   * overwrites both fields; if it never ran, `initLbug('')` fails loudly, which
   * is the same outcome the assertion had.
   */
  const probe: { dbPath: string; cleanup: () => Promise<void> } = {
    dbPath: '',
    cleanup: async () => {},
  };

  beforeAll(async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const tmp = await createTempDir('gitnexus-2841-drop-probe-');
    probe.dbPath = tmp.dbPath;
    probe.cleanup = tmp.cleanup;
    await adapter.initLbug(probe.dbPath);
    try {
      ftsAvailable = await adapter.loadFTSExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
      if (ftsAvailable) {
        await adapter.executeQuery(
          `CREATE NODE TABLE IF NOT EXISTS ${TABLE} (id STRING PRIMARY KEY, name STRING, content STRING)`,
        );
        // A real, live FTS index — the state that makes the catalog error fatal.
        await adapter.createFTSIndex(TABLE, LIVE_INDEX, ['name', 'content']);
      }
    } finally {
      await adapter.closeLbug();
    }
  }, 120_000);

  afterAll(async () => {
    await probe.cleanup();
  });

  beforeEach((ctx) => {
    if (!ftsAvailable) {
      if (process.env.GITNEXUS_REQUIRE_FTS === '1') {
        throw new Error(
          'GITNEXUS_REQUIRE_FTS=1 but the FTS extension is unavailable — cannot verify the #2841 drop guard.',
        );
      }
      console.warn(
        '[drop-fts-index-error-classification] Skipping the #2841 cases — FTS extension unavailable.',
      );
      ctx.skip();
    }
  });

  /** Reopen the seeded DB with the extension forced unloadable for this connection. */
  const withUnloadedFts = async (run: () => Promise<void>): Promise<void> => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
    resetExtensionState();
    try {
      await adapter.initLbug(probe.dbPath);
      await run();
    } finally {
      await adapter.closeLbug();
      if (previousPolicy === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = previousPolicy;
      resetExtensionState();
    }
  };

  it('rejects, naming FTS and both remedies, when the index is live and the extension is not loaded', async () => {
    await withUnloadedFts(async () => {
      await expect(dropFTSIndex(TABLE, LIVE_INDEX)).rejects.toThrow(
        /FTS index '.*' on table .* exists but the LadybugDB FTS extension is not loaded/,
      );
      // Both remedies, asserted as stable SUBSTRINGS — the load-side half is
      // generated by `diagnoseExtensionLoad` now, so pinning a whole sentence
      // would break on any classifier wording change. `never` is not a load
      // failure the classifier recognizes, so the diagnosis here is `unknown`
      // and the doctor pointer is the load-side remedy the user gets.
      await expect(dropFTSIndex(TABLE, LIVE_INDEX)).rejects.toThrow(/gitnexus doctor/);
      await expect(dropFTSIndex(TABLE, LIVE_INDEX)).rejects.toThrow(/analyze --force/);
    });
  }, 120_000);

  it('still resolves when the extension is not loaded and the index does not exist', async () => {
    await withUnloadedFts(async () => {
      await expect(dropFTSIndex(TABLE, 'drop_probe_2841_absent')).resolves.toBeUndefined();
    });
  }, 120_000);

  /**
   * #2374/#2375 redaction contract. LadybugDB's own load error names the
   * extension FILE, and that `reason` is what the classifier is fed — so the
   * one thing this surface must never do is pass it through into the message a
   * user sees. Until now that held only by code inspection.
   *
   * A bare "policy is never" run cannot prove it: that reason carries no path,
   * so the assertion would be vacuous. So the LOAD is forced to fail with a
   * real, path-bearing LadybugDB error instead, which drives the classifier
   * down its `missing_dependency` branch — the branch whose remedy is derived
   * from the very text that contains the path.
   */
  const FORCED_EXTENSION_PATH = '/nonexistent-gitnexus-2841/fts.lbug_extension';
  const FORCED_LOAD_FAILURE =
    `Failed to load library: ${FORCED_EXTENSION_PATH} which is needed by extension: fts; ` +
    'libcrypto.so.3: cannot open shared object file: No such file or directory';

  it('routes the load-side remedy through the classifier without leaking the path LadybugDB named', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { default: lbug } = await import('@ladybugdb/core');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'load-only';
    resetExtensionState();

    const originalQuery = lbug.Connection.prototype.query;
    // Installed BEFORE initLbug so FTS can never load on this connection —
    // otherwise the DROP would succeed and there would be no message to inspect.
    const spy = vi.spyOn(lbug.Connection.prototype, 'query').mockImplementation(function (
      this: unknown,
      sql: string,
      ...rest: unknown[]
    ) {
      if (/^\s*LOAD EXTENSION fts\b/i.test(sql)) {
        return Promise.reject(new Error(FORCED_LOAD_FAILURE));
      }
      return originalQuery.call(this, sql, ...rest);
    });

    try {
      await adapter.initLbug(probe.dbPath);
      // Record the capability from the forced failure, so `dropFTSIndex` reads
      // a real cached diagnosis rather than re-deriving one from nothing.
      await expect(adapter.loadFTSExtension(undefined, { policy: 'load-only' })).resolves.toBe(
        false,
      );

      const rejection: unknown = await dropFTSIndex(TABLE, LIVE_INDEX).catch((e: unknown) => e);
      expect(rejection).toBeInstanceOf(Error);
      const message = String(rejection);

      // The classifier really fired on this reason (POSIX missing-dependency),
      // so the redaction assertion below is not vacuous…
      expect(message).toContain('Reinstalling the extension will NOT help');
      // …and neither the path nor any other filesystem path reached the user.
      expect(message).not.toContain(FORCED_EXTENSION_PATH);
      expect(message).not.toMatch(/(?:[A-Za-z]:\\|\/)[^\s'"]+/);
    } finally {
      spy.mockRestore();
      await adapter.closeLbug();
      if (previousPolicy === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = previousPolicy;
      resetExtensionState();
    }
  }, 120_000);
});
