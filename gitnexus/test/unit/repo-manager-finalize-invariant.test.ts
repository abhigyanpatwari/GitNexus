/**
 * Regression tests for the analyze finalize invariant (#1169).
 *
 * Issue #1169: on Windows, `gitnexus analyze` was observed to exit
 * cleanly with `lbug.wal` written but `meta.json` missing AND no
 * registry entry for the repo. The user saw only the banner and exit
 * code 0, indistinguishable from a healthy index. {@link
 * assertAnalysisFinalized} is the runtime guard that catches that
 * silent-finalize state regardless of the upstream root cause.
 *
 * These tests intentionally exercise the real disk and the real
 * canonical-path comparison logic — they must fail if the invariant is
 * weakened or removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  AnalysisNotFinalizedError,
  assertAnalysisFinalized,
  isRepoRegistered,
  registerRepo,
  saveMeta,
  getStoragePaths,
  INDEX_METADATA_FILE,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';
import {
  STORAGE_PATH_ENV,
  STORAGE_ROOT_ENV,
  storagePathFromRoot,
} from '../../src/storage/storage-resolver.js';

describe('assertAnalysisFinalized (#1169)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;
  let savedStoragePath: string | undefined;
  let savedStorageRoot: string | undefined;

  const meta: RepoMeta = {
    repoPath: '',
    lastCommit: 'deadbee',
    indexedAt: '2026-04-30T00:00:00.000Z',
    stats: { files: 2, nodes: 9, edges: 17 },
  };

  beforeEach(async () => {
    tmpHome = await createTempDir('gn-1169-home-');
    tmpRepo = await createTempDir('gn-1169-repo-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    savedStoragePath = process.env[STORAGE_PATH_ENV];
    savedStorageRoot = process.env[STORAGE_ROOT_ENV];
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    delete process.env[STORAGE_PATH_ENV];
    delete process.env[STORAGE_ROOT_ENV];
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    if (savedStoragePath === undefined) delete process.env[STORAGE_PATH_ENV];
    else process.env[STORAGE_PATH_ENV] = savedStoragePath;
    if (savedStorageRoot === undefined) delete process.env[STORAGE_ROOT_ENV];
    else process.env[STORAGE_ROOT_ENV] = savedStorageRoot;
    await tmpHome.cleanup();
    await tmpRepo.cleanup();
  });

  it('throws missing="meta" when .gitnexus/gitnexus.json was never written (the #1169 symptom)', async () => {
    // Reproduce the exact disk shape from the user's repro: lbug.wal
    // present, the metadata file absent. analyze must report this as a
    // hard failure, not silently return success.
    const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(`${lbugPath}.wal`, 'simulated uncommitted WAL data');

    await expect(assertAnalysisFinalized(tmpRepo.dbPath)).rejects.toBeInstanceOf(
      AnalysisNotFinalizedError,
    );

    try {
      await assertAnalysisFinalized(tmpRepo.dbPath);
    } catch (e) {
      expect(e).toBeInstanceOf(AnalysisNotFinalizedError);
      const err = e as AnalysisNotFinalizedError;
      expect(err.missing).toBe('meta');
      expect(err.kind).toBe('AnalysisNotFinalizedError');
      expect(err.repoPath).toBe(path.resolve(tmpRepo.dbPath));
      expect(err.storagePath).toBe(storagePath);
      // Diagnostic message names the missing artifact (the PRIMARY
      // metadata filename the check actually probes) and the storage
      // path the user must inspect — required to clear DoD §2.8
      // (errors must be actionable).
      expect(err.message).toContain(INDEX_METADATA_FILE);
      expect(err.message).toContain(storagePath);
      expect(err.message).toContain('lbug.wal');
    }
  });

  it('throws missing="registry-entry" when meta.json exists but the registry was not updated', async () => {
    // Half-finalized state — meta.json was written but registerRepo
    // failed or was skipped. Surface this as a hard failure so the
    // caller does not believe the repo is discoverable from MCP.
    const { storagePath } = getStoragePaths(tmpRepo.dbPath);
    await saveMeta(storagePath, meta);

    await expect(assertAnalysisFinalized(tmpRepo.dbPath)).rejects.toBeInstanceOf(
      AnalysisNotFinalizedError,
    );

    try {
      await assertAnalysisFinalized(tmpRepo.dbPath);
    } catch (e) {
      expect(e).toBeInstanceOf(AnalysisNotFinalizedError);
      const err = e as AnalysisNotFinalizedError;
      expect(err.missing).toBe('registry-entry');
      expect(err.message).toContain('registry entry');
      expect(err.message).toContain(path.resolve(tmpRepo.dbPath));
    }
  });

  it('resolves cleanly when meta.json exists AND a matching registry entry was written', async () => {
    // Happy path — verify the invariant does NOT throw on a properly
    // finalized repo, otherwise we would break every successful
    // analyze run.
    const { storagePath } = getStoragePaths(tmpRepo.dbPath);
    await saveMeta(storagePath, meta);
    await registerRepo(tmpRepo.dbPath, meta);

    await expect(assertAnalysisFinalized(tmpRepo.dbPath)).resolves.toBeUndefined();
  });

  it('checks the analysis-selected external slot even when the environment changes afterward', async () => {
    const storageRoot = path.join(tmpHome.dbPath, 'external-indexes');
    const storagePath = storagePathFromRoot(storageRoot, tmpRepo.dbPath);
    const externalMeta = { ...meta, repoPath: tmpRepo.dbPath, storagePath };
    await saveMeta(storagePath, externalMeta);
    await registerRepo(tmpRepo.dbPath, externalMeta, { storagePath });

    // Simulate a parent process changing configuration after the worker has
    // completed the analysis but before its finalization assertion runs.
    process.env[STORAGE_ROOT_ENV] = path.join(tmpHome.dbPath, 'different-indexes');

    await expect(assertAnalysisFinalized(tmpRepo.dbPath, storagePath)).resolves.toBeUndefined();
    await expect(assertAnalysisFinalized(tmpRepo.dbPath)).rejects.toBeInstanceOf(
      AnalysisNotFinalizedError,
    );
  });

  it('matches registry entries case-insensitively on Windows so 8.3 short-name paths still finalize', async () => {
    // The registry comparison applies canonicalizePath + Windows
    // case-insensitivity. If the analyze caller passes the path in a
    // different case (uppercase drive letter, mixed-case parent dir),
    // the invariant must still see the entry. Otherwise valid
    // analyses would spuriously fail with AnalysisNotFinalizedError on
    // Windows runners.
    const { storagePath } = getStoragePaths(tmpRepo.dbPath);
    await saveMeta(storagePath, meta);
    await registerRepo(tmpRepo.dbPath, meta);

    const variant = process.platform === 'win32' ? tmpRepo.dbPath.toUpperCase() : tmpRepo.dbPath; // POSIX is case-sensitive; assertion uses canonical form
    await expect(assertAnalysisFinalized(variant)).resolves.toBeUndefined();
  });

  // isRepoRegistered backs the analyze up-to-date fast-path gate (#2264): the
  // fast path must NOT short-circuit a repo that is indexed-but-unregistered
  // (e.g. a prior --name collision wrote meta.json then failed before
  // registerRepo), otherwise --allow-duplicate-name could never heal it.
  it('isRepoRegistered is false when the repo has no registry entry', async () => {
    expect(await isRepoRegistered(tmpRepo.dbPath)).toBe(false);
  });

  it('isRepoRegistered is true once a matching entry is written', async () => {
    await registerRepo(tmpRepo.dbPath, meta);
    expect(await isRepoRegistered(tmpRepo.dbPath)).toBe(true);
  });
});
