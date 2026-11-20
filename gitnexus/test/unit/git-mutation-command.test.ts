/**
 * Commands the Claude-schema and Antigravity adapters treat as a git mutation,
 * and the directories whose index they check afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

const HELPER = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'git-mutation-command.cjs');

type Shell = 'bash' | 'powershell' | 'either';

const { gitMutationDirectories, readHead, onlyMarkdownChanged, canSkipMarkdownReindex } =
  createRequire(import.meta.url)(HELPER) as {
    onlyMarkdownChanged: (directory: string, cwd: string, base: string, head: string) => boolean;
    canSkipMarkdownReindex: (
      directory: string,
      cwd: string,
      base: string,
      head: string,
      cli: () => string,
    ) => boolean;
    gitMutationDirectories: (command: unknown, cwd: string, shell: Shell) => string[];
    readHead: (directory: string, cwd: string) => { head: string; checkout: string | null };
  };

// Absolute on every platform, and not required to exist.
const CWD = path.join(os.tmpdir(), 'gn-mutation', 'repo');
const under = (...segments: string[]) => path.resolve(CWD, ...segments);
const inBash = (command: unknown) => gitMutationDirectories(command, CWD, 'bash');

it('suppresses a docs-only gap but still warns for an earlier unindexed code change', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-hook-gap-'));
  try {
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, 'app.py'), 'v = 1\n');
    commitAll(repo, 'indexed base');
    const base = readHead(repo, repo).head;
    fs.writeFileSync(path.join(repo, 'README.md'), 'notes\n');
    fs.writeFileSync(path.join(repo, 'guide.MDX'), '# Usage\n');
    commitAll(repo, 'docs');
    expect(onlyMarkdownChanged(repo, repo, base, readHead(repo, repo).head)).toBe(true);
    vi.stubEnv('GIT_LITERAL_PATHSPECS', '1');
    expect(onlyMarkdownChanged(repo, repo, base, readHead(repo, repo).head)).toBe(true);
    const head = readHead(repo, repo).head;
    const cli = path.join(repo, '.git', 'status.cjs');
    for (const [identity, reasons, expected] of [
      ['current', [], true],
      ['current', ['incremental-in-progress'], false],
      ['stale-or-unknown', [], false],
    ] as const) {
      const status = {
        current: { commit: head },
        index: { commit: base, runnerIdentityStatus: identity, incompleteReasons: reasons },
      };
      fs.writeFileSync(cli, 'console.log(' + JSON.stringify(JSON.stringify(status)) + ')');
      expect(canSkipMarkdownReindex(repo, repo, base, head, () => cli)).toBe(expected);
    }
    fs.writeFileSync(path.join(repo, 'new.ts'), 'untracked');
    expect(onlyMarkdownChanged(repo, repo, base, head)).toBe(false);
    expect(spawnSync('git', ['add', 'new.ts'], { cwd: repo }).status).toBe(0);
    expect(onlyMarkdownChanged(repo, repo, base, head)).toBe(false);
    fs.writeFileSync(path.join(repo, 'app.py'), 'v = 2\n');
    commitAll(repo, 'change code');
    fs.writeFileSync(path.join(repo, 'README.md'), 'more notes\n');
    commitAll(repo, 'more docs');
    expect(onlyMarkdownChanged(repo, repo, base, readHead(repo, repo).head)).toBe(false);
    const docs = path.join(repo, 'docs');
    fs.mkdirSync(docs);
    expect(spawnSync('git', ['config', 'diff.relative', 'true'], { cwd: repo }).status).toBe(0);
    expect(onlyMarkdownChanged(docs, docs, base, readHead(docs, docs).head)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

it('keeps a stale hint when git is configured to hide submodule changes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-hook-gitlink-'));
  const git = (args: string[]) => expect(spawnSync('git', args, { cwd: repo }).status).toBe(0);
  try {
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base');
    commitAll(repo, 'base');
    const base = readHead(repo, repo).head;
    git(['update-index', '--add', '--cacheinfo', '160000,' + base + ',vendor']);
    git(['commit', '-qm', 'track submodule']);
    git(['config', 'diff.ignoreSubmodules', 'all']);
    expect(onlyMarkdownChanged(repo, repo, base, readHead(repo, repo).head)).toBe(false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

describe('gitMutationDirectories', () => {
  it.each([
    'git commit -m x',
    'git merge main',
    'git rebase main',
    'git cherry-pick abc',
    'git pull',
    'git pull origin main',
    'cd src && git commit -m x',
    // The subcommand may end at a shell operator.
    'git pull; git status',
    'git pull&&echo ok',
    'git pull|cat',
    '(git pull)',
  ])('runs %s in cwd', (command) => {
    expect(inBash(command)).toEqual([CWD]);
  });

  // #3897: the subcommand does not have to come right after `git`.
  it.each([
    'git -c user.name=x commit -m msg',
    'git --no-pager pull',
    'git -c user.name=Agent --no-pager commit -m x',
    'git --config-env user.name=GIT_AUTHOR_NAME commit -m x',
    'git -c user.name="A B" -c user.email=a@b.c commit -m x',
    'git -c user.name="$NAME" commit -m x',
    'git -c core.editor=true rebase --continue',
    'git -p --no-optional-locks merge main',
    'git --no-literal-pathspecs commit -m x',
    'git --exec-path=/usr/lib/git-core pull',
    'git --namespace=team --attr-source HEAD cherry-pick abc',
    'HUSKY=0 git -c commit.gpgsign=false commit -m x',
  ])('runs %s in cwd', (command) => {
    expect(inBash(command)).toEqual([CWD]);
  });

  // -C moves the git call, so the index to check is the one of that directory.
  // An absolute path is single-quoted: on Windows it holds backslashes, which
  // bash would read as escapes.
  it.each([
    ['git -C ../other commit -am msg', under('..', 'other')],
    ['git -C ../other -c user.name=Agent commit -m x', under('..', 'other')],
    ['git -C . commit -m x', CWD],
    ['git -C packages/web pull', under('packages', 'web')],
    ['git -C packages/web pull; git status', under('packages', 'web')],
    ['git -C "dir with space" commit -m x', under('dir with space')],
    ["git -C 'dir with space' merge main", under('dir with space')],
    ['git -C "say \\"hi\\"" commit -m x', under('say "hi"')],
    // Each -C is read relative to the one before it.
    ['git -C packages -C web commit -m x', under('packages', 'web')],
    ['git -C packages -C ../docs commit -m x', under('docs')],
    [`/usr/bin/git -C '${under('..', 'abs')}' -C sub cherry-pick abc`, under('..', 'abs', 'sub')],
  ])('runs %s in %s', (command, directory) => {
    expect(inBash(command)).toEqual([directory]);
  });

  // bash reads a backslash as an escape and PowerShell as a path separator. A
  // caller that cannot tell the two apart places a path only when both read it
  // the same way.
  it.each<[string, Shell, string[]]>([
    ['git -C dir\\ with\\ space merge main', 'bash', [under('dir with space')]],
    ['git -C dir\\ with\\ space merge main', 'either', []],
    ['git -C packages\\web merge main', 'powershell', [under('packages\\web')]],
    ['git -C packages\\web merge main', 'either', []],
    ['git -C "packages\\web" merge main', 'bash', [under('packages\\web')]],
    ['git -C "packages\\web" merge main', 'powershell', [under('packages\\web')]],
    ['git -C "packages\\web" merge main', 'either', [under('packages\\web')]],
    ["git -C 'packages\\web' merge main", 'either', [under('packages\\web')]],
    ['git -C "say \\"hi\\"" commit -m x', 'either', []],
    ['git -C "dir with space" commit -m x', 'either', [under('dir with space')]],
    ['git -C "dir with space" commit -m x', 'powershell', [under('dir with space')]],
  ])('reads %s in %s as %j', (command, shell, directories) => {
    expect(gitMutationDirectories(command, CWD, shell)).toEqual(directories);
  });

  // A backslash before a quote is where the two shells split a word
  // differently. Each of these has to come back, whatever the shell.
  it.each<[string, Shell, string[]]>([
    ["git -C 'Bob'\\''s Project' commit -m wip", 'bash', [under("Bob's Project")]],
    ["git -C 'Bob'\\''s Project' commit -m wip", 'either', []],
    ["git -C 'Bob'\\''s Project' commit -m wip", 'powershell', []],
    ["git -C ../Bob\\'s-app commit -m x", 'bash', [under('..', "Bob's-app")]],
    ["git -C ../Bob\\'s-app commit -m x", 'either', []],
    ["git -C ../Bob\\'s-app commit -m x", 'powershell', []],
    ['pwsh -Command "git -C \\"C:\\src\\app\\" commit -am wip"', 'bash', [under('"C:srcapp"')]],
    ['pwsh -Command "git -C \\"C:\\src\\app\\" commit -am wip"', 'either', []],
    ['git -C "open commit -m x', 'bash', []],
    ['git -C "open commit -m x', 'powershell', []],
    ["git -C 'open commit -m x", 'either', []],
  ])('reads %s in %s as %j', (command, shell, directories) => {
    expect(gitMutationDirectories(command, CWD, shell)).toEqual(directories);
  });

  // A doubled quote is one quote character inside a PowerShell string, and two
  // strings side by side in bash.
  it.each<[string, Shell, string[]]>([
    ["git -C 'Bob''s Project' commit -m wip", 'bash', [under('Bobs Project')]],
    ["git -C 'Bob''s Project' commit -m wip", 'either', []],
    ["git -C 'Bob''s Project' commit -m wip", 'powershell', []],
    ['git -C "say ""hi""" commit -m x', 'bash', [under('say hi')]],
    ['git -C "say ""hi""" commit -m x', 'either', []],
    ['git -C "say ""hi""" commit -m x', 'powershell', []],
    // Two different quotes side by side are two strings in both shells.
    [`git -C 'my '"repo" commit -m x`, 'either', [under('my repo')]],
    [`git -C 'my '"repo" commit -m x`, 'powershell', [under('my repo')]],
  ])('reads %s in %s as %j', (command, shell, directories) => {
    expect(gitMutationDirectories(command, CWD, shell)).toEqual(directories);
  });

  // Git changes directory through the filesystem: `link/..` is the parent of
  // the link's target, where text resolution would give the parent of the link.
  it.skipIf(process.platform === 'win32')('follows a symlink before stepping up from it', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-mutation-link-')));
    try {
      const workspace = path.join(root, 'workspace');
      const packageDir = path.join(root, 'other', 'repo', 'packages');
      fs.mkdirSync(workspace);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.symlinkSync(packageDir, path.join(workspace, 'link'));

      const from = (command: string) => gitMutationDirectories(command, workspace, 'bash');
      expect(from('git -C link/.. commit -m x')).toEqual([path.join(root, 'other', 'repo')]);
      expect(from('git -C link -C .. commit -m x')).toEqual([path.join(root, 'other', 'repo')]);
      expect(from('git -C link commit -m x')).toEqual([packageDir]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    // The shell is no longer in cwd when git reads the relative path.
    'cd ../other && git --no-pager pull',
    'pushd ../other && git -c user.name=x commit -m x',
    'cd ../../y/a && git -C ../b commit -am m',
    '(cd projects && git -C app commit -m x)',
    'pushd ../y && git -C b pull',
    'cd /srv && git -c user.name=x -C app -C /abs commit -m x',
  ])('cannot place %s', (command) => {
    expect(inBash(command)).toEqual([]);
  });

  it.each([
    [`cd pkg && git -C '${under('..', 'abs')}' commit -m x`, under('..', 'abs')],
    [`cd pkg && git -C '${under('..', 'abs')}' -C sub commit -m x`, under('..', 'abs', 'sub')],
    ['git -C ../other commit -m x && cd ../other', under('..', 'other')],
  ])('places %s, whose path does not depend on the shell directory', (command, directory) => {
    expect(inBash(command)).toEqual([directory]);
  });

  // A git call that cannot be placed does not hide the ones after it.
  it.each([
    ['git -C "$WT" commit -m a && git commit -m b', [CWD]],
    ['git -C ~/other pull && git pull', [CWD]],
    ['git --git-dir=../b/.git pull && git commit -am m', [CWD]],
    ['git -C ../vendor-lib pull && git commit -am x', [under('..', 'vendor-lib'), CWD]],
    ['git commit -m a && git commit --amend -m b', [CWD]],
    ['git -C packages/a commit -m x && git -C ./packages/a pull', [under('packages', 'a')]],
    ['git -C a pull && git -C b pull && git status', [under('a'), under('b')]],
  ])('reads every git call of %s', (command, directories) => {
    expect(inBash(command)).toEqual(directories);
  });

  it('keeps cwd when more directories are named than it returns', () => {
    const elsewhere = ['a', 'b', 'c', 'd', 'e', 'f'];
    const command = [...elsewhere.map((name) => `git -C ${name} pull`), 'git commit -m x'].join(
      ' && ',
    );
    expect(inBash(command)).toEqual([...elsewhere.slice(0, 4).map((name) => under(name)), CWD]);
  });

  // Whatever surrounds the git call is not parsed, as before.
  it.each([
    'GIT_EDITOR=true git rebase --continue',
    'timeout 60 git pull',
    '(cd pkg && git commit -m x)',
    'git commit -F - <<EOF\nmsg\nEOF',
    "echo 'git commit -m x'",
  ])('still recognizes %s', (command) => {
    expect(inBash(command)).toEqual([CWD]);
  });

  it.each([
    'git status',
    'git diff',
    'git stash push',
    'git commit-tree HEAD',
    'git merge-base a b',
    'git pull-request',
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
    // Git refuses a value attached to -C or -c, and an option it does not know.
    'git -C../other commit -m x',
    'git -cuser.name=x commit -m x',
    'git --super-prefix=x commit -m x',
  ])('finds no mutation in %s', (command) => {
    expect(inBash(command)).toEqual([]);
  });

  it.each([undefined, null, 42, {}])('finds no mutation in %s', (command) => {
    expect(inBash(command)).toEqual([]);
  });

  it('reads at most 32 options after a git word', () => {
    const withOptions = (count: number) => `git${' -c a=b'.repeat(count)} commit -m x`;
    expect(inBash(withOptions(32))).toEqual([CWD]);
    expect(inBash(withOptions(33))).toEqual([]);
  });

  describe('a command over 16 KB', () => {
    const LIMIT = 16 * 1024;
    const padded = (command: string, length: number) => command.padEnd(length, ' ');

    it('is read for options up to the limit', () => {
      expect(inBash(padded('git -c user.name=x commit -m x', LIMIT))).toEqual([CWD]);
      expect(inBash(padded('git -C ../other commit -m x', LIMIT))).toEqual([under('..', 'other')]);
    });

    it('is only matched without options past the limit, like before #3897', () => {
      expect(inBash(padded('git commit -m x', LIMIT + 1))).toEqual([CWD]);
      expect(inBash(padded('git -c user.name=x commit -m x', LIMIT + 1))).toEqual([]);
      expect(inBash(padded('git -C ../other commit -m x', LIMIT + 1))).toEqual([]);
    });

    // In both shapes every `git` word reads on to the end of the command
    // before it fails: 400 KB took 12 s and 30 s when they were read in full.
    it.each([
      ['an option value that never ends', `git -c ${"\\''git -c ".repeat(40_000)}`],
      ['options that never reach a subcommand', 'git -c '.repeat(50_000)],
    ])('is not read in full for %s', (_shape, command) => {
      expect(inBash(command)).toEqual([]);
    });
  });

  // One test on every platform, so each run records a pass.
  it('does not resolve a network path on Windows', () => {
    const elsewhere = process.platform === 'win32' ? [] : [path.resolve('//host/share')];
    expect(inBash('git -C //host/share pull')).toEqual(elsewhere);
    expect(inBash('git -C "//?/C:/repo" pull')).toEqual(
      process.platform === 'win32' ? [] : [path.resolve('//?/C:/repo')],
    );
  });
});

describe('readHead', () => {
  let root: string;
  let main: string;
  let other: string;
  let worktree: string;
  let nested: string;

  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const headOf = (dir: string) => git(dir, 'rev-parse', 'HEAD');
  // Spelled the way git reports it, which is the form `checkout` has.
  const rootOf = (dir: string) => path.resolve(git(dir, 'rev-parse', '--show-toplevel'));

  const newRepo = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    initGitRepo(dir, { name: 'Test', email: 'test@test.com' });
    fs.writeFileSync(path.join(dir, 'a.txt'), path.basename(dir));
    commitAll(dir, `init ${path.basename(dir)}`);
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-mutation-head-'));
    main = path.join(root, 'main');
    other = path.join(root, 'other');
    worktree = path.join(root, 'feat');
    nested = path.join(main, 'vendor', 'lib');
    newRepo(main);
    newRepo(other);
    fs.mkdirSync(path.join(main, 'src'));
    git(main, 'worktree', 'add', '-b', 'feat', worktree);
    fs.writeFileSync(path.join(worktree, 'b.txt'), 'feat');
    commitAll(worktree, 'feat');
    newRepo(nested);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads HEAD of cwd without naming a checkout', () => {
    expect(readHead(main, main)).toEqual({ head: headOf(main), checkout: null });
  });

  it('names no checkout for a directory of the checkout cwd is in', () => {
    expect(readHead(path.join(main, 'src'), main)).toEqual({ head: headOf(main), checkout: null });
    expect(readHead(main, path.join(main, 'src'))).toEqual({ head: headOf(main), checkout: null });
  });

  it('names another repository', () => {
    expect(readHead(other, main)).toEqual({ head: headOf(other), checkout: rootOf(other) });
  });

  // A linked worktree shares the repository of `main` and has its own HEAD.
  it('names a linked worktree, and the main checkout from inside one', () => {
    expect(headOf(worktree)).not.toBe(headOf(main));
    expect(readHead(worktree, main)).toEqual({
      head: headOf(worktree),
      checkout: rootOf(worktree),
    });
    expect(readHead(main, worktree)).toEqual({ head: headOf(main), checkout: rootOf(main) });
  });

  // A clone inside the folder of another checkout is still its own checkout.
  it('names the checkout around a nested clone, and the nested clone from around it', () => {
    expect(readHead(main, nested)).toEqual({ head: headOf(main), checkout: rootOf(main) });
    expect(readHead(nested, main)).toEqual({ head: headOf(nested), checkout: rootOf(nested) });
  });

  it('reads no HEAD outside a repository', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-mutation-outside-'));
    try {
      expect(readHead(outside, main)).toEqual({ head: '', checkout: null });
      expect(readHead(path.join(outside, 'missing'), main)).toEqual({ head: '', checkout: null });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // Windows looks for `git.exe` in the working directory of the child before
  // PATH, so git is started in cwd and told about the directory with -C. The
  // stand-in is a shell script, hence not on Windows.
  it.skipIf(process.platform === 'win32')('starts git in cwd, never in the directory', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-mutation-bin-'));
    try {
      const log = path.join(bin, 'started-in.log');
      const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).stdout;
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh\npwd -P >> "${log}"\nexec "${realGit.trim()}" "$@"\n`,
        { mode: 0o755 },
      );
      const expected = { head: headOf(other), checkout: rootOf(other) };

      vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
      const read = readHead(other, main);
      vi.unstubAllEnvs();

      expect(read).toEqual(expected);
      const startedIn = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(new Set(startedIn)).toEqual(new Set([fs.realpathSync(main)]));
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});
