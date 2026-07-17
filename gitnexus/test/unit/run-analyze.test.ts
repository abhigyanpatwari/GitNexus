import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
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
  INCREMENTAL_SCHEMA_VERSION,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { taintModelVersion } from '../../src/core/ingestion/taint/typescript-model.js';
import { createTempDir } from '../helpers/test-db.js';
import { readEmbeddingNodeIds } from '../helpers/embedding-seed.js';

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
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
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
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      };
      await saveMeta(flat.storagePath, flatMetaSeed);
      const branch = getStoragePaths(tmpRepo.dbPath, 'feature/x');
      await saveMeta(path.dirname(branch.metaPath), {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'feature/x',
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
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

      const flat = getStoragePaths(tmpRepo.dbPath);
      await saveMeta(flat.storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'main',
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      });
      const branch = getStoragePaths(tmpRepo.dbPath, 'feature/x');
      await saveMeta(path.dirname(branch.metaPath), {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'feature/x',
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
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

      const flat = getStoragePaths(tmpRepo.dbPath);
      await saveMeta(flat.storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'main',
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
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

      // Flat slot recorded for main; feature/x has its own up-to-date pinned
      // sub-index, so an explicit `--branch feature/x` run routes there.
      const flat = getStoragePaths(tmpRepo.dbPath);
      await saveMeta(flat.storagePath, {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'main',
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      });
      const branch = getStoragePaths(tmpRepo.dbPath, 'feature/x');
      await saveMeta(path.dirname(branch.metaPath), {
        repoPath: tmpRepo.dbPath,
        lastCommit: commit,
        indexedAt: new Date().toISOString(),
        branch: 'feature/x',
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
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
