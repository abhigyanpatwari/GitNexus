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
import { readFileSync, mkdtempSync, rmSync, realpathSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { findToolDefinition } from '../../src/mcp/tools.js';
import { resolveWorktreeCwd } from '../../src/mcp/local/local-backend.js';
import { getCanonicalRepoRoot } from '../../src/storage/git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = readFileSync(
  path.join(__dirname, '../../src/mcp/local/local-backend.ts'),
  'utf-8',
);

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
