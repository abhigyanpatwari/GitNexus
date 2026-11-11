import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCurrentBranch, getCurrentCheckout, getCurrentCommit } from '../../src/storage/git.js';

describe('getCurrentCheckout', () => {
  let root: string;
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const init = () => {
    git('init', '--initial-branch=feature/checkout');
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@test',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  const expectLegacyResult = (dir = repo) =>
    expect(getCurrentCheckout(dir)).toEqual({
      commit: getCurrentCommit(dir),
      branch: getCurrentBranch(dir),
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-checkout-'));
    repo = path.join(root, 'repo with spaces');
    fs.mkdirSync(repo);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the commit and slashed branch name', () => {
    const commit = init();
    expect(getCurrentCheckout(repo)).toEqual({ commit, branch: 'feature/checkout' });
  });

  it('preserves detached HEAD semantics', () => {
    const commit = init();
    git('checkout', '--detach', commit);
    expect(getCurrentCheckout(repo)).toEqual({ commit, branch: null });
  });

  it('refreshes both values after the checkout changes', () => {
    const first = init();
    expect(getCurrentCheckout(repo)).toEqual({ commit: first, branch: 'feature/checkout' });
    git('checkout', '-b', 'next');
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@test',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-m',
      'next',
    );
    const next = git('rev-parse', 'HEAD');
    expect(next).not.toBe(first);
    expect(getCurrentCheckout(repo)).toEqual({ commit: next, branch: 'next' });
  });

  it('reads a linked worktree independently of the original checkout', () => {
    const commit = init();
    const linked = path.join(root, 'linked');
    git('worktree', 'add', '-b', 'linked', linked);
    expect(getCurrentCheckout(linked)).toEqual({ commit, branch: 'linked' });
    expect(getCurrentCheckout(repo)).toEqual({ commit, branch: 'feature/checkout' });
  });

  it('preserves the results for an unborn branch', () => {
    git('init', '--initial-branch=unborn');
    expect(getCurrentCheckout(repo)).toEqual({ commit: '', branch: null });
    expectLegacyResult();
  });

  it('preserves the results outside a repository', () => {
    expect(getCurrentCheckout(repo)).toEqual({ commit: '', branch: null });
    expectLegacyResult();
  });

  it('preserves independent results when HEAD is an ambiguous ref name', () => {
    const commit = init();
    // Modern Git refuses to create this ref, but can still read one left on disk.
    fs.writeFileSync(path.join(repo, '.git', 'refs', 'tags', 'HEAD'), `${commit}\n`);
    expect(getCurrentCheckout(repo)).toEqual({ commit, branch: null });
    expectLegacyResult();
  });

  it('returns empty metadata when Git cannot run', () => {
    init();
    vi.stubEnv('PATH', path.join(root, 'missing-bin'));
    expect(getCurrentCheckout(repo)).toEqual({ commit: '', branch: null });
  });
});
