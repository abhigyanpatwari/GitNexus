/**
 * Unit Tests: Staleness Check
 *
 * Uses temporary git repositories for deterministic staleness behavior.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { checkStaleness } from '../../src/mcp/staleness.js';

const initRepo = async (prefix: string): Promise<string> => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'GitNexus Test'], { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
  return repoPath;
};

const commitAll = (repoPath: string, message: string): string => {
  execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', message], { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
};

describe('checkStaleness', () => {
  it('returns not stale when HEAD matches lastCommit', async () => {
    const repoPath = await initRepo('gn-stale-match-');
    try {
      await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const ok = true;\n');
      const headCommit = commitAll(repoPath, 'initial');

      const result = checkStaleness(repoPath, headCommit);
      expect(result.isStale).toBe(false);
      expect(result.commitsBehind).toBe(0);
      expect(result.hint).toBeUndefined();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('returns stale when relevant files changed', async () => {
    const repoPath = await initRepo('gn-stale-relevant-');
    try {
      await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const version = 1;\n');
      const previousCommit = commitAll(repoPath, 'initial');

      await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const version = 2;\n');
      commitAll(repoPath, 'source change');

      const result = checkStaleness(repoPath, previousCommit);
      expect(result.isStale).toBe(true);
      expect(result.commitsBehind).toBeGreaterThan(0);
      expect(result.changedFiles).toBeGreaterThan(0);
      expect(result.hint).toContain('relevant file change');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('treats ignored artifact-only changes as up-to-date', async () => {
    const repoPath = await initRepo('gn-stale-ignored-');
    try {
      await fs.mkdir(path.join(repoPath, 'dist'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'dist', 'bundle.min.js'), 'console.log(1);\n');
      const previousCommit = commitAll(repoPath, 'initial');

      await fs.writeFile(path.join(repoPath, 'dist', 'bundle.min.js'), 'console.log(2);\n');
      commitAll(repoPath, 'artifact-only update');

      const result = checkStaleness(repoPath, previousCommit);
      expect(result.isStale).toBe(false);
      expect(result.commitsBehind).toBe(0);
      expect(result.ignoredOnlyChanges).toBe(true);
      expect(result.hint).toContain('ignored paths');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('marks index stale when ignore rules change between commits', async () => {
    const repoPath = await initRepo('gn-stale-ignore-rules-');
    try {
      await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const version = 1;\n');
      await fs.writeFile(path.join(repoPath, '.gitignore'), 'dist/\n');
      const previousCommit = commitAll(repoPath, 'initial');

      await fs.writeFile(path.join(repoPath, '.gitignore'), 'dist/\n!dist/keep.ts\n');
      commitAll(repoPath, 'update ignore rules');

      const result = checkStaleness(repoPath, previousCommit);
      expect(result.isStale).toBe(true);
      expect(result.commitsBehind).toBeGreaterThan(0);
      expect(result.ignoreRulesChanged).toBe(true);
      expect(result.hint).toContain('ignore rules changed');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('respects custom ignore file options', async () => {
    const repoPath = await initRepo('gn-stale-custom-ignore-');
    try {
      await fs.mkdir(path.join(repoPath, 'docs', 'focused-only'), { recursive: true });
      await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const x = 1;\n');
      await fs.writeFile(path.join(repoPath, '.gitnexusignore.focused'), 'docs/focused-only/\n');
      const previousCommit = commitAll(repoPath, 'initial');

      await fs.writeFile(path.join(repoPath, 'docs', 'focused-only', 'artifact.md'), '# generated\n');
      commitAll(repoPath, 'generated docs change');

      const defaultResult = checkStaleness(repoPath, previousCommit);
      expect(defaultResult.isStale).toBe(true);

      const focusedResult = checkStaleness(repoPath, previousCommit, { ignoreFile: '.gitnexusignore.focused' });
      expect(focusedResult.isStale).toBe(false);
      expect(focusedResult.ignoredOnlyChanges).toBe(true);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('fails open when git command fails (invalid path)', () => {
    const result = checkStaleness('/nonexistent/path', 'abc123');
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });
});
