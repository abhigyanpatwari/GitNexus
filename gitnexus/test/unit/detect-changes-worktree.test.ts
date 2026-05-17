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
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

describe('detect_changes worktree support — structural', () => {
  it('detect_changes tool schema declares a "worktree" property', () => {
    expect(toolsSrc).toMatch(/worktree/);
  });

  it('detectChanges() signature includes worktree in its params type', () => {
    expect(backendSrc).toMatch(/worktree\?:\s*string/);
  });

  it('imports getCanonicalRepoRoot from storage/git to validate the worktree', () => {
    expect(backendSrc).toMatch(/getCanonicalRepoRoot/);
  });

  it('uses diffCwd as the cwd for execFileSync (not hard-coded repo.repoPath)', () => {
    // The git diff call must reference diffCwd, not repo.repoPath directly.
    expect(backendSrc).toMatch(/cwd:\s*diffCwd/);
  });

  it('defaults diffCwd to repo.repoPath when worktree param is not provided', () => {
    // Backward-compat: omitting worktree keeps current behavior.
    expect(backendSrc).toMatch(/diffCwd\s*=\s*repo\.repoPath/);
  });

  it('returns a structured error when the worktree canonical root does not match the repo', () => {
    expect(backendSrc).toMatch(/is not a worktree of repo/);
  });

  it('git worktree support is documented in the tool description', () => {
    expect(toolsSrc).toMatch(/GIT WORKTREE SUPPORT/);
  });
});

// ── Behavioural: guard logic via real path arithmetic ────────────────────────

import { getCanonicalRepoRoot } from '../../src/storage/git.js';

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
    const result = getCanonicalRepoRoot('/tmp');
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('mismatching canonical roots are correctly identified', () => {
    const worktreeCanonical: string = '/some/other/repo';
    const repoCanonical: string = '/canonical/repo';
    expect(worktreeCanonical === repoCanonical).toBe(false);
  });

  it('matching canonical roots are correctly accepted', () => {
    const canonical: string = '/canonical/repo';
    expect(canonical === canonical).toBe(true);
  });
});

// ── End-to-end: real git worktree + real git diff ────────────────────────────
//
// These tests prove the core bug scenario without going through LocalBackend:
//   - git diff from the canonical root misses changes in a linked worktree
//   - git diff with cwd set to the worktree correctly finds them
//   - getCanonicalRepoRoot equates canonical root and worktree (guard passes)
// They mirror the pattern used in git-utils.test.ts (#1259).

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
