import { describe, it } from 'node:test';
import { expect } from 'expect';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import {
  gitExecutable,
  makeIsolatedGitRepo,
} from '../../../../test/helpers/isolated-git-checkout.js';
import { registerCases } from '../support/cases.mjs';

/** A repo with two committed files, `a.ts` and `lib/b.ts`. */
function makeCommittedRepo(): string {
  const repo = makeIsolatedGitRepo();
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;');
  fs.mkdirSync(path.join(repo, 'lib'));
  fs.writeFileSync(path.join(repo, 'lib', 'b.ts'), 'export const b = 1;');
  execFileSync(gitExecutable, ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync(gitExecutable, ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

const gitIn = (repo: string, ...args: string[]): string =>
  execFileSync(gitExecutable, args, { cwd: repo, encoding: 'utf8' }).trim();

describe('isWorkingTreeDirty', () => {
  it('returns true when a real source file changes (regression: excludes must not mask real edits)', async () => {
    const { isWorkingTreeDirty } = await import('../../../../src/storage/git.js');
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
});

describe('listWorkingTreeDirtyPaths', () => {
  it('returns dirty source paths and omits GitNexus-managed writes', async () => {
    const { listWorkingTreeDirtyPaths } = await import('../../../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
      execSync('git add -A && git commit -q -m init', { cwd: repo, stdio: 'ignore' });
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', 'foo.ts'), 'export const x = 1;');
      fs.mkdirSync(path.join(repo, '.gitnexus'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.gitnexus', 'meta.json'), '{}');
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'x');

      expect(listWorkingTreeDirtyPaths(repo)).toEqual(['src/foo.ts']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves non-ASCII, newline, and arrow-shaped filenames exactly', async () => {
    const { listWorkingTreeDirtyPaths } = await import('../../../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    const names = ['src/ä.ts'];
    if (process.platform !== 'win32') {
      names.push('src/a -> b.ts', 'src/line\nbreak.ts', 'src/tab\tname.ts', 'src/back\\slash.ts');
    }
    try {
      for (const name of names) {
        fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
        fs.writeFileSync(path.join(repo, name), 'before');
      }
      execFileSync(gitExecutable, ['add', '--', ...names], { cwd: repo, stdio: 'ignore' });
      execFileSync(gitExecutable, ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
      for (const name of names) fs.writeFileSync(path.join(repo, name), 'after');

      expect(listWorkingTreeDirtyPaths(repo)?.sort()).toEqual([...names].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns both paths for a rename without parsing filename text', async () => {
    const { listWorkingTreeDirtyPaths } = await import('../../../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    const arrow = process.platform === 'win32' ? '→' : '->';
    const before = `src/before ${arrow} literal.ts`;
    const after = `src/after ${arrow} literal.ts`;
    try {
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, before), 'content');
      execFileSync(gitExecutable, ['add', '--', before], { cwd: repo, stdio: 'ignore' });
      execFileSync(gitExecutable, ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
      execFileSync(gitExecutable, ['mv', '--', before, after], { cwd: repo, stdio: 'ignore' });

      expect(listWorkingTreeDirtyPaths(repo)?.sort()).toEqual([after, before].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  registerCases(
    it,
    ['--assume-unchanged', '--skip-worktree'],
    'includes paths hidden by git update-index %s',
    async (flag: string) => {
      const { listWorkingTreeDirtyPaths } = await import('../../../../src/storage/git.js');
      const repo = makeIsolatedGitRepo();
      try {
        fs.writeFileSync(path.join(repo, 'hidden.ts'), 'before');
        execFileSync(gitExecutable, ['add', '--', 'hidden.ts'], { cwd: repo, stdio: 'ignore' });
        execFileSync(gitExecutable, ['commit', '-q', '-m', 'init'], {
          cwd: repo,
          stdio: 'ignore',
        });
        execFileSync(gitExecutable, ['update-index', flag, '--', 'hidden.ts'], {
          cwd: repo,
          stdio: 'ignore',
        });
        fs.writeFileSync(path.join(repo, 'hidden.ts'), 'after');

        expect(listWorkingTreeDirtyPaths(repo)).toContain('hidden.ts');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('preserves exact unusual names hidden by index bits, including both bits', async () => {
    const { listWorkingTreeDirtyPaths } = await import('../../../../src/storage/git.js');
    const repo = makeIsolatedGitRepo();
    const names =
      process.platform === 'win32'
        ? ['ä.ts', 'a → b.ts', 'two  spaces.ts', '[brackets].ts']
        : ['ä.ts', 'a -> b.ts', 'tab\tname.ts', 'line\nbreak.ts'];
    try {
      for (const name of names) fs.writeFileSync(path.join(repo, name), 'before');
      execFileSync(gitExecutable, ['add', '--', ...names], { cwd: repo, stdio: 'ignore' });
      execFileSync(gitExecutable, ['commit', '-q', '-m', 'init'], {
        cwd: repo,
        stdio: 'ignore',
      });
      execFileSync(gitExecutable, ['update-index', '--assume-unchanged', '--', names[0]], {
        cwd: repo,
        stdio: 'ignore',
      });
      execFileSync(gitExecutable, ['update-index', '--skip-worktree', '--', names[1]], {
        cwd: repo,
        stdio: 'ignore',
      });
      execFileSync(gitExecutable, ['update-index', '--assume-unchanged', '--', names[2]], {
        cwd: repo,
        stdio: 'ignore',
      });
      execFileSync(gitExecutable, ['update-index', '--skip-worktree', '--', names[2]], {
        cwd: repo,
        stdio: 'ignore',
      });
      execFileSync(gitExecutable, ['update-index', '--skip-worktree', '--', names[3]], {
        cwd: repo,
        stdio: 'ignore',
      });
      for (const name of names) fs.writeFileSync(path.join(repo, name), 'after');

      expect(listWorkingTreeDirtyPaths(repo)?.sort()).toEqual([...names].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('isWorkingTreePristine', () => {
  it('is true for a clean checkout, ignoring GitNexus-managed writes', async () => {
    const { isWorkingTreePristine } = await import('../../../../src/storage/git.js');
    const repo = makeCommittedRepo();
    try {
      fs.mkdirSync(path.join(repo, '.gitnexus'));
      fs.writeFileSync(path.join(repo, '.gitnexus', 'meta.json'), '{}');
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'x');

      expect(isWorkingTreePristine(repo)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is false with an untracked source file', async () => {
    const { isWorkingTreePristine } = await import('../../../../src/storage/git.js');
    const repo = makeCommittedRepo();
    try {
      fs.writeFileSync(path.join(repo, 'new.ts'), 'export const n = 1;');

      expect(isWorkingTreePristine(repo)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  registerCases(
    it,
    ['--assume-unchanged', '--skip-worktree'],
    'is false when git update-index %s hides a path, even with unchanged content',
    async (flag: string) => {
      const { isWorkingTreePristine } = await import('../../../../src/storage/git.js');
      const repo = makeCommittedRepo();
      try {
        gitIn(repo, 'update-index', flag, '--', 'a.ts');

        expect(isWorkingTreePristine(repo)).toBe(false);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  registerCases(
    it,
    [
      ['no-cone', ['set', '--no-cone', '/a.ts']],
      ['cone', ['set', '--cone']],
      ['cone with a sparse index', ['set', '--cone', '--sparse-index']],
    ],
    'is false in a %s sparse checkout that leaves committed files out',
    async (_mode: string, args: string[]) => {
      const { isWorkingTreePristine } = await import('../../../../src/storage/git.js');
      const repo = makeCommittedRepo();
      try {
        gitIn(repo, 'sparse-checkout', ...args);

        expect(fs.existsSync(path.join(repo, 'lib', 'b.ts'))).toBe(false);
        expect(isWorkingTreePristine(repo)).toBe(false);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('is false with a registered but uninitialized submodule', async () => {
    const { isWorkingTreePristine } = await import('../../../../src/storage/git.js');
    const repo = makeCommittedRepo();
    try {
      const head = gitIn(repo, 'rev-parse', 'HEAD');
      gitIn(repo, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/dep`);
      gitIn(repo, 'commit', '-q', '-m', 'add gitlink');

      expect(isWorkingTreePristine(repo)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is true with a checked-out submodule', async () => {
    const { isWorkingTreePristine } = await import('../../../../src/storage/git.js');
    const repo = makeCommittedRepo();
    try {
      const sub = path.join(repo, 'vendor', 'dep');
      fs.mkdirSync(sub, { recursive: true });
      gitIn(sub, 'init', '-q');
      fs.writeFileSync(path.join(sub, 'c.ts'), 'export const c = 1;');
      gitIn(sub, 'add', '-A');
      gitIn(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sub');
      gitIn(repo, 'add', 'vendor/dep');
      gitIn(repo, 'commit', '-q', '-m', 'add submodule');

      expect(isWorkingTreePristine(repo)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
