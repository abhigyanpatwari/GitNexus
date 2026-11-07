'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { seedWorkspace, restoreLinks } = require('./seed-workspace.cjs');

// seed-workspace.cjs commits the stage and restores links only inside the Linux
// dev container and import helper; host-side importer tests live in
// initialize-volumes.test.cjs and run on Linux, macOS and Windows.
const containerSide = {
  skip: process.platform !== 'linux' && 'runs only inside the Linux dev container and helper',
};

test(
  'symlink restoration rejects traversal, symlink parents and replacements before writing',
  containerSide,
  (t) => {
    const { root, target } = fixture(t);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target, 'parent'), 'dir');
    fs.writeFileSync(path.join(target, 'existing'), 'keep');
    for (const links of [
      [['../escape', 'target']],
      [['parent/escape', 'target']],
      [['existing', 'target']],
      [
        ['new-link', 'target'],
        ['new-link/child', 'target'],
      ],
      [
        ['new-link/child', 'target'],
        ['new-link', 'target'],
      ],
      [
        ['new-link', 'target'],
        ['new-link', 'duplicate'],
      ],
      [
        ['new-link', 'target'],
        ['../escape', 'target'],
      ],
    ]) {
      assert.throws(() => restoreLinks(target, links));
      // lstat: a created link to the missing 'target' would be dangling.
      assert.equal(
        fs.lstatSync(path.join(target, 'new-link'), { throwIfNoEntry: false }),
        undefined,
      );
    }
    assert.equal(fs.readFileSync(path.join(target, 'existing'), 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(outside), []);
  },
);

test(
  'symlink restoration creates missing parents for selected snapshot files',
  containerSide,
  (t) => {
    const { target } = fixture(t);
    restoreLinks(target, [['.config/gh', '../git-config']]);
    assert.equal(fs.readlinkSync(path.join(target, '.config/gh')), '../git-config');
  },
);

