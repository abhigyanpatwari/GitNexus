/**
 * Unit tests: reconcileMetadataFiles (PR #2363 review fix, F6)
 *
 * The gitnexus.json / meta.json dual-file contract:
 * - saveMeta writes BOTH files (primary must succeed, mirror best-effort)
 * - reconcileMetadataFiles converges the two on every analyze: a valid
 *   gitnexus.json wins; legacy is used only when primary is absent
 * - loadMeta prefers gitnexus.json, falls back to the mirror only when the
 *   primary is provably absent (ENOENT/ENOTDIR)
 *
 * Uses real tmp dirs (house style — see repo-manager.test.ts); the final
 * describe drives a mocked-pipeline runFullAnalysis to prove the analyze
 * entry point leaves a pre-rename (legacy-only) repo with both files.
 */
import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _captureLogger } from '../../src/core/logger.js';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  reconcileMetadataFiles,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import {
  STORAGE_PATH_ENV,
  STORAGE_ROOT_ENV,
  storagePathFromRoot,
} from '../../src/storage/storage-resolver.js';
import { createTempDir } from '../helpers/test-db.js';

const metaAt = (indexedAt: string, lastCommit: string, extra?: Partial<RepoMeta>): RepoMeta => ({
  repoPath: '/some/repo',
  lastCommit,
  indexedAt,
  ...extra,
});

const readJson = async (dir: string, filename: string): Promise<RepoMeta> =>
  JSON.parse(await fs.readFile(path.join(dir, filename), 'utf-8')) as RepoMeta;

