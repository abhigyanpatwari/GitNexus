import { execSync } from 'child_process';
import fs from 'fs/promises';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  getStoragePaths,
  loadMeta,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import { getIndexIncompleteReasons } from '../../src/core/index-freshness.js';
import type {
  EmbeddingPipelineOptions,
  EmbeddingPipelineResult,
} from '../../src/core/embeddings/embedding-pipeline.js';
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
      createSearchFTSIndexes: vi.fn(async () => []),
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

  const mockRepairSuccessLbugAdapter = (overrides: Record<string, unknown> = {}) => ({
    initLbug: vi.fn(async () => undefined),
    loadGraphToLbug: vi.fn(async () => undefined),
    getLbugStats: vi.fn(async () => ({})),
    executeQuery: vi.fn(async () => []),
    executeWithReusedStatement: vi.fn(async () => []),
    closeLbug: vi.fn(async () => undefined),
    wipeLbugDbFiles: vi.fn(async () => undefined),
    loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
    deleteNodesForFile: vi.fn(async () => undefined),
    deleteNodesForFiles: vi.fn(async () => undefined),
    deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
    queryImporters: vi.fn(async () => []),
    queryImportersBatch: vi.fn(async () => []),
    loadFTSExtension: vi.fn(async () => true),
    ...overrides,
  });

  it('--repair-fts stamps capabilities.fts.status while leaving indexedAt/lastCommit/runnerIdentity/stats byte-identical (#2767)', async () => {
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => mockRepairSuccessLbugAdapter());
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes: vi.fn(async () => []),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-stamp-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      const seededIndexedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
      const seeded: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: 'abc123',
        indexedAt: seededIndexedAt,
        stats: { files: 7, nodes: 42, edges: 10 },
        runnerIdentity: {
          source: { kind: 'source' as const, digest: 'src-digest' },
          build: {
            kind: 'source' as const,
            rootPath: '/x',
            canonicalization: 'gitnexus-analyzer-build-v2',
            digest: 'build-digest',
          },
          dependencyRuntime: {
            manifestPath: '/x/package.json',
            lockfilePath: null,
            canonicalization: 'gitnexus-analyzer-dependency-runtime-v4',
            packageCount: 1,
            artifactCount: 1,
            digest: 'dep-digest',
          },
        },
        capabilities: {
          graph: { provider: 'ladybugdb', status: 'available' },
          fts: { provider: 'ladybugdb-fts', status: 'degraded' },
          vectorSearch: { provider: 'exact-scan', status: 'unavailable', exactScanLimit: 500 },
        },
      };
      await saveMeta(storagePath, seeded);
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { repairFts: true },
        { onProgress: () => {} },
      );
      expect(result.ftsRepairedOnly).toBe(true);

      const meta = JSON.parse(await fs.readFile(`${storagePath}/gitnexus.json`, 'utf-8'));
      expect(meta.capabilities.fts.status).toBe('available');
      // Everything repair-fts must NOT touch stays byte-identical (R4).
      expect(meta.indexedAt).toBe(seededIndexedAt);
      expect(meta.lastCommit).toBe('abc123');
      expect(meta.runnerIdentity).toEqual(seeded.runnerIdentity);
      expect(meta.stats).toEqual(seeded.stats);
      // graph/vectorSearch, which repair-fts also never touches, pass through.
      expect(meta.capabilities.graph).toEqual(seeded.capabilities!.graph);
      expect(meta.capabilities.vectorSearch).toEqual(seeded.capabilities!.vectorSearch);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('--repair-fts backfills a full capabilities object when the existing meta predates the field entirely (#2767)', async () => {
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => mockRepairSuccessLbugAdapter());
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes: vi.fn(async () => []),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-legacy-meta-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      // Legacy shape: no `capabilities` key at all (pre-#2658 meta.json).
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: {},
      });
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      // Must not throw — a partial-capabilities spread over `undefined` would
      // otherwise violate RepoMeta.capabilities' required sub-fields.
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { repairFts: true },
        { onProgress: () => {} },
      );
      expect(result.ftsRepairedOnly).toBe(true);

      const meta = JSON.parse(await fs.readFile(`${storagePath}/gitnexus.json`, 'utf-8'));
      expect(meta.capabilities.fts.status).toBe('available');
      expect(meta.capabilities.graph).toBeDefined();
      expect(meta.capabilities.graph.status).toBe('available');
      expect(meta.capabilities.vectorSearch).toBeDefined();
      expect(meta.capabilities.vectorSearch.status).toBe('unavailable');
      expect(typeof meta.capabilities.vectorSearch.exactScanLimit).toBe('number');
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('--repair-fts still reports success when the capability-stamp write fails (#2767)', async () => {
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => mockRepairSuccessLbugAdapter());
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes: vi.fn(async () => []),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
      // Repair itself (createSearchFTSIndexes/verify) already succeeded by the
      // time this fires — a write failure here must degrade, not fail the run.
      saveMeta: vi.fn(async () => {
        throw new Error('EACCES: permission denied');
      }),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-stamp-write-fail-');
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
      const logs: string[] = [];
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { repairFts: true },
        { onProgress: () => {}, onLog: (msg: string) => logs.push(msg) },
      );

      expect(result.ftsRepairedOnly).toBe(true);
      expect(logs.join('\n')).toMatch(/capability stamp write failed/i);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('--repair-fts stamps onto the LATEST on-disk meta, not a snapshot from before the rebuild ran (#2767)', async () => {
    // A concurrent writer (e.g. the HTTP server's background embedding
    // checkpoint job) lands its own saveMeta while the FTS rebuild is in
    // flight. The repair-fts stamp must not silently revert that write by
    // basing itself on the `existingMeta` captured before the rebuild started.
    const CONCURRENT_LAST_COMMIT = 'concurrent-writer-commit';
    let storagePathForConcurrentWrite = '';
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => mockRepairSuccessLbugAdapter());
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes: vi.fn(async () => {
        // Simulate the concurrent writer landing mid-repair, via the test
        // file's own top-level `saveMeta` import (bound before any
        // vi.doMock call in this file, so it is always the real function).
        await saveMeta(storagePathForConcurrentWrite, {
          repoPath: '',
          lastCommit: CONCURRENT_LAST_COMMIT,
          indexedAt: new Date().toISOString(),
          stats: { files: 999 },
        });
        return [];
      }),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-repair-race-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      storagePathForConcurrentWrite = storagePath;
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: 'original-commit',
        indexedAt: new Date().toISOString(),
        stats: { files: 1 },
      });
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { repairFts: true },
        { onProgress: () => {} },
      );
      expect(result.ftsRepairedOnly).toBe(true);

      const meta = JSON.parse(await fs.readFile(`${storagePath}/gitnexus.json`, 'utf-8'));
      // The concurrent writer's update survives — the stamp did not revert it.
      expect(meta.lastCommit).toBe(CONCURRENT_LAST_COMMIT);
      expect(meta.stats).toEqual({ files: 999 });
      // The FTS stamp still landed on top of that latest state.
      expect(meta.capabilities.fts.status).toBe('available');
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

  it('degrades gracefully (no throw, warns, ftsSkipped) when FTS verification reports missing indexes after creation (#2544/#2546)', async () => {
    // A native tokenizer error on one pre-existing row (the #2544/#2546
    // failure mode) must not abort an otherwise-successful full analyze —
    // it degrades keyword search for this run instead, same contract as the
    // FTS-extension-unavailable sibling test below.
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
      // FTS extension loads → analyze proceeds to build + verify indexes.
      loadFTSExtension: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      buildSearchIndexesOrDegrade: vi.fn(async () => ({
        ok: false,
        error: 'missing indexes after build: Function.function_fts',
      })),
      ftsFailureIsFatal: (fc: 'capability' | 'integrity' | undefined, swap: boolean) =>
        fc === 'integrity' && swap,
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        // Full-analyze path only needs `forEachNode` before the FTS phase.
        graph: { forEachNode: () => undefined },
      })),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-full-verify-fail-');
    try {
      const logs: string[] = [];
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { force: true },
        { onProgress: () => {}, onLog: (msg: string) => logs.push(msg) },
      );

      expect(result.ftsSkipped).toBe(true);
      expect(result.ftsSkipReason).toBe('build-failed'); // #2658 review L2
      expect(logs.join('\n')).toMatch(
        /FTS index build failed.*missing indexes after build.*keyword search degraded this run/i,
      );

      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta = JSON.parse(await fs.readFile(`${storagePath}/meta.json`, 'utf-8'));
      expect(meta.capabilities.fts.status).toBe('unavailable');
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('ABORTS (throws before publish, leaves the previous index intact) on an FTS integrity failure on the atomic-swap path (#2658 review M1)', async () => {
    // The single-writer lock rules out a concurrent-writer race, so an
    // integrity-class FTS failure on the atomic-swap (--force) path is a real
    // broken build: run-analyze must throw BEFORE swapping the staging DB in,
    // leaving the previous live index untouched — not silently publish a
    // search-less index as success. This end-to-end throw path was previously
    // untested (only the ftsFailureIsFatal truth table was).
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({ nodes: 0, edges: 0, communities: 0, processes: 0 })),
      executeQuery: vi.fn(async () => []),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
      deleteNodesForFile: vi.fn(async () => undefined),
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      loadFTSExtension: vi.fn(async () => true),
    }));
    // Import the REAL classifier/predicate (not a re-stub) so the test pins the
    // actual fatal-decision logic, per the #2658 review.
    vi.doMock('../../src/core/search/fts-indexes.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/core/search/fts-indexes.js')>(
        '../../src/core/search/fts-indexes.js',
      );
      return {
        ...actual,
        initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
        buildSearchIndexesOrDegrade: vi.fn(async () => ({
          ok: false,
          failureClass: 'integrity' as const,
          error: 'IO exception: Error renaming lbug.staging.wal to checkpoint',
        })),
      };
    });
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        graph: { forEachNode: () => undefined },
      })),
    }));

    const tmpRepo = await createTempDir('gitnexus-run-analyze-integrity-abort-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      // A pre-existing "previous index" that must survive the aborted rebuild.
      await createPlaceholderGraphStore(lbugPath);
      const before = await fs.readFile(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const message = await runFullAnalysis(
        tmpRepo.dbPath,
        { force: true },
        { onProgress: () => {}, onLog: () => {} },
      ).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

      expect(message).toMatch(/integrity error/i);
      expect(message).toMatch(/aborted|previous index is\s+left intact/i);
      // The previous index bytes are untouched (throw happened before the swap).
      const after = await fs.readFile(lbugPath);
      expect(after.equals(before)).toBe(true);
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
      expect(result.ftsSkipReason).toBe('extension-unavailable'); // #2658 review L2
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
      expect(result.ftsSkipReason).toBe('extension-unavailable'); // #2658 review L2
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
      createSearchFTSIndexes: vi.fn(async () => []),
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
      createSearchFTSIndexes: vi.fn(async () => []),
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

describe('runFullAnalysis re-resolves git state under the lock (#2658 review H2)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/storage/git.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('re-reads HEAD after acquiring the lock, so a commit that lands during the wait is not missed', async () => {
    // acquireIndexLock can wait up to the timeout ceiling; HEAD may advance
    // during that wait. Pre-fix, resolveWriteTarget was called ONCE (before the
    // lock) and its stale snapshot fed the freshness check — a waiter could
    // return alreadyUpToDate against the OLD commit. Post-fix the wrapper
    // re-resolves UNDER the lock, so getCurrentCommit is called again and the
    // post-wait commit is what the pipeline uses. Simulate the advance by making
    // getCurrentCommit return a new value on each call.
    const commits = ['commit-before-wait', 'commit-after-wait'];
    let call = 0;
    const getCurrentCommit = vi.fn(
      () => commits[call < commits.length ? call++ : commits.length - 1],
    );
    vi.doMock('../../src/storage/git.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/storage/git.js')>(
        '../../src/storage/git.js',
      );
      return {
        ...actual,
        getCurrentCommit,
        hasGitDir: () => true,
        getCurrentBranch: () => 'main',
        isWorkingTreeDirty: () => false,
      };
    });
    // Stop the run right after the wrapper's two resolveWriteTarget calls so the
    // test pins the re-resolve, not the full pipeline.
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async () => {
        throw new Error('stop-after-resolve');
      }),
    }));

    const tmpRepo = await createTempDir('gitnexus-h2-relock-');
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(
        tmpRepo.dbPath,
        { force: true },
        { onProgress: () => {}, onLog: () => {} },
      ).catch(() => undefined);

      // Pre-fix: exactly 1 (single pre-lock resolve). Post-fix: >= 2 (re-resolve
      // under the lock), and the second call observed the post-wait commit.
      expect(getCurrentCommit.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(getCurrentCommit.mock.results[1]?.value).toBe('commit-after-wait');
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('releases the lock when the under-lock re-resolve throws (no leak) (#2658 review H2 self-review)', async () => {
    // The re-resolve runs UNDER the held lock and can throw (e.g. a `--branch`
    // that no longer matches a checkout switched during the wait). That throw
    // must still release the lock — the loop lives inside the try/finally.
    vi.doUnmock('../../src/storage/git.js');
    const release = vi.fn();
    vi.doMock('../../src/storage/index-lock.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/storage/index-lock.js')>(
        '../../src/storage/index-lock.js',
      );
      return {
        ...actual,
        acquireIndexLock: vi.fn(async () => ({
          record: {
            v: 1,
            pid: 1,
            hostname: 'h',
            startTime: null,
            token: 't',
            invocationId: 'i',
            acquiredAt: '',
          },
          release,
        })),
      };
    });
    // getCurrentCommit succeeds on the pre-lock resolve, then throws on the
    // under-lock re-resolve — the exact shape a mid-wait git change produces.
    let call = 0;
    vi.doMock('../../src/storage/git.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/storage/git.js')>(
        '../../src/storage/git.js',
      );
      return {
        ...actual,
        hasGitDir: () => true,
        getCurrentBranch: () => 'main',
        isWorkingTreeDirty: () => false,
        getCurrentCommit: () => {
          if (call++ === 0) return 'c1';
          throw new Error('git HEAD read failed mid-wait');
        },
      };
    });

    const tmpRepo = await createTempDir('gitnexus-h2-leak-');
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const err = await runFullAnalysis(
        tmpRepo.dbPath,
        { force: true },
        { onProgress: () => {}, onLog: () => {} },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(release).toHaveBeenCalledTimes(1); // lock freed despite the throw
    } finally {
      vi.doUnmock('../../src/storage/index-lock.js');
      await tmpRepo.cleanup();
    }
  });
});

