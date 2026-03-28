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