function fixture(t, repairOwner = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-source-volume-'));
  t.after(() => {
    if (repairOwner)
      execFileSync('sudo', ['chown', '-R', `${process.getuid()}:${process.getgid()}`, root]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'host');
  const target = path.join(root, 'volume');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git(source, 'init', '-b', 'local-work');
  git(source, 'config', 'user.name', 'Volume test');
  git(source, 'config', 'user.email', 'volume@example.invalid');
  git(source, 'config', 'commit.gpgsign', 'false');
  git(source, 'config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(source, 'tracked'), 'committed\n');
  git(source, 'add', 'tracked');
  git(source, 'commit', '-m', 'local commit');
  return { root, source, target, git };
}

test(
  'seed preserves Git state, local files, indexes, nested worktrees and symlinks',
  containerSide,
  (t) => {
    const { source, target, git } = fixture(t);
    git(source, 'remote', 'add', 'origin', 'https://example.invalid/fork.git');
    fs.writeFileSync(path.join(source, 'tracked'), 'stashed\n');
    git(source, 'stash', 'push');
    fs.writeFileSync(path.join(source, 'tracked'), 'staged\n');
    git(source, 'add', 'tracked');
    fs.writeFileSync(path.join(source, 'tracked'), 'unstaged\n');
    fs.writeFileSync(path.join(source, '.git/commondir'), '.\n');
    fs.writeFileSync(path.join(source, '.git/info/exclude'), 'node_modules/\nignored-local\n');
    fs.writeFileSync(path.join(source, 'ignored-local'), 'local settings\n');
    fs.writeFileSync(path.join(source, 'untracked'), 'untracked\n');
    fs.symlinkSync('tracked', path.join(source, 'relative-link'));
    fs.symlinkSync('missing-file', path.join(source, 'dangling-link'));
    fs.writeFileSync(path.join(source, 'executable'), '#!/bin/sh\n');
    fs.chmodSync(path.join(source, 'executable'), 0o755); // Independent of the process umask.
    for (const file of [
      '.gitnexus/index-sample',
      '.gitnexus/parse-cache/chunk.v8',
      '.gitnexus/parse-cache.json',
      '.gitnexus/parsedfile-cache/chunk.v8',
      '.worktrees/topic/.gitnexus/parse-cache/chunk.v8',
      '.worktrees/topic/.gitnexus/parsedfile-cache/chunk.v8',
      '.worktrees/topic/.gitnexus/lbug',
      '.claude/worktrees/topic/.gitnexus/parse-cache/chunk.v8',
      '.worktrees/topic/local-edit',
      '.git/worktrees/topic/gitdir',
      'eval/.venv/bin/python',
      'eval/.venv/pyvenv.cfg',
      'eval/.venv-notes/local-file',
      'eval/local-script.py',
      '.worktrees/topic/gitnexus-shared/node_modules/binary',
      '.worktrees/topic/eval/.venv/bin/python',
      '.worktrees/topic/.husky/_/h',
      '.claude/worktrees/topic/local-edit',
      '.claude/worktrees/topic/node_modules/binary',
    ]) {
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      fs.writeFileSync(path.join(source, file), 'preserve me\n');
    }
    const overlays = [
      'node_modules',
      'gitnexus/node_modules',
      'gitnexus-web/node_modules',
      'gitnexus-shared/node_modules',
    ];
    for (const folder of overlays) {
      fs.mkdirSync(path.join(source, folder), { recursive: true });
      fs.mkdirSync(path.join(target, folder), { recursive: true });
      fs.writeFileSync(path.join(source, folder, 'host-dependency'), 'host binary');
      fs.writeFileSync(path.join(target, folder, 'volume-dependency'), 'Linux binary');
    }
    fs.mkdirSync(path.join(source, '.husky/_'), { recursive: true });
    fs.writeFileSync(path.join(source, '.husky/_/h'), 'generated');
    fs.writeFileSync(path.join(source, '.husky/pre-commit'), 'tracked hook');
    const before = git(source, 'status', '--porcelain=v1', '--untracked-files=all');
    const index = fs.readFileSync(path.join(source, '.git/index'));
    assert.equal(seedWorkspace(source, target), true);
    assert.equal(git(target, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'));
    assert.equal(git(target, 'branch', '--show-current'), 'local-work');
    assert.equal(git(target, 'stash', 'list'), git(source, 'stash', 'list'));
    assert.equal(git(target, 'remote', 'get-url', 'origin'), 'https://example.invalid/fork.git');
    assert.equal(git(target, 'show', ':tracked'), 'staged');
    assert.equal(fs.readFileSync(path.join(target, 'tracked'), 'utf8'), 'unstaged\n');
    assert.deepEqual(fs.readFileSync(path.join(target, '.git/index')), index);
    assert.equal(git(source, 'status', '--porcelain=v1', '--untracked-files=all'), before);
    for (const file of [
      'ignored-local',
      'untracked',
      '.gitnexus/index-sample',
      '.worktrees/topic/.gitnexus/lbug',
      '.worktrees/topic/local-edit',
      '.git/worktrees/topic/gitdir',
      '.husky/pre-commit',
      'eval/.venv-notes/local-file',
      'eval/local-script.py',
    ]) {
      assert.deepEqual(
        fs.readFileSync(path.join(target, file)),
        fs.readFileSync(path.join(source, file)),
      );
    }
    assert.equal(fs.readlinkSync(path.join(target, 'relative-link')), 'tracked');
    assert.equal(fs.readlinkSync(path.join(target, 'dangling-link')), 'missing-file');
    assert.equal(fs.statSync(path.join(target, 'executable')).mode & 0o777, 0o755);
    assert.equal(fs.existsSync(path.join(target, '.husky/_')), false);
    assert.equal(fs.existsSync(path.join(target, 'eval/.venv')), false);
    for (const folder of [
      '.gitnexus/parse-cache',
      '.gitnexus/parse-cache.json',
      '.gitnexus/parsedfile-cache',
      '.worktrees/topic/.gitnexus/parse-cache',
      '.worktrees/topic/.gitnexus/parsedfile-cache',
      '.claude/worktrees/topic/.gitnexus/parse-cache',
      '.worktrees/topic/gitnexus-shared/node_modules',
      '.worktrees/topic/eval/.venv',
      '.worktrees/topic/.husky/_',
      '.claude/worktrees/topic/node_modules',
    ]) {
      assert.equal(fs.existsSync(path.join(target, folder)), false, folder);
      assert.equal(fs.existsSync(path.join(source, folder)), true, `host keeps ${folder}`);
    }
    assert.equal(
      fs.readFileSync(path.join(target, '.claude/worktrees/topic/local-edit'), 'utf8'),
      'preserve me\n',
    );
    for (const folder of overlays) {
      assert.equal(fs.existsSync(path.join(target, folder, 'host-dependency')), false);
      assert.equal(
        fs.readFileSync(path.join(target, folder, 'volume-dependency'), 'utf8'),
        'Linux binary',
      );
    }
  },
);

test(
  'recreation keeps volume edits and never synchronizes later host changes',
  containerSide,
  (t) => {
    const { source, target } = fixture(t);
    seedWorkspace(source, target);
    fs.writeFileSync(path.join(target, 'tracked'), 'volume work');
    fs.writeFileSync(path.join(target, 'new-volume-file'), 'new work');
    fs.writeFileSync(path.join(source, 'tracked'), 'changed host');
    fs.writeFileSync(path.join(source, 'host-only'), 'do not copy');
    assert.equal(seedWorkspace(source, target), false);
    assert.equal(fs.readFileSync(path.join(target, 'tracked'), 'utf8'), 'volume work');
    assert.equal(fs.readFileSync(path.join(target, 'new-volume-file'), 'utf8'), 'new work');
    assert.equal(fs.existsSync(path.join(target, 'host-only')), false);
    // A previously seeded host checkout must not publish its old marker early.
    const next = path.join(path.dirname(target), 'next-volume');
    fs.mkdirSync(next);
    assert.equal(seedWorkspace(target, next), true);
    assert.equal(fs.readFileSync(path.join(next, 'tracked'), 'utf8'), 'volume work');
  },
);

test('seed clears core.worktree only in the copy', containerSide, (t) => {
  const { source, target, git } = fixture(t);
  git(source, 'config', 'core.worktree', source);
  git(source, 'config', 'extensions.worktreeConfig', 'true');
  git(source, 'config', '--worktree', 'core.worktree', source);
  seedWorkspace(source, target);
  assert.equal(git(source, 'config', '--get', 'core.worktree'), source);
  assert.equal(git(source, 'config', '--worktree', '--get', 'core.worktree'), source);
  assert.equal(git(target, 'rev-parse', '--show-toplevel'), target);
});

test('seed refuses a symlinked Git config without modifying its target', containerSide, (t) => {
  const { root, source, target } = fixture(t);
  const external = path.join(root, 'external-config');
  fs.renameSync(path.join(source, '.git/config'), external);
  const original = fs.readFileSync(external);
  fs.symlinkSync(external, path.join(source, '.git/config'));
  assert.throws(() => seedWorkspace(source, target), /regular file/);
  assert.deepEqual(fs.readFileSync(external), original);
  assert.deepEqual(fs.readdirSync(target), []);
});

test(
  'refuses incomplete copies and unexpected files even inside mount parents',
  containerSide,
  (t) => {
    const { source, target } = fixture(t);
    for (const entry of ['.git/HEAD', 'gitnexus/local-work', 'untracked']) {
      fs.mkdirSync(path.dirname(path.join(target, entry)), { recursive: true });
      fs.writeFileSync(path.join(target, entry), 'keep');
      assert.throws(() => seedWorkspace(source, target), /Uninitialized source volume/);
      assert.equal(fs.readFileSync(path.join(target, entry), 'utf8'), 'keep');
      assert.equal(fs.existsSync(path.join(target, '.git/devcontainer-source-volume')), false);
      fs.rmSync(path.join(target, entry.split('/')[0]), { recursive: true });
    }
    fs.symlinkSync(source, path.join(target, 'gitnexus'));
    assert.throws(() => seedWorkspace(source, target), /Uninitialized source volume/);
  },
);

test(
  'refuses linked checkouts, external object stores, active Git operations and nested targets',
  containerSide,
  (t) => {
    const { root, source, target, git } = fixture(t);
    const linked = path.join(root, 'linked');
    git(source, 'worktree', 'add', '--detach', linked);
    assert.throws(() => seedWorkspace(linked, target), /full Git checkout/);
    fs.writeFileSync(path.join(source, '.git/objects/info/alternates'), '/some/other/objects\n');
    assert.throws(() => seedWorkspace(source, target), /own Git object database/);
    fs.rmSync(path.join(source, '.git/objects/info/alternates'));
    fs.writeFileSync(path.join(source, '.git/commondir'), path.join(source, '.git/objects'));
    assert.throws(() => seedWorkspace(source, target), /own Git object database/);
    fs.rmSync(path.join(source, '.git/commondir'));
    fs.writeFileSync(path.join(source, '.git/index.lock'), 'busy');
    assert.throws(() => seedWorkspace(source, target), /Git operation is active/);
    fs.rmSync(path.join(source, '.git/index.lock'));
    assert.throws(() => seedWorkspace(source, source), /separate directories/);
    const nested = path.join(source, 'nested');
    fs.mkdirSync(nested);
    assert.throws(() => seedWorkspace(source, nested), /separate directories/);
    assert.deepEqual(fs.readdirSync(target), []);
  },
);
test(
  'root preparation recovers an inaccessible old-UID volume and prunes dependencies',
  containerSide,
  (t) => {
    if (spawnSync('sudo', ['-n', 'true']).status !== 0) return t.skip('requires passwordless sudo');
    const { root, source, target } = fixture(t, true);
    seedWorkspace(source, target);
    const staging = path.join(root, 'seed');
    fs.mkdirSync(path.join(staging, 'tree/leftover'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'stage-complete'), '');
    const dependency = path.join(target, 'gitnexus/node_modules');
    fs.mkdirSync(dependency, { recursive: true });
    fs.chmodSync(dependency, 0o755); // Let the test stat it after the foreign chown.
    fs.writeFileSync(path.join(dependency, 'keep-owner'), 'binary');
    execFileSync('sudo', ['chown', '-R', '20001:20001', target]);
    execFileSync('sudo', ['chmod', '700', path.join(target, '.git')]);
    const result = spawnSync(
      'sudo',
      [
        '-n',
        process.execPath,
        path.join(__dirname, 'seed-workspace.cjs'),
        '--prepare',
        target,
        staging,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(path.join(target, '.git')).uid, process.getuid());
    assert.equal(fs.statSync(path.join(dependency, 'keep-owner')).uid, 20001);
    assert.deepEqual(fs.readdirSync(staging), []); // A ready volume discards the stale stage.
    assert.equal(seedWorkspace('/missing-host', target), false);
  },
);

test(
  'rejects an absolute self commondir before copying or modifying either repository',
  containerSide,
  (t) => {
    const { source, target } = fixture(t);
    fs.writeFileSync(path.join(source, '.git/commondir'), path.join(source, '.git'));
    const config = fs.readFileSync(path.join(source, '.git/config'));
    assert.throws(() => seedWorkspace(source, target), /commondir must be/);
    assert.deepEqual(fs.readdirSync(target), []);
    assert.deepEqual(fs.readFileSync(path.join(source, '.git/config')), config);
  },
);

test(
  'adapts Windows flags, executable modes and symlinks while preserving local edits and index',
  containerSide,
  (t) => {
    const { source, target, git } = fixture(t);
    fs.writeFileSync(path.join(source, 'foo.ts'), 'original');
    fs.writeFileSync(path.join(source, 'script'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync('foo.ts', path.join(source, 'link'));
    fs.symlinkSync('foo.ts', path.join(source, 'edited-link'));
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'Linux modes before Windows checkout');
    for (const name of ['link', 'edited-link']) {
      fs.unlinkSync(path.join(source, name));
      fs.writeFileSync(path.join(source, name), name === 'link' ? 'foo.ts' : 'local link edits');
    }
    fs.chmodSync(path.join(source, 'script'), 0o644);
    fs.chmodSync(path.join(source, 'foo.ts'), 0o755);
    git(source, 'config', 'extensions.worktreeConfig', 'true');
    for (const [key, value] of [
      ['core.filemode', 'false'],
      ['core.ignorecase', 'true'],
      ['core.symlinks', 'false'],
    ]) {
      git(source, 'config', key, value);
      git(source, 'config', '--worktree', key, value);
    }
    fs.writeFileSync(path.join(source, 'tracked'), 'staged');
    git(source, 'add', 'tracked');
    fs.writeFileSync(path.join(source, 'tracked'), 'unstaged');
    const index = fs.readFileSync(path.join(source, '.git/index'));
    seedWorkspace(source, target);
    assert.deepEqual(fs.readFileSync(path.join(target, '.git/index')), index);
    assert.equal(git(target, 'show', ':tracked'), 'staged');
    assert.equal(fs.readFileSync(path.join(target, 'tracked'), 'utf8'), 'unstaged');
    assert.equal(git(target, 'config', 'core.ignorecase'), 'false');
    assert.equal(git(target, 'config', 'core.filemode'), 'true');
    assert.equal(git(target, 'config', 'core.symlinks'), 'true');
    assert.equal(fs.statSync(path.join(target, 'script')).mode & 0o111, 0o111);
    assert.equal(fs.statSync(path.join(target, 'foo.ts')).mode & 0o111, 0);
    assert.equal(fs.readlinkSync(path.join(target, 'link')), 'foo.ts');
    assert.equal(fs.readFileSync(path.join(target, 'edited-link'), 'utf8'), 'local link edits');
    fs.writeFileSync(path.join(target, 'Foo.ts'), 'case-sensitive new file');
    fs.chmodSync(path.join(target, 'script'), 0o644);
    const status = git(target, 'status', '--porcelain');
    assert.match(status, /\?\? Foo.ts/);
    assert.match(status, / M script/);
    assert.equal(git(source, 'config', 'core.ignorecase'), 'true');
    assert.equal(fs.lstatSync(path.join(source, 'link')).isFile(), true);
  },
);

test(
  'normalizes a nested worktree with independent Windows filesystem overrides',
  containerSide,
  (t) => {
    const { source, target, git } = fixture(t);
    fs.writeFileSync(path.join(source, 'script'), '#!/bin/sh\n', { mode: 0o755 });
    git(source, 'add', 'script');
    git(source, 'commit', '-m', 'executable');
    git(source, 'config', 'extensions.worktreeConfig', 'true');
    const nested = path.join(source, '.worktrees/topic');
    git(source, 'worktree', 'add', '--detach', nested);
    for (const [key, value] of [
      ['core.filemode', 'false'],
      ['core.ignorecase', 'true'],
    ])
      git(nested, 'config', '--worktree', key, value);
    fs.chmodSync(path.join(nested, 'script'), 0o644);
    fs.writeFileSync(path.join(nested, 'tracked'), 'nested local edits');
    const index = fs.readFileSync(path.join(source, '.git/worktrees/topic/index'));
    // A host-created worktree records host paths that do not exist in the volume.
    const host = 'C:/Users/dev/GitNexus';
    git(nested, 'config', '--worktree', 'core.worktree', `${host}/.worktrees/topic`);
    const nestedConfig = path.join(source, '.git/worktrees/topic/config.worktree');
    const registration = path.join(source, '.git/worktrees/topic/gitdir');
    fs.writeFileSync(registration, `${host}/.worktrees/topic/.git\n`);
    fs.writeFileSync(path.join(nested, '.git'), `gitdir: ${host}/.git/worktrees/topic\n`);
    seedWorkspace(source, target);
    const copied = path.join(target, '.worktrees/topic');
    assert.equal(git(copied, 'rev-parse', '--show-toplevel'), copied);
    assert.throws(() => git(copied, 'config', '--worktree', '--get-all', 'core.worktree'), {
      status: 1,
    });
    assert.equal(
      git(source, 'config', '--file', nestedConfig, 'core.worktree'),
      `${host}/.worktrees/topic`,
    );
    assert.equal(git(target, 'worktree', 'list', '--porcelain').includes(copied), true);
    assert.equal(fs.readFileSync(registration, 'utf8'), `${host}/.worktrees/topic/.git\n`);
    assert.equal(git(copied, 'config', 'core.filemode'), 'true');
    assert.equal(git(copied, 'config', 'core.ignorecase'), 'false');
    assert.equal(fs.statSync(path.join(copied, 'script')).mode & 0o111, 0o111);
    assert.equal(fs.readFileSync(path.join(copied, 'tracked'), 'utf8'), 'nested local edits');
    assert.deepEqual(fs.readFileSync(path.join(target, '.git/worktrees/topic/index')), index);
  },
);
