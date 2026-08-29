import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, it, expect, vi } from 'vitest';
import { resolveAnalyzerRunnerIdentity } from '../../src/core/analyzer-identity.js';
import {
  deriveEmbeddingMode,
  deriveEmbeddingCap,
  DEFAULT_EMBEDDING_NODE_LIMIT,
} from '../../src/core/embedding-mode.js';
import {
  getStoragePaths,
  loadMeta,
  registerRepo,
  saveMeta,
  readRegistry,
  RegistryNameCollisionError,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { SCHEMA_FINGERPRINT } from '../../src/core/lbug/schema.js';
import { taintModelVersion } from '../../src/core/ingestion/taint/typescript-model.js';
import { createTempDir } from '../helpers/test-db.js';
import { readEmbeddingNodeIds } from '../helpers/embedding-seed.js';
import { getIndexIncompleteReasons } from '../../src/core/index-freshness.js';
import { CLASS_FRAMEWORK_ANNOTATIONS_FEATURE } from '../../src/core/analysis-features.js';

const CURRENT_ANALYSIS_FEATURES = {
  [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
};

const currentRunnerIdentity = () =>
  resolveAnalyzerRunnerIdentity(
    pathToFileURL(path.resolve(__dirname, '../../src/core/run-analyze.ts')).href,
  );

describe('run-analyze module', () => {
  it('exports runFullAnalysis as a function', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(typeof mod.runFullAnalysis).toBe('function');
  });

  it('exports PHASE_LABELS', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(mod.PHASE_LABELS).toBeDefined();
    expect(mod.PHASE_LABELS.parsing).toBe('Parsing code');
  });

  it('creates .gitnexus/.gitignore on the already-up-to-date fast path (#1233)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-fast-path-');
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: currentCommit,
        indexedAt: new Date().toISOString(),
        // Stamp current schema version so the run-analyze schema-mismatch
        // guard (#2289 P1) does not force a rebuild and short-circuit the
        // alreadyUpToDate fast path this test exercises.
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity: currentRunnerIdentity(),
      };
      await saveMeta(storagePath, meta);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        {},
        {
          onProgress: () => {},
        },
      );

      expect(result.alreadyUpToDate).toBe(true);
      // A flat/primary index reports isPrimaryBranch true (#2106 R2).
      expect(result.isPrimaryBranch).toBe(true);
      await expect(
        fs.readFile(path.join(tmpRepo.dbPath, '.gitnexus', '.gitignore'), 'utf-8'),
      ).resolves.toBe('*\n');
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('applies analyze --name on the already-up-to-date path without --force', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-fast-name-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-fast-name-home-');
    const savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: currentCommit,
        indexedAt: new Date().toISOString(),
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity: currentRunnerIdentity(),
      };
      await saveMeta(storagePath, meta);
      await registerRepo(tmpRepo.dbPath, meta, { name: 'old' });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { registryName: 'new' },
        { onProgress: () => {} },
      );

      expect(result.alreadyUpToDate).toBe(true);
      expect(result.repoName).toBe('new');
      const entries = await readRegistry();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('new');
    } finally {
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
      await tmpHome.cleanup();
      await tmpRepo.cleanup();
    }
  });

  it('repeating the same --name on the fast path is a no-op, not an error', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-fast-name-repeat-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-fast-name-repeat-home-');
    const savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: currentCommit,
        indexedAt: new Date().toISOString(),
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity: currentRunnerIdentity(),
      };
      await saveMeta(storagePath, meta);
      await registerRepo(tmpRepo.dbPath, meta, { name: 'kept' });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { registryName: 'kept' },
        { onProgress: () => {} },
      );

      expect(result.alreadyUpToDate).toBe(true);
      expect((await readRegistry())[0].name).toBe('kept');
    } finally {
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
      await tmpHome.cleanup();
      await tmpRepo.cleanup();
    }
  });

  it('fast-path --name still collides when another path already owns the alias', async () => {
    const tmpA = await createTempDir('gitnexus-run-analyze-fast-name-col-a-');
    const tmpB = await createTempDir('gitnexus-run-analyze-fast-name-col-b-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-fast-name-col-home-');
    const savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      for (const tmp of [tmpA, tmpB]) {
        execSync('git init', { cwd: tmp.dbPath, stdio: 'pipe' });
        execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
          cwd: tmp.dbPath,
          stdio: 'pipe',
        });
      }
      const commitB = execSync('git rev-parse HEAD', {
        cwd: tmpB.dbPath,
        encoding: 'utf-8',
      }).trim();
      const metaA: RepoMeta = {
        repoPath: tmpA.dbPath,
        lastCommit: 'aaaa',
        indexedAt: new Date().toISOString(),
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity: currentRunnerIdentity(),
      };
      await registerRepo(tmpA.dbPath, metaA, { name: 'new' });

      const { storagePath } = getStoragePaths(tmpB.dbPath);
      const metaB: RepoMeta = {
        repoPath: tmpB.dbPath,
        lastCommit: commitB,
        indexedAt: new Date().toISOString(),
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity: currentRunnerIdentity(),
      };
      await saveMeta(storagePath, metaB);
      await registerRepo(tmpB.dbPath, metaB, { name: 'old' });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await expect(
        runFullAnalysis(tmpB.dbPath, { registryName: 'new' }, { onProgress: () => {} }),
      ).rejects.toBeInstanceOf(RegistryNameCollisionError);
    } finally {
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
      await tmpHome.cleanup();
      await tmpA.cleanup();
      await tmpB.cleanup();
    }
  });

  it('plain fast path does not call registerRepo when --name is absent', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-fast-no-name-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-fast-no-name-home-');
    const savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: currentCommit,
        indexedAt: new Date().toISOString(),
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity: currentRunnerIdentity(),
      };
      await saveMeta(storagePath, meta);
      await registerRepo(tmpRepo.dbPath, meta, { name: 'original' });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(tmpRepo.dbPath, {}, { onProgress: () => {} });
      expect(result.alreadyUpToDate).toBe(true);
      expect((await readRegistry())[0].name).toBe('original');
    } finally {
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
      await tmpHome.cleanup();
      await tmpRepo.cleanup();
    }
  });

  it('resumes a matching embedding checkpoint instead of taking the clean fast path', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-embedding-checkpoint-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-embedding-checkpoint-home-');
    const saved = {
      home: process.env.GITNEXUS_HOME,
      url: process.env.GITNEXUS_EMBEDDING_URL,
      model: process.env.GITNEXUS_EMBEDDING_MODEL,
      dims: process.env.GITNEXUS_EMBEDDING_DIMS,
      extension: process.env.GITNEXUS_LBUG_EXTENSION_INSTALL,
    };
    try {
      process.env.GITNEXUS_HOME = tmpHome.dbPath;
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_DIMS = '384';
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
      const vector = Array.from({ length: 384 }, (_, i) => i / 384);
      const fetchMock = vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown[] };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return {
          ok: true,
          json: async () => ({
            data: Array.from({ length: count }, () => ({ embedding: vector })),
          }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      await fs.writeFile(
        path.join(tmpRepo.dbPath, 'index.ts'),
        'export function checkpointResume() { return "ready"; }\n',
      );
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git add index.ts', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(
        tmpRepo.dbPath,
        { embeddings: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      );
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const completed = await loadMeta(storagePath);
      expect(completed).not.toBeNull();
      if (!completed) throw new Error('expected completed metadata');
      const { resolveEmbeddingIdentity } =
        await import('../../src/core/embeddings/embedding-identity.js');
      const embeddingIdentity = resolveEmbeddingIdentity();
      await saveMeta(storagePath, {
        ...completed,
        embeddingCheckpoint: {
          at: new Date().toISOString(),
          nodesProcessed: 1,
          totalNodes: 1,
          chunksProcessed: 1,
          model: 'test-model',
          dimensions: 384,
          provider: embeddingIdentity.provider,
        },
      } as RepoMeta);
      fetchMock.mockClear();
      const logs: string[] = [];

      const resumed = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );

      expect(resumed.alreadyUpToDate).not.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logs.some((message) => message.includes('embedding checkpoint'))).toBe(true);
      expect((await loadMeta(storagePath))?.embeddingCheckpoint).toBeUndefined();

      const finalized = await loadMeta(storagePath);
      if (!finalized) throw new Error('expected finalized metadata');
      const [pendingNodeId] = await readEmbeddingNodeIds(tmpRepo.dbPath);
      if (!pendingNodeId) throw new Error('expected a persisted embedding node');
      await saveMeta(storagePath, {
        ...finalized,
        embeddingCheckpoint: {
          at: new Date().toISOString(),
          nodesProcessed: 0,
          totalNodes: 1,
          chunksProcessed: 0,
          model: 'test-model',
          dimensions: 384,
          provider: embeddingIdentity.provider,
          pendingNodeIds: [pendingNodeId],
        },
      });
      fetchMock.mockClear();

      await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      );

      expect(fetchMock).toHaveBeenCalled();
      expect((await loadMeta(storagePath))?.embeddingCheckpoint).toBeUndefined();

      const resumedPending = await loadMeta(storagePath);
      if (!resumedPending) throw new Error('expected pending-window resume metadata');
      fetchMock.mockClear();
      // Both mismatch stages name a pending node. That is what an 'interrupted'
      // marker means — nodes that may hold a SUBSET of their chunks — and it is
      // what the fail-closed gate exists to protect: a marker with an empty
      // pending set has nothing to regenerate, so `decideEmbeddingResume`
      // (embedding-checkpoint.ts) clears it without consulting the identity.
      await saveMeta(storagePath, {
        ...resumedPending,
        embeddingCheckpoint: {
          at: new Date().toISOString(),
          nodesProcessed: 1,
          totalNodes: 2,
          chunksProcessed: 1,
          model: 'test-model',
          dimensions: 384,
          provider: 'http:different-provider-fingerprint',
          pendingNodeIds: [pendingNodeId],
        },
      });
      await expect(
        runFullAnalysis(
          tmpRepo.dbPath,
          { skipAgentsMd: true, skipSkills: true },
          { onProgress: () => {} },
        ),
      ).rejects.toThrow(/provider configuration differs/i);
      expect(fetchMock).not.toHaveBeenCalled();

      await saveMeta(storagePath, {
        ...resumedPending,
        embeddingCheckpoint: {
          at: new Date().toISOString(),
          nodesProcessed: 1,
          totalNodes: 2,
          chunksProcessed: 1,
          model: 'different-model',
          dimensions: 384,
          provider: embeddingIdentity.provider,
          pendingNodeIds: [pendingNodeId],
        },
      });
      await expect(
        runFullAnalysis(
          tmpRepo.dbPath,
          { skipAgentsMd: true, skipSkills: true },
          { onProgress: () => {} },
        ),
      ).rejects.toThrow('Cannot resume embedding checkpoint');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('GITNEXUS_HOME', saved.home);
      restore('GITNEXUS_EMBEDDING_URL', saved.url);
      restore('GITNEXUS_EMBEDDING_MODEL', saved.model);
      restore('GITNEXUS_EMBEDDING_DIMS', saved.dims);
      restore('GITNEXUS_LBUG_EXTENSION_INSTALL', saved.extension);
      await tmpRepo.cleanup();
      await tmpHome.cleanup();
    }
  }, 120_000);

  /**
   * #2790 regression: an embedding checkpoint must write ONLY the checkpoint.
   *
   * `onCheckpointWindowStart` fires at batchIndex 0 — before a single embedding
   * row exists — and used to persist a full SUCCESS-shaped meta: the new
   * `lastCommit`, the new `fileHashes`, and `incrementalInProgress: undefined`.
   * A Phase 4 crash then left a meta vouching for a graph that (on a full
   * rebuild) had just been thrown away with the staging DB, and the next run
   * hash-diffed to changed=0/added=0/deleted=0, took the incremental path and
   * logged "skipping wipe + N unchanged file rows preserved" over the OLD
   * graph — verbatim the symptom in the issue report — with the crash-recovery
   * dirty flag it had cleared no longer able to force the healing rebuild.
   *
   * Driven through the REAL pipeline rather than by calling the closure
   * directly: the mid-run meta is captured from inside the fetch mock, which
   * the embedder only reaches AFTER the window-start save has completed, so
   * the observation point is ordered by the code under test, not by timing.
   */
  it('an embedding checkpoint does not advance lastCommit/fileHashes or clear the dirty flag (#2790)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-2790-checkpoint-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-2790-home-');
    const saved = {
      home: process.env.GITNEXUS_HOME,
      url: process.env.GITNEXUS_EMBEDDING_URL,
      model: process.env.GITNEXUS_EMBEDDING_MODEL,
      dims: process.env.GITNEXUS_EMBEDDING_DIMS,
      extension: process.env.GITNEXUS_LBUG_EXTENSION_INSTALL,
    };
    try {
      process.env.GITNEXUS_HOME = tmpHome.dbPath;
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_DIMS = '384';
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
      const vector = Array.from({ length: 384 }, (_, i) => i / 384);
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      // Every embed request snapshots the on-disk meta. The checkpoint save is
      // awaited before the batch that issues these requests, so snapshot[0] is
      // the state a crash inside the first embedding window would leave behind.
      const midRunMetas: RepoMeta[] = [];
      let captureMidRunMeta = false;
      const fetchMock = vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
        if (captureMidRunMeta) {
          const snapshot = await loadMeta(storagePath);
          if (snapshot) midRunMetas.push(snapshot);
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown[] };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return {
          ok: true,
          json: async () => ({
            data: Array.from({ length: count }, () => ({ embedding: vector })),
          }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);

      const git = (cmd: string) => execSync(cmd, { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      const headCommit = () =>
        execSync('git rev-parse HEAD', { cwd: tmpRepo.dbPath, encoding: 'utf-8' }).trim();

      await fs.writeFile(
        path.join(tmpRepo.dbPath, 'index.ts'),
        'export function first() { return "one"; }\n',
      );
      git('git init');
      git('git add index.ts');
      git('git -c user.name=test -c user.email=test@test commit -m init');
      const commitA = headCommit();

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(
        tmpRepo.dbPath,
        { embeddings: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      );
      const baselineMeta = await loadMeta(storagePath);
      if (!baselineMeta) throw new Error('expected baseline metadata');
      expect(baselineMeta.lastCommit).toBe(commitA);

      // A second commit gives the next run real incremental work AND a new
      // embeddable node, so the checkpoint window actually opens.
      await fs.writeFile(
        path.join(tmpRepo.dbPath, 'second.ts'),
        'export function second() { return "two"; }\n',
      );
      git('git add second.ts');
      git('git -c user.name=test -c user.email=test@test commit -m second');
      const commitB = headCommit();
      expect(commitB).not.toBe(commitA);

      captureMidRunMeta = true;
      const incrementalLogs: string[] = [];
      await runFullAnalysis(
        tmpRepo.dbPath,
        { embeddings: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: (message) => incrementalLogs.push(message) },
      );
      captureMidRunMeta = false;

      // Pins the scenario: this run really took the incremental path, so the
      // pre-write dirty flag below is the incremental one.
      expect(incrementalLogs).toContainEqual(expect.stringContaining('Incremental: changed='));
      const [midRunMeta] = midRunMetas;
      if (!midRunMeta) throw new Error('expected a mid-run metadata snapshot');

      // The checkpoint is persisted…
      expect(midRunMeta).toMatchObject({
        embeddingCheckpoint: { model: 'test-model', dimensions: 384 },
      });
      // …but NOTHING that certifies freshness moved: the graph is not published
      // yet, so the next run must still see this repo as changed and dirty.
      expect(midRunMeta).toMatchObject({
        lastCommit: commitA,
        fileHashes: baselineMeta.fileHashes,
        incrementalInProgress: { startedAt: expect.any(Number) },
      });
      expect(midRunMeta.lastCommit).not.toBe(commitB);
      // The stale-count restatement is gone too: the window-start save leaves
      // whatever count is already on disk alone.
      expect(midRunMeta.stats?.embeddings).toBe(baselineMeta.stats?.embeddings);

      // ── The consequence ────────────────────────────────────────────────
      // Restore exactly what a Phase 4 crash would have left on disk and run
      // again. The next run must NOT mistake the repo for unchanged.
      await saveMeta(storagePath, midRunMeta);
      const recoveryLogs: string[] = [];
      const recovered = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: (message) => recoveryLogs.push(message) },
      );

      expect(recovered.alreadyUpToDate).not.toBe(true);
      // The #2790 symptom line must NOT appear: pre-fix the advanced hashes
      // diffed to zero and the run "preserved" every stale row instead.
      expect(recoveryLogs).not.toContainEqual(expect.stringContaining('skipping wipe'));
      // The crash-recovery contract survived the checkpoint, so the dirty flag
      // is what drives the rebuild.
      expect(recoveryLogs).toContainEqual(
        expect.stringContaining('forcing full rebuild to restore a known-good index'),
      );
      const healed = await loadMeta(storagePath);
      expect(healed).toMatchObject({ lastCommit: commitB });
      expect(healed?.embeddingCheckpoint).toBeUndefined();
      expect(healed?.incrementalInProgress).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('GITNEXUS_HOME', saved.home);
      restore('GITNEXUS_EMBEDDING_URL', saved.url);
      restore('GITNEXUS_EMBEDDING_MODEL', saved.model);
      restore('GITNEXUS_EMBEDDING_DIMS', saved.dims);
      restore('GITNEXUS_LBUG_EXTENSION_INSTALL', saved.extension);
      await tmpRepo.cleanup();
      await tmpHome.cleanup();
    }
  }, 120_000);

  /**
   * #2790 regression: a partial embedding run must actually self-heal.
   *
   * The pipeline now tolerates a failed sub-batch by DELETING the affected
   * nodes' rows and naming them in `failedNodeIds`. "Zero rows heals itself" is
   * false on its own: a plain `gitnexus analyze` over an already-embedded index
   * derives shouldGenerateEmbeddings = false and never calls the pipeline, so
   * the dropped nodes stayed missing until someone passed
   * --embeddings/--force/--drop-embeddings. Retaining the checkpoint restores
   * the pre-#2790 heal — the resume path forces generation regardless of flags.
   *
   * Driven through the REAL pipeline against a stubbed endpoint so the pending
   * set is produced by the failure path itself, not hand-written.
   */
  it('a partially-failed embedding run is healed by the next PLAIN analyze (#2790)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-2790-heal-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-2790-heal-home-');
    const saved = {
      home: process.env.GITNEXUS_HOME,
      url: process.env.GITNEXUS_EMBEDDING_URL,
      model: process.env.GITNEXUS_EMBEDDING_MODEL,
      dims: process.env.GITNEXUS_EMBEDDING_DIMS,
      extension: process.env.GITNEXUS_LBUG_EXTENSION_INSTALL,
      batch: process.env.GITNEXUS_EMBEDDING_BATCH_SIZE,
      subBatch: process.env.GITNEXUS_EMBEDDING_SUB_BATCH_SIZE,
      attempts: process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS,
    };
    try {
      process.env.GITNEXUS_HOME = tmpHome.dbPath;
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_DIMS = '384';
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
      // One node per batch, one chunk per request: the failure lands on exactly
      // one sub-batch. maxAttempts 1 removes the retry loop, so a single stubbed
      // 503 is terminal without sleeping — and stays one failure, three short of
      // the shared circuit breaker's threshold, so no later batch is collaterally
      // failed.
      process.env.GITNEXUS_EMBEDDING_BATCH_SIZE = '1';
      process.env.GITNEXUS_EMBEDDING_SUB_BATCH_SIZE = '1';
      process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS = '1';

      const vector = Array.from({ length: 384 }, (_, i) => i / 384);
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      let failNextEmbedRequest = false;
      const fetchMock = vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
        if (failNextEmbedRequest) {
          failNextEmbedRequest = false;
          return { ok: false, status: 503, text: async () => 'endpoint unavailable' };
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown[] };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return {
          ok: true,
          json: async () => ({
            data: Array.from({ length: count }, () => ({ embedding: vector })),
          }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);

      const git = (cmd: string) => execSync(cmd, { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      // Several nodes so the run survives losing one — a run that persists
      // nothing is the Phase 5 gate's job, not this test's.
      for (const n of [1, 2, 3, 4, 5]) {
        await fs.writeFile(
          path.join(tmpRepo.dbPath, `mod${n}.ts`),
          `export function handler${n}(input: string): string {\n  return \`${n}:\${input}\`;\n}\n`,
        );
      }
      git('git init');
      git('git add .');
      git('git -c user.name=test -c user.email=test@test commit -m init');

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      // ── Run 1: one sub-batch loses the endpoint ───────────────────────
      failNextEmbedRequest = true;
      const partialLogs: string[] = [];
      await runFullAnalysis(
        tmpRepo.dbPath,
        { embeddings: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: (message) => partialLogs.push(message) },
      );
      expect(failNextEmbedRequest).toBe(false);
      expect(partialLogs).toContainEqual(
        expect.stringContaining('lost their embeddings to embedding-endpoint failures'),
      );

      const partialMeta = await loadMeta(storagePath);
      // The checkpoint survived finalize, carrying the dropped nodes…
      expect(partialMeta).toMatchObject({
        embeddingCheckpoint: {
          model: 'test-model',
          dimensions: 384,
          pendingNodeIds: [expect.any(String)],
        },
      });
      // The marker a COMPLETED run writes is 'partial' (#2790 review, finding
      // 5a): its nodes provably hold zero rows, so a later run under a
      // different embedding identity warns and drops them instead of throwing
      // at the resume gate before any phase runs.
      expect(partialMeta).toMatchObject({ embeddingCheckpoint: { kind: 'partial' } });
      const pendingNodeIds = partialMeta?.embeddingCheckpoint?.pendingNodeIds ?? [];
      // …and those nodes really hold no rows.
      const embeddedAfterPartial = await readEmbeddingNodeIds(tmpRepo.dbPath);
      expect(embeddedAfterPartial).toEqual(expect.not.arrayContaining(pendingNodeIds as string[]));

      // ── The containment claim, asserted EXACTLY ────────────────────────
      // `toBeGreaterThan(0)` passed with 1 survivor out of 5 — it could not
      // tell a contained sub-batch failure from a run that lost most of the
      // index. The whole safety argument for shipping a partial index is the
      // COLLATERAL-DAMAGE direction: every node that did NOT fail kept its
      // rows. The fixture is fully determined — five exported functions, one
      // embeddable Function node each, one node per batch and one chunk per
      // request — so the surviving set is exactly the five handlers minus the
      // one whose sub-batch lost the endpoint.
      const ALL_HANDLERS = ['handler1', 'handler2', 'handler3', 'handler4', 'handler5'];
      const handlerOf = (nodeId: string): string => /handler\d/.exec(nodeId)?.[0] ?? nodeId;
      const survivingHandlers = [...new Set(embeddedAfterPartial.map(handlerOf))].sort();
      const droppedHandlers = [...new Set(pendingNodeIds.map(handlerOf))].sort();
      expect(droppedHandlers).toHaveLength(1);
      expect([...survivingHandlers, ...droppedHandlers].sort()).toEqual(ALL_HANDLERS);
      expect(survivingHandlers).toHaveLength(ALL_HANDLERS.length - 1);

      // ── Run 2: a PLAIN analyze — no --embeddings, no --force ──────────
      // Pre-fix this early-returned "already up to date" (or derived
      // shouldGenerateEmbeddings = false) and the dropped nodes never came back.
      const healLogs: string[] = [];
      await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {}, onLog: (message) => healLogs.push(message) },
      );

      // The resume path is what forced generation on a flagless run.
      expect(healLogs).toContainEqual(
        expect.stringContaining('Previous analyze ended at an embedding checkpoint'),
      );
      expect(healLogs).toContainEqual(
        expect.stringContaining(`regenerating ${pendingNodeIds.length} pending node(s)`),
      );

      // The nodes are back, and the index no longer reports itself incomplete.
      const healedEmbedded = await readEmbeddingNodeIds(tmpRepo.dbPath);
      expect(healedEmbedded).toEqual(expect.arrayContaining(pendingNodeIds as string[]));
      const healedMeta = await loadMeta(storagePath);
      expect(healedMeta?.embeddingCheckpoint).toBeUndefined();
      expect(getIndexIncompleteReasons(healedMeta)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('GITNEXUS_HOME', saved.home);
      restore('GITNEXUS_EMBEDDING_URL', saved.url);
      restore('GITNEXUS_EMBEDDING_MODEL', saved.model);
      restore('GITNEXUS_EMBEDDING_DIMS', saved.dims);
      restore('GITNEXUS_LBUG_EXTENSION_INSTALL', saved.extension);
      restore('GITNEXUS_EMBEDDING_BATCH_SIZE', saved.batch);
      restore('GITNEXUS_EMBEDDING_SUB_BATCH_SIZE', saved.subBatch);
      restore('GITNEXUS_EMBEDDING_MAX_ATTEMPTS', saved.attempts);
      await tmpRepo.cleanup();
      await tmpHome.cleanup();
    }
  }, 180_000);

  it('plain analyze on another branch adopts the flat workspace slot (#2354)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-workspace-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-workspace-home-');
    const savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      execSync('git branch -M main', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git checkout -b feature/x', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      const commit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const runnerIdentity = currentRunnerIdentity();

      // Flat slot last analyzed on main; feature/x also has a pinned sub-index.
      // Both metas stamp the current schema version so the run-analyze
      // schema-mismatch guard (#2289 P1) does not force a rebuild before the
      // fast path runs.
      const flat = getStoragePaths(tmpRepo.dbPath);
      const flatMetaSeed: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'main',
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity,
      };
      await saveMeta(flat.storagePath, flatMetaSeed);
      const branch = getStoragePaths(tmpRepo.dbPath, 'feature/x');
      await saveMeta(path.dirname(branch.metaPath), {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'feature/x',
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity,
      });
      // Register the repo in an isolated registry: the shadow cleanup only
      // runs for registered repos (#2364 review F2 — unregistered repos must
      // never lose a pinned sub-index).
      await registerRepo(tmpRepo.dbPath, flatMetaSeed);
      await registerRepo(
        tmpRepo.dbPath,
        { ...flatMetaSeed, branch: 'feature/x' },
        { branch: 'feature/x' },
      );

      // A plain analyze ignores the pinned sub-index and serves the flat
      // workspace slot; the same-commit clean-tree fast path restamps the
      // slot's branch label and removes the now-shadowed sub-index.
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(tmpRepo.dbPath, {}, { onProgress: () => {} });
      expect(result.alreadyUpToDate).toBe(true);
      expect(result.isPrimaryBranch).toBe(true);
      const flatMeta = await loadMeta(flat.storagePath);
      expect(flatMeta?.branch).toBe('feature/x');
      await expect(fs.access(path.dirname(branch.metaPath))).rejects.toThrow();
    } finally {
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
      await tmpHome.cleanup();
      await tmpRepo.cleanup();
    }
  });

  it('the fast-path restamp leaves an unregistered repo pinned sub-index intact (#2364 F2)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-unregistered-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-unregistered-home-');
    const savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      execSync('git branch -M main', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git checkout -b feature/x', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      const commit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const runnerIdentity = currentRunnerIdentity();

      const flat = getStoragePaths(tmpRepo.dbPath);
      await saveMeta(flat.storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'main',
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity,
      });
      const branch = getStoragePaths(tmpRepo.dbPath, 'feature/x');
      await saveMeta(path.dirname(branch.metaPath), {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'feature/x',
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity,
      });
      // Deliberately NO registerRepo: the empty isolated registry makes this
      // repo unregistered, so the adopt must be a full no-op on disk
      // (#2264/#1169 no-self-heal, #2364 review F2).

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(tmpRepo.dbPath, {}, { onProgress: () => {} });
      expect(result.alreadyUpToDate).toBe(true);
      const flatMeta = await loadMeta(flat.storagePath);
      // The informational flat label still restamps…
      expect(flatMeta?.branch).toBe('feature/x');
      // …but the pinned sub-index survives untouched.
      await expect(fs.access(path.dirname(branch.metaPath))).resolves.toBeUndefined();
    } finally {
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
      await tmpHome.cleanup();
      await tmpRepo.cleanup();
    }
  });

  it('a detached HEAD at the same commit skips the fast-path restamp (#2364 F3 gap 6)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-detached-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-detached-home-');
    const savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      execSync('git branch -M main', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git checkout --detach', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      const commit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const runnerIdentity = currentRunnerIdentity();

      const flat = getStoragePaths(tmpRepo.dbPath);
      await saveMeta(flat.storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'main',
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity,
      });

      // Detached HEAD → branchLabel is null → the restamp block must not
      // fire: the existing stamp survives, mirroring the end-of-run write.
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(tmpRepo.dbPath, {}, { onProgress: () => {} });
      expect(result.alreadyUpToDate).toBe(true);
      const flatMeta = await loadMeta(flat.storagePath);
      expect(flatMeta?.branch).toBe('main');
    } finally {
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
      await tmpHome.cleanup();
      await tmpRepo.cleanup();
    }
  });

  it('reports isPrimaryBranch false for an up-to-date explicit --branch run (#2106 R2)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-nonprimary-');
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      execSync('git branch -M main', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git checkout -b feature/x', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      const commit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const runnerIdentity = currentRunnerIdentity();

      // Flat slot recorded for main; feature/x has its own up-to-date pinned
      // sub-index, so an explicit `--branch feature/x` run routes there.
      const flat = getStoragePaths(tmpRepo.dbPath);
      await saveMeta(flat.storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'main',
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity,
      });
      const branch = getStoragePaths(tmpRepo.dbPath, 'feature/x');
      await saveMeta(path.dirname(branch.metaPath), {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'feature/x',
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: CURRENT_ANALYSIS_FEATURES,
        runnerIdentity,
      });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { branch: 'feature/x' },
        { onProgress: () => {} },
      );
      expect(result.alreadyUpToDate).toBe(true);
      expect(result.isPrimaryBranch).toBe(false);
      // The pinned sub-index is untouched by an explicit branch run.
      await expect(fs.access(path.dirname(branch.metaPath))).resolves.toBeUndefined();
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('rejects --branch that does not match the checked-out branch (#2106)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-branch-mismatch-');
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      execSync('git branch -M main', { cwd: tmpRepo.dbPath, stdio: 'pipe' });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      // Checked out on main, but labelling the snapshot as feature/x would write
      // main's tree into feature/x's slot — must be refused before any indexing.
      await expect(
        runFullAnalysis(tmpRepo.dbPath, { branch: 'feature/x' }, { onProgress: () => {} }),
      ).rejects.toThrow(/does not match the checked-out branch/);
    } finally {
      await tmpRepo.cleanup();
    }
  });
});