/**
 * ── #2790: the Phase 5 embedding gate ─────────────────────────────────
 *
 * Four distinct real states used to collapse into `embeddingCount === 0`, and
 * the gate hard-crashed the run on three of them. Nothing pinned it in either
 * direction before this suite (the message string `'without persisted
 * embeddings'` appeared ONLY in run-analyze.ts). Driven on the wholesale-mock
 * harness above so each branch is reachable deterministically: the count probe
 * and the pipeline's `nodesProcessed`/`failedNodeIds` receipt are the only two
 * inputs the gate reads.
 */
describe('runFullAnalysis Phase 5 embedding gate (#2790)', () => {
  const GATE_NODE_ID = 'Function:src/app.ts:handler:1';
  const stubNode = {
    id: GATE_NODE_ID,
    label: 'Function',
    name: 'handler',
    properties: { filePath: 'src/app.ts' },
  };

  /** The `count(e)` probe's answer; `'throw'` simulates a failed count query. */
  type CountAnswer = 'throw' | Array<Record<string, unknown>>;

  const mockGateHarness = (
    countAnswer: CountAnswer,
    pipelineResult: EmbeddingPipelineResult,
  ): { runEmbeddingPipeline: Mock } => {
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({ nodes: 2, edges: 0, communities: 0, processes: 0 })),
      executeQuery: vi.fn(async (cypher: string) => {
        if (!/RETURN count\(e\) AS cnt/.test(cypher)) return [];
        if (countAnswer === 'throw') {
          throw new Error('Binder exception: Table CodeEmbedding does not exist.');
        }
        return countAnswer;
      }),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      wipeLbugDbFiles: vi.fn(async () => undefined),
      loadCachedEmbeddings: vi.fn(async () => ({
        embeddingNodeIds: new Set<string>(),
        embeddings: [],
      })),
      deleteNodesForFile: vi.fn(async () => undefined),
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes: vi.fn(async () => []),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        totalFileCount: 1,
        graph: {
          forEachNode: (fn: (node: typeof stubNode) => void) => fn(stubNode),
          getNode: (id: string) => (id === GATE_NODE_ID ? stubNode : undefined),
        },
      })),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      registerRepo: vi.fn(async () => 'embedding-gate-repo'),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));
    // Fixed identity: keeps the local embedder (and its native runtime) out of
    // a gate test that never embeds anything for real.
    vi.doMock('../../src/core/embeddings/embedding-identity.js', () => ({
      resolveEmbeddingIdentity: vi.fn(() => ({
        model: 'gate-test-model',
        dimensions: EMBEDDING_DIMS,
        provider: 'local',
      })),
    }));
    const runEmbeddingPipeline = vi.fn(async () => pipelineResult);
    vi.doMock('../../src/core/embeddings/embedding-pipeline.js', () => ({
      runEmbeddingPipeline,
      buildVectorIndex: vi.fn(async () => false),
    }));
    return { runEmbeddingPipeline };
  };

  const cleanPipelineResult = (
    overrides: Partial<EmbeddingPipelineResult> = {},
  ): EmbeddingPipelineResult => ({
    nodesProcessed: 3,
    chunksProcessed: 3,
    vectorIndexReady: false,
    semanticMode: 'exact-scan',
    failedNodeIds: [],
    ...overrides,
  });

  const runGate = async (
    prefix: string,
    countAnswer: CountAnswer,
    pipelineResult: EmbeddingPipelineResult,
  ): Promise<{ logs: string[]; meta: RepoMeta | null; rawMeta: string; error: unknown }> => {
    mockGateHarness(countAnswer, pipelineResult);
    const tmpRepo = await createTempDir(prefix);
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      const logs: string[] = [];
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const error: unknown = await runFullAnalysis(
        tmpRepo.dbPath,
        { embeddings: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      const rawMeta = await fs.readFile(`${storagePath}/meta.json`, 'utf-8').catch(() => '');
      return {
        logs,
        meta: rawMeta === '' ? null : (JSON.parse(rawMeta) as RepoMeta),
        rawMeta,
        error,
      };
    } finally {
      await tmpRepo.cleanup();
    }
  };

  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/core/search/fts-indexes.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/core/embeddings/embedding-identity.js');
    vi.doUnmock('../../src/core/embeddings/embedding-pipeline.js');
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  // State 4 — the ONLY genuine failure: work was attempted and nothing landed.
  it('throws when the pipeline attempted work and the count is a known zero', async () => {
    const { error, meta } = await runGate(
      'gitnexus-gate-known-zero-',
      [{ cnt: 0 }],
      cleanPipelineResult(),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringContaining('without persisted embeddings'),
    });
    // …and the crash now tells the operator how to recover.
    expect(error).toMatchObject({
      message: expect.stringMatching(/GITNEXUS_EMBEDDING_URL/),
    });
    expect(error).toMatchObject({
      message: expect.stringMatching(/--drop-embeddings/),
    });
    // The index really was not registered: no finalize meta was written.
    expect(meta).toBeNull();
  });

  // State 3 — "cannot ask" is not "wrote nothing".
  it('does not fire when the count query throws, and logs why the count is unknown', async () => {
    const { error, logs, meta } = await runGate(
      'gitnexus-gate-count-throws-',
      'throw',
      cleanPipelineResult(),
    );
    expect(error).toBeNull();
    // The silent `catch {}` is gone — the operator sees the real reason.
    expect(logs).toContainEqual(expect.stringContaining('could not count persisted embeddings'));
    expect(logs).toContainEqual(expect.stringContaining('Table CodeEmbedding does not exist'));
    expect(logs).toContainEqual(expect.stringContaining('without a verified embedding count'));
    // The index was registered despite the diagnostic failure.
    expect(meta).toMatchObject({ repoPath: expect.any(String) });
  });

  // State 2 — the pipeline ran but had nothing to embed (totalNodes 0 after
  // the incremental filter). A legitimately empty table is not a defect.
  it('does not fire when the pipeline had nothing to attempt', async () => {
    const { error, meta } = await runGate(
      'gitnexus-gate-nothing-to-do-',
      [{ cnt: 0 }],
      cleanPipelineResult({ nodesProcessed: 0, chunksProcessed: 0 }),
    );
    expect(error).toBeNull();
    expect(meta).toMatchObject({ stats: { embeddings: 0 } });
    expect(meta).toMatchObject({
      capabilities: { vectorSearch: { status: 'unavailable' } },
    });
  });

  // Partial success: honest partial index beats no index.
  it('warns but does not fire when nodes were dropped and embeddings still persisted', async () => {
    const { error, logs, meta } = await runGate(
      'gitnexus-gate-partial-',
      [{ cnt: 5 }],
      cleanPipelineResult({ nodesProcessed: 2, failedNodeIds: ['node-a', 'node-b'] }),
    );
    expect(error).toBeNull();
    expect(logs).toContainEqual(expect.stringContaining('2 node(s) lost their embeddings'));
    // The heal promise names what ACTUALLY heals them. "Zero rows, so the next
    // run re-embeds them automatically" was false: a plain analyze over an
    // already-embedded index derives shouldGenerateEmbeddings = false and never
    // calls the pipeline at all (#2790).
    expect(logs).toContainEqual(expect.stringMatching(/recorded as an embedding checkpoint/));
    expect(logs).not.toContainEqual(expect.stringMatching(/re-embeds\s+them automatically/));
    expect(meta).toMatchObject({ stats: { embeddings: 5 } });
  });

  // Finding 1: the checkpoint is the heal mechanism, so a partial run must
  // leave it on disk carrying exactly the dropped ids.
  it('retains the embedding checkpoint with the dropped ids as pendingNodeIds', async () => {
    const { error, meta } = await runGate(
      'gitnexus-gate-partial-checkpoint-',
      [{ cnt: 5 }],
      cleanPipelineResult({
        nodesProcessed: 2,
        chunksProcessed: 6,
        failedNodeIds: ['node-a', 'node-b'],
      }),
    );
    expect(error).toBeNull();
    expect(meta).toMatchObject({
      embeddingCheckpoint: {
        pendingNodeIds: ['node-a', 'node-b'],
        nodesProcessed: 2,
        // nodesProcessed (complete) + the dropped ones = the nodes walked.
        totalNodes: 4,
        chunksProcessed: 6,
        // The identity of the run that actually wrote it — so a later config
        // change trips the resume mismatch error, not a foreign-identity resume.
        model: 'gate-test-model',
        dimensions: EMBEDDING_DIMS,
        provider: 'local',
      },
    });
    // The index is registered and honestly reports itself as incomplete.
    expect(getIndexIncompleteReasons(meta)).toEqual(['embedding-checkpoint-pending']);
  });

  // …and the clean-run contract is unchanged: nothing pending, nothing retained.
  it('clears the embedding checkpoint on a clean run', async () => {
    const { error, meta } = await runGate(
      'gitnexus-gate-clean-checkpoint-',
      [{ cnt: 5 }],
      cleanPipelineResult(),
    );
    expect(error).toBeNull();
    expect(meta?.embeddingCheckpoint).toBeUndefined();
    expect(getIndexIncompleteReasons(meta)).toEqual([]);
  });

  /**
   * Finding 3: an UNVERIFIED count must not certify the vector lane.
   *
   * `runGate` above always starts from an empty temp dir, so
   * `existingMeta?.stats?.embeddings` is undefined there and the carry-forward
   * branch never runs. Seeded here: prior meta claims 5000 embeddings and a
   * working vector index, the operator runs --drop-embeddings (so the pipeline
   * never runs and cannot report anything), and the count probe throws. The
   * count carries forward — it is the sole input to the NEXT run's
   * deriveEmbeddingMode and a false 0 would make a later --force discard a live
   * cache — but a guess may not stamp 'vector-index' over a table holding zero.
   */
  it('does not certify the vector lane from a carried-forward count (#2790)', async () => {
    mockGateHarness('throw', cleanPipelineResult());
    const tmpRepo = await createTempDir('gitnexus-gate-carryforward-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: { nodes: 2, embeddings: 5000 },
        capabilities: {
          graph: { provider: 'ladybugdb', status: 'available' },
          fts: { provider: 'ladybugdb-fts', status: 'available' },
          vectorSearch: {
            provider: 'ladybugdb-vector',
            status: 'vector-index',
            exactScanLimit: 10_000,
          },
        },
      });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const dropLogs: string[] = [];
      await runFullAnalysis(
        tmpRepo.dbPath,
        { dropEmbeddings: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: (m: string) => dropLogs.push(m) },
      );

      const meta = await loadMeta(storagePath);
      // The carry-forward is deliberate and still happens…
      expect(meta).toMatchObject({ stats: { embeddings: 5000 } });
      // …but the unverified figure does not vouch for a vector lane over a DB
      // whose embedding table the run just dropped. Pre-fix this stamped
      // 'vector-index' (the persisted stamp fed `effectiveSemanticMode`).
      expect(meta).toMatchObject({
        capabilities: { vectorSearch: { status: 'unavailable' } },
      });
      expect(dropLogs).toContainEqual(
        expect.stringContaining('without a verified embedding count'),
      );

      // The carried-forward count still drives the NEXT run's mode derivation:
      // a plain re-analyze reads 5000 as `existingEmbeddingCount` rather than
      // treating the repo as never-embedded (which is what a false 0 would do,
      // making the run discard the surviving cache).
      const nextLogs: string[] = [];
      await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: (m: string) => nextLogs.push(m) },
      );
      expect(nextLogs).toContainEqual(expect.stringContaining('5000 existing embeddings'));
    } finally {
      await tmpRepo.cleanup();
    }
  });

  // The bypass hole: `Number(...)` → NaN, `NaN === 0` is false, so the old gate
  // waved this through and `stats.embeddings` serialized to null.
  it('treats a non-finite count as unknown rather than a silent pass', async () => {
    const { error, logs, meta, rawMeta } = await runGate(
      'gitnexus-gate-non-finite-',
      [{ cnt: 'not-a-number' }],
      cleanPipelineResult(),
    );
    expect(error).toBeNull();
    expect(logs).toContainEqual(
      expect.stringContaining('count query returned a non-numeric result'),
    );
    expect(logs).toContainEqual(expect.stringContaining('without a verified embedding count'));
    // Not silently stamped: no NaN-derived null lands in meta.json, and the
    // capability stamp does not claim a working vector lane off an unknown.
    expect(meta?.stats?.embeddings).toBeUndefined();
    expect(rawMeta).not.toContain('"embeddings":null');
    expect(meta).toMatchObject({
      capabilities: { vectorSearch: { status: 'unavailable' } },
    });
  });
});

