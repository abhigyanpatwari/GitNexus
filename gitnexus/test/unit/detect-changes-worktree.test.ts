/**
 * Tests for detect_changes worktree support.
 *
 * When a caller is editing inside a linked git worktree the canonical
 * repo.repoPath (main checkout root) is a different working directory.
 * Running `git diff` from the canonical root returns empty output while
 * the actual changes live in the linked worktree.
 *
 * The `worktree` param pins the cwd for git diff to the linked worktree
 * after verifying it belongs to the same canonical repository.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  readFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'fs';
import { execSync, execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { findToolDefinition } from '../../src/mcp/tools.js';
import { LocalBackend, resolveWorktreeCwd } from '../../src/mcp/local/local-backend.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import * as registry from '../../src/storage/repo-manager.js';
import { getCanonicalRepoRoot } from '../../src/storage/git.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = readFileSync(
  path.join(__dirname, '../../src/mcp/local/local-backend.ts'),
  'utf-8',
);
const tempDirs = createTempDirPool('gitnexus-worktree-tool-');

describe('detect_changes worktree support', () => {
  it('statically imports the canonical repo lookup', () => {
    expect(backendSrc).toMatch(
      /^import\s*\{[^}]*getCanonicalRepoRoot[^}]*\}\s*from\s*['"].*storage\/git/m,
    );
    expect(backendSrc).not.toMatch(/await import\(.*storage\/git/);
  });

  it('exposes worktree selection and automatic detection in the tool schema', () => {
    const tool = findToolDefinition('detect_changes');
    expect(tool?.inputSchema.properties?.worktree).toMatchObject({ type: 'string' });
    expect(tool?.description).toContain('automatically detects');
  });
});

describe('detect_changes worktree selection', () => {
  let repoDir: string;
  let backend: LocalBackend;
  const params = { scope: 'unstaged', repo: 'worktree-test' };

  beforeEach(async () => {
    repoDir = tempDirs.dir();
    initGitRepo(repoDir);
    writeFileSync(path.join(repoDir, 'main.ts'), 'export const value = 1;\n');
    commitAll(repoDir, 'initial');
    const storagePath = path.join(repoDir, '.gitnexus');
    mkdirSync(path.join(storagePath, 'lbug'), { recursive: true });
    writeFileSync(path.join(storagePath, 'meta.json'), '{}');
    vi.spyOn(registry, 'listRegisteredRepos').mockResolvedValue([
      {
        name: params.repo,
        path: repoDir,
        storagePath,
        indexedAt: '2026-01-01T00:00:00Z',
        lastCommit: 'abc1234',
      },
    ]);
    vi.spyOn(pool, 'initLbug').mockResolvedValue(false);
    vi.spyOn(pool, 'isLbugReady').mockReturnValue(true);
    vi.spyOn(pool, 'executeParameterized').mockResolvedValue([]);
    backend = new LocalBackend();
    await backend.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await backend?.dispose();
  });

  it('reports the edit only when the explicit path or launch cwd selects the linked worktree', async () => {
    const linked = tempDirs.dir();
    execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(path.join(linked, 'main.ts'), 'export const value = 2;\n');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repoDir);
    expect(await backend.callTool('detect_changes', params)).toMatchObject({
      summary: { changed_count: 0, risk_level: 'none' },
    });
    const expected = { summary: { changed_files: 1 }, unmapped_files: ['main.ts'] };
    expect(await backend.callTool('detect_changes', { ...params, worktree: linked })).toMatchObject(
      expected,
    );
    cwd.mockReturnValue(linked);
    expect(await backend.callTool('detect_changes', params)).toMatchObject(expected);
  });

  it('rejects relative and foreign worktrees and reports an unavailable registered root', async () => {
    const foreign = tempDirs.dir();
    initGitRepo(foreign);
    expect(
      await backend.callTool('detect_changes', { ...params, worktree: 'relative' }),
    ).toMatchObject({
      error: expect.stringContaining('worktree must be an absolute path'),
    });
    expect(
      await backend.callTool('detect_changes', { ...params, worktree: foreign }),
    ).toMatchObject({
      error: expect.stringContaining('is not a worktree of repo'),
    });
    renameSync(path.join(repoDir, '.git'), path.join(repoDir, 'saved-git'));
    expect(
      await backend.callTool('detect_changes', { ...params, worktree: foreign }),
    ).toMatchObject({
      error: expect.stringContaining('Could not determine canonical root for repo'),
    });
  });
});

// ── resolveWorktreeCwd — auto-detection helper (behavioural) ─────────────────
//
// resolveWorktreeCwd is extracted from detectChanges specifically so tests can
// pass any launchCwd instead of being stuck with the fixed process.cwd().

describe('resolveWorktreeCwd — auto-detection helper', () => {
  it('returns repoPath unchanged when launchCwd is the same git root', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-rwc-same-'));
    try {
      execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
      // Compare via realpathSync.native: mkdtempSync may return a symlink path
      // on macOS (/var vs /private/var) or a Windows 8.3 short name
      // (RUNNER~1 vs runneradmin) while getGitRoot returns the expanded form.
      const result = resolveWorktreeCwd(repoDir, repoDir);
      expect(realpathSync.native(result)).toBe(realpathSync.native(repoDir));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns repoPath unchanged when launchCwd is a non-git directory', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-rwc-repo-'));
    const plainDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-rwc-plain-'));
    try {
      execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
      // plainDir has no git repo — no git root found → fall through to repoPath
      const result = resolveWorktreeCwd(repoDir, plainDir);
      expect(result).toBe(repoDir);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('returns worktreeDir when launchCwd is a linked worktree of the same repo', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-rwc-wt-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeDir = path.join(repoDir, 'wt-auto');
      execSync(`git worktree add -q -b auto "${worktreeDir}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });

      // Key assertion: passing the worktree as launchCwd returns it,
      // proving the auto-detect logic in detectChanges works correctly.
      // Use realpathSync.native: mkdtempSync may return a symlink or 8.3
      // short-name path while getGitRoot returns the expanded canonical form.
      const result = resolveWorktreeCwd(repoDir, worktreeDir);
      expect(realpathSync.native(result)).toBe(realpathSync.native(worktreeDir));
      // Confirm it's NOT the canonical root (auto-detection fired).
      expect(realpathSync.native(result)).not.toBe(realpathSync.native(repoDir));
    } finally {
      try {
        execSync('git worktree remove -f wt-auto', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns repoPath when launchCwd belongs to a different (unrelated) repo', () => {
    const repoA = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-rwc-a-'));
    const repoB = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-rwc-b-'));
    try {
      execSync('git init -q', { cwd: repoA, stdio: 'ignore' });
      execSync('git init -q', { cwd: repoB, stdio: 'ignore' });
      // repoB has a different canonical root — guard must reject it.
      const result = resolveWorktreeCwd(repoA, repoB);
      expect(result).toBe(repoA);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });

  it('returns worktreeDir unchanged when repoPath IS a linked worktree and launchCwd is the main checkout', () => {
    // Regression for: detect_changes returns no changes when the MCP server
    // runs from the main checkout but the resolved repo index is a separately-
    // indexed linked worktree (issue #1659 / dpearson2699 report).
    //
    // Before the fix, resolveWorktreeCwd would detect that launchCwd (main
    // checkout) and repoPath (worktree) share the same canonical root and
    // wrongly override repoPath with the main-checkout path, causing git diff
    // to run from the wrong directory and return 0 changes.
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-rwc-idx-wt-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeDir = path.join(repoDir, 'wt-indexed');
      execSync(`git worktree add -q -b indexed "${worktreeDir}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });

      // Simulate: repo registry entry points to the worktree (repoPath = worktreeDir)
      // but the MCP server was launched from the main checkout (launchCwd = repoDir).
      // resolveWorktreeCwd must NOT override the correct worktree path with repoDir.
      const result = resolveWorktreeCwd(worktreeDir, repoDir);
      expect(realpathSync.native(result)).toBe(realpathSync.native(worktreeDir));
      expect(realpathSync.native(result)).not.toBe(realpathSync.native(repoDir));
    } finally {
      try {
        execSync('git worktree remove -f wt-indexed', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns worktreeA unchanged when both repoPath and launchCwd are different linked worktrees of the same repo', () => {
    // Covers: repoPath = wt-A (indexed), launchCwd = wt-B (server launched from another worktree).
    // The guard fires on repoPath being a linked worktree regardless of what launchCwd is,
    // so wt-A must be returned unchanged — not wt-B, not the main checkout.
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-rwc-two-wt-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeA = path.join(repoDir, 'wt-a');
      const worktreeB = path.join(repoDir, 'wt-b');
      execSync(`git worktree add -q -b branch-a "${worktreeA}"`, { cwd: repoDir, stdio: 'ignore' });
      execSync(`git worktree add -q -b branch-b "${worktreeB}"`, { cwd: repoDir, stdio: 'ignore' });

      // repoPath = wt-A (the indexed worktree), launchCwd = wt-B (where the server runs).
      // resolveWorktreeCwd must return wt-A — the indexed path — unchanged.
      const result = resolveWorktreeCwd(worktreeA, worktreeB);
      expect(realpathSync.native(result)).toBe(realpathSync.native(worktreeA));
      expect(realpathSync.native(result)).not.toBe(realpathSync.native(worktreeB));
      expect(realpathSync.native(result)).not.toBe(realpathSync.native(repoDir));
    } finally {
      try {
        execSync('git worktree remove -f wt-a', { cwd: repoDir, stdio: 'ignore' });
        execSync('git worktree remove -f wt-b', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ── Guard logic via real path arithmetic ─────────────────────────────────────

describe('detect_changes worktree support — guard logic', () => {
  it('getCanonicalRepoRoot returns the same root for the main checkout and a sub-path', () => {
    const fromRoot = getCanonicalRepoRoot(path.join(__dirname, '../..'));
    const fromSub = getCanonicalRepoRoot(path.join(__dirname, '../../src'));
    if (fromRoot === null) {
      expect(fromSub).toBeNull();
    } else {
      expect(fromSub).toBe(fromRoot);
    }
  });

  it('getCanonicalRepoRoot returns null for a non-git directory', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-nonrepo-'));
    try {
      expect(getCanonicalRepoRoot(tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('getCanonicalRepoRoot equates a worktree path with the canonical root', () => {
    // This directly exercises the comparison the guard performs:
    // both paths must yield the same canonical root for the guard to pass.
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-guard-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeDir = path.join(repoDir, 'wt-guard');
      execSync(`git worktree add -q -b guard "${worktreeDir}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });

      const fromRepo = getCanonicalRepoRoot(repoDir);
      const fromWorktree = getCanonicalRepoRoot(worktreeDir);

      // Both must be non-null and equal — the guard's passing condition.
      expect(fromRepo).not.toBeNull();
      expect(fromWorktree).toBe(fromRepo);
    } finally {
      try {
        execSync('git worktree remove -f wt-guard', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore cleanup failure
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('getCanonicalRepoRoot returns different roots for two unrelated repos', () => {
    // The guard's rejection condition: roots must NOT match for unrelated repos.
    const repoA = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-repoA-'));
    const repoB = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-repoB-'));
    try {
      execSync('git init -q', { cwd: repoA, stdio: 'ignore' });
      execSync('git init -q', { cwd: repoB, stdio: 'ignore' });
      const rootA = getCanonicalRepoRoot(repoA);
      const rootB = getCanonicalRepoRoot(repoB);
      expect(rootA).not.toBeNull();
      expect(rootB).not.toBeNull();
      expect(rootA).not.toBe(rootB);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});

// ── End-to-end: real git worktree + real git diff ────────────────────────────
//
// These tests prove the core bug scenario without going through LocalBackend:
//   - git diff from the canonical root misses changes in a linked worktree
//   - git diff with cwd set to the worktree correctly finds them
//   - getCanonicalRepoRoot equates canonical root and worktree (guard passes)

describe('detect_changes worktree support — end-to-end with real worktree', () => {
  it('git diff from canonical root misses unstaged changes in a linked worktree, but worktree cwd finds them', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-wt-detect-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'main.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeDir = path.join(repoDir, 'wt-feature');
      execSync(`git worktree add -q -b feature "${worktreeDir}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });

      // Make an unstaged change inside the linked worktree only.
      writeFileSync(path.join(worktreeDir, 'main.ts'), 'export const x = 2;\n');

      // Bug: git diff from canonical root → empty (misses worktree changes).
      const diffFromCanonical = execFileSync('git', ['diff', '-U0'], {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      expect(diffFromCanonical.trim()).toBe('');

      // Fix: git diff with cwd = worktree → finds the change.
      const diffFromWorktree = execFileSync('git', ['diff', '-U0'], {
        cwd: worktreeDir,
        encoding: 'utf-8',
      });
      expect(diffFromWorktree).toContain('main.ts');
      expect(diffFromWorktree).toContain('+export const x = 2;');

      // Guard: getCanonicalRepoRoot equates both paths → guard approves this worktree.
      const canonicalFromRepo = getCanonicalRepoRoot(repoDir);
      const canonicalFromWorktree = getCanonicalRepoRoot(worktreeDir);
      expect(canonicalFromRepo).not.toBeNull();
      expect(canonicalFromWorktree).toBe(canonicalFromRepo);
    } finally {
      try {
        execSync('git worktree remove -f wt-feature', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore on cleanup failure
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('git diff --staged from worktree cwd sees staged changes in that worktree', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-wt-staged-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'foo.ts'), 'export const a = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeDir = path.join(repoDir, 'wt-staged');
      execSync(`git worktree add -q -b staged-branch "${worktreeDir}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });

      // Stage a change inside the linked worktree.
      writeFileSync(path.join(worktreeDir, 'foo.ts'), 'export const a = 99;\n');
      execSync('git add foo.ts', { cwd: worktreeDir, stdio: 'ignore' });

      // Staged diff from canonical root → empty.
      const stagedFromCanonical = execFileSync('git', ['diff', '--staged', '-U0'], {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      expect(stagedFromCanonical.trim()).toBe('');

      // Staged diff from worktree cwd → has output.
      const stagedFromWorktree = execFileSync('git', ['diff', '--staged', '-U0'], {
        cwd: worktreeDir,
        encoding: 'utf-8',
      });
      expect(stagedFromWorktree).toContain('foo.ts');
      expect(stagedFromWorktree).toContain('+export const a = 99;');
    } finally {
      try {
        execSync('git worktree remove -f wt-staged', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
