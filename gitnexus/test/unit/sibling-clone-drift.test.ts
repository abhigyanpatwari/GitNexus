/**
 * Unit tests: sibling-clone drift detection.
 *
 * Issue: a single absolute `repoPath` per registry entry causes silent
 * graph drift when the same logical repo lives at multiple on-disk
 * paths (worktrees, multi-agent workspaces, etc.). We persist a
 * canonical `remoteUrl` at index time and use it to:
 *   - find sibling clones registered under different paths
 *   - detect when the caller's `cwd` is in a sibling clone whose HEAD
 *     has drifted from the indexed `lastCommit`
 *
 * These tests cover the persistence + helpers; the LocalBackend
 * stderr-warning side-effect is exercised end-to-end via the same
 * `checkCwdMatch` API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { execSync } from 'child_process';
import {
  registerRepo,
  readRegistry,
  findSiblingClones,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { checkCwdMatch } from '../../src/core/git-staleness.js';
import { createTempDir } from '../helpers/test-db.js';

const initRepoWithCommit = (dir: string, remoteUrl?: string): string => {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  execSync('git commit --allow-empty -q -m initial', { cwd: dir });
  if (remoteUrl) execSync(`git remote add origin ${remoteUrl}`, { cwd: dir });
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
};

describe('registry persists remoteUrl', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-sibling-home-');
    tmpRepo = await createTempDir('gitnexus-sibling-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
    await tmpRepo.cleanup();
  });

  it('round-trips remoteUrl from RepoMeta into the registry', async () => {
    const meta: RepoMeta = {
      repoPath: tmpRepo.dbPath,
      lastCommit: 'abc123',
      indexedAt: new Date().toISOString(),
      remoteUrl: 'https://example.com/foo/bar',
    };
    await registerRepo(tmpRepo.dbPath, meta);
    const entries = await readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0].remoteUrl).toBe('https://example.com/foo/bar');
  });

  it('omits remoteUrl from registry when meta has none (back-compat)', async () => {
    const meta: RepoMeta = {
      repoPath: tmpRepo.dbPath,
      lastCommit: 'abc123',
      indexedAt: new Date().toISOString(),
    };
    await registerRepo(tmpRepo.dbPath, meta);
    const entries = await readRegistry();
    expect(entries[0].remoteUrl).toBeUndefined();
  });
});

describe('findSiblingClones', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-sibling-find-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  it('returns other registered entries with the same remoteUrl', async () => {
    const a = await createTempDir('clone-a-');
    const b = await createTempDir('clone-b-');
    const c = await createTempDir('clone-c-');
    try {
      const remote = 'https://example.com/foo/bar';
      const baseMeta = {
        lastCommit: 'x',
        indexedAt: new Date().toISOString(),
      };
      await registerRepo(a.dbPath, { ...baseMeta, repoPath: a.dbPath, remoteUrl: remote });
      await registerRepo(b.dbPath, { ...baseMeta, repoPath: b.dbPath, remoteUrl: remote });
      await registerRepo(c.dbPath, {
        ...baseMeta,
        repoPath: c.dbPath,
        remoteUrl: 'https://example.com/other/repo',
      });

      const siblings = await findSiblingClones(remote, a.dbPath);
      expect(siblings.map((s) => s.path).sort()).toEqual([path.resolve(b.dbPath)]);
    } finally {
      await a.cleanup();
      await b.cleanup();
      await c.cleanup();
    }
  });

  it('returns [] when remoteUrl is undefined (no fingerprint to match)', async () => {
    const a = await createTempDir('clone-a-');
    try {
      await registerRepo(a.dbPath, {
        repoPath: a.dbPath,
        lastCommit: 'x',
        indexedAt: new Date().toISOString(),
      });
      const siblings = await findSiblingClones(undefined, a.dbPath);
      expect(siblings).toEqual([]);
    } finally {
      await a.cleanup();
    }
  });
});

describe('checkCwdMatch', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-cwd-match-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  it('returns match=path when cwd is inside the registered entry', async () => {
    const repo = await createTempDir('cwd-repo-');
    try {
      const head = initRepoWithCommit(repo.dbPath, 'https://example.com/foo/bar');
      await registerRepo(repo.dbPath, {
        repoPath: repo.dbPath,
        lastCommit: head,
        indexedAt: new Date().toISOString(),
        remoteUrl: 'https://example.com/foo/bar',
      });
      const m = await checkCwdMatch(repo.dbPath);
      expect(m.match).toBe('path');
      expect(m.entry?.path).toBe(path.resolve(repo.dbPath));
    } finally {
      await repo.cleanup();
    }
  });

  it('detects sibling-by-remote when sibling HEAD differs from indexed commit', async () => {
    const indexed = await createTempDir('cwd-indexed-');
    const sibling = await createTempDir('cwd-sibling-');
    try {
      const remote = 'https://example.com/foo/bar';
      const indexedHead = initRepoWithCommit(indexed.dbPath, remote);
      // Sibling is a separate `git init` with the same remote URL —
      // that's enough for the remote-URL-based fingerprint to match.
      // Use a distinct commit message so the sibling's SHA cannot
      // coincidentally collide with the indexed one even when both
      // commits land in the same second.
      execSync('git init -q', { cwd: sibling.dbPath });
      execSync('git config user.email test@example.com', { cwd: sibling.dbPath });
      execSync('git config user.name test', { cwd: sibling.dbPath });
      execSync('git commit --allow-empty -q -m sibling-distinct', { cwd: sibling.dbPath });
      execSync(`git remote add origin ${remote}`, { cwd: sibling.dbPath });

      await registerRepo(indexed.dbPath, {
        repoPath: indexed.dbPath,
        lastCommit: indexedHead,
        indexedAt: new Date().toISOString(),
        remoteUrl: remote,
      });

      const m = await checkCwdMatch(sibling.dbPath);
      expect(m.match).toBe('sibling-by-remote');
      expect(m.entry?.path).toBe(path.resolve(indexed.dbPath));
      // Path format differs between git and Node.js on Windows (8.3 short
      // vs long names from os.tmpdir()). Verify the git root was resolved
      // and it's not the indexed repo (it's the sibling clone's root).
      expect(m.cwdGitRoot).toBeTruthy();
      expect(m.cwdGitRoot).not.toBe(path.resolve(indexed.dbPath));
      expect(m.hint).toBeTruthy();
    } finally {
      await indexed.cleanup();
      await sibling.cleanup();
    }
  });

  it('returns match=none when cwd is unrelated to any registered repo', async () => {
    const indexed = await createTempDir('cwd-none-indexed-');
    const stranger = await createTempDir('cwd-none-stranger-');
    try {
      const indexedHead = initRepoWithCommit(indexed.dbPath, 'https://example.com/foo/bar');
      initRepoWithCommit(stranger.dbPath, 'https://example.com/totally/different');

      await registerRepo(indexed.dbPath, {
        repoPath: indexed.dbPath,
        lastCommit: indexedHead,
        indexedAt: new Date().toISOString(),
        remoteUrl: 'https://example.com/foo/bar',
      });

      const m = await checkCwdMatch(stranger.dbPath);
      expect(m.match).toBe('none');
    } finally {
      await indexed.cleanup();
      await stranger.cleanup();
    }
  });

  it('reports sibling-by-remote with a stale hint when cwd HEAD has advanced', async () => {
    // Polecat-style scenario from the issue: index at path A, query
    // from cwd=path B (same repo), get a warning rather than
    // silently-stale data. We can't easily share commits between two
    // separate temp `git init` repos, so we instead verify that the
    // cwd HEAD is captured and the hint mentions either drift or a
    // HEAD mismatch.
    const indexed = await createTempDir('cwd-stale-indexed-');
    const sibling = await createTempDir('cwd-stale-sibling-');
    try {
      const remote = 'https://example.com/foo/bar';
      initRepoWithCommit(indexed.dbPath, remote);
      // Use a fabricated indexed commit that doesn't exist in the
      // sibling clone — git rev-list will fail and `drift` is left
      // undefined. The hint must still flag this as a stale-or-divergent
      // sibling clone. Named to make test intent obvious; not git's
      // all-zero "null" OID, which has special semantics in some git
      // commands.
      const FAKE_INDEXED_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      initRepoWithCommit(sibling.dbPath, remote);

      await registerRepo(indexed.dbPath, {
        repoPath: indexed.dbPath,
        lastCommit: FAKE_INDEXED_COMMIT,
        indexedAt: new Date().toISOString(),
        remoteUrl: remote,
      });

      const m = await checkCwdMatch(sibling.dbPath);
      expect(m.match).toBe('sibling-by-remote');
      expect(m.cwdHead).toBeTruthy();
      expect(m.cwdHead).not.toBe(FAKE_INDEXED_COMMIT);
      expect(m.hint).toMatch(/sibling clone/);
    } finally {
      await indexed.cleanup();
      await sibling.cleanup();
    }
  });

  it('omits hint when sibling cwd HEAD matches the indexed commit (no drift)', async () => {
    // Same-commit sibling: the relationship is real (and surfaces in
    // `match: 'sibling-by-remote'`) but there is nothing to warn
    // about. `LocalBackend.maybeWarnSiblingDrift` short-circuits in
    // exactly this case, so confirming `hint` is unset here pins the
    // contract those two pieces of code rely on.
    const indexed = await createTempDir('cwd-same-indexed-');
    const sibling = await createTempDir('cwd-same-sibling-');
    try {
      const remote = 'https://example.com/foo/bar';
      initRepoWithCommit(indexed.dbPath, remote);
      const siblingHead = initRepoWithCommit(sibling.dbPath, remote);

      // Register the indexed entry with the SIBLING's HEAD as
      // `lastCommit`. That is the on-disk reality when both clones
      // happen to be at the same commit hash — e.g. immediately
      // after both fast-forwarded to the same `main`.
      await registerRepo(indexed.dbPath, {
        repoPath: indexed.dbPath,
        lastCommit: siblingHead,
        indexedAt: new Date().toISOString(),
        remoteUrl: remote,
      });

      const m = await checkCwdMatch(sibling.dbPath);
      expect(m.match).toBe('sibling-by-remote');
      expect(m.cwdHead).toBe(siblingHead);
      expect(m.hint).toBeUndefined();
    } finally {
      await indexed.cleanup();
      await sibling.cleanup();
    }
  });
});
