/**
 * Tests for resolving the `repo` param when it points at a LINKED GIT WORKTREE
 * rather than the registered main checkout.
 *
 * `gitnexus analyze` only ever registers a repo's canonical root (main
 * checkout) — see `getCanonicalRepoRoot` (#1259). Every MCP/CLI tool that
 * accepts `repo` (impact, cypher, context, detect_changes, ...) resolves it
 * through `resolveRepoFromCache`, which used to compare `repo` against each
 * registered `handle.repoPath` by EXACT canonical path only. A linked
 * worktree's path — or the documented CLI fallback `--repo .` run from
 * inside one — never equals the main checkout's path, so resolution used to
 * fail with "Repository ... not found" even though the worktree belongs to
 * exactly the repo that IS indexed.
 *
 * This suite verifies `resolveRepoFromCache` (accessed via the private cast,
 * same pattern as impact-pagination.test.ts) now falls back to comparing the
 * PARAM's own canonical root against the registered path, so a worktree path
 * resolves to its repo's handle instead of throwing.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { LocalBackend } from '../../src/mcp/local/local-backend';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

function makeBackendWithRepo(repoPath: string) {
  const backend = new LocalBackend();
  const repoHandle = {
    id: 'repo1',
    name: 'repo1',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
    lbugPath: path.join(repoPath, '.gitnexus', 'lbug'),
    indexedAt: 'now',
    lastCommit: 'c',
    stats: {},
  } as any;
  (backend as any).repos.set(repoHandle.id, repoHandle);
  return { backend, repoHandle };
}

describe('resolveRepoFromCache — linked worktree path', () => {
  it('resolves a linked worktree path to the repo registered at the main checkout', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resolve-wt-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeDir = path.join(repoDir, 'wt-feature');
      execSync(`git worktree add -q -b feature "${worktreeDir}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });

      const { backend, repoHandle } = makeBackendWithRepo(repoDir);

      // Before the fix this returned null (exact-path match only), and
      // resolveRepo() would ultimately throw `Repository "<worktreeDir>" not found`.
      const resolved = (backend as any).resolveRepoFromCache(worktreeDir);
      expect(resolved).toBe(repoHandle);
    } finally {
      try {
        execSync('git worktree remove -f wt-feature', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('still returns null for a worktree belonging to an unrelated repo', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resolve-wt-a-'));
    const otherRepoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resolve-wt-b-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      initGitRepo(otherRepoDir);
      writeFileSync(path.join(otherRepoDir, 'y.ts'), 'export const y = 1;\n');
      commitAll(otherRepoDir, 'initial');

      const worktreeDir = path.join(otherRepoDir, 'wt-unrelated');
      execSync(`git worktree add -q -b unrelated "${worktreeDir}"`, {
        cwd: otherRepoDir,
        stdio: 'ignore',
      });

      // Only repoDir is registered — a worktree of the unrelated otherRepoDir
      // must not resolve to it.
      const { backend } = makeBackendWithRepo(repoDir);
      const resolved = (backend as any).resolveRepoFromCache(worktreeDir);
      expect(resolved).toBeNull();
    } finally {
      try {
        execSync('git worktree remove -f wt-unrelated', { cwd: otherRepoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherRepoDir, { recursive: true, force: true });
    }
  });

  it('still resolves a normal (non-worktree) exact repo path as before', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resolve-plain-'));
    try {
      execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
      const { backend, repoHandle } = makeBackendWithRepo(repoDir);
      const resolved = (backend as any).resolveRepoFromCache(repoDir);
      expect(resolved).toBe(repoHandle);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
