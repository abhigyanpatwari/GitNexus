/**
 * Commands the Claude-schema and Antigravity adapters treat as a git mutation,
 * and the directory whose index they check afterwards.
 */
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const HELPER = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'git-mutation-command.cjs');

const { gitMutationDirectory, isOutside } = createRequire(import.meta.url)(HELPER) as {
  gitMutationDirectory: (command: unknown, cwd: string) => string | null;
  isOutside: (directory: string, root: string) => boolean;
};

// Absolute on every platform, and not required to exist.
const CWD = path.join(os.tmpdir(), 'gn-mutation', 'repo');
const under = (...segments: string[]) => path.resolve(CWD, ...segments);

describe('gitMutationDirectory', () => {
  it.each([
    'git commit -m x',
    'git merge main',
    'git rebase main',
    'git cherry-pick abc',
    'git pull',
    'git pull origin main',
    'cd src && git commit -m x',
  ])('runs %s in cwd', (command) => {
    expect(gitMutationDirectory(command, CWD)).toBe(CWD);
  });

  // #3897: the subcommand does not have to come right after `git`.
  it.each([
    'git -c user.name=x commit -m msg',
    'git --no-pager pull',
    'git -cuser.name=Agent --no-pager commit -m x',
    'git --config-env user.name=GIT_AUTHOR_NAME commit -m x',
    'git -c user.name="A B" -c user.email=a@b.c commit -m x',
    'git -c user.name="$NAME" commit -m x',
    'git -c core.editor=true rebase --continue',
    'git -p --no-optional-locks merge main',
    'git --exec-path=/usr/lib/git-core pull',
    'git --namespace=team --attr-source HEAD cherry-pick abc',
    'HUSKY=0 git -c commit.gpgsign=false commit -m x',
  ])('runs %s in cwd', (command) => {
    expect(gitMutationDirectory(command, CWD)).toBe(CWD);
  });

  // -C moves the git call, so the index to check is the one of that directory.
  it.each([
    ['git -C ../other commit -am msg', under('..', 'other')],
    ['git -C../other -c user.name=Agent commit -m x', under('..', 'other')],
    ['git -C . commit -m x', CWD],
    ['git -C packages/web pull', under('packages', 'web')],
    ['git -C "dir with space" commit -m x', under('dir with space')],
    ["git -C 'dir with space' merge main", under('dir with space')],
    ['git -C "say \\"hi\\"" commit -m x', under('say "hi"')],
    // Each -C is read relative to the one before it.
    ['git -C packages -C web commit -m x', under('packages', 'web')],
    ['git -C packages -C ../docs commit -m x', under('docs')],
    [`/usr/bin/git -C ${under('..', 'abs')} -C sub cherry-pick abc`, under('..', 'abs', 'sub')],
  ])('runs %s in %s', (command, directory) => {
    expect(gitMutationDirectory(command, CWD)).toBe(directory);
  });

  it.runIf(process.platform !== 'win32')('reads a bare backslash as an escape', () => {
    expect(gitMutationDirectory('git -C dir\\ with\\ space merge main', CWD)).toBe(
      under('dir with space'),
    );
  });

  it.runIf(process.platform === 'win32')('keeps a bare backslash as a separator', () => {
    expect(gitMutationDirectory('git -C packages\\web merge main', CWD)).toBe(
      under('packages', 'web'),
    );
  });

  // The repository cannot be read from the command: no check rather than a
  // check of the wrong one.
  it.each([
    'git -C "$WORKTREE" commit -m x',
    'git -C $WORKTREE commit -m x',
    'git -C "$(git rev-parse --show-toplevel)" commit -m x',
    'git -C `pwd` commit -m x',
    'git -C ~/project commit -m x',
    'git --git-dir /repo/.git --work-tree=/repo commit -m x',
    'git --git-dir=/other/.git commit -m x',
    'git --work-tree /other pull',
  ])('cannot place %s', (command) => {
    expect(gitMutationDirectory(command, CWD)).toBeNull();
  });

  // Whatever surrounds the git call is not parsed, as before.
  it.each([
    'GIT_EDITOR=true git rebase --continue',
    'timeout 60 git pull',
    '(cd pkg && git commit -m x)',
    'git commit -F - <<EOF\nmsg\nEOF',
  ])('still recognizes %s', (command) => {
    expect(gitMutationDirectory(command, CWD)).toBe(CWD);
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
  ])('finds no mutation in %s', (command) => {
    expect(gitMutationDirectory(command, CWD)).toBeNull();
  });

  it.each([undefined, null, 42, {}])('finds no mutation in %s', (command) => {
    expect(gitMutationDirectory(command, CWD)).toBeNull();
  });

  it('reads a bounded run of options after each git word', () => {
    // Every `-c git` pair reads as one more option. With an unbounded run each
    // `git` word re-read the rest of the command and this input took 30 s.
    const command = 'git -c '.repeat(50_000);
    const started = performance.now();
    expect(gitMutationDirectory(command, CWD)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('isOutside', () => {
  it.each([
    [CWD, CWD, false],
    [under('packages', 'web'), CWD, false],
    [under('..', 'other'), CWD, true],
    [under('..'), CWD, true],
    [under('..', 'repo-two'), CWD, true],
  ])('%s outside %s: %s', (directory, root, expected) => {
    expect(isOutside(directory, root)).toBe(expected);
  });
});
