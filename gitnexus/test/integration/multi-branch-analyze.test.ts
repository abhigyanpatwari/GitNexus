import { execSync, execFileSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getStoragePaths, loadMeta, listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

/**
 * #2106/#2354 — branch handling end-to-end. Proves that a plain analyze
 * always updates the flat workspace index (following the checked-out working
 * tree, no `branches/` sub-directory, no slot-ownership friction), that an
 * explicit `--branch` run pins a separate index under
 * `.gitnexus/branches/<slug>/` without touching the flat slot, and that a
 * pinned sub-index shadowed by a later plain analyze on the same branch is
 * cleaned up.
 */
const git = (args: string[], cwd: string): string =>
  execSync(['git', ...args].join(' '), { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

const commit = (cwd: string, message: string): void => {
  git(['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', message], cwd);
};

describe('multi-branch analyze (#2106)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;

  beforeEach(async () => {
    // Isolate the global registry so the full analyze runs below don't write
    // to the developer's real ~/.gitnexus/registry.json.
    tmpHome = await createTempDir('gitnexus-multibranch-home-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
  });

  it('a plain analyze follows a branch switch into the flat workspace slot (#2354)', async () => {
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

      // First analyze lands in the flat slot, byte-identical layout.
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

      // The flat workspace index followed the working tree — updated in place,
      // no `branches/` sub-directory, no slot-ownership error or warning.
      expect(existsSync(flat.lbugPath)).toBe(true);
      const flatMetaAfter = await loadMeta(flat.storagePath);
      expect(flatMetaAfter?.branch).toBe('feature/x');
      expect(flatMetaAfter?.lastCommit).toBe(featureCommit);
      expect(existsSync(path.join(flat.storagePath, 'branches'))).toBe(false);

      // The registry follows along: one entry, relabelled, no branches[].
      const entries = await listRegisteredRepos();
      const entry = entries.find((e) => path.resolve(e.path) === path.resolve(repo));
      expect(entry).toBeDefined();
      expect(entry?.branch).toBe('feature/x');
      expect(entry?.lastCommit).toBe(featureCommit);
      expect(entry?.branches).toBeUndefined();
    } finally {
      await tmp.cleanup();
    }
  }, 180_000);

  it('an explicit --branch run pins a sub-index; a later plain analyze on that branch reclaims it', async () => {
    const tmp = await createTempDir('gitnexus-multibranch-pin-');
    const repo = tmp.dbPath;
    try {
      git(['init'], repo);
      await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
      git(['add', '-A'], repo);
      commit(repo, 'a');
      git(['branch', '-M', 'main'], repo);
      const mainCommit = git(['rev-parse', 'HEAD'], repo);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      const flat = getStoragePaths(repo);
      // main records its live chunk keys so a later branch prune can keep them.
      const mainCacheKeys = (await loadMeta(flat.storagePath))?.cacheKeys ?? [];
      expect(mainCacheKeys.length).toBeGreaterThan(0);

      // Pin the feature branch into its own sub-index with explicit --branch.
      git(['checkout', '-b', 'feature/x'], repo);
      await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 2;\n');
      git(['add', '-A'], repo);
      commit(repo, 'b');
      const featureCommit = git(['rev-parse', 'HEAD'], repo);

      await runFullAnalysis(repo, { branch: 'feature/x' }, { onProgress: () => {} });

      // The flat (main) index is untouched — NOT overwritten by the pinned run.
      expect(existsSync(flat.lbugPath)).toBe(true);
      const flatMetaAfter = await loadMeta(flat.storagePath);
      expect(flatMetaAfter?.branch).toBe('main');
      expect(flatMetaAfter?.lastCommit).toBe(mainCommit);

      // The pinned index is a separate DB under branches/<slug>/.
      const branchPaths = getStoragePaths(repo, 'feature/x');
      const branchDir = path.dirname(branchPaths.lbugPath);
      expect(branchDir.includes(path.join('.gitnexus', 'branches'))).toBe(true);
      expect(existsSync(branchPaths.lbugPath)).toBe(true);
      const branchMeta = await loadMeta(branchDir);
      expect(branchMeta?.branch).toBe('feature/x');
      expect(branchMeta?.lastCommit).toBe(featureCommit);

      // #2106 R6: the pinned analyze must NOT have evicted main's chunks from
      // the SHARED parse cache (they were unioned in via main's recorded keys).
      const { loadParseCache } = await import('../../src/storage/parse-cache.js');
      const sharedCache = await loadParseCache(flat.storagePath);
      const onDisk = sharedCache.onDiskKeys ?? new Set<string>();
      for (const k of mainCacheKeys) {
        expect(onDisk.has(k), `main chunk ${k} survives the feature prune`).toBe(true);
      }

      // The global registry keeps one entry per path: flat label at top level,
      // the pinned branch nested under branches[] (#2106 U4).
      let entries = await listRegisteredRepos();
      let entry = entries.find((e) => path.resolve(e.path) === path.resolve(repo));
      expect(entry?.branch).toBe('main');
      expect(entry?.branches?.map((b) => b.branch)).toEqual(['feature/x']);

      // A plain analyze on the pinned branch adopts the flat workspace slot
      // and removes the now-shadowed sub-index (#2354): the flat handle would
      // always win for this label, leaving the sub-index unreachable bloat.
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      const reclaimed = await loadMeta(flat.storagePath);
      expect(reclaimed?.branch).toBe('feature/x');
      expect(reclaimed?.lastCommit).toBe(featureCommit);
      expect(existsSync(branchDir)).toBe(false);
      entries = await listRegisteredRepos();
      entry = entries.find((e) => path.resolve(e.path) === path.resolve(repo));
      expect(entry?.branch).toBe('feature/x');
      expect(entry?.branches).toBeUndefined();
    } finally {
      await tmp.cleanup();
    }
  }, 180_000);

  it('a detached-HEAD re-analyze preserves the primary stamp (no later overwrite)', async () => {
    const tmp = await createTempDir('gitnexus-multibranch-detached-');
    const repo = tmp.dbPath;
    try {
      git(['init'], repo);
      await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
      git(['add', '-A'], repo);
      commit(repo, 'a');
      git(['branch', '-M', 'main'], repo);
      const mainCommit = git(['rev-parse', 'HEAD'], repo);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      const flat = getStoragePaths(repo);
      expect((await loadMeta(flat.storagePath))?.branch).toBe('main');

      // Detach HEAD (what CI's actions/checkout does) and force a rebuild of the
      // flat/primary index. The primary stamp must NOT be stripped.
      git(['checkout', mainCommit], repo); // detached
      await runFullAnalysis(repo, { force: true }, { onProgress: () => {} });
      expect((await loadMeta(flat.storagePath))?.branch).toBe('main');

      // Now an explicit --branch analyze must still route to a sub-dir (the
      // stamp survived), leaving the flat index intact rather than updating it.
      git(['checkout', '-b', 'feature/y'], repo);
      await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 2;\n');
      git(['add', '-A'], repo);
      commit(repo, 'b');
      await runFullAnalysis(repo, { branch: 'feature/y' }, { onProgress: () => {} });

      const flatMeta = await loadMeta(flat.storagePath);
      expect(flatMeta?.branch).toBe('main');
      expect(flatMeta?.lastCommit).toBe(mainCommit); // flat NOT touched by the pinned run
      expect(existsSync(getStoragePaths(repo, 'feature/y').lbugPath)).toBe(true);
    } finally {
      await tmp.cleanup();
    }
  }, 180_000);

  it('an auto-detected branch the rules forbid lands on the flat slot (#2106 R1)', async () => {
    const tmp = await createTempDir('gitnexus-multibranch-r1-');
    const repo = tmp.dbPath;
    try {
      git(['init'], repo);
      await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
      git(['add', '-A'], repo);
      commit(repo, 'a');
      // A backtick is valid in a git ref but rejected by validateBranchName.
      // execFileSync (no shell) so the backtick is not interpreted.
      execFileSync('git', ['branch', '-M', 'feat`x'], { cwd: repo, stdio: 'pipe' });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo, {}, { onProgress: () => {} });

      // The forbidden ref was normalized to null → flat slot, no branch field,
      // and no branches/ sub-directory created for an unqueryable slug.
      const flat = getStoragePaths(repo);
      expect(existsSync(flat.lbugPath)).toBe(true);
      expect((await loadMeta(flat.storagePath))?.branch).toBeUndefined();
      expect(existsSync(path.join(flat.storagePath, 'branches'))).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  }, 180_000);
});
