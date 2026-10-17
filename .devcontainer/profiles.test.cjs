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

test('image consumers retain configured features and runtime lifecycle', () => {
  for (const options of [{}, { native: true }, { ui: true }, { native: true, ui: true }]) {
    const image = 'ghcr.io/example/devcontainer@sha256:abcd';
    const c = parse(profile(source, { ...options, image }));
    assert.equal(c.build, undefined);
    assert.equal(c.image, image);
    assert.deepEqual(c.features, parse(source).features);
    assert.ok(c.features['ghcr.io/devcontainers/features/github-cli:1']);
    assert.equal(c.postCreateCommand, 'bash .devcontainer/post-create.sh');
  }
});

test('image selection accepts short names, uppercase tags, ports and digests', () => {
  for (const image of [
    'a',
    'a:RC',
    'ghcr.io/example/image:ReleaseCandidate',
    'localhost:5000/example/image:ReleaseCandidate',
    `ghcr.io/example/image@sha256:${'a'.repeat(64)}`,
    `ghcr.io/example/image:RC@sha256:${'a'.repeat(64)}`,
  ]) {
    assert.equal(parse(profile(source, { image })).image, image);
  }
  for (const image of [
    '--privileged',
    'image;bad',
    'image name',
    'image\nname',
    '$(id)',
    '"image"',
  ])
    assert.throws(() => profile(source, { image }), /Invalid image reference/);
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
    () => profile(source, { imageOnly: true, image: 'ghcr.io/example/image' }),
    /--image cannot/,
  );
  for (const url of ['--upload-pack=bad', 'ext::command', 'https://token@github.com/user/repo.git'])
    assert.throws(() => profile(source, { native: true, url }), /Invalid clone URL/);
  assert.throws(
    () => profile(source.replace('"context": "."', '"context": "elsewhere"')),
    /layout changed/,
  );
});

test('native branch validation rejects invalid Git refs before generation', () => {
  for (const ref of [
    'foo..',
    'topic/.hidden',
    'topic/name.lock',
    'topic/name.lock/child',
    'topic//child',
    'topic/name.',
    'topic/',
    'HEAD',
  ]) {
    assert.notEqual(spawnSync('git', ['check-ref-format', '--branch', ref]).status, 0);
    assert.throws(() => profile(source, { native: true, ref }), /Invalid clone branch/);
  }
  for (const ref of [
    'main',
    'feature/fix-123',
    'release/v1.2.3',
    'topic/name.locked',
    'topic/name.LOCK',
  ]) {
    assert.equal(spawnSync('git', ['check-ref-format', '--branch', ref]).status, 0);
    assert.equal(
      parse(profile(source, { native: true, ref })).containerEnv.GITNEXUS_CLONE_REF,
      ref,
    );
  }
});

test('UI variants preserve empty, custom, and absent capability selections', () => {
  for (const capabilities of [[], ['SYS_PTRACE'], undefined]) {
    const customized = source.replace(
      '  "capAdd": ["SYS_ADMIN"],',
      capabilities === undefined ? '' : `  "capAdd": ${JSON.stringify(capabilities)},`,
    );
    for (const options of [{}, { native: true }, { image: 'ghcr.io/example/devcontainer:ui' }]) {
      const c = parse(profile(customized, { ...options, ui: true, playwright: '1.63.0' }));
      assert.deepEqual(c.capAdd, capabilities);
      assert.deepEqual(c.runArgs, ['--shm-size=1g']);
    }
  }
});

test('native profiles accept fork remotes over HTTPS and Git SSH', () => {
  for (const url of [
    'https://github.com/contributor/GitNexus.git',
    'git@github.com:contributor/GitNexus.git',
    'ssh://git@example.com:2222/contributor/GitNexus.git',
  ]) {
    const c = parse(profile(source, { native: true, url, ref: 'feature/fork-only' }));
    assert.equal(c.containerEnv.GITNEXUS_CLONE_URL, url);
    assert.equal(c.containerEnv.GITNEXUS_CLONE_REF, 'feature/fork-only');
  }
});

