/**
 * Git bootstrap for tests that need a real repository on disk.
 *
 * Ten test files had hand-rolled the same opening sequence — `init`, then the
 * two `config` calls that keep `commit` from failing on a machine with no
 * global identity (CI containers, fresh sandboxes), then `add` + `commit` so
 * `HEAD` exists. The copies had already drifted on everything that does not
 * matter (`spawnSync` vs `execFileSync`, `-q` or not, `add .` vs `add -A`) and
 * on one thing that does: the `spawnSync` copies passed `stdio: 'pipe'` and
 * never looked at the status, so a git that failed to run at all left an
 * ordinary directory behind and the suite failed several asserts later,
 * pointing at the code under test. Every command here is checked.
 *
 * Only the BOOTSTRAP is shared, deliberately. The directory belongs to the
 * caller — these functions never create or remove one, so a suite keeps
 * whatever it already uses (`createTempDirPool`, `createTempDir`, a bare
 * `mkdtempSync`). Seeding belongs to the caller too: the files a test commits
 * are the test. Nothing beyond `init`/`config`/`add`/`commit` lives here;
 * consumers that also need remotes, worktrees, or empty commits drive git
 * themselves.
 *
 * The identity is a parameter because the existing consumers genuinely
 * disagree — the hook suites configure `test@test.com` and the staleness suite
 * a `GitNexus Test` author — and a test's committed identity is the test's to
 * declare, not this helper's to standardize.
 */

import { spawnSync } from 'node:child_process';

/** The `user.name`/`user.email` written into the repo's own git config. */
export interface GitIdentity {
  name: string;
  email: string;
}

/** Used by consumers that never cared which identity they committed under. */
export const DEFAULT_TEST_IDENTITY: GitIdentity = {
  name: 'Test',
  email: 'test@example.com',
};

function runGit(dir: string, args: readonly string[]): void {
  const result = spawnSync('git', [...args], {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status === 0) return;
  const reason = result.stderr || result.stdout || result.error?.message || 'unknown error';
  throw new Error(`git ${args.join(' ')} failed in ${dir}: ${reason.trim()}`);
}

/**
 * Initialize a git repo in an EXISTING directory and give it a committer
 * identity. The directory is not created, not cleaned up, and not seeded.
 */
export function initGitRepo(dir: string, identity: GitIdentity = DEFAULT_TEST_IDENTITY): void {
  runGit(dir, ['init', '-q']);
  runGit(dir, ['config', 'user.email', identity.email]);
  runGit(dir, ['config', 'user.name', identity.name]);
}

/** Stage everything in the working tree and commit it. */
export function commitAll(dir: string, message: string): void {
  runGit(dir, ['add', '-A']);
  runGit(dir, ['commit', '-q', '-m', message]);
}