describe('collectBranchCacheKeys (#2106 R6)', () => {
  const writeMeta = async (dir: string, cacheKeys: unknown, filename = 'gitnexus.json') => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), JSON.stringify({ cacheKeys }));
  };

  it('collects sibling branch keys, excluding the current run dir', async () => {
    const tmp = await createTempDir('gnx-cachekeys-');
    try {
      const storagePath = path.join(tmp.dbPath, '.gitnexus');
      await writeMeta(storagePath, ['a', 'b']); // flat
      await writeMeta(path.join(storagePath, 'branches', 'feat'), ['c']);
      const { collectBranchCacheKeys } = await import('../../src/core/run-analyze.js');
      // Excluding the flat dir → only the branch's keys.
      const r1 = await collectBranchCacheKeys(storagePath, storagePath);
      expect([...r1.keys].sort()).toEqual(['c']);
      expect(r1.complete).toBe(true);
      // Excluding the branch dir → only the flat keys.
      const r2 = await collectBranchCacheKeys(
        storagePath,
        path.join(storagePath, 'branches', 'feat'),
      );
      expect([...r2.keys].sort()).toEqual(['a', 'b']);
    } finally {
      await tmp.cleanup();
    }
  });

  it('single-branch (flat only) excluded → empty (byte-identical prune)', async () => {
    const tmp = await createTempDir('gnx-cachekeys-solo-');
    try {
      const storagePath = path.join(tmp.dbPath, '.gitnexus');
      await writeMeta(storagePath, ['a', 'b']);
      const { collectBranchCacheKeys } = await import('../../src/core/run-analyze.js');
      const r = await collectBranchCacheKeys(storagePath, storagePath);
      expect(r.keys.size).toBe(0);
      expect(r.complete).toBe(true);
    } finally {
      await tmp.cleanup();
    }
  });

  it('a corrupt sibling meta sets complete=false (fail-safe retention)', async () => {
    const tmp = await createTempDir('gnx-cachekeys-corrupt-');
    try {
      const storagePath = path.join(tmp.dbPath, '.gitnexus');
      await writeMeta(storagePath, ['a']);
      const branchDir = path.join(storagePath, 'branches', 'feat');
      await fs.mkdir(branchDir, { recursive: true });
      await fs.writeFile(path.join(branchDir, 'gitnexus.json'), '{ not valid json');
      const { collectBranchCacheKeys } = await import('../../src/core/run-analyze.js');
      const r = await collectBranchCacheKeys(storagePath, storagePath);
      expect(r.complete).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });

  it('falls back to legacy meta.json sibling keys during migration', async () => {
    const tmp = await createTempDir('gnx-cachekeys-legacy-');
    try {
      const storagePath = path.join(tmp.dbPath, '.gitnexus');
      await writeMeta(storagePath, ['a']);
      await writeMeta(path.join(storagePath, 'branches', 'legacy'), ['legacy'], 'meta.json');
      const { collectBranchCacheKeys } = await import('../../src/core/run-analyze.js');
      const r = await collectBranchCacheKeys(storagePath, storagePath);
      expect([...r.keys]).toEqual(['legacy']);
      expect(r.complete).toBe(true);
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('deriveEmbeddingMode', () => {
  // Default `analyze` on a repo with existing embeddings: must preserve, must
  // NOT regenerate, must load the cache so phase 3.5 can re-insert vectors.
  it('default + existing>0 → preserve only (load cache, no generation)', () => {
    const m = deriveEmbeddingMode({}, 1234);
    expect(m.preserveExistingEmbeddings).toBe(true);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('default + existing=0 → no-op (no preserve, no generation, no cache load)', () => {
    const m = deriveEmbeddingMode({}, 0);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(false);
  });

  // The headline behavior change requested in PR feedback: --force on an
  // already-embedded repo must regenerate (top up new/changed nodes), not
  // silently downgrade to "preserve only".
  it('--force + existing>0 → forceRegenerate + generate + load cache', () => {
    const m = deriveEmbeddingMode({ force: true }, 500);
    expect(m.forceRegenerateEmbeddings).toBe(true);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('--force + existing=0 → no embedding work (force keeps prior semantics)', () => {
    const m = deriveEmbeddingMode({ force: true }, 0);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(false);
  });

  it('--embeddings → generate + load cache (incremental top-up)', () => {
    const m = deriveEmbeddingMode({ embeddings: true }, 500);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('--embeddings + existing=0 → generate; cache load still fires (harmless empty load)', () => {
    const m = deriveEmbeddingMode({ embeddings: true }, 0);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    // Cache load is gated at the call site by `existingMeta`, not by count;
    // when explicit `--embeddings` is set we always attempt the load so any
    // stray vectors from a partial prior run get picked up.
    expect(m.shouldLoadCache).toBe(true);
  });

  // --drop-embeddings is the explicit wipe path; it must suppress cache load
  // even when --force is also set (the dominant escape hatch).
  it('--drop-embeddings → suppresses cache load, no generation', () => {
    const m = deriveEmbeddingMode({ dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
  });

  it('--force + --drop-embeddings → drop wins (no cache load, no generation)', () => {
    const m = deriveEmbeddingMode({ force: true, dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
  });

  it('--embeddings + --drop-embeddings → drop suppresses cache load (no preservation)', () => {
    // --embeddings still generates, but the prior vectors are wiped first.
    const m = deriveEmbeddingMode({ embeddings: true, dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
  });

  // Pure drop-shape derivation pin: `{ embeddings: false, dropEmbeddings:
  // true }` with existing=0 must force ALL FOUR flags false even against an
  // explicit `--embeddings` invocation — dropEmbeddings alone still
  // generates, and zeroing only the existing count would still load the
  // cache. (Historical note: run-analyze's dirty-recovery block derived this
  // exact shape between tri-review 4669518496 P2-3 and this shipping
  // review's FIX 1, which replaced it with a fail-fast LbugWipeError — see
  // run-analyze-fts-repair.test.ts. The derivation itself remains a real
  // deriveEmbeddingMode contract worth pinning.)
  it('drop shape kills an explicit --embeddings recovery invocation (all four flags false)', () => {
    const recoveryInvocation = { embeddings: true, force: true };
    const m = deriveEmbeddingMode(
      { ...recoveryInvocation, embeddings: false, dropEmbeddings: true },
      0,
    );
    expect(m).toEqual({
      shouldGenerateEmbeddings: false,
      preserveExistingEmbeddings: false,
      forceRegenerateEmbeddings: false,
      shouldLoadCache: false,
    });
  });
});

describe('deriveEmbeddingCap', () => {
  it('uses the default 50K cap when limit is undefined', () => {
    const d = deriveEmbeddingCap(10_000, undefined);
    expect(d.nodeLimit).toBe(DEFAULT_EMBEDDING_NODE_LIMIT);
    expect(d.capDisabled).toBe(false);
    expect(d.skipForCap).toBe(false);
  });

  it('skips when node count exceeds the default cap', () => {
    const d = deriveEmbeddingCap(75_000, undefined);
    expect(d.skipForCap).toBe(true);
    expect(d.capDisabled).toBe(false);
  });

  it('does not skip when node count equals the default cap (boundary)', () => {
    const d = deriveEmbeddingCap(DEFAULT_EMBEDDING_NODE_LIMIT, undefined);
    expect(d.skipForCap).toBe(false);
  });

  it('limit=0 disables the cap regardless of node count', () => {
    const d = deriveEmbeddingCap(1_000_000, 0);
    expect(d.capDisabled).toBe(true);
    expect(d.skipForCap).toBe(false);
    expect(d.nodeLimit).toBe(0);
  });

  it('honors a custom positive cap', () => {
    expect(deriveEmbeddingCap(99_999, 100_000).skipForCap).toBe(false);
    expect(deriveEmbeddingCap(100_001, 100_000).skipForCap).toBe(true);
  });

  it('custom cap below default still applies', () => {
    expect(deriveEmbeddingCap(15_000, 10_000).skipForCap).toBe(true);
  });
});

describe('pdgModeMismatch / resolvePdgConfig (#2099 F1)', () => {
  // M2 (#2082) added the resolved REACHING_DEF cap to the stamp; M3 (#2083)
  // added the two taint caps + the built-in model digest. These tests model
  // M3 STEADY-STATE equality — this object is the DELIBERATE pin of the
  // resolved-record shape, updated per milestone. The era-stamp (field
  // absent) upgrade paths are pinned in pdg-mode-flip.test.ts.
  const DEFAULTS = {
    maxFunctionLines: 2000,
    maxEdgesPerFunction: 5000,
    maxReachingDefEdgesPerFunction: 4000,
    maxCdgEdgesPerFunction: 5000,
    maxTaintFindingsPerFunction: 200,
    maxTaintHops: 32,
    maxInterprocFindings: 2000,
    maxInterprocHops: 32,
    maxInterprocEdges: 1000,
    // Content digest, not a tunable cap — pinned via the exported constant
    // (its VALUE changes whenever the built-in model changes, by design).
    taintModelVersion,
    // Solver identity, not a tunable cap — always stamped on a pdg-on run
    // (#2201 review R3). Bumps when the reaching-defs solver's emitted facts
    // change; absence on a pre-#2201 stamp forces a re-analysis.
    reachingDefSolver: 'ssa-sparse-v1',
    // FU-C return-value-ascent layer presence — always stamped on a pdg-on run;
    // absence on a pre-FU-C (v3) stamp forces a re-analysis (key-union mismatch).
    hasCallSummary: true,
  };

  it('resolvePdgConfig: pdg-off run resolves to undefined (the meta field is omitted)', async () => {
    const { resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    expect(resolvePdgConfig({})).toBeUndefined();
    expect(resolvePdgConfig({ pdg: false })).toBeUndefined();
  });

  it('resolvePdgConfig: caps resolve to their defaults; 0 = unlimited is preserved', async () => {
    const { resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    expect(resolvePdgConfig({ pdg: true })).toEqual(DEFAULTS);
    expect(
      resolvePdgConfig({
        pdg: true,
        pdgMaxFunctionLines: 0,
        pdgMaxEdgesPerFunction: 0,
        pdgMaxReachingDefEdgesPerFunction: 0,
        pdgMaxCdgEdgesPerFunction: 0,
        pdgMaxTaintFindingsPerFunction: 0,
        pdgMaxTaintHops: 0,
        pdgMaxInterprocFindings: 0,
        pdgMaxInterprocHops: 0,
        pdgMaxInterprocEdges: 0,
      }),
    ).toEqual({
      maxFunctionLines: 0,
      maxEdgesPerFunction: 0,
      maxReachingDefEdgesPerFunction: 0,
      maxCdgEdgesPerFunction: 0,
      maxTaintFindingsPerFunction: 0,
      maxTaintHops: 0,
      maxInterprocFindings: 0,
      maxInterprocHops: 0,
      maxInterprocEdges: 0,
      taintModelVersion, // not a cap — always stamped on a pdg-on run
      reachingDefSolver: 'ssa-sparse-v1', // solver identity — always stamped (#2201 R3)
      hasCallSummary: true, // FU-C ascent layer — always stamped on a pdg-on run
    });
  });

  it('legacy meta (no recorded stamp) + plain run → no mismatch', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    expect(pdgModeMismatch(undefined, {})).toBe(false);
  });

  it('legacy meta + --pdg run → mismatch (the P1 trigger)', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    expect(pdgModeMismatch(undefined, { pdg: true })).toBe(true);
  });

  it('recorded stamp + plain run → mismatch (zombie-cleanup direction)', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    expect(pdgModeMismatch(DEFAULTS, {})).toBe(true);
  });

  it('explicit defaults compare equal to absent caps (KTD5 normalization)', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    expect(pdgModeMismatch(DEFAULTS, { pdg: true })).toBe(false);
    expect(
      pdgModeMismatch(DEFAULTS, {
        pdg: true,
        pdgMaxFunctionLines: 2000,
        pdgMaxEdgesPerFunction: 5000,
      }),
    ).toBe(false);
  });

  it('a cap change while pdg stays on → mismatch (persisted edges differ)', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    expect(pdgModeMismatch(DEFAULTS, { pdg: true, pdgMaxEdgesPerFunction: 1 })).toBe(true);
    expect(pdgModeMismatch(DEFAULTS, { pdg: true, pdgMaxFunctionLines: 500 })).toBe(true);
    // 0 = unlimited differs from the 2000-line default, too.
    expect(pdgModeMismatch(DEFAULTS, { pdg: true, pdgMaxFunctionLines: 0 })).toBe(true);
    // The M3 taint caps participate identically (#2083).
    expect(pdgModeMismatch(DEFAULTS, { pdg: true, pdgMaxTaintFindingsPerFunction: 1 })).toBe(true);
    expect(pdgModeMismatch(DEFAULTS, { pdg: true, pdgMaxTaintHops: 1 })).toBe(true);
    expect(pdgModeMismatch(DEFAULTS, { pdg: true, pdgMaxTaintFindingsPerFunction: 200 })).toBe(
      false, // explicit default ≡ default
    );
  });
});

// cjkSegmentationModeMismatch's pure-function tests moved to
// cjk-segmentation.test.ts (#2339) — it now lives in cjk-segmentation.ts,
// not here, so callers that only need this comparator (e.g. the MCP query
// path) don't have to import the full analyze-pipeline module. run-analyze.ts
// still imports and uses it (see the mismatch check above the early-return).
