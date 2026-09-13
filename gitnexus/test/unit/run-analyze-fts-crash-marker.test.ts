/**
 * U4: FTS-phase dirty flag, converged boundary checkpoint, and `--repair-fts`
 * admission. A true native abort kills the process before JS can write a skip
 * reason (KTD6); these tests induce the phase through saveMeta / in-run stamps
 * rather than killing analyze.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getStoragePaths,
  loadMeta,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';
import { ANALYSIS_FEATURES } from '../../src/core/analysis-feature-registry.js';
import { resolveAnalysisFeatureVersions } from '../../src/core/analysis-features.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { resolveAnalyzerRunnerIdentity } from '../../src/core/analyzer-identity.js';
import { EMBEDDING_DIMS, SCHEMA_FINGERPRINT } from '../../src/core/lbug/schema.js';
import { getSearchFTSCjkSegmentation } from '../../src/core/search/cjk-segmentation.js';
import {
  FTS_DIRTY_PHASE,
  allowsFtsCrashWalPark,
  buildFtsDirtyStamp,
  inferNativeAbortSkip,
  isBoundaryCheckpointFatal,
  isFtsStagingDirty,
  resolveFtsWritePlan,
  shouldRefuseRepairFtsWhileDirty,
  shouldStampFtsDirtyPhase,
} from '../../src/core/search/fts-crash-marker.js';

const RUN_ANALYZE_URL = new URL('../../src/core/run-analyze.ts', import.meta.url);
const RUN_ANALYZE_SRC = fileURLToPath(RUN_ANALYZE_URL);

const REL_FILE = 'src/a.ts';

const createPlaceholderGraphStore = async (lbugPath: string): Promise<void> => {
  await fs.writeFile(lbugPath, 'fixture');
};

const seedGitFile = async (repoPath: string): Promise<void> => {
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoPath, REL_FILE), 'export const a = 1;\n');
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
    cwd: repoPath,
    stdio: 'pipe',
  });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m init', {
    cwd: repoPath,
    stdio: 'pipe',
  });
};

const incrementalMeta = (repoPath: string): RepoMeta => ({
  repoPath,
  lastCommit: 'stale-not-head',
  indexedAt: new Date().toISOString(),
  stats: {},
  fileHashes: { [REL_FILE]: 'stale-hash' },
  schemaFingerprint: SCHEMA_FINGERPRINT,
  analysisFeatures: resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, [REL_FILE]),
  cjkSegmentation: getSearchFTSCjkSegmentation(),
  embeddingDims: EMBEDDING_DIMS,
  runnerIdentity: resolveAnalyzerRunnerIdentity(RUN_ANALYZE_URL.href),
});

const headCommit = (repoPath: string): string =>
  execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();

const GRAPH_BYTES = 'QUERYABLE_GRAPH_BYTES_U5';
const WAL_PATTERN = Buffer.alloc(8192, 0xab);

const ftsInPlaceDirty = {
  startedAt: Date.now() - 60_000,
  toWriteCount: 0,
  phase: FTS_DIRTY_PHASE,
  writePlan: 'in-place' as const,
  checkpointSucceeded: true,
};

const fileGraph = () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'file:src/a.ts',
    label: 'File',
    properties: { filePath: REL_FILE },
  });
  return graph;
};

const mockLbugAdapter = async () => {
  const actual = await vi.importActual<typeof import('../../src/core/lbug/lbug-adapter.js')>(
    '../../src/core/lbug/lbug-adapter.js',
  );
  return {
    ...actual,
    initLbug: vi.fn(async () => undefined),
    loadGraphToLbug: vi.fn(async () => undefined),
    getLbugStats: vi.fn(async () => ({ nodes: 1, edges: 0, communities: 0, processes: 0 })),
    executeQuery: vi.fn(async () => []),
    executeWithReusedStatement: vi.fn(async () => []),
    closeLbug: vi.fn(async () => undefined),
    wipeLbugDbFiles: vi.fn(async () => undefined),
    tryFlushWAL: vi.fn(async () => true),
    loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
    deleteNodesForFile: vi.fn(async () => undefined),
    deleteNodesForFiles: vi.fn(async () => undefined),
    nodeTablesWithRowsForFiles: vi.fn(async () => []),
    snapshotDerivedRelsForFiles: vi.fn(async () => []),
    restoreDerivedRels: vi.fn(async () => undefined),
    deleteAllCommunitiesAndProcesses: vi.fn(async () => undefined),
    deleteAllInterprocTaintPaths: vi.fn(async () => undefined),
    deleteAllCallSummaries: vi.fn(async () => undefined),
    deleteAllInjects: vi.fn(async () => undefined),
    deleteAllAdvisedBy: vi.fn(async () => undefined),
    deleteAllDestinations: vi.fn(async () => undefined),
    deleteSpringAopEvidenceNodes: vi.fn(async () => undefined),
    deleteSpringAutoConfigurationDeclarations: vi.fn(async () => undefined),
    deleteSpringAutoConfigurationSyntheticClasses: vi.fn(async () => undefined),
    queryImporters: vi.fn(async () => []),
    queryImportersBatch: vi.fn(async () => []),
    loadFTSExtension: vi.fn(async () => true),
    readIndexCatalogSnapshot: vi.fn(async () => []),
    ensureEmbeddingRowDmlSafe: vi.fn(async () => true),
    ensureFtsRowDmlSafe: vi.fn(async () => true),
  };
};

describe('FTS crash-marker policy (characterization)', () => {
  it('stamps only the in-place write plan', () => {
    expect(resolveFtsWritePlan('/idx/lbug', '/idx/lbug')).toBe('in-place');
    expect(resolveFtsWritePlan('/idx/lbug.staging.abc', '/idx/lbug')).toBe('staging');
    expect(shouldStampFtsDirtyPhase('in-place')).toBe(true);
    expect(shouldStampFtsDirtyPhase('staging')).toBe(false);
  });

  it('mirrors staging-versus-in-place checkpoint fatality', () => {
    expect(isBoundaryCheckpointFatal('staging')).toBe(true);
    expect(isBoundaryCheckpointFatal('in-place')).toBe(false);
  });

  it('admits --repair-fts only for the FTS phase', () => {
    expect(shouldRefuseRepairFtsWhileDirty(undefined)).toBe(false);
    expect(
      shouldRefuseRepairFtsWhileDirty({
        startedAt: 1,
        toWriteCount: 3,
        phase: 'load-graph',
      }),
    ).toBe(true);
    expect(
      shouldRefuseRepairFtsWhileDirty({
        startedAt: 1,
        toWriteCount: 0,
        phase: FTS_DIRTY_PHASE,
      }),
    ).toBe(false);
    expect(inferNativeAbortSkip({ startedAt: 1, toWriteCount: 0, phase: 'full-rebuild' })).toBe(
      false,
    );
    expect(inferNativeAbortSkip({ startedAt: 1, toWriteCount: 0, phase: FTS_DIRTY_PHASE })).toBe(
      true,
    );
  });

  it('warrants a live WAL park only for in-place FTS after a successful checkpoint', () => {
    expect(
      allowsFtsCrashWalPark({
        startedAt: 1,
        toWriteCount: 0,
        phase: FTS_DIRTY_PHASE,
        writePlan: 'in-place',
        checkpointSucceeded: true,
      }),
    ).toBe(true);
    expect(
      allowsFtsCrashWalPark({
        startedAt: 1,
        toWriteCount: 0,
        phase: FTS_DIRTY_PHASE,
        writePlan: 'staging',
        checkpointSucceeded: true,
      }),
    ).toBe(false);
    expect(
      allowsFtsCrashWalPark({
        startedAt: 1,
        toWriteCount: 0,
        phase: FTS_DIRTY_PHASE,
        writePlan: 'in-place',
        checkpointSucceeded: false,
      }),
    ).toBe(false);
    expect(
      allowsFtsCrashWalPark({
        startedAt: 1,
        toWriteCount: 3,
        phase: 'load-graph',
        writePlan: 'in-place',
        checkpointSucceeded: true,
      }),
    ).toBe(false);
    expect(
      isFtsStagingDirty({
        startedAt: 1,
        toWriteCount: 0,
        phase: FTS_DIRTY_PHASE,
        writePlan: 'staging',
      }),
    ).toBe(true);
    expect(
      isFtsStagingDirty({
        startedAt: 1,
        toWriteCount: 0,
        phase: FTS_DIRTY_PHASE,
        writePlan: 'in-place',
      }),
    ).toBe(false);
  });

  it('lifts the prior-meta precondition on the in-place stamp', () => {
    const stamp = buildFtsDirtyStamp({
      writePlan: 'in-place',
      checkpointSucceeded: true,
      now: 42,
    });
    expect(stamp).toMatchObject({
      startedAt: 42,
      phase: FTS_DIRTY_PHASE,
      writePlan: 'in-place',
      checkpointSucceeded: true,
      toWriteCount: 0,
    });
  });

  it('stamps after the escalation valve in source order', () => {
    const src = readFileSync(RUN_ANALYZE_SRC, 'utf8');
    const valve = src.indexOf("saveIncrementalDirtyState('escalated-full-write'");
    const stamp = src.indexOf('shouldStampFtsDirtyPhase(ftsWritePlan)');
    expect(valve).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(valve);
  });
});

describe('runFullAnalysis FTS crash marker', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/core/search/fts-indexes.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.doUnmock('../../src/core/lbug/wal-checkpoint-driver.js');
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('stamps phase fts during an in-place incremental build and clears it after a clean run', async () => {
    const sequence: string[] = [];
    const checkpointOnce = vi.fn(async () => {
      sequence.push('checkpoint');
    });
    let midBuild: RepoMeta | null = null;
    vi.doMock('../../src/core/lbug/wal-checkpoint-driver.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/wal-checkpoint-driver.js')>()),
      checkpointOnce,
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', mockLbugAdapter);
    vi.doMock('../../src/core/search/fts-indexes.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/search/fts-indexes.js')>()),
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      missingSearchFTSIndexTables: vi.fn(async () => []),
      dropSearchFTSIndexes: vi.fn(async () => undefined),
      buildSearchIndexesOrDegrade: vi.fn(async () => {
        sequence.push('build');
        return { ok: true };
      }),
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        graph: fileGraph(),
      })),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => {
      const actual = await importActual<typeof import('../../src/storage/repo-manager.js')>();
      return {
        ...actual,
        saveMeta: async (...args: Parameters<typeof actual.saveMeta>) => {
          const result = await actual.saveMeta(...args);
          if (args[1].incrementalInProgress?.phase === FTS_DIRTY_PHASE) {
            sequence.push('stamp-fts');
            midBuild = args[1];
          }
          return result;
        },
      };
    });

    const tmpRepo = await createTempDir('gitnexus-fts-crash-inplace-');
    try {
      await seedGitFile(tmpRepo.dbPath);
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, incrementalMeta(tmpRepo.dbPath));

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: () => {} },
      );

      expect(result.ftsSkipped).not.toBe(true);
      expect(midBuild?.incrementalInProgress).toMatchObject({
        phase: FTS_DIRTY_PHASE,
        writePlan: 'in-place',
        checkpointSucceeded: true,
      });
      expect(sequence.indexOf('checkpoint')).toBeLessThan(sequence.indexOf('stamp-fts'));
      expect(sequence.indexOf('stamp-fts')).toBeLessThan(sequence.indexOf('build'));
      expect(checkpointOnce).toHaveBeenCalled();

      const finalMeta = await loadMeta(storagePath);
      expect(finalMeta?.incrementalInProgress).toBeUndefined();
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not stamp an FTS phase on a staging plan',
    async () => {
      const phases: Array<string | undefined> = [];
      vi.doMock('../../src/core/lbug/lbug-adapter.js', mockLbugAdapter);
      vi.doMock('../../src/core/search/fts-indexes.js', async (importActual) => ({
        ...(await importActual<typeof import('../../src/core/search/fts-indexes.js')>()),
        initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
        buildSearchIndexesOrDegrade: vi.fn(async () => ({ ok: true })),
      }));
      vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
        runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
          repoPath,
          graph: { forEachNode: () => undefined },
        })),
      }));
      vi.doMock('../../src/storage/repo-manager.js', async (importActual) => {
        const actual = await importActual<typeof import('../../src/storage/repo-manager.js')>();
        return {
          ...actual,
          saveMeta: async (...args: Parameters<typeof actual.saveMeta>) => {
            phases.push(args[1].incrementalInProgress?.phase);
            return actual.saveMeta(...args);
          },
        };
      });

      const tmpRepo = await createTempDir('gitnexus-fts-crash-staging-');
      try {
        const { storagePath } = getStoragePaths(tmpRepo.dbPath);
        await fs.mkdir(storagePath, { recursive: true });
        await saveMeta(storagePath, {
          repoPath: tmpRepo.dbPath,
          lastCommit: '',
          indexedAt: new Date().toISOString(),
          stats: {},
        });

        const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
        await runFullAnalysis(
          tmpRepo.dbPath,
          { force: true, skipAgentsMd: true, skipSkills: true },
          { onProgress: () => {}, onLog: () => {} },
        );

        expect(phases).toContain('full-rebuild');
        expect(phases).not.toContain(FTS_DIRTY_PHASE);
      } finally {
        await tmpRepo.cleanup();
      }
    },
  );

  it('clears the FTS phase on the degrade path as well as on success', async () => {
    vi.doMock('../../src/core/lbug/lbug-adapter.js', mockLbugAdapter);
    vi.doMock('../../src/core/search/fts-indexes.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/search/fts-indexes.js')>()),
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      missingSearchFTSIndexTables: vi.fn(async () => []),
      dropSearchFTSIndexes: vi.fn(async () => undefined),
      buildSearchIndexesOrDegrade: vi.fn(async () => ({
        ok: false,
        error: 'tokenizer failed',
        failureClass: 'capability' as const,
      })),
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        graph: fileGraph(),
      })),
    }));

    const tmpRepo = await createTempDir('gitnexus-fts-crash-degrade-');
    try {
      await seedGitFile(tmpRepo.dbPath);
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, incrementalMeta(tmpRepo.dbPath));

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: () => {} },
      );
      expect(result.ftsSkipped).toBe(true);
      expect(result.ftsSkipReason).toBe('build-failed');
      const finalMeta = await loadMeta(storagePath);
      expect(finalMeta?.incrementalInProgress).toBeUndefined();
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('lets --repair-fts run when the dirty flag is the FTS phase', async () => {
    const createSearchFTSIndexes = vi.fn(async () => []);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', mockLbugAdapter);
    vi.doMock('../../src/core/search/fts-indexes.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/search/fts-indexes.js')>()),
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes,
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));

    const tmpRepo = await createTempDir('gitnexus-fts-crash-repair-admit-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: 'abc',
        indexedAt: new Date().toISOString(),
        stats: {},
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 0,
          phase: FTS_DIRTY_PHASE,
          writePlan: 'in-place',
          checkpointSucceeded: true,
        },
      });
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { repairFts: true },
        { onProgress: () => {} },
      );
      expect(result.ftsRepairedOnly).toBe(true);
      expect(createSearchFTSIndexes).toHaveBeenCalled();
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('still refuses --repair-fts for a half-written graph phase', async () => {
    const tmpRepo = await createTempDir('gitnexus-fts-crash-repair-refuse-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
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
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await expect(
        runFullAnalysis(tmpRepo.dbPath, { repairFts: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/mid-incremental-recovery[\s\S]*gitnexus analyze/);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('infers native-abort and skips CREATE after an FTS-phase crash', async () => {
    const buildSearchIndexesOrDegrade = vi.fn(async () => ({ ok: true }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', mockLbugAdapter);
    vi.doMock('../../src/core/search/fts-indexes.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/search/fts-indexes.js')>()),
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      buildSearchIndexesOrDegrade,
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        graph: { forEachNode: () => undefined },
      })),
    }));

    const tmpRepo = await createTempDir('gitnexus-fts-crash-infer-skip-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
        stats: {},
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 0,
          phase: FTS_DIRTY_PHASE,
          writePlan: 'in-place',
          checkpointSucceeded: true,
        },
      });
      await createPlaceholderGraphStore(lbugPath);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { force: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: () => {} },
      );

      expect(buildSearchIndexesOrDegrade).not.toHaveBeenCalled();
      expect(result.ftsSkipped).toBe(true);
      expect(result.ftsSkipReason).toBe('native-abort');
      const finalMeta = await loadMeta(storagePath);
      expect(finalMeta?.incrementalInProgress).toBeUndefined();
      expect(finalMeta?.capabilities?.fts).toMatchObject({
        status: 'unavailable',
        skipReason: 'native-abort',
      });
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'treats a boundary checkpoint failure as fatal on staging',
    async () => {
      const checkpointError = new Error('checkpoint rename failed');
      const checkpointOnce = vi.fn(async () => {
        throw checkpointError;
      });
      const buildSearchIndexesOrDegrade = vi.fn(async () => ({ ok: true }));
      vi.doMock('../../src/core/lbug/wal-checkpoint-driver.js', async (importActual) => ({
        ...(await importActual<typeof import('../../src/core/lbug/wal-checkpoint-driver.js')>()),
        checkpointOnce,
      }));
      vi.doMock('../../src/core/lbug/lbug-adapter.js', mockLbugAdapter);
      vi.doMock('../../src/core/search/fts-indexes.js', async (importActual) => ({
        ...(await importActual<typeof import('../../src/core/search/fts-indexes.js')>()),
        initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
        buildSearchIndexesOrDegrade,
      }));
      vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
        runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
          repoPath,
          graph: { forEachNode: () => undefined },
        })),
      }));

      const tmpRepo = await createTempDir('gitnexus-fts-crash-ckpt-staging-');
      try {
        const { storagePath } = getStoragePaths(tmpRepo.dbPath);
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
            { force: true, skipAgentsMd: true, skipSkills: true },
            { onProgress: () => {}, onLog: () => {} },
          ),
        ).rejects.toBe(checkpointError);
        expect(buildSearchIndexesOrDegrade).not.toHaveBeenCalled();
      } finally {
        await tmpRepo.cleanup();
      }
    },
  );

  it('treats a boundary checkpoint failure as best-effort on an in-place plan', async () => {
    const checkpointOnce = vi.fn(async () => {
      throw new Error('checkpoint rename failed');
    });
    let stamped: RepoMeta['incrementalInProgress'];
    vi.doMock('../../src/core/lbug/wal-checkpoint-driver.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/wal-checkpoint-driver.js')>()),
      checkpointOnce,
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', mockLbugAdapter);
    vi.doMock('../../src/core/search/fts-indexes.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/search/fts-indexes.js')>()),
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      missingSearchFTSIndexTables: vi.fn(async () => []),
      dropSearchFTSIndexes: vi.fn(async () => undefined),
      buildSearchIndexesOrDegrade: vi.fn(async () => ({ ok: true })),
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        graph: fileGraph(),
      })),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => {
      const actual = await importActual<typeof import('../../src/storage/repo-manager.js')>();
      return {
        ...actual,
        saveMeta: async (...args: Parameters<typeof actual.saveMeta>) => {
          if (args[1].incrementalInProgress?.phase === FTS_DIRTY_PHASE) {
            stamped = args[1].incrementalInProgress;
          }
          return actual.saveMeta(...args);
        },
      };
    });

    const tmpRepo = await createTempDir('gitnexus-fts-crash-ckpt-inplace-');
    try {
      await seedGitFile(tmpRepo.dbPath);
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, incrementalMeta(tmpRepo.dbPath));

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: () => {} },
      );
      expect(result.ftsSkipped).not.toBe(true);
      expect(stamped).toMatchObject({
        phase: FTS_DIRTY_PHASE,
        writePlan: 'in-place',
        checkpointSucceeded: false,
      });
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('parks an in-place FTS crash WAL and keeps the graph on the next analyze', async () => {
    const wipeLbugDbFiles = vi.fn(async () => undefined);
    const runPipelineFromRepo = vi.fn(async () => {
      throw new Error('pipeline must not run on FTS-park survivorship');
    });
    vi.doMock('../../src/core/lbug/lbug-adapter.js', async () => ({
      ...(await mockLbugAdapter()),
      wipeLbugDbFiles,
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({ runPipelineFromRepo }));

    const tmpRepo = await createTempDir('gitnexus-fts-crash-survivorship-');
    try {
      await seedGitFile(tmpRepo.dbPath);
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        ...incrementalMeta(tmpRepo.dbPath),
        lastCommit: headCommit(tmpRepo.dbPath),
        incrementalInProgress: ftsInPlaceDirty,
      });
      await fs.writeFile(lbugPath, GRAPH_BYTES);
      await fs.writeFile(`${lbugPath}.wal`, WAL_PATTERN);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: () => {} },
      );

      expect(result.alreadyUpToDate).toBe(true);
      expect(result.ftsSkipped).toBe(true);
      expect(result.ftsSkipReason).toBe('native-abort');
      expect(wipeLbugDbFiles).not.toHaveBeenCalled();
      expect(runPipelineFromRepo).not.toHaveBeenCalled();
      expect(await fs.readFile(lbugPath, 'utf8')).toBe(GRAPH_BYTES);
      expect(Buffer.compare(await fs.readFile(`${lbugPath}.wal.dirty-recovery`), WAL_PATTERN)).toBe(
        0,
      );
      await expect(fs.stat(`${lbugPath}.wal`)).rejects.toMatchObject({ code: 'ENOENT' });
      const finalMeta = await loadMeta(storagePath);
      expect(finalMeta?.incrementalInProgress).toBeUndefined();
      expect(finalMeta?.capabilities?.fts).toMatchObject({
        status: 'unavailable',
        skipReason: 'native-abort',
      });
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('does not keep the graph for a non-FTS dirty flag', async () => {
    const wipeLbugDbFiles = vi.fn(async () => undefined);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', async () => ({
      ...(await mockLbugAdapter()),
      wipeLbugDbFiles,
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/search/fts-indexes.js')>()),
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      buildSearchIndexesOrDegrade: vi.fn(async () => ({ ok: true })),
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        graph: fileGraph(),
      })),
    }));

    const tmpRepo = await createTempDir('gitnexus-fts-crash-nonfts-dirty-');
    try {
      await seedGitFile(tmpRepo.dbPath);
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        ...incrementalMeta(tmpRepo.dbPath),
        lastCommit: headCommit(tmpRepo.dbPath),
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 12,
          phase: 'load-graph',
        },
      });
      await fs.writeFile(lbugPath, GRAPH_BYTES);
      await fs.writeFile(`${lbugPath}.wal`, WAL_PATTERN);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: () => {} },
      );

      expect(result.alreadyUpToDate).not.toBe(true);
      expect(result.ftsSkipReason).not.toBe('native-abort');
      expect(wipeLbugDbFiles).toHaveBeenCalled();
      expect(Buffer.compare(await fs.readFile(`${lbugPath}.wal.dirty-recovery`), WAL_PATTERN)).toBe(
        0,
      );
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('leaves a staging FTS abort WAL on the live index', async () => {
    const wipeLbugDbFiles = vi.fn(async () => undefined);
    const runPipelineFromRepo = vi.fn(async () => {
      throw new Error('pipeline must not run on staging FTS recover');
    });
    vi.doMock('../../src/core/lbug/lbug-adapter.js', async () => ({
      ...(await mockLbugAdapter()),
      wipeLbugDbFiles,
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({ runPipelineFromRepo }));

    const tmpRepo = await createTempDir('gitnexus-fts-crash-staging-wal-');
    try {
      await seedGitFile(tmpRepo.dbPath);
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        ...incrementalMeta(tmpRepo.dbPath),
        lastCommit: headCommit(tmpRepo.dbPath),
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 0,
          phase: FTS_DIRTY_PHASE,
          writePlan: 'staging',
          checkpointSucceeded: true,
        },
      });
      await fs.writeFile(lbugPath, GRAPH_BYTES);
      await fs.writeFile(`${lbugPath}.wal`, WAL_PATTERN);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: () => {} },
      );

      expect(result.alreadyUpToDate).toBe(true);
      expect(result.ftsSkipReason).toBe('native-abort');
      expect(wipeLbugDbFiles).not.toHaveBeenCalled();
      expect(Buffer.compare(await fs.readFile(`${lbugPath}.wal`), WAL_PATTERN)).toBe(0);
      await expect(fs.stat(`${lbugPath}.wal.dirty-recovery`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('parks a live WAL before --repair-fts opens the DB', async () => {
    const initLbug = vi.fn(async () => undefined);
    const createSearchFTSIndexes = vi.fn(async () => []);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', async () => ({
      ...(await mockLbugAdapter()),
      initLbug,
    }));
    vi.doMock('../../src/core/search/fts-indexes.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/search/fts-indexes.js')>()),
      initialiseSearchFTSStemmer: vi.fn(() => 'porter'),
      createSearchFTSIndexes,
      verifySearchFTSIndexes: vi.fn(async () => []),
    }));
    vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));

    const tmpRepo = await createTempDir('gitnexus-fts-crash-repair-park-');
    try {
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: 'abc',
        indexedAt: new Date().toISOString(),
        stats: {},
        incrementalInProgress: ftsInPlaceDirty,
      });
      await createPlaceholderGraphStore(lbugPath);
      await fs.writeFile(`${lbugPath}.wal`, WAL_PATTERN);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { repairFts: true },
        { onProgress: () => {} },
      );
      expect(result.ftsRepairedOnly).toBe(true);
      expect(createSearchFTSIndexes).toHaveBeenCalled();
      expect(initLbug).toHaveBeenCalled();
      expect(Buffer.compare(await fs.readFile(`${lbugPath}.wal.dirty-recovery`), WAL_PATTERN)).toBe(
        0,
      );
      const initOrder = initLbug.mock.invocationCallOrder[0] ?? 0;
      expect(initOrder).toBeGreaterThan(0);
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('refuses to open the DB when an FTS-phase park cannot move the WAL', async () => {
    const initLbug = vi.fn(async () => undefined);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', async () => ({
      ...(await mockLbugAdapter()),
      initLbug,
    }));

    const tmpRepo = await createTempDir('gitnexus-fts-crash-park-fail-');
    try {
      await seedGitFile(tmpRepo.dbPath);
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await saveMeta(storagePath, {
        ...incrementalMeta(tmpRepo.dbPath),
        lastCommit: headCommit(tmpRepo.dbPath),
        incrementalInProgress: ftsInPlaceDirty,
      });
      await fs.writeFile(lbugPath, GRAPH_BYTES);
      await fs.writeFile(`${lbugPath}.wal`, WAL_PATTERN);

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

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await expect(
        runFullAnalysis(
          tmpRepo.dbPath,
          { skipAgentsMd: true, skipSkills: true },
          { onProgress: () => {} },
        ),
      ).rejects.toThrow(/gitnexus clean --lbug-sidecars/);
      expect(initLbug).not.toHaveBeenCalled();
      expect(await fs.readFile(lbugPath, 'utf8')).toBe(GRAPH_BYTES);
      expect(Buffer.compare(await fs.readFile(`${lbugPath}.wal`), WAL_PATTERN)).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await tmpRepo.cleanup();
    }
  });
});
