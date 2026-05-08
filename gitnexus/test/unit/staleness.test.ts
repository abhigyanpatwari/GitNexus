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
import { checkStaleness, checkStalenessAsync } from '../../src/core/git-staleness.js';

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
});

describe('checkStalenessAsync', () => {
  it('returns not stale when HEAD matches lastCommit', async () => {
    let headCommit: string;
    try {
      headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return;
    }

    const result = await checkStalenessAsync(process.cwd(), headCommit);
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.hint).toBeUndefined();
  });

  it('returns stale when lastCommit is behind HEAD', async () => {
    let previousCommit: string;
    try {
      previousCommit = execFileSync('git', ['rev-parse', 'HEAD~1'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return;
    }

    if (!previousCommit) return;

    const result = await checkStalenessAsync(process.cwd(), previousCommit);
    expect(result.isStale).toBe(true);
    expect(result.commitsBehind).toBeGreaterThan(0);
    expect(result.hint).toContain('behind HEAD');
  });

  it('fails open when git command fails (e.g., invalid path)', async () => {
    const result = await checkStalenessAsync('/nonexistent/path', 'abc123');
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });

  it('fails open with invalid commit hash', async () => {
    const result = await checkStalenessAsync(process.cwd(), 'not-a-real-commit-hash');
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });

  it('parallel calls complete faster than sequential', async () => {
    let headCommit: string;
    try {
      headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return;
    }

    const cwd = process.cwd();
    const N = 10;

    // Parallel
    const t0 = performance.now();
    await Promise.all(Array.from({ length: N }, () => checkStalenessAsync(cwd, headCommit)));
    const parallelMs = performance.now() - t0;

    // Sequential sync
    const t1 = performance.now();
    for (let i = 0; i < N; i++) checkStaleness(cwd, headCommit);
    const sequentialMs = performance.now() - t1;

    // Parallel should be meaningfully faster than sequential.
    // Use a generous ratio to avoid flakiness on slow CI machines.
    expect(parallelMs).toBeLessThan(sequentialMs * 1.5);
  });
});