describe('reconcileMetadataFiles', () => {
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let storagePath: string;
  let savedStoragePath: string | undefined;
  let savedStorageRoot: string | undefined;

  beforeEach(async () => {
    tmpRepo = await createTempDir('gitnexus-reconcile-suite-');
    savedStoragePath = process.env[STORAGE_PATH_ENV];
    savedStorageRoot = process.env[STORAGE_ROOT_ENV];
    delete process.env[STORAGE_PATH_ENV];
    delete process.env[STORAGE_ROOT_ENV];
    storagePath = getStoragePaths(tmpRepo.dbPath).storagePath;
    await fs.mkdir(storagePath, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedStoragePath === undefined) delete process.env[STORAGE_PATH_ENV];
    else process.env[STORAGE_PATH_ENV] = savedStoragePath;
    if (savedStorageRoot === undefined) delete process.env[STORAGE_ROOT_ENV];
    else process.env[STORAGE_ROOT_ENV] = savedStorageRoot;
    await tmpRepo.cleanup();
  });

  it('flat round-trip: legacy-only dir gains an identical gitnexus.json; meta.json is untouched', async () => {
    const legacy = metaAt('2026-06-01T00:00:00.000Z', 'legacy-commit', {
      fileHashes: { 'src/a.ts': 'hash-a' },
    });
    const legacyRaw = JSON.stringify(legacy);
    await fs.writeFile(path.join(storagePath, 'meta.json'), legacyRaw);

    await expect(reconcileMetadataFiles(tmpRepo.dbPath)).resolves.toBe(true);

    await expect(readJson(storagePath, 'gitnexus.json')).resolves.toEqual(legacy);
    await expect(readJson(storagePath, 'meta.json')).resolves.toEqual(legacy);
  });

  it('primary-only dir gets its meta.json mirror re-established', async () => {
    const primary = metaAt('2026-06-01T00:00:00.000Z', 'primary-commit');
    await fs.writeFile(path.join(storagePath, 'gitnexus.json'), JSON.stringify(primary));

    await expect(reconcileMetadataFiles(tmpRepo.dbPath)).resolves.toBe(true);

    await expect(readJson(storagePath, 'meta.json')).resolves.toEqual(primary);
  });

  it('preserves the incrementalInProgress crash-recovery flag through a bootstrap', async () => {
    // The dirty flag travels through this file; a reconciliation that
    // reconstructed a trimmed object instead of carrying fields verbatim
    // would silently drop it and skip the recovery full-rebuild.
    const dirty = metaAt('2026-06-01T00:00:00.000Z', 'crashed-run', {
      incrementalInProgress: true,
    } as Partial<RepoMeta>);
    await fs.writeFile(path.join(storagePath, 'meta.json'), JSON.stringify(dirty));

    await reconcileMetadataFiles(tmpRepo.dbPath);

    const primary = await readJson(storagePath, 'gitnexus.json');
    expect(primary).toMatchObject({ incrementalInProgress: true, lastCommit: 'crashed-run' });
  });

  it('mixed branch states converge in one call (legacy-only / converged / primary-authoritative)', async () => {
    const branches = path.join(storagePath, 'branches');
    const legacyOnly = path.join(branches, 'legacy-only');
    const converged = path.join(branches, 'converged');
    const primaryAuthoritative = path.join(branches, 'primary-authoritative');
    for (const dir of [legacyOnly, converged, primaryAuthoritative]) {
      await fs.mkdir(dir, { recursive: true });
    }

    await fs.writeFile(
      path.join(legacyOnly, 'meta.json'),
      JSON.stringify(metaAt('2026-06-01T00:00:00.000Z', 'lo-commit')),
    );

    const convergedMeta = metaAt('2026-06-01T00:00:00.000Z', 'cv-commit');
    await saveMeta(converged, convergedMeta); // writes both, already in sync

    await fs.writeFile(
      path.join(primaryAuthoritative, 'gitnexus.json'),
      JSON.stringify(metaAt('2026-01-01T00:00:00.000Z', 'primary-commit')),
    );
    await fs.writeFile(
      path.join(primaryAuthoritative, 'meta.json'),
      JSON.stringify(metaAt('2026-06-01T00:00:00.000Z', 'legacy-newer-but-not-authoritative')),
    );

    // Flat slot: nothing — stays empty and untouched.
    await expect(reconcileMetadataFiles(tmpRepo.dbPath)).resolves.toBe(true);

    await expect(readJson(legacyOnly, 'gitnexus.json')).resolves.toMatchObject({
      lastCommit: 'lo-commit',
    });
    await expect(readJson(converged, 'gitnexus.json')).resolves.toEqual(convergedMeta);
    await expect(readJson(primaryAuthoritative, 'gitnexus.json')).resolves.toMatchObject({
      lastCommit: 'primary-commit',
    });
    await expect(readJson(primaryAuthoritative, 'meta.json')).resolves.toMatchObject({
      lastCommit: 'primary-commit',
    });
    // Flat slot stayed empty (reconcile fabricates nothing).
    await expect(fs.access(path.join(storagePath, 'gitnexus.json'))).rejects.toThrow();
  });

  it('second call after convergence is a no-op with identical file content', async () => {
    await fs.writeFile(
      path.join(storagePath, 'meta.json'),
      JSON.stringify(metaAt('2026-06-01T00:00:00.000Z', 'legacy-commit')),
    );

    await expect(reconcileMetadataFiles(tmpRepo.dbPath)).resolves.toBe(true);
    const primaryAfterFirst = await fs.readFile(path.join(storagePath, 'gitnexus.json'), 'utf-8');
    const legacyAfterFirst = await fs.readFile(path.join(storagePath, 'meta.json'), 'utf-8');

    await expect(reconcileMetadataFiles(tmpRepo.dbPath)).resolves.toBe(false);
    await expect(fs.readFile(path.join(storagePath, 'gitnexus.json'), 'utf-8')).resolves.toBe(
      primaryAfterFirst,
    );
    await expect(fs.readFile(path.join(storagePath, 'meta.json'), 'utf-8')).resolves.toBe(
      legacyAfterFirst,
    );
  });

  it('both files corrupt: no throw, no fabricated content, one primary warning', async () => {
    await fs.writeFile(path.join(storagePath, 'gitnexus.json'), '{ nope');
    await fs.writeFile(path.join(storagePath, 'meta.json'), 'also nope {{{');

    const cap = _captureLogger();
    try {
      await expect(reconcileMetadataFiles(tmpRepo.dbPath)).resolves.toBe(false);
    } finally {
      cap.restore();
    }

    // Corrupt bytes left exactly as they were (next successful saveMeta heals).
    await expect(fs.readFile(path.join(storagePath, 'gitnexus.json'), 'utf-8')).resolves.toBe(
      '{ nope',
    );
    await expect(fs.readFile(path.join(storagePath, 'meta.json'), 'utf-8')).resolves.toBe(
      'also nope {{{',
    );
    expect(cap.records().filter((r) => r.level === 40)).toHaveLength(1);
  });

  it('fresh directory (neither file) is a silent no-op', async () => {
    const cap = _captureLogger();
    try {
      await expect(reconcileMetadataFiles(tmpRepo.dbPath)).resolves.toBe(false);
    } finally {
      cap.restore();
    }
    expect(cap.records().filter((r) => r.level === 40)).toEqual([]);
  });

  it('a mirror-write failure during reconciliation does not throw (best-effort semantics)', async () => {
    await fs.writeFile(
      path.join(storagePath, 'meta.json'),
      JSON.stringify(metaAt('2026-06-01T00:00:00.000Z', 'legacy-commit')),
    );

    // Fail only the legacy-mirror write inside saveMeta's dual-write.
    const realOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(
      async (filePath: Parameters<typeof fs.open>[0], ...rest) => {
        if (String(filePath).includes(`${path.sep}meta.json.tmp.`)) {
          const err = new Error('simulated mirror-write failure') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return realOpen(filePath, ...rest);
      },
    );

    await expect(reconcileMetadataFiles(tmpRepo.dbPath)).resolves.toBe(true);
    // Primary was bootstrapped; the pre-existing legacy file is still intact.
    await expect(readJson(storagePath, 'gitnexus.json')).resolves.toMatchObject({
      lastCommit: 'legacy-commit',
    });
    await expect(readJson(storagePath, 'meta.json')).resolves.toMatchObject({
      lastCommit: 'legacy-commit',
    });
  });

  it('loadMeta sees the reconciled state (bootstrap then read round-trip)', async () => {
    const legacy = metaAt('2026-06-01T00:00:00.000Z', 'roundtrip-commit');
    await fs.writeFile(path.join(storagePath, 'meta.json'), JSON.stringify(legacy));

    await reconcileMetadataFiles(tmpRepo.dbPath);

    await expect(loadMeta(storagePath)).resolves.toEqual(legacy);
  });

  it('does not overwrite a corrupt primary with otherwise valid legacy metadata', async () => {
    await fs.writeFile(path.join(storagePath, 'gitnexus.json'), '{ invalid primary');
    await fs.writeFile(
      path.join(storagePath, 'meta.json'),
      JSON.stringify(metaAt('2026-06-01T00:00:00.000Z', 'legacy-commit')),
    );

    await expect(reconcileMetadataFiles(tmpRepo.dbPath)).resolves.toBe(false);
    await expect(fs.readFile(path.join(storagePath, 'gitnexus.json'), 'utf-8')).resolves.toBe(
      '{ invalid primary',
    );
    await expect(readJson(storagePath, 'meta.json')).resolves.toMatchObject({
      lastCommit: 'legacy-commit',
    });
  });

  it('uses analyze\'s validated storage path instead of resolving it again', async () => {
    const externalRoot = path.join(tmpRepo.dbPath, 'external-storage');
    const externalStoragePath = storagePathFromRoot(externalRoot, tmpRepo.dbPath);
    const expected = metaAt('2026-06-01T00:00:00.000Z', 'validated-path');
    const redirected = metaAt('2026-06-01T00:00:00.000Z', 'redirected-path');
    const previous = process.env[STORAGE_ROOT_ENV];
    await fs.mkdir(externalStoragePath, { recursive: true });
    await fs.writeFile(path.join(storagePath, 'meta.json'), JSON.stringify(expected));
    await fs.writeFile(path.join(externalStoragePath, 'meta.json'), JSON.stringify(redirected));
    process.env[STORAGE_ROOT_ENV] = externalRoot;

    try {
      await expect(reconcileMetadataFiles(tmpRepo.dbPath, storagePath)).resolves.toBe(true);
    } finally {
      if (previous === undefined) delete process.env[STORAGE_ROOT_ENV];
      else process.env[STORAGE_ROOT_ENV] = previous;
    }

    await expect(readJson(storagePath, 'gitnexus.json')).resolves.toMatchObject({
      lastCommit: 'validated-path',
    });
    await expect(fs.access(path.join(externalStoragePath, 'gitnexus.json'))).rejects.toThrow();
  });
});

// ─── analyze entry point: a pre-rename repo ends with both files ─────────

describe('runFullAnalysis metadata reconciliation (mocked pipeline)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/core/search/fts-indexes.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('analyze on a legacy-only (pre-rename) repo ends with both metadata files in sync', async () => {
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
      createSearchFTSIndexes: vi.fn(async () => []),
      verifySearchFTSIndexes: vi.fn(async () => []),
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
      registerRepo: vi.fn(async () => 'reconcile-e2e-repo'),
      ensureGitNexusIgnored: vi.fn(async () => undefined),
    }));

    const tmpRepo = await createTempDir('gitnexus-reconcile-analyze-e2e-');
    try {
      // Pre-rename repo: ONLY the legacy filename exists before analyze.
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      await fs.mkdir(storagePath, { recursive: true });
      await fs.writeFile(
        path.join(storagePath, 'meta.json'),
        JSON.stringify(
          metaAt('2026-01-01T00:00:00.000Z', 'pre-rename-commit', {
            repoPath: tmpRepo.dbPath,
            storagePath,
          }),
        ),
      );

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(tmpRepo.dbPath, { force: true }, { onProgress: () => {} });

      const primary = await readJson(storagePath, 'gitnexus.json');
      const legacy = await readJson(storagePath, 'meta.json');
      expect(primary).toEqual(legacy);
      // The final saveMeta of THIS run wrote both (not just the reconciled
      // pre-analyze stamp): lastCommit was re-stamped by the analyze.
      expect(primary.lastCommit).not.toBe('pre-rename-commit');
    } finally {
      await tmpRepo.cleanup();
    }
  });
});
