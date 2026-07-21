/**
 * #2589: the incremental writeback must drop every FTS index BEFORE
 * `deleteNodesForFiles` runs its batched DETACH DELETE — not only in
 * Phase 3, after the delete already ran against a table still carrying the
 * PREVIOUS run's index. This drives the real `runFullAnalysis` incremental
 * path (real git repo, real LadybugDB, real FTS extension) and asserts,
 * at the moment `deleteNodesForFiles` is invoked, that `SHOW_INDEXES()`
 * already reports every FTS index absent — proving the drop-before-delete
 * ordering end-to-end rather than only unit-testing the call sequence.
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

describe('runFullAnalysis incremental writeback — FTS drop-before-delete ordering (#2589)', () => {
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

  it('SHOW_INDEXES() reports every FTS index absent by the time deleteNodesForFiles runs', async () => {
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

      // Spy on the real deleteNodesForFiles, recording the FTS index list at
      // the exact moment it's invoked (before it does anything), then
      // delegating to the real implementation so the run completes normally.
      let indexNamesAtDeleteTime: string[] | undefined;
      const originalDeleteNodesForFiles = lbugAdapter.deleteNodesForFiles;
      vi.spyOn(lbugAdapter, 'deleteNodesForFiles').mockImplementation(async (filePaths, opts) => {
        indexNamesAtDeleteTime = await showIndexNames();
        return originalDeleteNodesForFiles(filePaths, opts);
      });

      // Small change to a single file — stays well under the escalation
      // threshold (50 files) on this 7-file mini-repo, so it takes the
      // non-escalated (surgical) incremental branch this test targets.
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

      expect(indexNamesAtDeleteTime).toBeDefined();
      for (const { indexName } of FTS_INDEXES) {
        expect(indexNamesAtDeleteTime).not.toContain(indexName);
      }
    } finally {
      await repo.cleanup();
    }
  }, 300_000);
});