test('profile CLI validates combinations before writing and generates fork configuration', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-profile-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, '.devcontainer');
  fs.mkdirSync(config);
  for (const file of ['profile.cjs', 'devcontainer.json', 'devcontainer-lock.json'])
    fs.copyFileSync(path.join(__dirname, file), path.join(config, file));
  fs.mkdirSync(path.join(root, 'gitnexus-web'));
  fs.writeFileSync(
    path.join(root, 'gitnexus-web/package-lock.json'),
    JSON.stringify({
      packages: { 'node_modules/@playwright/test': { version: '1.63.0' } },
    }),
  );
  const run = (...args) =>
    spawnSync(process.execPath, [path.join(config, 'profile.cjs'), ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  for (const [args, error] of [
    [
      ['image-build', '--image', 'ghcr.io/example/image'],
      /--image cannot be used with image-build/,
    ],
    [['native', '--url'], /--url requires a value/],
    [['native', '--ref', '--ui'], /--ref requires a value/],
    [['prebuilt', '--url', 'https://github.com/user/repo.git'], /require the native profile/],
    [['native', '--ref', 'main', '--ref', 'other'], /Duplicate profile argument/],
    [['native', '--ref', 'foo..'], /Invalid clone branch/],
  ]) {
    const result = run(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(fs.existsSync(path.join(config, 'generated')), false);
  }
  const result = run(
    'native',
    '--url',
    'https://github.com/contributor/GitNexus.git',
    '--ref',
    'feature/fork-only',
  );
  assert.equal(result.status, 0, result.stderr);
  const c = parse(fs.readFileSync(path.join(config, 'generated/devcontainer.json'), 'utf8'));
  assert.equal(c.containerEnv.GITNEXUS_CLONE_URL, 'https://github.com/contributor/GitNexus.git');
  assert.equal(c.containerEnv.GITNEXUS_CLONE_REF, 'feature/fork-only');
  for (const args of [
    ['prebuilt'],
    ['prebuilt', '--ui'],
    ['native', '--image', 'a'],
    ['ui', '--image', 'ghcr.io/example/image:ReleaseCandidate'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    const generated = parse(
      fs.readFileSync(path.join(config, 'generated/devcontainer.json'), 'utf8'),
    );
    assert.deepEqual(generated.features, parse(source).features);
    if (args.includes('--image')) assert.equal(generated.image, args.at(-1));
  }
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
  const checkoutGit = (...args) =>
    execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
  assert.equal(checkoutGit('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
  assert.match(checkoutGit('pull'), /Already up to date/);
  fs.writeFileSync(path.join(checkout, 'file'), 'local edits');
  bootstrap(checkout, origin, 'main');
  assert.equal(fs.readFileSync(path.join(checkout, 'file'), 'utf8'), 'local edits');
  assert.throws(() => bootstrap(checkout, path.join(root, 'other'), 'main'), /another origin/);
  const retry = path.join(root, 'retry');
  assert.throws(() => bootstrap(retry, origin, 'new-branch'));
  git('branch', 'new-branch');
  bootstrap(retry, origin, 'new-branch');
  assert.equal(fs.readFileSync(path.join(retry, 'file'), 'utf8'), 'source');
  assert.equal(
    execFileSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], {
      cwd: retry,
      encoding: 'utf8',
    }).trim(),
    'origin/new-branch',
  );
  const conflict = path.join(root, 'conflict');
  fs.mkdirSync(conflict);
  fs.writeFileSync(path.join(conflict, 'file'), 'pre-existing user file');
  assert.throws(() => bootstrap(conflict, origin, 'main'));
  assert.equal(fs.readFileSync(path.join(conflict, 'file'), 'utf8'), 'pre-existing user file');
  const ignored = path.join(root, 'ignored-conflict');
  fs.mkdirSync(ignored);
  execFileSync('git', ['init', '-q'], { cwd: ignored });
  fs.writeFileSync(path.join(ignored, '.git/info/exclude'), 'file\n');
  fs.writeFileSync(path.join(ignored, 'file'), 'ignored user file');
  assert.throws(() => bootstrap(ignored, origin, 'main'));
  assert.equal(fs.readFileSync(path.join(ignored, 'file'), 'utf8'), 'ignored user file');
  // Preserve the user's file elsewhere, then verify the same checkout can resume.
  fs.renameSync(path.join(ignored, 'file'), path.join(ignored, 'saved-user-file'));
  bootstrap(ignored, origin, 'main');
  assert.equal(fs.readFileSync(path.join(ignored, 'file'), 'utf8'), 'source');
  assert.equal(fs.readFileSync(path.join(ignored, 'saved-user-file'), 'utf8'), 'ignored user file');
});
