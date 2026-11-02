'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const verifier = path.join(__dirname, 'verify-git-hooks.cjs');
const husky = path.resolve(__dirname, '../node_modules/husky/bin.js');

function fixture(t, install = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-husky-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const globalConfig = path.join(root, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    HUSKY: '',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
  };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
    delete env[key];
  const options = { cwd: root, env, encoding: 'utf8' };
  const git = (...args) => execFileSync('git', args, options);
  git('init', '-q');
  git('config', 'user.name', 'Husky test');
  git('config', 'user.email', 'husky-test@example.invalid');
  fs.mkdirSync(path.join(root, '.husky'));
  fs.copyFileSync(
    path.resolve(__dirname, '../.husky/pre-commit'),
    path.join(root, '.husky/pre-commit'),
  );
  if (install) execFileSync(process.execPath, [husky], options);
  const verify = (overrides = {}) =>
    spawnSync(process.execPath, [verifier], { ...options, env: { ...env, ...overrides } });
  const commit = () => spawnSync('git', ['commit', '--allow-empty', '-m', 'hook test'], options);
  const tool = (file, status) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `#!/bin/sh\nprintf called > "$0.called"\nexit ${status}\n`, {
      mode: 0o755,
    });
    return `${target}.called`;
  };
  return { root, git, verify, commit, tool };
}

test('Husky verification accepts a real installation', (t) => {
  const repo = fixture(t);
  const result = repo.verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed and enabled/);
});

test('Husky verification rejects missing Git hook configuration', (t) => {
  const repo = fixture(t, false);
  assert.equal(repo.verify().status, 1);
});

test('Husky verification rejects a cleared cache without removing the tracked hook', (t) => {
  const repo = fixture(t);
  fs.rmSync(path.join(repo.root, '.husky/_'), { recursive: true });
  assert.equal(repo.verify().status, 1);
  assert.ok(fs.existsSync(path.join(repo.root, '.husky/pre-commit')));
});

test('Husky verification rejects hooks redirected elsewhere', (t) => {
  const repo = fixture(t);
  repo.git('config', 'core.hooksPath', 'other-hooks');
  assert.equal(repo.verify().status, 1);
});

test('Husky verification rejects a missing tracked pre-commit script', (t) => {
  const repo = fixture(t);
  fs.rmSync(path.join(repo.root, '.husky/pre-commit'));
  assert.equal(repo.verify().status, 1);
});

test('Husky verification rejects a non-executable Git hook', (t) => {
  const repo = fixture(t);
  fs.chmodSync(path.join(repo.root, '.husky/_/pre-commit'), 0o644);
  assert.equal(repo.verify().status, 1);
});

test('Husky verification rejects an explicitly disabled hook', (t) => {
  const repo = fixture(t);
  const result = repo.verify({ HUSKY: '0' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HUSKY=0 disables/);
});

for (const init of ['export HUSKY=0\n', 'exit 0\n']) {
  test(`Husky verification rejects startup configuration ${init.trim()}`, (t) => {
    const repo = fixture(t);
    const marker = repo.tool('node_modules/.bin/lint-staged', 1);
    fs.mkdirSync(path.join(repo.root, 'xdg/husky'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, 'xdg/husky/init.sh'), init);
    const result = repo.verify();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /startup configuration disables or skips/);
    // Demonstrate why the verifier must fail: real Git would skip the formatter.
    assert.equal(repo.commit().status, 0);
    assert.equal(fs.existsSync(marker), false);
  });
}

test('Husky probe accepts enabled startup configuration without running the tracked hook', (t) => {
  const repo = fixture(t);
  const marker = repo.tool('node_modules/.bin/lint-staged', 1);
  fs.mkdirSync(path.join(repo.root, 'xdg/husky'), { recursive: true });
  fs.writeFileSync(path.join(repo.root, 'xdg/husky/init.sh'), 'export HUSKY=1\nprintf startup\n');
  assert.equal(repo.verify().status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(repo.commit().status, 1);
  assert.equal(fs.existsSync(marker), true);
});

test('Git rejects a commit when the actual pre-commit formatter fails', (t) => {
  const repo = fixture(t);
  const marker = repo.tool('node_modules/.bin/lint-staged', 1);
  assert.equal(repo.verify().status, 0);
  const result = repo.commit();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout + result.stderr, /pre-commit: formatting staged files/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'called');
  assert.throws(() => repo.git('rev-parse', '--verify', 'HEAD'));
});

for (const pkg of ['gitnexus', 'gitnexus-web']) {
  test(`Git rejects a commit when the actual ${pkg} pre-commit typecheck fails`, (t) => {
    const repo = fixture(t);
    repo.tool('node_modules/.bin/lint-staged', 0);
    const marker = repo.tool(`${pkg}/node_modules/.bin/tsc`, 1);
    fs.writeFileSync(path.join(repo.root, pkg, 'change.ts'), 'export const value = 1;\n');
    repo.git('add', `${pkg}/change.ts`);
    assert.equal(repo.verify().status, 0);
    const result = repo.commit();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout + result.stderr, new RegExp(`pre-commit: typechecking ${pkg}`));
    assert.equal(fs.readFileSync(marker, 'utf8'), 'called');
    assert.throws(() => repo.git('rev-parse', '--verify', 'HEAD'));
  });
}

test('Git accepts a commit when the actual pre-commit checks pass', (t) => {
  const repo = fixture(t);
  repo.tool('node_modules/.bin/lint-staged', 0);
  assert.equal(repo.verify().status, 0);
  const result = repo.commit();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /pre-commit: all checks passed/);
  assert.ok(repo.git('rev-parse', '--verify', 'HEAD').trim());
});