/**
 * ── #2790: an embedding checkpoint writes ONLY the checkpoint ──────────
 *
 * `onCheckpointWindowStart` fires at batchIndex 0 — before a single embedding
 * row exists — and used to persist a full SUCCESS-shaped meta: the new
 * `lastCommit`, the new `fileHashes`, and `incrementalInProgress: undefined`.
 * On a full rebuild the graph is still in the unpublished staging DB, so a
 * Phase 4 crash discarded the build and left a meta claiming the new commit;
 * the next run hash-diffed to changed=0/added=0/deleted=0, took the incremental
 * path and "preserved" the OLD graph — while the crash-recovery dirty flag it
 * had cleared could no longer force the healing rebuild.
 *
 * The end-to-end version of this lives in run-analyze.test.ts (real repo, real
 * pipeline). This one drives the same callbacks through the wholesale-mock
 * harness so every field is asserted against a KNOWN pre-existing meta and the
 * assertions need no build artifacts.
 */
describe('runFullAnalysis embedding-checkpoint meta write (#2790)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/core/search/fts-indexes.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/core/embeddings/embedding-identity.js');
    vi.doUnmock('../../src/core/embeddings/embedding-pipeline.js');
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('preserves lastCommit / fileHashes / the dirty flag, and never restates a stale count', async () => {
    const STALE_COMMIT = '1111111111111111111111111111111111111111';
    const STALE_HASHES = { 'src/app.ts': 'stale-hash' };
    const LIVE_EMBEDDING_COUNT = 42;

    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({ nodes: 2, edges: 0, communities: 0, processes: 0 })),
      executeQuery: vi.fn(async (cypher: string) =>
        /RETURN count\(e\) AS cnt/.test(cypher) ? [{ cnt: LIVE_EMBEDDING_COUNT }] : [],
      ),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      wipeLbugDbFiles: vi.fn(async () => undefined),
      // The post-window `onCheckpoint` drains the WAL through the real
      // wal-checkpoint-driver, which flushes via this adapter export.
      tryFlushWAL: vi.fn(async () => true),
      loadCachedEmbeddings: vi.fn(async () => ({
        embeddingNodeIds: new Set<string>(),
        embeddings: [],
      })),
      deleteNodesForFile: vi.fn(async () => undefined),
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes: vi.fn(async () => []),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    // No File nodes → this run's computed fileHashes are EMPTY, so a save that
    // wrote them would visibly erase the stale map the assertions pin.
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        totalFileCount: 1,
        graph: { forEachNode: () => undefined, getNode: () => undefined },
      })),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      registerRepo: vi.fn(async () => 'checkpoint-meta-repo'),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));
    vi.doMock('../../src/core/embeddings/embedding-identity.js', () => ({
      resolveEmbeddingIdentity: vi.fn(() => ({
        model: 'checkpoint-test-model',
        dimensions: EMBEDDING_DIMS,
        provider: 'local',
      })),
    }));

    const tmpRepo = await createTempDir('gitnexus-2790-checkpoint-meta-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      // A real commit so `currentCommit` differs from the stale stamp: without
      // it both are '' and the advancement would be unobservable.
      const git = (cmd: string) => execSync(cmd, { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      git('git init');
      git('git -c user.name=test -c user.email=test@test commit --allow-empty -m init');
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();

      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: STALE_COMMIT,
        indexedAt: new Date().toISOString(),
        stats: { nodes: 2, embeddings: 7 },
        fileHashes: STALE_HASHES,
        // A crashed prior run's dirty flag: the checkpoint save must not clear
        // it (it is the only thing that can force the healing rebuild).
        incrementalInProgress: { startedAt: Date.now() - 60_000, toWriteCount: 3 },
      });

      const snapshots: Record<string, RepoMeta | null> = {};
      const runEmbeddingPipeline = vi.fn(
        async (
          _executeQuery: unknown,
          _executeWithReusedStatement: unknown,
          _onProgress: unknown,
          _config: unknown,
          _cachedNodeIds: unknown,
          _existingEmbeddings: unknown,
          pipelineOptions: EmbeddingPipelineOptions,
        ): Promise<EmbeddingPipelineResult> => {
          // Window 1 — fires before ANY embedding row exists.
          await pipelineOptions.onCheckpointWindowStart?.({
            nodesProcessed: 0,
            totalNodes: 4,
            chunksProcessed: 0,
            nodeIds: ['node-1', 'node-2'],
          });
          snapshots.windowStart = await loadMeta(storagePath);
          // Post-window checkpoint — this one MEASURED the live count.
          await pipelineOptions.onCheckpoint?.({
            nodesProcessed: 2,
            totalNodes: 4,
            chunksProcessed: 4,
          });
          snapshots.postWindow = await loadMeta(storagePath);
          // Window 2 — the old code restated the PREVIOUS run's count here and
          // clobbered the live figure the post-window save had just written.
          await pipelineOptions.onCheckpointWindowStart?.({
            nodesProcessed: 2,
            totalNodes: 4,
            chunksProcessed: 4,
            nodeIds: ['node-3', 'node-4'],
          });
          snapshots.secondWindow = await loadMeta(storagePath);
          return {
            nodesProcessed: 4,
            chunksProcessed: 8,
            vectorIndexReady: false,
            semanticMode: 'exact-scan',
            failedNodeIds: [],
          };
        },
      );
      vi.doMock('../../src/core/embeddings/embedding-pipeline.js', () => ({
        runEmbeddingPipeline,
        buildVectorIndex: vi.fn(async () => false),
      }));

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(
        tmpRepo.dbPath,
        { embeddings: true, force: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: () => {} },
      );

      expect(runEmbeddingPipeline).toHaveBeenCalledTimes(1);

      // ── Window 1: the checkpoint landed… ──────────────────────────────
      expect(snapshots.windowStart).toMatchObject({
        embeddingCheckpoint: {
          nodesProcessed: 0,
          totalNodes: 4,
          model: 'checkpoint-test-model',
          pendingNodeIds: ['node-1', 'node-2'],
        },
      });
      // …and NOTHING that certifies freshness moved. lastCommit still points at
      // the last PUBLISHED index, the stale hash map is intact (this run's own
      // map is empty), and the dirty flag survives so a crash here still forces
      // the rebuild.
      expect(snapshots.windowStart).toMatchObject({
        lastCommit: STALE_COMMIT,
        fileHashes: STALE_HASHES,
        incrementalInProgress: { phase: 'full-rebuild' },
        stats: { embeddings: 7 },
      });
      expect(snapshots.windowStart?.lastCommit).not.toBe(currentCommit);

      // ── Post-window: the one save that legitimately measured the count ──
      expect(snapshots.postWindow).toMatchObject({
        lastCommit: STALE_COMMIT,
        fileHashes: STALE_HASHES,
        incrementalInProgress: { phase: 'full-rebuild' },
        stats: { embeddings: LIVE_EMBEDDING_COUNT },
      });

      // ── Window 2: no stale restatement over the measured figure ────────
      expect(snapshots.secondWindow).toMatchObject({
        lastCommit: STALE_COMMIT,
        stats: { embeddings: LIVE_EMBEDDING_COUNT },
        embeddingCheckpoint: { pendingNodeIds: ['node-3', 'node-4'] },
      });

      // Only the finalize write — after the index is published — advances
      // freshness and clears both the checkpoint and the dirty flag.
      const finalMeta = JSON.parse(
        await fs.readFile(`${storagePath}/meta.json`, 'utf-8'),
      ) as RepoMeta;
      expect(finalMeta).toMatchObject({ lastCommit: currentCommit });
      expect(finalMeta.embeddingCheckpoint).toBeUndefined();
      expect(finalMeta.incrementalInProgress).toBeUndefined();
    } finally {
      await tmpRepo.cleanup();
    }
  });
});

