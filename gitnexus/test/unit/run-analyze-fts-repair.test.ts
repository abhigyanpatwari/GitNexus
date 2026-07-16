import fs from 'fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStoragePaths, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
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
    vi.doUnmock('../../src/core/lbug/extension-loader.js');
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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

  it('refuses repair mode while the incremental dirty flag is set (#2409 / tri-review 4669518496 R6)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-dirty-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      // A crashed writeback left the dirty flag set: the graph may be
      // half-written and its WAL possibly poisoned. --repair-fts returns
      // early — BEFORE the dirty-recovery sidecar quarantine — so opening
      // the DB here would replay that WAL pre-quarantine.
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: {},
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 12,
          phase: 'load-graph',
        },
      });
      // Store present and a regular file — proving the refusal comes from
      // the dirty guard, not the missing/not-a-file preflights around it.
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      await expect(
        runFullAnalysis(tmpRepo.dbPath, { repairFts: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/mid-incremental-recovery[\s\S]*gitnexus analyze/);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('validates configured FTS stemmer before full analyze pipeline work', async () => {
    const runPipelineFromRepo = vi.fn(async (repoPath: string) => ({
      repoPath,
      graph: { forEachNode: () => undefined },
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo,
    }));
    vi.stubEnv('GITNEXUS_FTS_STEMMER', 'porterr');

    const tmpRepo = await createTempDir('gitnexus-run-analyze-invalid-fts-stemmer-');
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
      ).rejects.toThrow(/Invalid GITNEXUS_FTS_STEMMER/i);
      expect(runPipelineFromRepo).not.toHaveBeenCalled();
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('validates configured FTS CJK segmentation mode before full analyze pipeline work (#2331)', async () => {
    const runPipelineFromRepo = vi.fn(async (repoPath: string) => ({
      repoPath,
      graph: { forEachNode: () => undefined },
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo,
    }));
    vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'jieba');

    const tmpRepo = await createTempDir('gitnexus-run-analyze-invalid-fts-cjk-segmentation-');
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
      ).rejects.toThrow(/Invalid GITNEXUS_FTS_CJK_SEGMENTATION/i);
      expect(runPipelineFromRepo).not.toHaveBeenCalled();
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
      // Full-rebuild wipe is loud now (#2409, tri-review 4669518496 P2-4) —
      // run-analyze calls this on every full-path analyze.
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      // Batched incremental APIs (#2409) — consumed UNCONDITIONALLY by
      // run-analyze's incremental branch; a wholesale factory without them is
      // a latent TypeError the moment a mocked run goes incremental
      // (tri-review 4669518496 accuracy sweep).
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      // Repair path now gates on FTS availability before drop-then-create.
      loadFTSExtension: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
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
      // Full-rebuild wipe is loud now (#2409, tri-review 4669518496 P2-4) —
      // run-analyze calls this on every full-path analyze.
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      // Batched incremental APIs (#2409) — consumed UNCONDITIONALLY by
      // run-analyze's incremental branch; a wholesale factory without them is
      // a latent TypeError the moment a mocked run goes incremental
      // (tri-review 4669518496 accuracy sweep).
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      // Extension loads; the throw under test comes from index creation itself.
      loadFTSExtension: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
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
      // Full-rebuild wipe is loud now (#2409, tri-review 4669518496 P2-4) —
      // run-analyze calls this on every full-path analyze.
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      // Batched incremental APIs (#2409) — consumed UNCONDITIONALLY by
      // run-analyze's incremental branch; a wholesale factory without them is
      // a latent TypeError the moment a mocked run goes incremental
      // (tri-review 4669518496 accuracy sweep).
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      // Extension cannot load — the guard must fail BEFORE any index is touched.
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes,
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    // Populate the live capability so the repair error actually interpolates the
    // real LOAD reason (#2374). Without this the branch is vacuous — the reason
    // is undefined and the assertion passes whether or not interpolation fires.
    vi.doMock('../../src/core/lbug/extension-loader.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/extension-loader.js')>()),
      getExtensionCapabilities: () => [
        { name: 'fts', loaded: false, reason: 'LOAD fts failed: invalid ELF header' },
      ],
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
        // The specific reason must appear between the headline and the remedy —
        // proving the interpolation fired, not just that the base message exists.
      ).rejects.toThrow(
        /FTS extension failed to load[\s\S]*invalid ELF header[\s\S]*gitnexus doctor/i,
      );
      // The guard fires before drop-then-create, so no index is dropped.
      expect(createSearchFTSIndexes).not.toHaveBeenCalled();
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('repair error carries the runtime-dependency remedy, not "retry the network install" (#2383 F6a)', async () => {
    const createSearchFTSIndexes = vi.fn(async () => undefined);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({})),
      executeQuery: vi.fn(async () => []),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      // Full-rebuild wipe is loud now (#2409, tri-review 4669518496 P2-4) —
      // run-analyze calls this on every full-path analyze.
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      // Batched incremental APIs (#2409) — consumed UNCONDITIONALLY by
      // run-analyze's incremental branch; a wholesale factory without them is
      // a latent TypeError the moment a mocked run goes incremental
      // (tri-review 4669518496 accuracy sweep).
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes,
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    // A Windows error-126 reason → the missing_dependency remedy branch.
    vi.doMock('../../src/core/lbug/extension-loader.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/extension-loader.js')>()),
      getExtensionCapabilities: () => [
        {
          name: 'fts',
          loaded: false,
          reason: 'LOAD fts failed: The specified module could not be found.',
        },
      ],
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-fts-dep-');
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

      const run = runFullAnalysis(tmpRepo.dbPath, { repairFts: true }, { onProgress: () => {} });
      const message = await run.catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      // The classified runtime-dependency remedy (VC++ redist), interpolated into the throw.
      expect(message).toMatch(/Visual C\+\+/);
      expect(message).toMatch(/vc_redist\.x64\.exe/);
      // The old generic "retry the network install" tail must not appear for this class.
      expect(message).not.toMatch(/Retry with network access/i);
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
      // Full-rebuild wipe is loud now (#2409, tri-review 4669518496 P2-4) —
      // run-analyze calls this on every full-path analyze.
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      // Batched incremental APIs (#2409) — consumed UNCONDITIONALLY by
      // run-analyze's incremental branch; a wholesale factory without them is
      // a latent TypeError the moment a mocked run goes incremental
      // (tri-review 4669518496 accuracy sweep).
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      // FTS extension loads → analyze proceeds to create + verify indexes.
      loadFTSExtension: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
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
      // Full-rebuild wipe is loud now (#2409, tri-review 4669518496 P2-4) —
      // run-analyze calls this on every full-path analyze.
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      // Batched incremental APIs (#2409) — consumed UNCONDITIONALLY by
      // run-analyze's incremental branch; a wholesale factory without them is
      // a latent TypeError the moment a mocked run goes incremental
      // (tri-review 4669518496 accuracy sweep).
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      // FTS extension cannot load (offline + not pre-installed, or policy forced).
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
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

      // The degraded state is persisted so the metadata / doctor stay honest —
      // in BOTH filenames (gitnexus.json primary + dual-written meta.json mirror).
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta = JSON.parse(await fs.readFile(`${storagePath}/meta.json`, 'utf-8'));
      expect(meta.capabilities.fts.status).toBe('unavailable');
      const primaryMeta = JSON.parse(await fs.readFile(`${storagePath}/gitnexus.json`, 'utf-8'));
      expect(primaryMeta.capabilities.fts.status).toBe('unavailable');
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('degrade log for a missing runtime dependency omits the contradictory reinstall guidance (#2383 F2)', async () => {
    const createSearchFTSIndexes = vi.fn(async () => undefined);
    const verifySearchFTSIndexes = vi.fn(async () => []);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({ nodes: 1, edges: 0, communities: 0, processes: 0 })),
      executeQuery: vi.fn(async () => []),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      // Full-rebuild wipe is loud now (#2409, tri-review 4669518496 P2-4) —
      // run-analyze calls this on every full-path analyze.
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      // Batched incremental APIs (#2409) — consumed UNCONDITIONALLY by
      // run-analyze's incremental branch; a wholesale factory without them is
      // a latent TypeError the moment a mocked run goes incremental
      // (tri-review 4669518496 accuracy sweep).
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
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
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      registerRepo: vi.fn(async () => 'degraded-repo'),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));
    // A Windows error-126 reason routes the degrade log through the missing_dependency branch.
    vi.doMock('../../src/core/lbug/extension-loader.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/extension-loader.js')>()),
      getExtensionCapabilities: () => [
        {
          name: 'fts',
          loaded: false,
          reason: 'LOAD fts failed: The specified module could not be found.',
        },
      ],
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-fts-degrade-dep-');
    try {
      const logs: string[] = [];
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { force: true },
        { onProgress: () => {}, onLog: (msg: string) => logs.push(msg) },
      );

      expect(result.ftsSkipped).toBe(true);
      const degradeLine = logs
        .filter((l) => l.includes('skipping search-index creation'))
        .join('\n');
      // Class-neutral lead + the classified VC++ remedy...
      expect(degradeLine).toMatch(/FTS extension unavailable; skipping search-index creation/i);
      expect(degradeLine).toMatch(/Visual C\+\+/);
      // ...but NOT the generic install guidance that contradicts "reinstalling will NOT help".
      expect(degradeLine).not.toMatch(/network access/i);
      expect(degradeLine).not.toMatch(/pre-installed for offline use/i);
    } finally {
      await tmpRepo.cleanup();
    }
  });
});

