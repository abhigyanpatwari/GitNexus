/**
 * Fresh graph COPY runs before FTS indexes are built (#2589, #3852), without
 * dropping or mutating the prior published graph's search indexes.
 */
import { readFile, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';
import { createTempDir } from '../helpers/test-db.js';
import { resolveAnalyzeInstallPolicy } from '../../src/core/lbug/extension-loader.js';

const ftsMustBeAvailable = process.env.GITNEXUS_REQUIRE_FTS === '1';

describe('runFullAnalysis compact writeback — fresh FTS ordering (#2589, #3852)', () => {
  let ftsAvailable = true;
  let skipWarned = false;

  beforeAll(async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    // Cheap standalone probe — matches the withTestLbugDB/lbug-vector-extension
    // convention of checking availability once, up front, rather than deep
    // inside the (expensive) test body.
    const probe = await createTempDir('gitnexus-2589-fts-probe-');
    try {
      await lbugAdapter.initLbug(probe.dbPath);
      ftsAvailable = await lbugAdapter.loadFTSExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
    } finally {
      await lbugAdapter.closeLbug();
      await probe.cleanup();
    }
  }, 120_000);

  // Skip VISIBLY (ctx.skip() marks the test as skipped, not passed) when the
  // extension is unavailable — silently `return`ing from inside `it()` would
  // report a false pass and hide a regression in the drop-before-delete
  // ordering in exactly the environments least likely to have a human notice.
  beforeEach((ctx) => {
    if (!ftsAvailable) {
      if (ftsMustBeAvailable) {
        throw new Error(
          'GITNEXUS_REQUIRE_FTS=1 but the FTS extension is unavailable — cannot verify the #2589 ordering fix.',
        );
      }
      if (!skipWarned) {
        skipWarned = true;
        console.warn(
          '[incremental-fts-drop-ordering] Skipping — the LadybugDB FTS extension is unavailable.',
        );
      }
      ctx.skip();
    }
  });

  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.resetModules();
  });

  it('loads a fresh graph before building every configured FTS index', async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2589-fts-order-');
    try {
      // First run: full rebuild, builds every FTS index for real.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // runFullAnalysis closes its own connection on return — open a fresh
      // one just to probe SHOW_INDEXES(), then close it before the second
      // run opens its own (LadybugDB is single-writer/single-connection).
      const { lbugPath } = getStoragePaths(repo.dbPath);
      await lbugAdapter.initLbug(lbugPath);
      const showIndexNames = async (): Promise<string[]> => {
        const rows = (await lbugAdapter.executeQuery('CALL SHOW_INDEXES() RETURN *')) as Array<
          Record<string, unknown>
        >;
        return rows.map((r) => r.index_name).filter((n): n is string => typeof n === 'string');
      };
      const beforeChange = await showIndexNames();
      await lbugAdapter.closeLbug();

      // Hard assertion, not a soft skip: the beforeEach gate already proved
      // the extension loads, so every index failing to build here is a real
      // bug in the full-rebuild FTS phase, not an environment gap.
      for (const { indexName } of FTS_INDEXES) {
        expect(beforeChange).toContain(indexName);
      }

      const deleteNodes = vi.spyOn(lbugAdapter, 'deleteNodesForFiles');
      let indexNamesAtCopyTime: string[] | undefined;
      const originalLoadGraph = lbugAdapter.loadGraphToLbug;
      vi.spyOn(lbugAdapter, 'loadGraphToLbug').mockImplementation(async (...args) => {
        indexNamesAtCopyTime = await showIndexNames();
        return originalLoadGraph(...args);
      });

      const handlerPath = path.join(repo.dbPath, 'src', 'handler.ts');
      await writeFile(
        handlerPath,
        (await readFile(handlerPath, 'utf-8')) + '\n// #2589 ordering-test touch\n',
        'utf-8',
      );
      execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
        cwd: repo.dbPath,
        stdio: 'pipe',
      });
      execSync(
        'git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m "#2589 ordering touch"',
        { cwd: repo.dbPath, stdio: 'pipe' },
      );

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      expect(deleteNodes).not.toHaveBeenCalled();
      expect(indexNamesAtCopyTime).toBeDefined();
      const configured = FTS_INDEXES.map((index) => index.indexName);
      expect(indexNamesAtCopyTime!.filter((name) => configured.includes(name))).toEqual([]);
      await lbugAdapter.initLbug(lbugPath);
      try {
        const after = await showIndexNames();
        expect(after.filter((name) => configured.includes(name)).sort()).toEqual(configured.sort());
      } finally {
        await lbugAdapter.closeLbug();
      }
    } finally {
      await repo.cleanup();
    }
  }, 300_000);
});
