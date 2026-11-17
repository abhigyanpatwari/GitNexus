/**
 * Commands the Claude-schema and Antigravity adapters treat as a git mutation,
 * and therefore follow with a stale-index check.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const HELPER = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'git-mutation-command.cjs');

const { isGitMutationCommand } = createRequire(import.meta.url)(HELPER) as {
  isGitMutationCommand: (command: unknown) => boolean;
};

describe('isGitMutationCommand', () => {
  it.each([
    'git commit -m x',
    'git merge main',
    'git rebase main',
    'git cherry-pick abc',
    'git pull',
    'git pull origin main',
    'cd src && git commit -m x',
  ])('recognizes %s', (command) => {
    expect(isGitMutationCommand(command)).toBe(true);
  });

  // #3897: the subcommand does not have to come right after `git`.
  it.each([
    'git -c user.name=x commit -m msg',
    'git -C ../other commit -am msg',
    'git --no-pager pull',
    'git -C/repo -c user.name=Agent commit -m x',
    'git -cuser.name=Agent --no-pager commit -m x',
    'git --git-dir /repo/.git --work-tree=/repo commit -m x',
    'git --config-env user.name=GIT_AUTHOR_NAME commit -m x',
    'git -C "dir with space" commit -m x',
    'git -c user.name="A B" -c user.email=a@b.c commit -m x',
    "git -C 'dir with space' merge main",
    'git -C "$WORKTREE" commit -m x',
    'git -c core.editor=true rebase --continue',
    'git -p --no-optional-locks merge main',
    'git --exec-path=/usr/lib/git-core pull',
    '/usr/bin/git -C /repo cherry-pick abc',
    'HUSKY=0 git -c commit.gpgsign=false commit -m x',
  ])('recognizes %s', (command) => {
    expect(isGitMutationCommand(command)).toBe(true);
  });

  // Whatever surrounds the git call is not parsed, as before.
  it.each([
    'GIT_EDITOR=true git rebase --continue',
    'timeout 60 git pull',
    '(cd pkg && git commit -m x)',
    'git commit -F - <<EOF\nmsg\nEOF',
  ])('still recognizes %s', (command) => {
    expect(isGitMutationCommand(command)).toBe(true);
  });

  it.each([
    'git status',
    'git diff',
    'git stash push',
    'git commit-tree HEAD',
    'git merge-base a b',
    'gitk commit',
    // The word after -C or -c is that option's value, not the subcommand.
    'git -C commit',
    'git -C commit status',
    'git -c alias.ship=commit status',
    'git --git-dir commit status',
    // An option is global only before the subcommand.
    'git log -c commit',
    'git --no-pager log --grep pull',
    'git -c user.name=x status',
    'git -C ../other log',
    // --help and --version end the run; git never reaches the subcommand.
    'git --help commit',
    'git --version commit',
  ])('does not recognize %s', (command) => {
    expect(isGitMutationCommand(command)).toBe(false);
  });

  it.each([undefined, null, 42, {}])('returns false for %s', (command) => {
    expect(isGitMutationCommand(command)).toBe(false);
  });

  it('reads a bounded run of options after each git word', () => {
    // Every `-c git` pair reads as one more option. With an unbounded run each
    // `git` word re-read the rest of the command and this input took 30 s.
    const command = 'git -c '.repeat(50_000);
    const started = performance.now();
    expect(isGitMutationCommand(command)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