/**
 * U3 wiring pin (tri-review 4669518496 P1): a wiped run that restores cached
 * embeddings recreates the HNSW vector index at the Phase 3.5/Phase 4 seam —
 * and when that recreation reports FAILURE, the persisted meta must stamp
 * `capabilities.vectorSearch.status = 'exact-scan'`, never the platform-derived
 * 'vector-index' (which is exactly what the linux fallback would claim).
 * Pinned here at unit level with the wholesale-mock harness so the wiring is
 * platform-independent; the real-index orchestration half lives in
 * incremental-orchestration.test.ts and skip-gates on VECTOR availability.
 */
describe('runFullAnalysis wipe-and-restore vector-index stamp (tri-review 4669518496 P1 / U3)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/core/search/fts-indexes.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/core/embeddings/embedding-pipeline.js');
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('stamps capabilities.vectorSearch.status = exact-scan when post-restore index recreation reports failure', async () => {
    const RESTORED_NODE_ID = 'Function:src/app.ts:handler:1';
    const stubNode = {
      id: RESTORED_NODE_ID,
      label: 'Function',
      name: 'handler',
      properties: { filePath: 'src/app.ts' },
    };
    const buildVectorIndex = vi.fn(async () => false);
    const executeWithReusedStatement = vi.fn(async () => []);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({ nodes: 2, edges: 0, communities: 0, processes: 0 })),
      // The finalize embedding count answers 1 (the restored row) — a zero
      // count would stamp 'unavailable' and the exact-scan assertion below
      // would pass for the wrong reason. (No surviving-id pre-read to answer
      // anymore: Phase 3.5 derives its restore scope in memory — FIX 3 of
      // this shipping review — and this wiped/full-rebuild path restores ALL
      // live cached rows.)
      executeQuery: vi.fn(async (cypher: string) =>
        /RETURN count\(e\) AS cnt/.test(cypher) ? [{ cnt: 1 }] : [],
      ),
      executeWithReusedStatement,
      closeLbug: vi.fn(async () => undefined),
      // Full-rebuild wipe is loud now (#2409, tri-review 4669518496 P2-4) —
      // run-analyze calls this on every full-path analyze.
      wipeLbugDbFiles: vi.fn(async () => undefined),
      // ≥1 cached row with a real-dims embedding: the harness default (empty
      // cache) would leave restoredEmbeddingCount at 0 and the recreation
      // gate shut — this test would then assert nothing.
      loadCachedEmbeddings: vi.fn(async () => ({
        embeddingNodeIds: new Set([RESTORED_NODE_ID]),
        embeddings: [
          {
            nodeId: RESTORED_NODE_ID,
            chunkIndex: 0,
            startLine: 0,
            endLine: 3,
            embedding: new Array(EMBEDDING_DIMS).fill(0),
            contentHash: 'stub-hash',
          },
        ],
      })),
      deleteNodesForFile: vi.fn(async () => undefined),
      // Batched incremental APIs (#2409) — consumed UNCONDITIONALLY by
      // run-analyze's incremental branch; a wholesale factory without them is
      // a latent TypeError the moment a mocked run goes incremental
      // (tri-review 4669518496 accuracy sweep).
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes: vi.fn(async () => undefined),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    // The stub graph must CONTAIN the cached row's node: Phase 3.5's
    // live-graph filter (KTD10) drops rows absent from the fresh graph, and
    // `getNode` is the lookup it uses.
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        totalFileCount: 1,
        graph: {
          forEachNode: (fn: (node: typeof stubNode) => void) => fn(stubNode),
          getNode: (id: string) => (id === RESTORED_NODE_ID ? stubNode : undefined),
        },
      })),
    }));
    // Avoid touching the global registry / repo .gitnexusignore from a unit test.
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      registerRepo: vi.fn(async () => 'vector-stamp-repo'),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));
    // Real pipeline module (the real batchInsertEmbeddings drives the restore
    // through the mocked executeWithReusedStatement) with ONLY the index
    // recreation forced to report failure.
    vi.doMock('../../src/core/embeddings/embedding-pipeline.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/embeddings/embedding-pipeline.js')>()),
      buildVectorIndex,
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-vector-stamp-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      // stats.embeddings > 0 → deriveEmbeddingMode loads the cache; force +
      // embeddingsNodeLimit(1) < getLbugStats().nodes(2) → generation is
      // cap-skipped. That makes this a wiped PRESERVE-shaped run — exactly
      // the KTD1 case where a naive `!shouldGenerateEmbeddings` gate would
      // wrongly stay shut (shouldGenerate is TRUE here, yet the Phase 4
      // pipeline never runs).
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: { embeddings: 1 },
      });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(
        tmpRepo.dbPath,
        { force: true, embeddingsNodeLimit: 1 },
        { onProgress: () => {} },
      );

      // The recreation seam fired exactly once…
      expect(buildVectorIndex).toHaveBeenCalledTimes(1);
      // …the restore first clears the exact target id, then submits the
      // cached row (one 200-row batch)…
      expect(executeWithReusedStatement).toHaveBeenCalledTimes(2);
      const [deleteCall, restoreCall] = executeWithReusedStatement.mock.calls;
      expect(deleteCall[0]).toContain('DELETE e');
      expect(deleteCall[1]).toEqual([{ id: `${RESTORED_NODE_ID}:0` }]);
      expect(restoreCall[0]).toContain('CREATE (e:CodeEmbedding');
      expect(restoreCall[1]).toHaveLength(1);
      // …and the persisted stamp reflects the DB's ACTUAL state, not the
      // platform capability fallback.
      const meta = JSON.parse(await fs.readFile(`${storagePath}/meta.json`, 'utf-8')) as RepoMeta;
      expect(meta.capabilities?.vectorSearch.status).toBe('exact-scan');
      expect(meta.stats?.embeddings).toBe(1);
    } finally {
      await tmpRepo.cleanup();
    }
  });
});