/**
 * ── #2790 review: the four P1s the first cut left behind ───────────────
 *
 * Everything above proves Phase 5 reasons correctly once it is REACHED and
 * once the count probe answers honestly. These prove the four ways it was not:
 *
 *  1. the mid-run `onCheckpoint` count query ran bare — a throw there rejected
 *     the callback, propagated out of `runEmbeddingPipeline` and killed the run
 *     before Phase 5 executed at all, so the tri-state could never fire;
 *  2. Phase 5's hand-copied count body ended `?? 0` where the server's ended
 *     `?? Number.NaN`, so a NO-ROW answer became a MEASURED zero and the gate
 *     threw on runs where every embedding persisted;
 *  4. the unknown-count fallback read `existingMeta` — a run-START snapshot —
 *     and clobbered the fresher count this run's own checkpoint had written;
 *  5. an exit-0 partial run planted a checkpoint stamped with this run's
 *     embedding identity that a later plain `analyze` could not resume, could
 *     not clear, and died on before any phase ran.
 *
 * Driven on the same wholesale-mock harness, with MUTABLE controls so one mock
 * set can drive a multi-run scenario (a checkpoint's whole point is what the
 * NEXT run does with it).
 */
describe('runFullAnalysis embedding-checkpoint resilience (#2790 review)', () => {
  const RESILIENCE_NODE_ID = 'Function:src/app.ts:handler:1';
  const stubNode = {
    id: RESILIENCE_NODE_ID,
    label: 'Function',
    name: 'handler',
    properties: { filePath: 'src/app.ts' },
  };

  const HARNESS_IDENTITY = {
    model: 'resilience-test-model',
    dimensions: EMBEDDING_DIMS,
    provider: 'local',
  } as const;

  /** Mutable per-run controls; every mock reads through them at call time. */
  interface ResilienceControls {
    /** The `count(e)` probe's answer. `'throw'` ≡ the count is unavailable. */
    count: 'throw' | Array<Record<string, unknown>>;
    /** What the mocked pipeline reports, and what it does with its callbacks. */
    pipeline: (options: EmbeddingPipelineOptions) => Promise<EmbeddingPipelineResult>;
  }

  const cleanResult = (overrides: Partial<EmbeddingPipelineResult> = {}): EmbeddingPipelineResult =>
    ({
      nodesProcessed: 3,
      chunksProcessed: 3,
      vectorIndexReady: false,
      semanticMode: 'exact-scan',
      failedNodeIds: [],
      ...overrides,
    }) satisfies EmbeddingPipelineResult;

  const mockResilienceHarness = (
    controls: ResilienceControls,
  ): { runEmbeddingPipeline: Mock; loadCachedEmbeddings: Mock } => {
    const loadCachedEmbeddings = vi.fn(async () => ({
      embeddingNodeIds: new Set<string>(),
      embeddings: [],
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      initLbug: vi.fn(async () => undefined),
      loadGraphToLbug: vi.fn(async () => undefined),
      getLbugStats: vi.fn(async () => ({ nodes: 2, edges: 0, communities: 0, processes: 0 })),
      executeQuery: vi.fn(async (cypher: string) => {
        if (!/RETURN count\(e\) AS cnt/.test(cypher)) return [];
        if (controls.count === 'throw') {
          throw new Error('Binder exception: Table CodeEmbedding does not exist.');
        }
        return controls.count;
      }),
      executeWithReusedStatement: vi.fn(async () => []),
      closeLbug: vi.fn(async () => undefined),
      wipeLbugDbFiles: vi.fn(async () => undefined),
      // The post-window `onCheckpoint` drains the WAL through the real
      // wal-checkpoint-driver, which flushes via this adapter export.
      tryFlushWAL: vi.fn(async () => true),
      loadCachedEmbeddings,
      deleteNodesForFile: vi.fn(async () => undefined),
      deleteNodesForFiles: vi.fn(async () => undefined),
      deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
      queryImporters: vi.fn(async () => []),
      queryImportersBatch: vi.fn(async () => []),
      loadFTSExtension: vi.fn(async () => false),
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', () => ({
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes: vi.fn(async () => []),
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        totalFileCount: 1,
        graph: {
          forEachNode: (fn: (node: typeof stubNode) => void) => fn(stubNode),
          getNode: (id: string) => (id === RESILIENCE_NODE_ID ? stubNode : undefined),
        },
      })),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      registerRepo: vi.fn(async () => 'embedding-resilience-repo'),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));
    // Fixed identity: keeps the local embedder (and its native runtime) out of
    // tests that never embed anything for real. A checkpoint written with a
    // DIFFERENT provider string is therefore a controlled identity mismatch.
    vi.doMock('../../src/core/embeddings/embedding-identity.js', () => ({
      resolveEmbeddingIdentity: vi.fn(() => ({ ...HARNESS_IDENTITY })),
    }));
    const runEmbeddingPipeline = vi.fn(
      async (
        _executeQuery: unknown,
        _executeWithReusedStatement: unknown,
        _onProgress: unknown,
        _config: unknown,
        _cachedNodeIds: unknown,
        _existingEmbeddings: unknown,
        pipelineOptions: EmbeddingPipelineOptions,
      ): Promise<EmbeddingPipelineResult> => controls.pipeline(pipelineOptions),
    );
    vi.doMock('../../src/core/embeddings/embedding-pipeline.js', () => ({
      runEmbeddingPipeline,
      buildVectorIndex: vi.fn(async () => false),
    }));
    return { runEmbeddingPipeline, loadCachedEmbeddings };
  };

  /** A checkpoint shaped exactly as `RepoMeta` declares it. */
  const checkpointFixture = (
    overrides: Partial<NonNullable<RepoMeta['embeddingCheckpoint']>> = {},
  ): NonNullable<RepoMeta['embeddingCheckpoint']> => ({
    at: new Date(0).toISOString(),
    nodesProcessed: 2,
    totalNodes: 3,
    chunksProcessed: 4,
    model: HARNESS_IDENTITY.model,
    dimensions: HARNESS_IDENTITY.dimensions,
    provider: HARNESS_IDENTITY.provider,
    ...overrides,
  });

  const seedMeta = async (
    storagePath: string,
    repoPath: string,
    overrides: Partial<RepoMeta>,
  ): Promise<void> => {
    await fs.mkdir(storagePath, { recursive: true });
    await saveMeta(storagePath, {
      repoPath,
      lastCommit: '',
      indexedAt: new Date(0).toISOString(),
      stats: { nodes: 2, embeddings: 0 },
      ...overrides,
    });
  };

  /** `runFullAnalysis` that resolves to the thrown error instead of rejecting. */
  const runAnalyze = async (
    repoPath: string,
    options: Record<string, unknown>,
    logs: string[],
  ): Promise<unknown> => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    return await runFullAnalysis(repoPath, options, {
      onProgress: () => {},
      onLog: (m: string) => logs.push(m),
    }).then(
      () => null,
      (e: unknown) => e,
    );
  };

  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/core/search/fts-indexes.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/core/embeddings/embedding-identity.js');
    vi.doUnmock('../../src/core/embeddings/embedding-pipeline.js');
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  /**
   * FINDING 1 — the mid-run count is a diagnostic, not a kill switch.
   *
   * `onCheckpoint` used to run the count query bare. Its rejection propagates
   * out of `runEmbeddingPipeline`, so a DB-busy moment / closed connection /
   * read-only store / the VECTOR-extension DML lock (#2623) took the entire
   * analyze down BEFORE Phase 5 — the exact failure Phase 5's tri-state exists
   * to absorb, and it never got to run.
   */
  it('survives a mid-run checkpoint count failure and still reaches Phase 5', async () => {
    const midRunMetas: Array<RepoMeta | null> = [];
    const tmpRepo = await createTempDir('gitnexus-2790r-checkpoint-count-throws-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await seedMeta(storagePath, tmpRepo.dbPath, { stats: { nodes: 2, embeddings: 9 } });
      const controls: ResilienceControls = {
        count: 'throw',
        pipeline: async (options) => {
          await options.onCheckpoint?.({
            nodesProcessed: 2,
            totalNodes: 4,
            chunksProcessed: 4,
          });
          midRunMetas.push(await loadMeta(storagePath));
          return cleanResult();
        },
      };
      mockResilienceHarness(controls);

      const logs: string[] = [];
      const error = await runAnalyze(
        tmpRepo.dbPath,
        { embeddings: true, skipAgentsMd: true, skipSkills: true },
        logs,
      );

      // Pre-fix: the callback's rejection killed the run here.
      expect(error).toBeNull();
      expect(logs).toContainEqual(
        expect.stringContaining(
          'could not measure persisted embeddings at the embedding checkpoint',
        ),
      );
      // The checkpoint still landed — only the count was skipped…
      expect(midRunMetas[0]).toMatchObject({
        embeddingCheckpoint: { nodesProcessed: 2, totalNodes: 4, kind: 'interrupted' },
      });
      // …and the last known count was left alone rather than overwritten with
      // NaN (which `JSON.stringify` serializes as `null`).
      expect(midRunMetas[0]).toMatchObject({ stats: { embeddings: 9 } });
      // Phase 5 ran: its own probe is unavailable too, and it says so.
      expect(logs).toContainEqual(expect.stringContaining('without a verified embedding count'));
    } finally {
      await tmpRepo.cleanup();
    }
  });

  /**
   * FINDING 2 — a no-row answer is UNKNOWN, never a measured zero.
   *
   * An empty CodeEmbedding table still answers `count(e)` with one row holding
   * `0`, so no row at all means the query did not really answer. Phase 5's copy
   * ended `?? 0`, which made `Number.isFinite(0)` true, the unknown branch
   * unreachable, and the "completed without persisted embeddings" gate fire on
   * a run where every embedding persisted.
   */
  it('treats a no-row count as unknown instead of crashing a successful run', async () => {
    const tmpRepo = await createTempDir('gitnexus-2790r-no-row-count-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      mockResilienceHarness({ count: [], pipeline: async () => cleanResult() });

      const logs: string[] = [];
      const error = await runAnalyze(
        tmpRepo.dbPath,
        { embeddings: true, skipAgentsMd: true, skipSkills: true },
        logs,
      );

      // Pre-fix this threw "Embedding generation completed without persisted
      // embeddings" and refused to register the index.
      expect(error).toBeNull();
      expect(logs).toContainEqual(expect.stringContaining('the count query returned no row'));
      expect(logs).toContainEqual(expect.stringContaining('without a verified embedding count'));
      const meta = await loadMeta(storagePath);
      expect(meta).toMatchObject({ repoPath: tmpRepo.dbPath });
    } finally {
      await tmpRepo.cleanup();
    }
  });

  /**
   * FINDING 4 — the unknown-count fallback must read the LATEST on-disk meta.
   *
   * The damage chain in full: prior meta says `embeddings: 0` → a clean run
   * inserts embeddings and its terminal `onCheckpoint` writes the real count to
   * disk → the FINAL count probe is unavailable → finalization used to carry
   * the run-START snapshot's 0 forward and clear the checkpoint, reporting
   * success → the next `--force` reads 0, `deriveEmbeddingMode` sees
   * `hasExisting: false`, `shouldLoadCache` is false, and the rebuild destroys
   * every live embedding.
   */
  it('carries the mid-run count forward, not the run-start snapshot, so --force still loads the cache', async () => {
    const MID_RUN_COUNT = 12;
    const tmpRepo = await createTempDir('gitnexus-2790r-latest-meta-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      // The dangerous starting point: a prior meta claiming zero embeddings.
      await seedMeta(storagePath, tmpRepo.dbPath, { stats: { nodes: 2, embeddings: 0 } });
      const controls: ResilienceControls = {
        count: [{ cnt: MID_RUN_COUNT }],
        pipeline: async (options) => {
          // The checkpoint measures the live count and persists it…
          await options.onCheckpoint?.({
            nodesProcessed: 3,
            totalNodes: 3,
            chunksProcessed: 3,
          });
          // …and then the count becomes unavailable for the rest of the run.
          controls.count = 'throw';
          return cleanResult();
        },
      };
      const { loadCachedEmbeddings } = mockResilienceHarness(controls);

      const firstLogs: string[] = [];
      expect(
        await runAnalyze(
          tmpRepo.dbPath,
          { embeddings: true, skipAgentsMd: true, skipSkills: true },
          firstLogs,
        ),
      ).toBeNull();

      const afterRun = await loadMeta(storagePath);
      // Pre-fix this was 0 — the run-start snapshot — and the checkpoint was
      // cleared, so nothing on disk remembered the run had never been verified.
      expect(afterRun).toMatchObject({ stats: { embeddings: MID_RUN_COUNT } });
      // Its own `kind`, not `'partial'`: nothing was dropped, so reporting it
      // as pending nodes told the operator N node(s) had lost their embeddings
      // where N is zero.
      expect(afterRun).toMatchObject({
        embeddingCheckpoint: { kind: 'unverified-count', pendingNodeIds: [] },
      });
      expect(getIndexIncompleteReasons(afterRun)).toEqual(['embedding-count-unverified']);
      expect(firstLogs).toContainEqual(
        expect.stringContaining('re-derives the count instead of publishing an unverified one'),
      );

      // ── The consequence: the next --force must still load the cache ─────
      controls.count = [{ cnt: MID_RUN_COUNT }];
      controls.pipeline = async () => cleanResult();
      loadCachedEmbeddings.mockClear();
      const forceLogs: string[] = [];
      expect(
        await runAnalyze(
          tmpRepo.dbPath,
          { force: true, skipAgentsMd: true, skipSkills: true },
          forceLogs,
        ),
      ).toBeNull();

      // With a carried-forward 0 this run derived `hasExisting: false`,
      // `shouldLoadCache: false`, and wiped the live rows without reading them.
      expect(loadCachedEmbeddings).toHaveBeenCalled();
      expect(forceLogs).toContainEqual(
        expect.stringContaining(`--force on a repo with ${MID_RUN_COUNT} existing embeddings`),
      );
    } finally {
      await tmpRepo.cleanup();
    }
  });

  /**
   * FINDING 5a — a `'partial'` marker may not wedge a repo on identity.
   *
   * `GITNEXUS_EMBEDDING_URL=… analyze --embeddings` drops three nodes to a
   * transient fault, warns, and exits 0 with the checkpoint persisted under
   * `http:<sha256(endpoint)>`. A later plain `analyze` — a post-commit hook, a
   * CI job, any shell without those exports — resolves `provider: 'local'` and
   * threw at the resume gate BEFORE any phase ran. The graph was then never
   * refreshed again until someone passed `--drop-embeddings`.
   *
   * Those nodes hold ZERO rows (the pipeline deleted them), so no vector space
   * can be mixed and the mismatch is a warning. `'interrupted'` markers — whose
   * pending nodes may be half-persisted — still fail closed, and so do legacy
   * markers with no `kind` at all.
   */
  it('warns and proceeds on an identity-mismatched partial checkpoint', async () => {
    const tmpRepo = await createTempDir('gitnexus-2790r-partial-mismatch-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await seedMeta(storagePath, tmpRepo.dbPath, {
        stats: { nodes: 2, embeddings: 4 },
        embeddingCheckpoint: checkpointFixture({
          kind: 'partial',
          provider: 'http:1f0c9a2b',
          pendingNodeIds: ['node-a', 'node-b'],
        }),
      });
      mockResilienceHarness({ count: [{ cnt: 4 }], pipeline: async () => cleanResult() });

      const logs: string[] = [];
      const error = await runAnalyze(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        logs,
      );

      // Pre-fix: threw at the gate, before any phase, forever.
      expect(error).toBeNull();
      expect(logs).toContainEqual(
        expect.stringContaining('dropping 2 pending node(s) from a partial embedding checkpoint'),
      );
      // The landmine is gone and the index is certifiable again.
      const meta = await loadMeta(storagePath);
      expect(meta?.embeddingCheckpoint).toBeUndefined();
      expect(getIndexIncompleteReasons(meta)).toEqual([]);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('still fails closed on an identity-mismatched interrupted checkpoint', async () => {
    const tmpRepo = await createTempDir('gitnexus-2790r-interrupted-mismatch-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await seedMeta(storagePath, tmpRepo.dbPath, {
        stats: { nodes: 2, embeddings: 4 },
        embeddingCheckpoint: checkpointFixture({
          kind: 'interrupted',
          provider: 'http:1f0c9a2b',
          pendingNodeIds: ['node-a'],
        }),
      });
      mockResilienceHarness({ count: [{ cnt: 4 }], pipeline: async () => cleanResult() });

      const logs: string[] = [];
      expect(
        await runAnalyze(tmpRepo.dbPath, { skipAgentsMd: true, skipSkills: true }, logs),
      ).toMatchObject({
        message: expect.stringContaining('the embedding provider configuration differs'),
      });
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('treats a checkpoint with no kind as interrupted and fails closed', async () => {
    const tmpRepo = await createTempDir('gitnexus-2790r-legacy-mismatch-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await seedMeta(storagePath, tmpRepo.dbPath, {
        stats: { nodes: 2, embeddings: 4 },
        // No `kind` — exactly what versions before this change wrote.
        embeddingCheckpoint: checkpointFixture({
          model: 'a-different-model',
          pendingNodeIds: ['node-a'],
        }),
      });
      mockResilienceHarness({ count: [{ cnt: 4 }], pipeline: async () => cleanResult() });

      const logs: string[] = [];
      expect(
        await runAnalyze(tmpRepo.dbPath, { skipAgentsMd: true, skipSkills: true }, logs),
      ).toMatchObject({
        message: expect.stringContaining('Cannot resume embedding checkpoint'),
      });
    } finally {
      await tmpRepo.cleanup();
    }
  });

  /**
   * FINDING 5b — `--force` is the documented rebuild escape hatch, so it must
   * be able to discard a checkpoint. The gate used to inspect only
   * `options.dropEmbeddings`, which is why a wedged repo could not be freed by
   * the flag every operator reaches for first.
   */
  it('discards a checkpoint under --force and says so', async () => {
    const tmpRepo = await createTempDir('gitnexus-2790r-force-clears-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await seedMeta(storagePath, tmpRepo.dbPath, {
        stats: { nodes: 2, embeddings: 4 },
        embeddingCheckpoint: checkpointFixture({
          kind: 'interrupted',
          provider: 'http:1f0c9a2b',
          pendingNodeIds: ['node-a', 'node-b'],
        }),
      });
      const { runEmbeddingPipeline } = mockResilienceHarness({
        count: [{ cnt: 4 }],
        pipeline: async () => cleanResult(),
      });

      const logs: string[] = [];
      const error = await runAnalyze(
        tmpRepo.dbPath,
        { force: true, skipAgentsMd: true, skipSkills: true },
        logs,
      );

      // Not even the identity mismatch fires: --force never reaches the gate.
      expect(error).toBeNull();
      expect(logs).toContainEqual(
        expect.stringContaining(
          'Discarding the embedding checkpoint (--force) and its 2 pending node(s)',
        ),
      );
      const meta = await loadMeta(storagePath);
      expect(meta?.embeddingCheckpoint).toBeUndefined();
      expect(getIndexIncompleteReasons(meta)).toEqual([]);
      // --force over an embedded repo still regenerates, so the pending nodes
      // (which hold no rows and therefore look new) come back anyway.
      expect(runEmbeddingPipeline).toHaveBeenCalled();
    } finally {
      await tmpRepo.cleanup();
    }
  });

  /**
   * FINDING 5c — the retry must converge.
   *
   * A node the endpoint rejects DETERMINISTICALLY produces a resume run too
   * small for any of the pipeline's failure guards to fire, so the pending set
   * never shrank, `getIndexIncompleteReasons` returned
   * `embedding-checkpoint-pending` forever, and the same-commit fast return was
   * disabled for the life of the repo. `attempts` bounds it: after
   * EMBEDDING_RESUME_MAX_ATTEMPTS identical failures the set is abandoned, out
   * loud, and the index certifies complete again.
   *
   * Every run below is a PLAIN `analyze` — no flags. That is the whole point:
   * the checkpoint is what forces generation, so once it is dropped the loop
   * genuinely stops instead of being re-armed by an explicit --embeddings.
   */
  it('abandons a pending set that fails EMBEDDING_RESUME_MAX_ATTEMPTS times in a row', async () => {
    const tmpRepo = await createTempDir('gitnexus-2790r-attempts-bound-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      // A real (empty) git repo, unlike the single-run tests above. Two things
      // depend on it: `schemaVersion` is only stamped for git repos, and an
      // unstamped one trips the schema-mismatch guard into `force` on EVERY
      // run — which would keep re-arming embedding generation and hide whether
      // the pending set converged. An empty commit keeps `fileHashes` empty, so
      // each run still takes the plain full-rebuild path.
      const git = (cmd: string) => execSync(cmd, { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      git('git init');
      git('git -c user.name=test -c user.email=test@test commit --allow-empty -m init');
      await seedMeta(storagePath, tmpRepo.dbPath, {
        stats: { nodes: 2, embeddings: 5 },
        embeddingCheckpoint: checkpointFixture({
          kind: 'partial',
          pendingNodeIds: ['node-a'],
        }),
      });
      const forcedSets: Array<readonly string[]> = [];
      mockResilienceHarness({
        count: [{ cnt: 5 }],
        pipeline: async (options) => {
          forcedSets.push([...(options.forceReembedNodeIds ?? [])]);
          // The endpoint rejects this node the same way every single time.
          return cleanResult({ nodesProcessed: 1, failedNodeIds: ['node-a'] });
        },
      });

      const { EMBEDDING_RESUME_MAX_ATTEMPTS } =
        await import('../../src/core/embedding-checkpoint.js');
      const attemptsSeen: Array<number | undefined> = [];
      for (let run = 0; run < EMBEDDING_RESUME_MAX_ATTEMPTS; run++) {
        const runLogs: string[] = [];
        expect(
          await runAnalyze(tmpRepo.dbPath, { skipAgentsMd: true, skipSkills: true }, runLogs),
        ).toBeNull();
        attemptsSeen.push((await loadMeta(storagePath))?.embeddingCheckpoint?.attempts);
      }

      // Each plain run really did resume and re-offer the same node…
      expect(forcedSets).toEqual(
        Array.from({ length: EMBEDDING_RESUME_MAX_ATTEMPTS }, () => ['node-a']),
      );
      // …and the counter advanced once per identical failure.
      expect(attemptsSeen).toEqual(
        Array.from({ length: EMBEDDING_RESUME_MAX_ATTEMPTS }, (_, i) => i + 1),
      );

      // The converging run: the budget is spent, so the set is abandoned.
      const finalLogs: string[] = [];
      expect(
        await runAnalyze(tmpRepo.dbPath, { skipAgentsMd: true, skipSkills: true }, finalLogs),
      ).toBeNull();
      expect(finalLogs).toContainEqual(
        expect.stringContaining(
          `failed to embed on ${EMBEDDING_RESUME_MAX_ATTEMPTS} consecutive resume attempts`,
        ),
      );
      const finalMeta = await loadMeta(storagePath);
      expect(finalMeta?.embeddingCheckpoint).toBeUndefined();
      // `gitnexus status` stops reporting the index as incomplete.
      expect(getIndexIncompleteReasons(finalMeta)).toEqual([]);
      // The pipeline was not re-armed by the dropped checkpoint.
      expect(forcedSets).toHaveLength(EMBEDDING_RESUME_MAX_ATTEMPTS);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  /**
   * The retry budget is for a DETERMINISTIC rejection, not a flaky endpoint: a
   * resume that clears the set it was handed and loses different nodes is a
   * FRESH partial, so the counter resets rather than marching toward abandon.
   */
  it('resets the attempt counter when the resume clears the set it was handed', async () => {
    const tmpRepo = await createTempDir('gitnexus-2790r-attempts-reset-');
    try {
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await seedMeta(storagePath, tmpRepo.dbPath, {
        stats: { nodes: 2, embeddings: 5 },
        embeddingCheckpoint: checkpointFixture({
          kind: 'partial',
          attempts: 2,
          pendingNodeIds: ['node-a'],
        }),
      });
      mockResilienceHarness({
        count: [{ cnt: 5 }],
        // 'node-a' embedded fine this time; a different node lost its rows.
        pipeline: async () => cleanResult({ nodesProcessed: 1, failedNodeIds: ['node-z'] }),
      });

      const logs: string[] = [];
      expect(
        await runAnalyze(tmpRepo.dbPath, { skipAgentsMd: true, skipSkills: true }, logs),
      ).toBeNull();

      const meta = await loadMeta(storagePath);
      expect(meta).toMatchObject({
        embeddingCheckpoint: { kind: 'partial', pendingNodeIds: ['node-z'] },
      });
      expect(meta?.embeddingCheckpoint?.attempts).toBeUndefined();
    } finally {
      await tmpRepo.cleanup();
    }
  });
});
