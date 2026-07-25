/**
 * Unit Tests: git utility helpers (storage/git.ts)
 *
 * Tests isGitRepo, getCurrentCommit, getGitRoot, and the newly added
 * hasGitDir helper introduced for issue #384 (indexing non-git folders).
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFileSync, execSync } from 'child_process';

const gitExecutable = (() => {
  if (process.platform !== 'win32') return 'git';
  try {
    return (
      execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean) ?? 'git'
    );
  } catch {
    return 'git';
  }
})();

const isolatedTmpRoot = (() => {
  const root =
    process.platform === 'win32'
      ? path.join(path.parse(os.tmpdir()).root, 'gitnexus-outside-git')
      : path.join(os.tmpdir(), 'gitnexus-outside-git');
  fs.mkdirSync(root, { recursive: true });
  return root;
})();

const makeIsolatedTempDir = (prefix = 'gitnexus-test-'): string =>
  fs.mkdtempSync(path.join(isolatedTmpRoot, prefix));

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
    const tmpDir = makeIsolatedTempDir();
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

  // Regression: #1172 — without explicit stdio on execSync, Node forwards
  // the child's stderr to the parent process, printing "fatal: not a git
  // repository" to the user's terminal even though the error is caught.
  it('does not leak git stderr to process.stderr (#1172)', async () => {
    const { getCurrentCommit } = await import('../../src/storage/git.js');
    // git-init a dir without commits so `git rev-parse HEAD` fails with a
    // "fatal:" message — the exact class of error that leaked before the fix.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    execSync('git init -q', { cwd: tmpDir, stdio: 'ignore' });
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(getCurrentCommit(tmpDir)).toBe('');
      const stderrOutput = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrOutput).not.toContain('fatal');
    } finally {
      spy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── getGitRoot ───────────────────────────────────────────────────────────

describe('getGitRoot', () => {
  it('returns null for a plain temp directory', async () => {
    const { getGitRoot } = await import('../../src/storage/git.js');
    const tmpDir = makeIsolatedTempDir();
    try {
      expect(getGitRoot(tmpDir)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Regression: #1172 -- mirrors the getCurrentCommit stderr test above.
  it('does not leak git stderr to process.stderr (#1172)', async () => {
    const { getGitRoot } = await import('../../src/storage/git.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      getGitRoot(tmpDir);
      const stderrOutput = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrOutput).not.toContain('fatal');
    } finally {
      spy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves a trailing-space repository directory name (#2190)', async () => {
    const { getGitRoot } = await import('../../src/storage/git.js');
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-space-root-'));
    const initDir = path.join(parentDir, 'repo-init');
    const repoDir = path.join(parentDir, 'repo ');
    try {
      fs.mkdirSync(initDir);
      execFileSync(gitExecutable, ['init', '-q'], { cwd: initDir, stdio: 'ignore' });
      fs.renameSync(initDir, repoDir);

      expect(getGitRoot(repoDir)).toBe(path.resolve(repoDir));
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
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
    const tmpDir = makeIsolatedTempDir('gitnexus-canonical-');
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
      // Compare via `path.basename` instead of full-path string equality so
      // the test is robust to platform path-format quirks (Windows 8.3 short
      // names like `C:\Users\RUNNER~1\…` vs long form `C:\Users\runneradmin\…`,
      // macOS `/var/folders/… ↔ /private/var/folders/…`). The basename is the
      // only part that registry name derivation actually uses (#1259).
      const result = getCanonicalRepoRoot(tmpDir);
      expect(result).not.toBeNull();
      expect(path.basename(result!)).toBe(path.basename(tmpDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns the CANONICAL repo root when called from inside a linked worktree (#1259)', async () => {
    const { getCanonicalRepoRoot, getGitRoot } = await import('../../src/storage/git.js');
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-canonical-wt-'));
    try {
      execFileSync(gitExecutable, ['init', '-q'], { cwd: repoDir, stdio: 'ignore' });
      // `git worktree add` requires at least one commit on a real branch.
      execSync('git config user.email "test@example.com"', { cwd: repoDir });
      execSync('git config user.name "Test"', { cwd: repoDir });
      execSync('git commit --allow-empty -q -m "initial"', { cwd: repoDir });
      // Create a linked worktree on a new branch outside the main checkout.
      const worktreeDir = path.join(repoDir, 'wt-feature');
      execSync(`git worktree add -q -b feature "${worktreeDir}"`, { cwd: repoDir });

      // Both calls go through the same git executable, so their path-format
      // output is guaranteed consistent — equality between them is the
      // stable cross-platform assertion. (Comparing against `realpathSync`
      // breaks on Windows where 8.3 short names and long names diverge.)
      const fromMain = getCanonicalRepoRoot(repoDir);
      const fromWorktree = getCanonicalRepoRoot(worktreeDir);

      expect(fromMain).not.toBeNull();
      // From inside the worktree: canonical points BACK to the main repo's
      // shared `.git`. This is the regression-guard for #1259 — the
      // registry name derivation collapses across worktrees.
      expect(fromWorktree).toBe(fromMain);
      // Basename matches the canonical repo dir (NOT the worktree slug).
      expect(path.basename(fromWorktree!)).toBe(path.basename(repoDir));
      expect(path.basename(fromWorktree!)).not.toBe('wt-feature');
      // Sanity: getGitRoot returns the worktree-local root (existing
      // behavior unchanged). Compare basenames for the same path-format
      // reason as above.
      expect(path.basename(getGitRoot(worktreeDir)!)).toBe('wt-feature');
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

// ─── selfCommitContextFiles (#2639) ────────────────────────────────────────

describe('selfCommitContextFiles', () => {
  const initRepo = (): string => {
    const repoDir = makeIsolatedTempDir('gitnexus-self-commit-');
    execFileSync(gitExecutable, ['init', '-q'], { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    return repoDir;
  };

  const lastCommitMessage = (repoDir: string): string =>
    execSync('git log -1 --format=%s', { cwd: repoDir, encoding: 'utf8' }).trim();

  const commitCount = (repoDir: string): number =>
    Number(execSync('git rev-list --count HEAD', { cwd: repoDir, encoding: 'utf8' }).trim());

  const stagedFiles = (repoDir: string): string[] =>
    execSync('git diff --cached --name-only', { cwd: repoDir, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

  // Most tests below aren't exercising snapshotSelfCommitSafety itself (that
  // has its own describe block); they just need "everything is safe to
  // commit," matching a normal run where nothing was dirty beforehand.
  const allSafe = (names: string[]): Map<string, boolean> =>
    new Map(names.map((name) => [name, true]));

  it('commits only the changed candidate file, scoped by name (never git add -A)', async () => {
    const { selfCommitContextFiles } = await import('../../src/storage/git.js');
    const repoDir = initRepo();
    try {
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'v1\n');
      execSync('git add AGENTS.md', { cwd: repoDir });
      execSync('git commit -q -m "initial"', { cwd: repoDir });

      // Dirty AGENTS.md (candidate) plus an unrelated untracked file that
      // must never be swept in.
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'v2\n');
      fs.writeFileSync(path.join(repoDir, 'unrelated.txt'), 'should stay untouched\n');

      selfCommitContextFiles(
        repoDir,
        ['AGENTS.md', 'CLAUDE.md'],
        allSafe(['AGENTS.md', 'CLAUDE.md']),
      );

      expect(commitCount(repoDir)).toBe(2);
      expect(lastCommitMessage(repoDir)).toBe('chore(gitnexus): refresh index stats [skip ci]');
      const status = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' });
      // unrelated.txt is still untracked/dirty — proves the commit was scoped.
      expect(status).toContain('unrelated.txt');
      expect(status).not.toContain('AGENTS.md');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('no-ops (no new commit) when neither candidate file changed', async () => {
    const { selfCommitContextFiles } = await import('../../src/storage/git.js');
    const repoDir = initRepo();
    try {
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'v1\n');
      execSync('git add AGENTS.md', { cwd: repoDir });
      execSync('git commit -q -m "initial"', { cwd: repoDir });

      selfCommitContextFiles(
        repoDir,
        ['AGENTS.md', 'CLAUDE.md'],
        allSafe(['AGENTS.md', 'CLAUDE.md']),
      );

      expect(commitCount(repoDir)).toBe(1);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('commits newly-created (untracked) candidate files, not just modified ones', async () => {
    // Regression guard: a first-time `analyze --self-commit` run creates
    // AGENTS.md/CLAUDE.md fresh — they are untracked, not modified. An
    // implementation based on `git diff --quiet` misses untracked files
    // entirely and would silently skip this case.
    const { selfCommitContextFiles } = await import('../../src/storage/git.js');
    const repoDir = initRepo();
    try {
      execSync('git commit -q --allow-empty -m "initial"', { cwd: repoDir });

      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'fresh from analyze\n');

      selfCommitContextFiles(
        repoDir,
        ['AGENTS.md', 'CLAUDE.md'],
        allSafe(['AGENTS.md', 'CLAUDE.md']),
      );

      expect(commitCount(repoDir)).toBe(2);
      expect(lastCommitMessage(repoDir)).toBe('chore(gitnexus): refresh index stats [skip ci]');
      const status = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' });
      expect(status.trim()).toBe('');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('no-ops when neither candidate file exists on disk', async () => {
    const { selfCommitContextFiles } = await import('../../src/storage/git.js');
    const repoDir = initRepo();
    try {
      execSync('git commit -q --allow-empty -m "initial"', { cwd: repoDir });

      expect(() =>
        selfCommitContextFiles(
          repoDir,
          ['AGENTS.md', 'CLAUDE.md'],
          allSafe(['AGENTS.md', 'CLAUDE.md']),
        ),
      ).not.toThrow();
      expect(commitCount(repoDir)).toBe(1);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('never throws when repoPath is not a git repository', async () => {
    const { selfCommitContextFiles } = await import('../../src/storage/git.js');
    const tmpDir = makeIsolatedTempDir('gitnexus-self-commit-nongit-');
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'not a git repo\n');
      expect(() =>
        selfCommitContextFiles(
          tmpDir,
          ['AGENTS.md', 'CLAUDE.md'],
          allSafe(['AGENTS.md', 'CLAUDE.md']),
        ),
      ).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('commits both files when both changed, still scoped (no -A)', async () => {
    const { selfCommitContextFiles } = await import('../../src/storage/git.js');
    const repoDir = initRepo();
    try {
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'v1\n');
      fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'v1\n');
      execSync('git add AGENTS.md CLAUDE.md', { cwd: repoDir });
      execSync('git commit -q -m "initial"', { cwd: repoDir });

      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'v2\n');
      fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'v2\n');

      selfCommitContextFiles(
        repoDir,
        ['AGENTS.md', 'CLAUDE.md'],
        allSafe(['AGENTS.md', 'CLAUDE.md']),
      );

      expect(commitCount(repoDir)).toBe(2);
      const status = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' });
      expect(status.trim()).toBe('');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('logs a warning (never throws) when the commit step fails, e.g. no git identity', async () => {
    const { selfCommitContextFiles } = await import('../../src/storage/git.js');
    const { _captureLogger } = await import('../../src/core/logger.js');
    const repoDir = initRepo();
    try {
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'v1\n');
      execSync('git add AGENTS.md', { cwd: repoDir });
      execSync('git commit -q -m "initial"', { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'v2\n');

      // useConfigOnly forces git to error on a missing identity instead of
      // guessing from OS user/hostname; HOME/XDG_CONFIG_HOME are redirected
      // and GIT_CONFIG_NOSYSTEM disables the system config, so no ambient
      // global identity on the CI runner can leak in and make git succeed
      // anyway. Together these deterministically reproduce "no git identity
      // configured" regardless of the machine running the test.
      execSync('git config user.useConfigOnly true', { cwd: repoDir });
      execSync('git config --unset user.name', { cwd: repoDir });
      execSync('git config --unset user.email', { cwd: repoDir });

      const savedHome = process.env.HOME;
      const savedXdg = process.env.XDG_CONFIG_HOME;
      const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
      process.env.HOME = makeIsolatedTempDir('gitnexus-self-commit-noidentity-home-');
      process.env.XDG_CONFIG_HOME = process.env.HOME;
      process.env.GIT_CONFIG_NOSYSTEM = '1';

      const cap = _captureLogger();
      try {
        expect(() =>
          selfCommitContextFiles(
            repoDir,
            ['AGENTS.md', 'CLAUDE.md'],
            allSafe(['AGENTS.md', 'CLAUDE.md']),
          ),
        ).not.toThrow();
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = savedXdg;
        if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
        else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
      }
      const warning = cap
        .records()
        .find((r) => r.msg.includes('--self-commit failed to commit context files'));
      cap.restore();

      expect(warning).toBeDefined();
      expect(commitCount(repoDir)).toBe(1); // commit never landed
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('skips (and logs) a candidate that already had an uncommitted edit before this run, never sweeping it into the generated commit', async () => {
    // Regression for #2640 review round 1/2: without snapshotSelfCommitSafety,
    // a pre-existing unstaged user edit in AGENTS.md and this run's stats
    // refresh are indistinguishable — both just show up as "AGENTS.md is
    // dirty" — so the old implementation silently committed both together.
    const { selfCommitContextFiles, snapshotSelfCommitSafety } =
      await import('../../src/storage/git.js');
    const { _captureLogger } = await import('../../src/core/logger.js');
    const repoDir = initRepo();
    try {
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'v1\n');
      fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'v1\n');
      execSync('git add AGENTS.md CLAUDE.md', { cwd: repoDir });
      execSync('git commit -q -m "initial"', { cwd: repoDir });

      // A user edit lands in AGENTS.md BEFORE analyze/self-commit ever runs.
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'user note\n');

      // The real call sequence: snapshot safety first (this is what
      // analyze.ts does before writing), THEN simulate analyze's own write
      // on top of the user's pre-existing edit, for both candidates.
      const safety = snapshotSelfCommitSafety(repoDir, ['AGENTS.md', 'CLAUDE.md']);
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'user note\ngenerated stats refresh\n');
      fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'generated stats refresh\n');

      const cap = _captureLogger();
      selfCommitContextFiles(repoDir, ['AGENTS.md', 'CLAUDE.md'], safety);
      const warning = cap
        .records()
        .find((r) => r.msg.includes('skipping file(s) with uncommitted changes'));
      cap.restore();

      expect(warning).toBeDefined();
      // CLAUDE.md was clean pre-run (safe) and got committed; AGENTS.md was
      // already dirty pre-run (unsafe) and must stay out of the commit and
      // out of the index entirely — proving its edit wasn't swept in.
      expect(commitCount(repoDir)).toBe(2);
      expect(lastCommitMessage(repoDir)).toBe('chore(gitnexus): refresh index stats [skip ci]');
      const diffTreeFiles = execSync('git diff-tree --no-commit-id --name-only -r HEAD', {
        cwd: repoDir,
        encoding: 'utf8',
      })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(diffTreeFiles).toEqual(['CLAUDE.md']);
      const status = execSync('git status --porcelain -- AGENTS.md', {
        cwd: repoDir,
        encoding: 'utf8',
      });
      expect(status.trim()).not.toBe(''); // AGENTS.md's edit is still there, untouched
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('restores the index for exactly the staged files when commit fails after git add (no leftover staged state)', async () => {
    // Regression for #2640 review round 2: `git add` runs before `git commit`;
    // if commit then fails (e.g. missing identity), the old implementation
    // left the candidate staged even though it reported nothing happened —
    // silently mutating the user's index on a run that "did nothing."
    const { selfCommitContextFiles } = await import('../../src/storage/git.js');
    const repoDir = initRepo();
    try {
      execSync('git commit -q --allow-empty -m "initial"', { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'fresh from analyze\n');

      execSync('git config user.useConfigOnly true', { cwd: repoDir });
      execSync('git config --unset user.name', { cwd: repoDir });
      execSync('git config --unset user.email', { cwd: repoDir });

      const savedHome = process.env.HOME;
      const savedXdg = process.env.XDG_CONFIG_HOME;
      const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
      process.env.HOME = makeIsolatedTempDir('gitnexus-self-commit-noidentity-home2-');
      process.env.XDG_CONFIG_HOME = process.env.HOME;
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      try {
        selfCommitContextFiles(
          repoDir,
          ['AGENTS.md', 'CLAUDE.md'],
          allSafe(['AGENTS.md', 'CLAUDE.md']),
        );
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = savedXdg;
        if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
        else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
      }

      expect(commitCount(repoDir)).toBe(1); // commit never landed
      expect(stagedFiles(repoDir)).toEqual([]); // and nothing was left staged
      // The file itself is still there, unstaged, exactly as analyze left it.
      const status = execSync('git status --porcelain -- AGENTS.md', {
        cwd: repoDir,
        encoding: 'utf8',
      });
      expect(status.trim()).toBe('?? AGENTS.md');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ─── isWorkingTreeDirty ───────────────────────────────────────────────────
//
// analyze's fast-path gate. GitNexus writes to .gitnexus/, .claude/, .cursor/,
// AGENTS.md, CLAUDE.md, and the repo-local .agents/ skill mirror during a run;
// those writes must never count as "dirty" or the up-to-date fast path is
// defeated on every re-run. Real temporary git repos exercise the actual
// `git status --porcelain` pathspec exclude list.

/** Create a fresh git repo in an isolated temp dir and return its path. */
function makeIsolatedGitRepo(): string {
  const dir = makeIsolatedTempDir('gn-dirty-');
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  // Set a stable identity so commit doesn't fail on environments without
  // global git config (CI containers, fresh sandboxes).
  execSync('git config user.email t@t', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name t', { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('isWorkingTreeDirty', () => {
  it('returns false for a clean tree with only GitNexus-managed paths written', async () => {
    const { isWorkingTreeDirty } = await import('../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    try {
      // Initial commit so the tree has a HEAD.
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
      execSync('git add -A && git commit -q -m init', { cwd: repo, stdio: 'ignore' });

      // Simulate GitNexus writing its managed outputs.
      fs.mkdirSync(path.join(repo, '.gitnexus'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.gitnexus', 'meta.json'), '{}');
      fs.mkdirSync(path.join(repo, '.claude', 'skills', 'gitnexus-cli'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'skills', 'gitnexus-cli', 'SKILL.md'), 'x');
      fs.mkdirSync(path.join(repo, '.agents', 'skills', 'gitnexus-area-auth'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(repo, '.agents', 'skills', 'gitnexus-area-auth', 'SKILL.md'), 'x');
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'x');
      fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'x');

      expect(isWorkingTreeDirty(repo)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns true when a real source file changes (regression: excludes must not mask real edits)', async () => {
    const { isWorkingTreeDirty } = await import('../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
      execSync('git add -A && git commit -q -m init', { cwd: repo, stdio: 'ignore' });

      // A real business-file edit alongside GitNexus writes.
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', 'foo.ts'), 'export const x = 2;');
      fs.mkdirSync(path.join(repo, '.agents', 'skills', 'x'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.agents', 'skills', 'x', 'SKILL.md'), 'x');

      expect(isWorkingTreeDirty(repo)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('treats the entire .agents/ tree as excluded (root file, nested skills, deep paths)', async () => {
    const { isWorkingTreeDirty } = await import('../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
      execSync('git add -A && git commit -q -m init', { cwd: repo, stdio: 'ignore' });

      // Root-level file under .agents/.
      fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.agents', 'foo.txt'), 'x');
      // Deep nested mirror path.
      fs.mkdirSync(path.join(repo, '.agents', 'skills', 'gitnexus-area-auth'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(repo, '.agents', 'skills', 'gitnexus-area-auth', 'SKILL.md'), 'x');

      expect(isWorkingTreeDirty(repo)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not error when .agents/ does not exist (no pathspec failure)', async () => {
    const { isWorkingTreeDirty } = await import('../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
      execSync('git add -A && git commit -q -m init', { cwd: repo, stdio: 'ignore' });

      expect(isWorkingTreeDirty(repo)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not error when .agents is a file rather than a directory', async () => {
    const { isWorkingTreeDirty } = await import('../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
      execSync('git add -A && git commit -q -m init', { cwd: repo, stdio: 'ignore' });

      // .agents exists as a regular file (e.g. user created it by mistake).
      fs.writeFileSync(path.join(repo, '.agents'), 'not a directory');

      // Must not throw; the tree is otherwise clean so it is not dirty.
      expect(isWorkingTreeDirty(repo)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT exclude prefix-colliding names like .agentsrc or .claudefoo', async () => {
    // pathspec `:(exclude).agents` must not swallow `.agentsrc` (no path
    // separator). A change to such a colliding name still counts as dirty.
    const { isWorkingTreeDirty } = await import('../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
      execSync('git add -A && git commit -q -m init', { cwd: repo, stdio: 'ignore' });

      fs.writeFileSync(path.join(repo, '.agentsrc'), 'x');
      fs.writeFileSync(path.join(repo, '.claudefoo'), 'x');

      expect(isWorkingTreeDirty(repo)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT exclude a nested .agents/ inside a subdirectory (root-relative pathspec)', async () => {
    // `:(exclude).agents` is relative to the repo root; a subdirectory's
    // .agents/ is unrelated and must still count as dirty.
    const { isWorkingTreeDirty } = await import('../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
      execSync('git add -A && git commit -q -m init', { cwd: repo, stdio: 'ignore' });

      fs.mkdirSync(path.join(repo, 'subdir', '.agents'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'subdir', '.agents', 'x'), 'x');

      expect(isWorkingTreeDirty(repo)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns true (conservative) when called outside a git repository', async () => {
    const { isWorkingTreeDirty } = await import('../../src/storage/git.js');
    const dir = makeIsolatedTempDir('gn-nongit-');
    try {
      // No git init — git status fails, and the gate must fail closed (dirty).
      expect(isWorkingTreeDirty(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true (conservative) when git is not on PATH', async () => {
    // PATH cleared so `git` cannot be found. The catch block must return true
    // (fail closed) rather than silently treating the tree as clean — a clean
    // false-positive would skip re-indexing of a genuinely-changed repo.
    const { isWorkingTreeDirty } = await import('../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    const savedPath = process.env.PATH;
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
      execSync('git add -A && git commit -q -m init', { cwd: repo, stdio: 'ignore' });
      process.env.PATH = '';
      expect(isWorkingTreeDirty(repo)).toBe(true);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
