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
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = readFileSync(
  path.join(__dirname, '../../src/mcp/local/local-backend.ts'),
  'utf-8',
);
const toolsSrc = readFileSync(path.join(__dirname, '../../src/mcp/tools.ts'), 'utf-8');

// ── Structural tests (source-grep) ───────────────────────────────────────────
//
// NOTE: These grep the source as plain text and verify that key patterns are
// present. They are a useful backstop to catch accidental regressions (e.g.
// someone moves the import back to a dynamic one, or removes the error
// messages). They do NOT prove the guards work correctly at runtime — that is
// what the E2E real-worktree tests below are for.

describe('detect_changes worktree support — structural', () => {
  it('getCanonicalRepoRoot is statically imported from storage/git (not dynamic)', () => {
    // Must be a top-level static import, not a dynamic await import inside the function.
    expect(backendSrc).toMatch(
      /^import\s*\{[^}]*getCanonicalRepoRoot[^}]*\}\s*from\s*['"].*storage\/git/m,
    );
    // Confirm the dynamic import is gone.
    expect(backendSrc).not.toMatch(/await import\(.*storage\/git/);
  });

  it('detect_changes tool schema declares a "worktree" property', () => {
    expect(toolsSrc).toMatch(/worktree/);
  });

  it('detectChanges() signature includes worktree in its params type', () => {
    expect(backendSrc).toMatch(/worktree\?:\s*string/);
  });

  it('uses diffCwd as the cwd for execFileSync (not hard-coded repo.repoPath)', () => {
    expect(backendSrc).toMatch(/cwd:\s*diffCwd/);
  });

  it('defaults diffCwd via resolveWorktreeCwd (falls back to repo.repoPath internally)', () => {
    // diffCwd is now initialised directly from resolveWorktreeCwd, which
    // returns repo.repoPath when no linked worktree is detected. The old
    // dead `let diffCwd = repo.repoPath` was removed to fix CodeQL
    // "useless assignment to local variable".
    expect(backendSrc).toMatch(/let diffCwd\s*=\s*resolveWorktreeCwd\(/);
  });

  it('rejects relative paths with an absolute-path error', () => {
    expect(backendSrc).toMatch(/worktree must be an absolute path/);
  });

  it('returns a distinct error when git is unavailable (null repoCanonical)', () => {
    expect(backendSrc).toMatch(/Could not determine canonical root for repo/);
  });

  it('returns a mismatch error when the worktree belongs to a different repo', () => {
    expect(backendSrc).toMatch(/is not a worktree of repo/);
  });

  it('explicit params.worktree is wired through to execFileSync cwd', () => {
    // A full callTool() integration test requires a live LadybugDB; instead
    // we verify the wiring via two complementary structural assertions that
    // would both need to be wrong simultaneously to hide a real bug:
    //   1. The validated explicit path is stored in diffCwd.
    //   2. diffCwd is the value passed to execFileSync as cwd.
    // If either assignment were swapped back to repo.repoPath the tests in
    // this file would immediately fail.
    expect(backendSrc).toMatch(/diffCwd\s*=\s*providedResolved/);
    // Also verify canonical roots are compared via tryRealpath (Finding 3).
    expect(backendSrc).toMatch(
      /tryRealpath\(worktreeCanonical\)\s*!==\s*tryRealpath\(repoCanonical\)/,
    );
  });

  it('auto-detects linked worktree via process.cwd() when worktree param is omitted', () => {
    // The else branch must delegate to the exported resolveWorktreeCwd helper.
    expect(backendSrc).toMatch(/resolveWorktreeCwd/);
    // The helper must be exported so tests can call it directly.
    expect(backendSrc).toMatch(/export function resolveWorktreeCwd/);
    // detectChanges passes process.cwd() to the helper.
    expect(backendSrc).toMatch(/resolveWorktreeCwd\(repo\.repoPath,\s*process\.cwd\(\)\)/);
  });

  it('git worktree support is documented in the tool description', () => {
    expect(toolsSrc).toMatch(/GIT WORKTREE SUPPORT/);
    // Auto-detection is the primary path now.
    expect(toolsSrc).toMatch(/automatically detects/);
  });
});

// ── resolveWorktreeCwd — auto-detection helper (behavioural) ─────────────────
//
// resolveWorktreeCwd is extracted from detectChanges specifically so tests can
// pass any launchCwd instead of being stuck with the fixed process.cwd().

import { resolveWorktreeCwd } from '../../src/mcp/local/local-backend.js';
import { getCanonicalRepoRoot } from '../../src/storage/git.js';

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
      execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'ignore' });
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      execSync('git add x.ts', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -q -m "initial"', { cwd: repoDir, stdio: 'ignore' });

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
      execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'ignore' });
      writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 1;\n');
      execSync('git add a.ts', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -q -m "initial"', { cwd: repoDir, stdio: 'ignore' });

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
      execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'ignore' });
      writeFileSync(path.join(repoDir, 'main.ts'), 'export const x = 1;\n');
      execSync('git add main.ts', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -q -m "initial"', { cwd: repoDir, stdio: 'ignore' });

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
      execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'ignore' });
      writeFileSync(path.join(repoDir, 'foo.ts'), 'export const a = 1;\n');
      execSync('git add foo.ts', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -q -m "initial"', { cwd: repoDir, stdio: 'ignore' });

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
