import fs from 'fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStoragePaths, saveMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const SIMULATED_MISSING_FTS_INDEX_NAME = 'File.file_fts';
const PLACEHOLDER_GRAPH_STORE_CONTENT = 'fixture';

const createPlaceholderGraphStore = async (lbugPath: string): Promise<void> => {
  // Repair mode gates on existence before `initLbug` takes over open/validate.
  // A placeholder file is enough to exercise this preflight branch.
  await fs.writeFile(lbugPath, PLACEHOLDER_GRAPH_STORE_CONTENT);
};

const escapeForRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('runFullAnalysis FTS repair and verification failure paths', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/core/search/fts-indexes.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('fails repair mode when no base meta exists', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-no-meta-');
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      await expect(
        runFullAnalysis(
          tmpRepo.dbPath,
          { repairFts: true },
          {
            onProgress: () => {},
          },
        ),
      ).rejects.toThrow(/has not been analyzed yet/i);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('fails repair mode when graph store is missing', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-missing-store-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: {},
      });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      await expect(
        runFullAnalysis(
          tmpRepo.dbPath,
          { repairFts: true },
          {
            onProgress: () => {},
          },
        ),
      ).rejects.toThrow(new RegExp(`graph store at ${escapeForRegex(lbugPath)} is missing`));
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('fails repair mode when graph store path is not a file', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-store-not-file-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: {},
      });
      await fs.mkdir(lbugPath, { recursive: true });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      await expect(
        runFullAnalysis(
          tmpRepo.dbPath,
          { repairFts: true },
          {
            onProgress: () => {},
          },
        ),
      ).rejects.toThrow(
        new RegExp(
          `graph store at ${escapeForRegex(lbugPath)} is a directory \\(expected a file\\)`,
        ),
      );
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('fails repair mode when FTS verify still reports missing indexes', async () => {
    const closeLbugMock = vi.fn(async () => undefined);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({})),
      executeQuery: vi.fn(async () => []),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: closeLbugMock,
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      // Repair path now gates on FTS availability before drop-then-create.
      loadFTSExtension: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      createSearchFTSIndexes: vi.fn(async () => undefined),
      verifySearchFTSIndexes: vi.fn(async () => [SIMULATED_MISSING_FTS_INDEX_NAME]),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-verify-fail-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: {},
      });
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      await expect(
        runFullAnalysis(
          tmpRepo.dbPath,
          { repairFts: true },
          {
            onProgress: () => {},
          },
        ),
      ).rejects.toThrow(/FTS repair failed - missing indexes after rebuild/i);
      expect(closeLbugMock).toHaveBeenCalled();
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('surfaces extension-unavailable errors from FTS index creation in repair mode', async () => {
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({})),
      executeQuery: vi.fn(async () => []),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      // Extension loads; the throw under test comes from index creation itself.
      loadFTSExtension: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      createSearchFTSIndexes: vi.fn(async () => {
        throw new Error('FTS extension unavailable');
      }),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-extension-fail-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: {},
      });
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      await expect(
        runFullAnalysis(
          tmpRepo.dbPath,
          { repairFts: true },
          {
            onProgress: () => {},
          },
        ),
      ).rejects.toThrow(/FTS extension unavailable/i);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('fails repair mode loudly WITHOUT dropping indexes when the FTS extension is unavailable', async () => {
    // Regression guard (#2299): createSearchFTSIndexes now drops each index
    // before recreating it. If the extension is unavailable, the repair path must
    // bail before any drop runs — otherwise it would destroy the existing indexes
    // and then fail to recreate them, leaving the DB worse off.
    const createSearchFTSIndexes = vi.fn(async () => undefined);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({})),
      executeQuery: vi.fn(async () => []),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      // Extension cannot load — the guard must fail BEFORE any index is touched.
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      createSearchFTSIndexes,
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-fts-unavailable-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: {},
      });
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      await expect(
        runFullAnalysis(tmpRepo.dbPath, { repairFts: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/FTS extension is unavailable[\s\S]*gitnexus doctor/i);
      // The guard fires before drop-then-create, so no index is dropped.
      expect(createSearchFTSIndexes).not.toHaveBeenCalled();
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('fails full analyze when FTS verification reports missing indexes after creation', async () => {
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({ nodes: 0, edges: 0, communities: 0, processes: 0 })),
      executeQuery: vi.fn(async () => []),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      // FTS extension loads → analyze proceeds to create + verify indexes.
      loadFTSExtension: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      createSearchFTSIndexes: vi.fn(async () => undefined),
      verifySearchFTSIndexes: vi.fn(async () => ['Function.function_fts']),
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        // Full-analyze path only needs `forEachNode` before the FTS verify guard.
        graph: { forEachNode: () => undefined },
      })),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-full-verify-fail-');
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await expect(
        runFullAnalysis(
          tmpRepo.dbPath,
          { force: true },
          {
            onProgress: () => {},
          },
        ),
      ).rejects.toThrow(/FTS verification failed - missing indexes after analyze/i);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('full analyze degrades gracefully (no throw, warns, skips index creation) when FTS extension is unavailable', async () => {
    // Offline-first degradation: when loadFTSExtension() returns false, the
    // analyze path must NOT call createSearchFTSIndexes / verifySearchFTSIndexes
    // and must NOT throw — it logs a warning and completes (#1161).
    const createSearchFTSIndexes = vi.fn(async () => undefined);
    const verifySearchFTSIndexes = vi.fn(async () => []);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({ nodes: 1, edges: 0, communities: 0, processes: 0 })),
      executeQuery: vi.fn(async () => []),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      // FTS extension cannot load (offline + not pre-installed, or policy forced).
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      createSearchFTSIndexes,
      verifySearchFTSIndexes,
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        totalFileCount: 1,
        graph: { forEachNode: () => undefined },
      })),
    }));
    // Avoid touching the global registry / repo .gitnexusignore from a unit test.
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      registerRepo: vi.fn(async () => 'degraded-repo'),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-fts-degrade-');
    try {
      const logs: string[] = [];
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { force: true },
        { onProgress: () => {}, onLog: (msg: string) => logs.push(msg) },
      );

      expect(result.ftsSkipped).toBe(true);
      expect(createSearchFTSIndexes).not.toHaveBeenCalled();
      expect(verifySearchFTSIndexes).not.toHaveBeenCalled();
      expect(logs.join('\n')).toMatch(/FTS extension unavailable; skipping search-index creation/i);

      // The degraded state is persisted so meta.json / doctor stay honest.
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta = JSON.parse(await fs.readFile(`${storagePath}/meta.json`, 'utf-8'));
      expect(meta.capabilities.fts.status).toBe('unavailable');
    } finally {
      await tmpRepo.cleanup();
    }
  });
});
