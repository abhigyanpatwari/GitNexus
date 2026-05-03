/**
 * Unit Tests: git utility helpers (storage/git.ts)
 *
 * Tests isGitRepo, getCurrentCommit, getGitRoot, and the newly added
 * hasGitDir helper introduced for issue #384 (indexing non-git folders).
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';

// ─── hasGitDir ────────────────────────────────────────────────────────────
//
// hasGitDir is a synchronous fs.statSync check — we test it by actually
// creating temporary directories rather than mocking the fs module,
// because the implementation is a simple one-liner and real disk I/O is
// fast and deterministic for this purpose.

describe('hasGitDir', () => {
  // Import after test setup to ensure module resolution is correct
  const getHasGitDir = async () => {
    const mod = await import('../../src/storage/git.js');
    return mod.hasGitDir;
  };

  it('returns true when .git directory exists', async () => {
    const hasGitDir = await getHasGitDir();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.git'));
      expect(hasGitDir(tmpDir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns true when .git is a file (git worktree)', async () => {
    const hasGitDir = await getHasGitDir();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '.git'), 'gitdir: /some/other/.git\n');
      expect(hasGitDir(tmpDir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns false when .git entry is absent', async () => {
    const hasGitDir = await getHasGitDir();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    try {
      // No .git here — plain directory
      expect(hasGitDir(tmpDir)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns false for a non-existent path', async () => {
    const hasGitDir = await getHasGitDir();
    expect(hasGitDir('/tmp/__gitnexus_nonexistent_path__')).toBe(false);
  });
});

// ─── isGitRepo ────────────────────────────────────────────────────────────
//
// isGitRepo shells out to `git rev-parse` — we verify it returns false
// for a plain temp directory without running git init.

describe('isGitRepo', () => {
  it('returns false for a plain (non-git) directory', async () => {
    const { isGitRepo } = await import('../../src/storage/git.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    try {
      expect(isGitRepo(tmpDir)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns false for a non-existent path', async () => {
    const { isGitRepo } = await import('../../src/storage/git.js');
    expect(isGitRepo('/tmp/__gitnexus_nonexistent__')).toBe(false);
  });
});

// ─── getCurrentCommit ─────────────────────────────────────────────────────

describe('getCurrentCommit', () => {
  it('returns empty string for a non-git directory', async () => {
    const { getCurrentCommit } = await import('../../src/storage/git.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    try {
      expect(getCurrentCommit(tmpDir)).toBe('');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── getGitRoot ───────────────────────────────────────────────────────────

describe('getGitRoot', () => {
  it('returns null for a plain temp directory', async () => {
    const { getGitRoot } = await import('../../src/storage/git.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    try {
      expect(getGitRoot(tmpDir)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── getRemoteUrl ─────────────────────────────────────────────────────────

describe('getRemoteUrl', () => {
  const setupRepoWithRemote = (remoteUrl: string): string => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-remote-'));
    // Use real fs paths and shellouts — the helper itself shells out to
    // `git config`, so we need a real git repo for the assertion to be
    // meaningful.
    execSync('git init -q', { cwd: tmpDir });
    execSync(`git remote add origin ${remoteUrl}`, { cwd: tmpDir });
    return tmpDir;
  };

  it('returns undefined for a non-git directory', async () => {
    const { getRemoteUrl } = await import('../../src/storage/git.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    try {
      expect(getRemoteUrl(tmpDir)).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns undefined for a git repo with no origin remote', async () => {
    const { getRemoteUrl } = await import('../../src/storage/git.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    try {
      execSync('git init -q', { cwd: tmpDir });
      expect(getRemoteUrl(tmpDir)).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('strips trailing .git and lowercases host for HTTPS remotes', async () => {
    const { getRemoteUrl } = await import('../../src/storage/git.js');
    const tmpDir = setupRepoWithRemote('https://GitHub.COM/Foo/Bar.git');
    try {
      expect(getRemoteUrl(tmpDir)).toBe('https://github.com/Foo/Bar');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lowercases host for SCP-style SSH remotes and strips .git', async () => {
    const { getRemoteUrl } = await import('../../src/storage/git.js');
    const tmpDir = setupRepoWithRemote('git@GitHub.com:Foo/Bar.git');
    try {
      expect(getRemoteUrl(tmpDir)).toBe('git@github.com:Foo/Bar');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns the same fingerprint for two clones of the same repo', async () => {
    const { getRemoteUrl } = await import('../../src/storage/git.js');
    const a = setupRepoWithRemote('https://example.com/foo/bar.git');
    const b = setupRepoWithRemote('https://example.com/foo/bar');
    try {
      expect(getRemoteUrl(a)).toBe(getRemoteUrl(b));
      expect(getRemoteUrl(a)).toBeTruthy();
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

// ─── getCanonicalRepoRoot (#1259) ────────────────────────────────────────
//
// Critical for the worktree-naming bug: when `gitnexus analyze` runs from a
// linked worktree, deriving `repoName` from `path.basename(getGitRoot(cwd))`
// uses the worktree's directory slug instead of the canonical repo's
// basename. `getCanonicalRepoRoot` exists specifically to dereference
// worktrees via `git rev-parse --git-common-dir`.

describe('getCanonicalRepoRoot', () => {
  it('returns null for a plain temp directory (not a git repo)', async () => {
    const { getCanonicalRepoRoot } = await import('../../src/storage/git.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-canonical-'));
    try {
      expect(getCanonicalRepoRoot(tmpDir)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns null for a non-existent path', async () => {
    const { getCanonicalRepoRoot } = await import('../../src/storage/git.js');
    expect(getCanonicalRepoRoot('/tmp/__gitnexus_canonical_nonexistent__')).toBeNull();
  });

  it('returns the repo root when called from a regular (non-worktree) checkout', async () => {
    const { getCanonicalRepoRoot } = await import('../../src/storage/git.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-canonical-main-'));
    try {
      execSync('git init -q', { cwd: tmpDir });
      // realpath because macOS symlinks `/var/folders/...` to
      // `/private/var/folders/...`; git resolves to the canonical form,
      // and so should the test expectation.
      const repoRoot = fs.realpathSync(tmpDir);
      expect(getCanonicalRepoRoot(tmpDir)).toBe(repoRoot);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns the CANONICAL repo root when called from inside a linked worktree (#1259)', async () => {
    const { getCanonicalRepoRoot, getGitRoot } = await import('../../src/storage/git.js');
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-canonical-wt-'));
    try {
      execSync('git init -q', { cwd: repoDir });
      // `git worktree add` requires at least one commit on a real branch.
      execSync('git config user.email "test@example.com"', { cwd: repoDir });
      execSync('git config user.name "Test"', { cwd: repoDir });
      execSync('git commit --allow-empty -q -m "initial"', { cwd: repoDir });
      // Create a linked worktree on a new branch outside the main checkout.
      const worktreeDir = path.join(repoDir, 'wt-feature');
      execSync(`git worktree add -q -b feature "${worktreeDir}"`, { cwd: repoDir });

      const canonical = fs.realpathSync(repoDir);

      // From the main checkout: canonical and getGitRoot agree.
      expect(getCanonicalRepoRoot(repoDir)).toBe(canonical);

      // From inside the worktree: canonical points BACK to the main repo,
      // while `getGitRoot` (correctly) points at the worktree's own root.
      // This asymmetry is exactly what fixes #1259 — the registry name
      // derivation now collapses across worktrees.
      const fromWorktree = getCanonicalRepoRoot(worktreeDir);
      expect(fromWorktree).toBe(canonical);
      expect(fromWorktree).not.toBe(fs.realpathSync(worktreeDir));
      // Sanity: getGitRoot returns the worktree-local root (existing
      // behavior unchanged).
      expect(getGitRoot(worktreeDir)).toBe(fs.realpathSync(worktreeDir));
    } finally {
      // Best-effort cleanup; worktree teardown can leak open handles on
      // Windows so use force.
      try {
        execSync('git worktree remove -f wt-feature', { cwd: repoDir });
      } catch {
        // ignore — fall through to recursive rm
      }
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
