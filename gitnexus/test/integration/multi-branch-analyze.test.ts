import { execSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

/**
 * #2106 — multi-branch indexing end-to-end. Proves that analyzing a second
 * branch creates its own index under `.gitnexus/branches/<slug>/` and does NOT
 * overwrite the primary (flat) index, and that the primary single-branch
 * layout stays at `.gitnexus/{lbug,meta.json}`.
 */
const git = (args: string[], cwd: string): string =>
  execSync(['git', ...args].join(' '), { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

const commit = (cwd: string, message: string): void => {
  git(['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', message], cwd);
};

describe('multi-branch analyze (#2106)', () => {
  it('indexes a second branch without overwriting the first', async () => {
    const tmp = await createTempDir('gitnexus-multibranch-');
    const repo = tmp.dbPath;
    try {
      git(['init'], repo);
      await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
      git(['add', '-A'], repo);
      commit(repo, 'a');
      // Normalise the branch name across git defaults (master vs main).
      git(['branch', '-M', 'main'], repo);
      const mainCommit = git(['rev-parse', 'HEAD'], repo);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo, {}, { onProgress: () => {} });

      // Primary branch lands in the flat slot, byte-identical layout.
      const flat = getStoragePaths(repo);
      expect(path.dirname(flat.lbugPath)).toBe(flat.storagePath);
      expect(existsSync(flat.lbugPath)).toBe(true);
      const flatMeta = await loadMeta(flat.storagePath);
      expect(flatMeta?.branch).toBe('main');
      expect(flatMeta?.lastCommit).toBe(mainCommit);

      // Switch to a feature branch with different content and re-analyze.
      git(['checkout', '-b', 'feature/x'], repo);
      await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 2;\n');
      git(['add', '-A'], repo);
      commit(repo, 'b');
      const featureCommit = git(['rev-parse', 'HEAD'], repo);
      expect(featureCommit).not.toBe(mainCommit);

      await runFullAnalysis(repo, {}, { onProgress: () => {} });

      // The flat (main) index is untouched — NOT overwritten by the feature run.
      expect(existsSync(flat.lbugPath)).toBe(true);
      const flatMetaAfter = await loadMeta(flat.storagePath);
      expect(flatMetaAfter?.branch).toBe('main');
      expect(flatMetaAfter?.lastCommit).toBe(mainCommit);

      // The feature index is a separate DB under branches/<slug>/.
      const branchPaths = getStoragePaths(repo, 'feature/x');
      const branchDir = path.dirname(branchPaths.lbugPath);
      expect(branchDir.includes(path.join('.gitnexus', 'branches'))).toBe(true);
      expect(existsSync(branchPaths.lbugPath)).toBe(true);
      const branchMeta = await loadMeta(branchDir);
      expect(branchMeta?.branch).toBe('feature/x');
      expect(branchMeta?.lastCommit).toBe(featureCommit);
    } finally {
      await tmp.cleanup();
    }
  }, 180_000);
});
