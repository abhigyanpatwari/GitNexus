/**
 * P2 Unit Tests: Staleness Check
 *
 * Tests: checkStaleness from staleness.ts
 * - HEAD matches → not stale
 * - HEAD differs → stale with commit count
 * - Git failure → fail open (not stale)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import {
  checkStaleness,
  checkStalenessAsync,
  type StalenessInfo,
} from '../../src/core/git-staleness.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

// ── #3256: the additive `status` channel ─────────────────────────────────────
//
// The fail-open tests above pin `isStale` / `commitsBehind` and are unchanged.
// These pin `status`, which separates "could not tell" from "fresh". They build
// their own repositories rather than leaning on this checkout, so every answer
// is exact in a shallow CI clone too.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();

const commit = (repo: string, text: string): string => {
  writeFileSync(join(repo, 'a.txt'), `${text}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', text);
  return git(repo, 'rev-parse', 'HEAD');
};

/** A repository with three commits. */
const makeRepo = (root: string, name: string) => {
  const repo = join(root, name);
  git(root, 'init', '-q', '--initial-branch=main', repo);
  const c1 = commit(repo, 'c1');
  const c2 = commit(repo, 'c2');
  const c3 = commit(repo, 'c3');
  return { repo, c1, c2, c3 };
};

const removeTree = (dir: string) =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

const bothHelpers: Record<
  string,
  (repoPath: string, lastCommit: string) => Promise<StalenessInfo>
> = {
  checkStaleness: async (repoPath, lastCommit) => checkStaleness(repoPath, lastCommit),
  checkStalenessAsync,
};

describe('staleness status (#3256)', () => {
  let root: string;
  let fixture: ReturnType<typeof makeRepo>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'gitnexus-staleness-'));
    fixture = makeRepo(root, 'repo');
  });
  afterAll(() => removeTree(root));

  for (const [name, check] of Object.entries(bothHelpers)) {
    describe(name, () => {
      it('reports current when the index is at HEAD', async () => {
        expect(await check(fixture.repo, fixture.c3)).toMatchObject({
          status: 'current',
          isStale: false,
          commitsBehind: 0,
        });
      });

      it('reports behind with the counted gap', async () => {
        expect(await check(fixture.repo, fixture.c1)).toMatchObject({
          status: 'behind',
          isStale: true,
          commitsBehind: 2,
        });
      });

      it('reports diverged, not current, when the recorded commit is not in history', async () => {
        const result = await check(fixture.repo, '0000000000000000000000000000000000000abc');
        expect(result.status).toBe('diverged');
        // The hint claims only the uncountable gap, not that the commit left
        // history — every other `rev-list` failure reaches the same branch.
        expect(result.hint).toContain('could not be counted');
        // The fail-open values the tests above pin are unchanged.
        expect(result).toMatchObject({ isStale: false, commitsBehind: 0 });
      });

      it('reports unknown when the path is not a git repository', async () => {
        const notGit = mkdtempSync(join(root, 'not-git-'));
        expect(await check(notGit, fixture.c3)).toMatchObject({
          status: 'unknown',
          isStale: false,
          commitsBehind: 0,
        });
      });

      it('reports unknown when no commit was recorded', async () => {
        expect(await check(fixture.repo, '')).toMatchObject({
          status: 'unknown',
          isStale: false,
          commitsBehind: 0,
        });
      });
    });
  }
});

describe('branch-pinned serve clone once git prunes the indexed commit (#3256)', () => {
  // The pinned update is `fetch --depth 1` + `checkout -B`
  // (fetchAndCheckoutRequestedBranch in server/git-clone.ts). It re-shallows at
  // the new tip, which orphans the indexed commit. While the HEAD reflog holds
  // that commit, rev-list still counts; once the reflog entry expires and gc
  // prunes it, rev-list cannot answer at all.
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitnexus-staleness-shallow-'));
  });
  afterEach(() => removeTree(root));

  /** A depth-1 clone whose upstream has since moved on by one commit. */
  const shallowCloneBehindUpstream = () => {
    const upstream = makeRepo(root, 'upstream');
    const clone = join(root, 'clone');
    git(
      root,
      '-c',
      'protocol.file.allow=always',
      'clone',
      '-q',
      '--depth',
      '1',
      pathToFileURL(upstream.repo).href,
      clone,
    );
    const indexed = git(clone, 'rev-parse', 'HEAD');
    commit(upstream.repo, 'c4'); // the re-index that pulls this is the one that fails
    return { clone, indexed };
  };

  const expireAndPrune = (clone: string) => {
    git(clone, 'reflog', 'expire', '--expire-unreachable=now', '--all');
    git(clone, 'gc', '-q', '--prune=now');
  };

  it('reports diverged instead of fresh once the orphaned commit is pruned', async () => {
    const { clone, indexed } = shallowCloneBehindUpstream();
    git(
      clone,
      'fetch',
      '-q',
      '--depth',
      '1',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    );
    git(clone, 'checkout', '-q', '-B', 'main', 'origin/main');

    // Countable while the reflog still holds the indexed commit.
    expect(await checkStalenessAsync(clone, indexed)).toMatchObject({
      status: 'behind',
      commitsBehind: 1,
    });

    expireAndPrune(clone);

    // Before #3256 this read as `{ isStale: false, commitsBehind: 0 }`, with
    // nothing to tell it apart from an index that is genuinely current.
    expect(await checkStalenessAsync(clone, indexed)).toMatchObject({
      status: 'diverged',
      isStale: false,
    });
    expect(checkStaleness(clone, indexed).status).toBe('diverged');
  });

  it('keeps an unpinned pull --ff-only clone countable after gc', async () => {
    // The unpinned update keeps the indexed commit reachable as HEAD's parent,
    // so gc never prunes it and the count survives.
    const { clone, indexed } = shallowCloneBehindUpstream();
    git(clone, 'pull', '-q', '--ff-only');
    expireAndPrune(clone);

    expect(await checkStalenessAsync(clone, indexed)).toMatchObject({
      status: 'behind',
      isStale: true,
      commitsBehind: 1,
    });
  });
});
