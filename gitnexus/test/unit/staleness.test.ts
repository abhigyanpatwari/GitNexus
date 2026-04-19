/**
 * P2 Unit Tests: Staleness Check
 *
 * Tests: checkStaleness from staleness.ts
 * - HEAD matches → not stale
 * - HEAD differs → stale with commit count
 * - Git failure → fail open (not stale)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkStaleness, isGeneratedIndexPath } from '../../src/core/git-staleness.js';

// We test checkStaleness with a real git repo (the project itself)
// since mocking execFileSync across ESM modules is complex.

describe('checkStaleness', () => {
  it('returns not stale when HEAD matches lastCommit', () => {
    // Get the actual HEAD commit of this repo
    let headCommit: string;
    try {
      headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // If we can't get HEAD (e.g., not in a git repo), skip
      return;
    }

    const result = checkStaleness(process.cwd(), headCommit);
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.hint).toBeUndefined();
  });

  it('returns stale when lastCommit is behind HEAD', () => {
    // Use HEAD~1 — works in shallow clones (GitHub Actions) unlike rev-list --max-parents=0
    let previousCommit: string;
    try {
      previousCommit = execFileSync('git', ['rev-parse', 'HEAD~1'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return; // Not in a git repo or only 1 commit
    }

    if (!previousCommit) return;

    const result = checkStaleness(process.cwd(), previousCommit);
    expect(result.isStale).toBe(true);
    expect(result.commitsBehind).toBeGreaterThan(0);
    expect(result.hint).toContain('behind HEAD');
  });

  it('fails open when git command fails (e.g., invalid path)', () => {
    const result = checkStaleness('/nonexistent/path', 'abc123');
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });

  it('fails open with invalid commit hash', () => {
    const result = checkStaleness(process.cwd(), 'not-a-real-commit-hash');
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });

  it('treats commits containing only generated GitNexus artifacts as fresh', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-staleness-'));
    try {
      execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });

      fs.writeFileSync(path.join(repoPath, 'src.ts'), 'export const value = 1;\n');
      execFileSync('git', ['add', 'src.ts'], { cwd: repoPath });
      execFileSync('git', ['commit', '-m', 'source'], { cwd: repoPath, stdio: 'ignore' });
      const indexedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim();

      fs.mkdirSync(path.join(repoPath, '.gitnexus'), { recursive: true });
      fs.writeFileSync(path.join(repoPath, '.gitnexus', 'meta.json'), '{}\n');
      fs.writeFileSync(path.join(repoPath, 'AGENTS.md'), '# GitNexus\n');
      execFileSync('git', ['add', '.gitnexus/meta.json', 'AGENTS.md'], { cwd: repoPath });
      execFileSync('git', ['commit', '-m', 'index artifacts'], { cwd: repoPath, stdio: 'ignore' });

      const result = checkStaleness(repoPath, indexedCommit);
      expect(result.isStale).toBe(false);
      expect(result.artifactOnly).toBe(true);
      expect(result.commitsBehind).toBe(1);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('still treats source changes after the indexed commit as stale', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-staleness-'));
    try {
      execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });

      fs.writeFileSync(path.join(repoPath, 'src.ts'), 'export const value = 1;\n');
      execFileSync('git', ['add', 'src.ts'], { cwd: repoPath });
      execFileSync('git', ['commit', '-m', 'source'], { cwd: repoPath, stdio: 'ignore' });
      const indexedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim();

      fs.writeFileSync(path.join(repoPath, 'src.ts'), 'export const value = 2;\n');
      execFileSync('git', ['add', 'src.ts'], { cwd: repoPath });
      execFileSync('git', ['commit', '-m', 'source change'], { cwd: repoPath, stdio: 'ignore' });

      const result = checkStaleness(repoPath, indexedCommit);
      expect(result.isStale).toBe(true);
      expect(result.artifactOnly).toBeUndefined();
      expect(result.changedFiles).toContain('src.ts');
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('recognizes generated index paths', () => {
    expect(isGeneratedIndexPath('.gitnexus/meta.json')).toBe(true);
    expect(isGeneratedIndexPath('AGENTS.md')).toBe(true);
    expect(isGeneratedIndexPath('CLAUDE.md')).toBe(true);
    expect(isGeneratedIndexPath('.claude/skills/gitnexus/gitnexus-cli/SKILL.md')).toBe(true);
    expect(isGeneratedIndexPath('src/app.ts')).toBe(false);
  });
});
