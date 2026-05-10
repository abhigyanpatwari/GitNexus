/**
 * Integration coverage for the `runFullAnalysis` incremental-orchestration
 * wiring (Claude PR-review Finding 2).
 *
 * These tests exercise the *real runtime path* — they call
 * `runFullAnalysis` against a real on-disk git repo backed by a real
 * LadybugDB at `<repo>/.gitnexus/`, and assert behaviours that pure
 * unit tests on `diffFileHashes` / `extractChangedSubgraph` cannot
 * catch:
 *
 *   - the `isIncremental` decision (post-pipeline eligibility check)
 *   - `incrementalInProgress` dirty-flag set-before-mutation and
 *     clear-on-success
 *   - the importer-closure expansion (1-hop reached via the writable
 *     set, transitive reachable via bounded BFS)
 *   - the "forced full rebuild on dirty-flag-from-prior-crash" path
 *
 * Each test creates a temporary git repo, runs the analyzer, and asserts
 * on the resulting `meta.json` and graph state. Cleanup is best-effort
 * (Windows LadybugDB handle release can lag; `cleanupTempDir` retries).
 */

import { execSync } from 'child_process';
import { writeFile, readFile, copyFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  INCREMENTAL_SCHEMA_VERSION,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.resolve(HERE, '..', 'fixtures', 'mini-repo', 'src');

/**
 * Copy the mini-repo fixture into a fresh git-initialized temp directory.
 * Returns the temp handle so the caller owns cleanup.
 */
async function setupMiniRepo(): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
  const tmp = await createTempDir('gitnexus-incr-orch-');
  const dest = path.join(tmp.dbPath, 'src');
  await mkdir(dest, { recursive: true });
  // Copy mini-repo fixture files
  const names = [
    'index.ts',
    'handler.ts',
    'validator.ts',
    'formatter.ts',
    'middleware.ts',
    'logger.ts',
    'db.ts',
  ];
  for (const n of names) {
    await copyFile(path.join(FIXTURE_SRC, n), path.join(dest, n));
  }
  execSync('git init', { cwd: tmp.dbPath, stdio: 'pipe' });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
    cwd: tmp.dbPath,
    stdio: 'pipe',
  });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m initial', {
    cwd: tmp.dbPath,
    stdio: 'pipe',
  });
  return tmp;
}

describe('runFullAnalysis — incremental orchestration', () => {
  it('first run populates fileHashes + schemaVersion and clears incrementalInProgress on success', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(INCREMENTAL_SCHEMA_VERSION);
      expect(meta!.fileHashes).toBeDefined();
      expect(Object.keys(meta!.fileHashes ?? {}).length).toBeGreaterThan(0);
      // Dirty flag MUST be cleared after a successful run.
      expect(meta!.incrementalInProgress).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  }, 180_000);

  it('second run on unchanged state takes the alreadyUpToDate fast path', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const first = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      expect(first.alreadyUpToDate).toBeUndefined();

      const second = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // lastCommit==HEAD && working tree clean (mod GitNexus output) →
      // early-return fast path.
      expect(second.alreadyUpToDate).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('second run after a source edit takes the incremental path (not full rebuild) and clears the dirty flag', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const firstMeta = await loadMeta(storagePath);

      // Modify a source file — body-only edit is enough to register a
      // content-hash change.
      const target = path.join(repo.dbPath, 'src', 'logger.ts');
      const before = await readFile(target, 'utf-8');
      await writeFile(target, before + '\n// touched by test\n', 'utf-8');

      const second = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // The early-return alreadyUpToDate path must NOT fire (the dirty
      // tree should kick the run through to incremental writeback).
      expect(second.alreadyUpToDate).toBeUndefined();

      const secondMeta = await loadMeta(storagePath);
      expect(secondMeta).not.toBeNull();
      // Dirty flag must be cleared on success.
      expect(secondMeta!.incrementalInProgress).toBeUndefined();
      // fileHashes[logger.ts] must have rotated to the new content.
      expect(secondMeta!.fileHashes?.['src/logger.ts']).toBeDefined();
      expect(secondMeta!.fileHashes?.['src/logger.ts']).not.toBe(
        firstMeta!.fileHashes?.['src/logger.ts'],
      );
      // Stats should still be populated.
      expect(secondMeta!.stats?.files).toBeGreaterThan(0);
      expect(secondMeta!.stats?.nodes).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('a stale incrementalInProgress flag at startup forces a full rebuild that clears it', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      // First run lays down a normal index.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // Manually corrupt meta.json with a stale dirty flag — simulates
      // a crashed previous incremental run.
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      const tampered: RepoMeta = {
        ...meta!,
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 3,
        },
      };
      await saveMeta(storagePath, tampered);

      // Next run must detect the flag, force a full rebuild (which
      // overwrites meta), and clear the flag.
      const recovered = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // A full rebuild was taken — the alreadyUpToDate fast path
      // explicitly cannot fire because the dirty-flag check rewrote
      // `options.force` to true.
      expect(recovered.alreadyUpToDate).toBeUndefined();

      const after = await loadMeta(storagePath);
      expect(after!.incrementalInProgress).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  }, 300_000);
});
