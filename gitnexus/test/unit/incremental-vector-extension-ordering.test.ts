/**
 * Fresh graph writes preserve legacy vectors without mutating the old HNSW
 * index (#2623, #3852). Rebuild HNSW only after every retained row is restored.
 */
import { readFile, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { seedEmbeddingsForFiles, stampEmbeddingCount } from '../helpers/embedding-seed.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';
import { EMBEDDING_TABLE_NAME } from '../../src/core/lbug/schema.js';
import { resolveAnalyzeInstallPolicy } from '../../src/core/lbug/extension-loader.js';

const vectorMustBeAvailable = process.env.GITNEXUS_REQUIRE_VECTOR === '1';

const commitAll = (cwd: string, message: string): void => {
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
    cwd,
    stdio: 'pipe',
  });
  execSync(
    `git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m "${message}"`,
    { cwd, stdio: 'pipe' },
  );
};

describe('runFullAnalysis compact writeback — VECTOR preservation (#2623, #3852)', () => {
  let vectorAvailable = true;
  let skipWarned = false;

  beforeAll(async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    // Cheap standalone probe, matching the #2589 suite's convention: settle
    // availability once, up front, not inside the expensive test body.
    const probe = await createTempDir('gitnexus-2623-vector-probe-');
    try {
      await lbugAdapter.initLbug(probe.dbPath);
      vectorAvailable = await lbugAdapter.loadVectorExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
    } finally {
      await lbugAdapter.closeLbug();
      await probe.cleanup();
    }
  }, 120_000);

  // Skip VISIBLY: a silent `return` would report a false pass and hide an
  // ordering regression in exactly the environments least likely to notice.
  beforeEach((ctx) => {
    if (!vectorAvailable) {
      if (vectorMustBeAvailable) {
        throw new Error(
          'GITNEXUS_REQUIRE_VECTOR=1 but the VECTOR extension is unavailable — cannot verify the #2623 ordering fix.',
        );
      }
      if (!skipWarned) {
        skipWarned = true;
        console.warn(
          '[incremental-vector-extension-ordering] Skipping — the LadybugDB VECTOR extension is unavailable.',
        );
      }
      ctx.skip();
    }
  });

  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.resetModules();
  });

  it('restores changed and retained vectors before rebuilding HNSW without selective deletes', async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2623-vector-order-');
    try {
      // First run: full rebuild, real graph.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // Seed real embedding rows for two files, then build the HNSW index —
      // the state a prior `analyze --embeddings` leaves behind. Zero vectors
      // need no extension for the TABLE; only the index is extension-gated.
      // POSIX literals, NOT path.join: the graph stores repo-relative
      // filePaths with forward slashes on every OS, and a Windows backslash
      // inside the seed helper's single-quoted Cypher literal is a parser
      // error ("Invalid input <... n.filePath = '>"). path.join stays only
      // for real filesystem access below.
      const changedFile = 'src/handler.ts';
      const untouchedFile = 'src/validator.ts';
      const seeded = await seedEmbeddingsForFiles(repo.dbPath, [changedFile, untouchedFile], 2);
      const changedIds = seeded.get(changedFile) ?? [];
      const untouchedIds = seeded.get(untouchedFile) ?? [];
      expect(changedIds.length).toBeGreaterThan(0);
      expect(untouchedIds.length).toBeGreaterThan(0);

      const { lbugPath, storagePath } = getStoragePaths(repo.dbPath);
      // Without this, deriveEmbeddingMode sees a repo with no embeddings, the
      // Phase 3.5 restore never engages, and rows deleted by the importer-BFS
      // write-set expansion simply never come back — which would make the
      // preservation assertion below measure the wrong thing.
      await stampEmbeddingCount(storagePath, changedIds.length + untouchedIds.length);

      const readEmbeddingIndexRows = async (): Promise<Array<Record<string, unknown>>> => {
        const rows = (await lbugAdapter.executeQuery('CALL SHOW_INDEXES() RETURN *')) as Array<
          Record<string, unknown>
        >;
        return rows.filter((r) => r.table_name === EMBEDDING_TABLE_NAME && r.index_type !== 'HASH');
      };

      await lbugAdapter.initLbug(lbugPath);
      const indexBuilt = await lbugAdapter.createVectorIndex();
      const indexRowsBefore = await readEmbeddingIndexRows();
      await lbugAdapter.closeLbug();

      // The beforeEach gate already proved VECTOR loads here, so a failure to
      // build the index is a real bug, not an environment gap.
      expect(indexBuilt).toBe(true);
      expect(indexRowsBefore.length).toBeGreaterThan(0);

      const deleteNodes = vi.spyOn(lbugAdapter, 'deleteNodesForFiles');
      const originalCreateVectorIndex = lbugAdapter.createVectorIndex;
      let restoredBeforeIndex: string[] | undefined;
      vi.spyOn(lbugAdapter, 'createVectorIndex').mockImplementation(async (...args) => {
        const rows = (await lbugAdapter.executeQuery(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId`,
        )) as Array<{ nodeId: string }>;
        restoredBeforeIndex = rows.map((row) => row.nodeId).sort();
        return originalCreateVectorIndex(...args);
      });

      const handlerPath = path.join(repo.dbPath, changedFile);
      await writeFile(
        handlerPath,
        (await readFile(handlerPath, 'utf-8')) + '\n// #2623 ordering-test touch\n',
        'utf-8',
      );
      commitAll(repo.dbPath, '#2623 ordering touch');

      // THE regression: before the fix this rejects with
      // "Trying to delete from an index on table CodeEmbedding".
      await expect(
        runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} }),
      ).resolves.toBeDefined();

      expect(deleteNodes).not.toHaveBeenCalled();
      expect(restoredBeforeIndex).toEqual([...changedIds, ...untouchedIds].sort());

      await lbugAdapter.initLbug(lbugPath);
      try {
        const perNode = (await lbugAdapter.executeQuery(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, count(e) AS c`,
        )) as Array<{ nodeId: string; c: number | bigint }>;
        const counts = new Map(perNode.map((r) => [String(r.nodeId), Number(r.c)]));
        for (const id of [...changedIds, ...untouchedIds]) {
          expect(counts.get(id)).toBe(1);
        }
        for (const [, c] of counts) {
          expect(c).toBe(1);
        }
        // The replacement index covers every restored row.
        expect((await readEmbeddingIndexRows()).length).toBeGreaterThan(0);
      } finally {
        await lbugAdapter.closeLbug();
      }
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('rescues underreported legacy vectors when VECTOR cannot be loaded', async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2623-vector-blocked-');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      // POSIX literal for the graph-side path (see the note in the first case).
      const seeded = await seedEmbeddingsForFiles(repo.dbPath, ['src/handler.ts'], 2);
      const seededIds = seeded.get('src/handler.ts') ?? [];
      expect(seededIds.length).toBeGreaterThan(0);
      // Deliberately NOT stampEmbeddingCount: this pins the case where the DB
      // holds embedding rows that meta does not account for. The escalation
      // wipes the DB, so without an explicit rescue read those rows would be
      // destroyed silently — the run would still "succeed" and the loss would
      // be invisible.

      const { lbugPath } = getStoragePaths(repo.dbPath);
      await lbugAdapter.initLbug(lbugPath);
      const indexBuilt = await lbugAdapter.createVectorIndex();
      await lbugAdapter.closeLbug();
      expect(indexBuilt).toBe(true);

      const handlerPath = path.join(repo.dbPath, 'src', 'handler.ts');
      await writeFile(
        handlerPath,
        (await readFile(handlerPath, 'utf-8')) + '\n// #2623 blocked-path touch\n',
        'utf-8',
      );
      commitAll(repo.dbPath, '#2623 blocked touch');

      // VECTOR becomes unloadable for this run. The table is now immutable
      // (the index cannot be dropped without the extension either), so the
      // run must abandon surgery rather than fail mid-writeback.
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
      const logs: string[] = [];
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
        ),
      ).resolves.toBeDefined();

      expect(logs.some((m) => m.includes('full DB write'))).toBe(true);
      const metadata = await loadMeta(getStoragePaths(repo.dbPath).storagePath);
      expect(metadata?.capabilities?.vectorSearch.status).toBe('exact-scan');

      // Missing metadata must not discard paid vectors during fresh loading.
      await lbugAdapter.initLbug(lbugPath);
      try {
        const surviving = (await lbugAdapter.executeQuery(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId`,
        )) as Array<{ nodeId: string }>;
        const survivingIds = new Set(surviving.map((r) => String(r.nodeId)));
        for (const id of seededIds) {
          expect(survivingIds.has(id)).toBe(true);
        }
        // …and exactly once each — the restore must not double-insert.
        expect(surviving.length).toBe(survivingIds.size);
      } finally {
        await lbugAdapter.closeLbug();
      }
      expect(logs.some((m) => m.includes('Preserving'))).toBe(true);
    } finally {
      if (previousPolicy === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = previousPolicy;
      await repo.cleanup();
    }
  }, 300_000);
});
