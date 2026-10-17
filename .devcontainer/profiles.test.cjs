'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const ts = require('typescript');
const { profile } = require('./profile.cjs');
const { bootstrap } = require('./bootstrap-native.cjs');
const source = fs.readFileSync(path.join(__dirname, 'devcontainer.json'), 'utf8');
const parse = (text) => {
  const result = ts.parseConfigFileTextToJson('devcontainer.json', text);
  assert.equal(result.error, undefined);
  return result.config;
};

test('native/UI profile inherits hooks, storage and defaults while changing workspace and browser setup', () => {
  const c = parse(
    profile(source, { native: true, ui: true, playwright: '1.63.0', ref: 'feature/test' }),
  );
  assert.match(c.workspaceMount, /type=volume/);
  assert.match(c.onCreateCommand, /bootstrap-native/);
  assert.equal(c.containerEnv.GITNEXUS_CLONE_REF, 'feature/test');
  assert.equal(c.build.args.PLAYWRIGHT_VERSION, '1.63.0');
  assert.equal(c.containerEnv.GITNEXUS_DEV_UI, '1');
  assert.ok(c.mounts.some((m) => m.includes('ms-playwright')));
  assert.ok(c.mounts.some((m) => m.includes('/home/node/.gitnexus')));
  assert.deepEqual(c.capAdd, ['SYS_ADMIN']);
  assert.equal(c.updateContentCommand, 'bash .devcontainer/install-deps.sh');
});

test('prebuilt consumers retain runtime lifecycle and do not reinstall image features', () => {
  const c = parse(profile(source, { image: 'ghcr.io/example/devcontainer@sha256:abcd' }));
  assert.equal(c.build, undefined);
  assert.equal(c.image, 'ghcr.io/example/devcontainer@sha256:abcd');
  assert.deepEqual(c.features, {});
  assert.equal(c.postCreateCommand, 'bash .devcontainer/post-create.sh');
});

test('published toolchain metadata excludes host mounts and lifecycle hooks', () => {
  const c = parse(profile(source, { imageOnly: true, ui: true, playwright: '1.63.0' }));
  assert.equal(c.mounts, undefined);
  assert.equal(c.updateContentCommand, undefined);
  assert.equal(c.containerEnv, undefined);
  assert.equal(c.build.args.INSTALL_BROWSER_DEPS, 'true');
  assert.ok(c.features['ghcr.io/devcontainers/features/github-cli:1']);
});

test('profile generator rejects unsafe values and changed canonical layout', () => {
  assert.throws(() => profile(source, { ref: '--upload-pack=bad' }), /Invalid/);
  assert.throws(() => profile(source, { image: 'image;bad' }), /Invalid/);
  assert.throws(
    () => profile(source.replace('"context": "."', '"context": "elsewhere"')),
    /layout changed/,
  );
});

test('native workspace preserves edits, rejects a different origin and resumes interrupted fetches', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-native-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  const git = (...args) => execFileSync('git', args, { cwd: origin, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Profile test');
  git('config', 'user.email', 'profile@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(origin, 'file'), 'source');
  git('add', 'file');
  git('commit', '-m', 'fixture');
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(path.join(checkout, 'node_modules'), { recursive: true });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const ownershipLog = path.join(root, 'ownership.json');
  fs.writeFileSync(
    path.join(bin, 'sudo'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(ownershipLog)}, JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'bootstrap-native.cjs'), checkout],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITNEXUS_CLONE_URL: origin,
        GITNEXUS_CLONE_REF: 'main',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const ownership = JSON.parse(fs.readFileSync(ownershipLog, 'utf8'));
  assert.deepEqual(ownership.slice(0, 4), ['-n', 'find', checkout, '-xdev']);
  assert.ok(ownership.includes('-h'));
  fs.writeFileSync(path.join(checkout, 'file'), 'local edits');
  bootstrap(checkout, origin, 'main');
  assert.equal(fs.readFileSync(path.join(checkout, 'file'), 'utf8'), 'local edits');
  assert.throws(() => bootstrap(checkout, path.join(root, 'other'), 'main'), /another origin/);
  const retry = path.join(root, 'retry');
  assert.throws(() => bootstrap(retry, origin, 'new-branch'));
  git('branch', 'new-branch');
  bootstrap(retry, origin, 'new-branch');
  assert.equal(fs.readFileSync(path.join(retry, 'file'), 'utf8'), 'source');
  const conflict = path.join(root, 'conflict');
  fs.mkdirSync(conflict);
  fs.writeFileSync(path.join(conflict, 'file'), 'pre-existing user file');
  assert.throws(() => bootstrap(conflict, origin, 'main'));
  assert.equal(fs.readFileSync(path.join(conflict, 'file'), 'utf8'), 'pre-existing user file');
});