/**
 * U5 fail-fast pin (this shipping review, FIX 1 — replacing the tri-review
 * 4669518496 P2-3 drop-shape design): when the dirty-recovery sidecar
 * quarantine can neither PARK nor REMOVE a crashed run's sidecar, the run
 * must reject with a typed LbugWipeError in seconds — before any DB open
 * (the pre-wipe preservation open would replay the possibly-poisoned WAL
 * and die: the #2409 defect-2 death loop) and before the pipeline burns
 * minutes only to die at the rebuild wipe on the very same handle. The
 * dirty flag must survive the rejection so the next run re-attempts
 * recovery.
 */
describe('runFullAnalysis dirty-recovery parking failure fails fast (this shipping review, FIX 1)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/core/search/fts-indexes.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/core/embeddings/embedding-pipeline.js');
    // The test spies on fs.rename/fs.rm — restore BEFORE resetModules/
    // clearAllMocks so later suites' atomic meta writes never see the
    // path-filtered reject.
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('all-fail park + explicit --embeddings: rejects with LbugWipeError before any DB open, dirty flag survives', async () => {
    const loadCachedEmbeddings = vi.fn(async () => ({
      embeddingNodeIds: new Set<string>(),
      embeddings: [],
    }));
    const runEmbeddingPipeline = vi.fn(async () => ({ semanticMode: 'exact-scan' as const }));
    const runPipelineFromRepo = vi.fn(async (repoPath: string) => ({
      repoPath,
      totalFileCount: 1,
      graph: { forEachNode: () => undefined },
    }));
    // Wholesale factory EXCEPT LbugWipeError: run-analyze throws the class it
    // imports from this module, and the test asserts on that very type — so
    // the real class rides along via importActual.
    vi.doMock('../../src/core/lbug/lbug-adapter.js', async (importActual) => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({ nodes: 1, edges: 0, communities: 0, processes: 0 })),
      executeQuery: vi.fn(async () => []),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings,
      deleteNodesForFile: vi.fn(async () => undefined),
      // Batched incremental APIs (#2409) — consumed UNCONDITIONALLY by
      // run-analyze's incremental branch; a wholesale factory without them is
      // a latent TypeError the moment a mocked run goes incremental
      // (tri-review 4669518496 accuracy sweep).
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      loadFTSExtension: vi.fn(async () => false),
      LbugWipeError: (await importActual<typeof import('../../src/core/lbug/lbug-adapter.js')>())
        .LbugWipeError,
      DELETE_FILES_CHUNK_SIZE: 200,
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes: vi.fn(async () => undefined),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo,
    }));
    // Avoid touching the global registry / repo .gitnexusignore from a unit test.
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      registerRepo: vi.fn(async () => 'park-fail-repo'),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));
    // If the fail-fast gate were broken, the explicit --embeddings below
    // would reach Phase 4 and initialize a REAL embedder in CI — stub it so
    // the failure mode is a clean assertion, not a model download.
    vi.doMock('../../src/core/embeddings/embedding-pipeline.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/embeddings/embedding-pipeline.js')>()),
      runEmbeddingPipeline,
      buildVectorIndex: vi.fn(async () => true),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-park-fail-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      // Embedded repo + crashed writeback: exactly the state where the run
      // would otherwise open the DB pre-wipe to preserve embeddings.
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: { embeddings: 3 },
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 5,
          phase: 'load-graph',
        },
      });
      await createPlaceholderGraphStore(lbugPath);
      // A leftover WAL from the crash…
      await fs.writeFile(`${lbugPath}.wal`, Buffer.alloc(8192, 0xab));
      // …locked against EVERY escape hatch: renames onto `.dirty-recovery*`
      // targets fail EBUSY (retried direct park AND confirm probe), and the
      // rm-fallback on the WAL source fails EBUSY too. Path-filtered with
      // typed captured originals (repo-manager-transient-error.test.ts
      // precedent, minus its as-any) so meta's atomic tmp→final renames and
      // the temp-dir cleanup keep working.
      const originalRename: typeof fs.rename = fs.rename;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to).includes('.dirty-recovery')) {
          const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return originalRename(from, to);
      });
      const originalRm: typeof fs.rm = fs.rm;
      vi.spyOn(fs, 'rm').mockImplementation(async (p, opts) => {
        if (String(p) === `${lbugPath}.wal`) {
          const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return originalRm(p, opts);
      });

      const logs: string[] = [];
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const { LbugWipeError } = await import('../../src/core/lbug/lbug-adapter.js');
      const rejection: unknown = await runFullAnalysis(
        tmpRepo.dbPath,
        { embeddings: true },
        { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
      ).then(
        () => null,
        (e: unknown) => e,
      );

      // Fail-fast with the typed, self-contained error (serve forwards only
      // err.message over IPC): headline + blocked path + lock guidance.
      expect(rejection).toBeInstanceOf(LbugWipeError);
      expect(rejection).toMatchObject({
        name: 'LbugWipeError',
        survivors: [`${lbugPath}.wal`],
        message: expect.stringContaining('dirty-state recovery'),
      });
      expect(rejection).toMatchObject({
        message: expect.stringMatching(/stop any GitNexus MCP or serve process/i),
      });
      // The preservation open is the ONLY loadCachedEmbeddings call site —
      // not called means the DB was never opened before the throw…
      expect(loadCachedEmbeddings).not.toHaveBeenCalled();
      // …the pipeline never started (the throw is in seconds, not minutes)…
      expect(runPipelineFromRepo).not.toHaveBeenCalled();
      // …and the embedder never ran despite the explicit --embeddings.
      expect(runEmbeddingPipeline).not.toHaveBeenCalled();
      // The dirty flag SURVIVES the rejection: the next run re-attempts
      // recovery instead of certifying the half-written index.
      const meta = JSON.parse(await fs.readFile(`${storagePath}/meta.json`, 'utf-8')) as RepoMeta;
      expect(meta.incrementalInProgress).toMatchObject({ phase: 'load-graph' });
    } finally {
      await tmpRepo.cleanup();
    }
  });
});
