'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { ensureDependencies, markerName } = require('./dependencies.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dependencies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { example: '1.0.0' } }),
  );
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  let installs = 0;
  const run = () => {
    installs++;
    fs.mkdirSync(path.join(root, 'node_modules/example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/example/package.json'), '{}');
  };
  return { root, run, count: () => installs };
}

test('reuses completed dependency volumes and reinstalls after lockfile changes', (t) => {
  const f = fixture(t);
  assert.equal(ensureDependencies(f.root, { run: f.run }), true);
  assert.equal(ensureDependencies(f.root, { run: f.run }), false);
  fs.writeFileSync(path.join(f.root, 'package-lock.json'), '{"lockfileVersion":3}');
  assert.equal(ensureDependencies(f.root, { run: f.run }), true);
  assert.equal(f.count(), 2);
});

test('repairs a missing direct dependency even if the receipt matches', (t) => {
  const f = fixture(t);
  ensureDependencies(f.root, { run: f.run });
  fs.rmSync(path.join(f.root, 'node_modules/example'), { recursive: true });
  assert.equal(ensureDependencies(f.root, { run: f.run }), true);
});

test('runtime ABI changes and explicit repair invalidate reuse', (t) => {
  const f = fixture(t);
  ensureDependencies(f.root, { run: f.run });
  const runtime = {
    version: 'v22.23.3',
    versions: { modules: 'different' },
    platform: 'linux',
    arch: 'arm64',
  };
  assert.equal(ensureDependencies(f.root, { run: f.run, runtime }), true);
  assert.equal(ensureDependencies(f.root, { run: f.run, runtime, force: true }), true);
});

test('local file-dependency manifest changes invalidate reuse', (t) => {
  const f = fixture(t);
  const local = path.join(f.root, 'local');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'package.json'), '{"version":"1.0.0"}');
  fs.writeFileSync(
    path.join(f.root, 'package.json'),
    '{"dependencies":{"example":"1.0.0","local":"file:./local"}}',
  );
  const run = () => {
    f.run();
    fs.mkdirSync(path.join(f.root, 'node_modules/local'), { recursive: true });
    fs.copyFileSync(
      path.join(local, 'package.json'),
      path.join(f.root, 'node_modules/local/package.json'),
    );
  };
  ensureDependencies(f.root, { run });
  assert.equal(ensureDependencies(f.root, { run }), false);
  fs.writeFileSync(path.join(local, 'package.json'), '{"version":"1.0.1"}');
  assert.equal(ensureDependencies(f.root, { run }), true);
});

test('tracked native source and installer edits invalidate reuse', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'scripts'));
  fs.mkdirSync(path.join(f.root, 'vendor'));
  fs.writeFileSync(path.join(f.root, 'scripts/build-tree-sitter-grammars.cjs'), '// original');
  fs.writeFileSync(path.join(f.root, 'vendor/grammar.c'), '// original');
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { cwd: f.root, stdio: 'pipe' },
    );
  git('init');
  git(
    'add',
    'package.json',
    'package-lock.json',
    'scripts/build-tree-sitter-grammars.cjs',
    'vendor/grammar.c',
  );
  git('commit', '-m', 'fixture');
  ensureDependencies(f.root, { run: f.run });
  assert.equal(ensureDependencies(f.root, { run: f.run }), false);
  fs.writeFileSync(path.join(f.root, 'vendor/grammar.c'), '// changed grammar');
  assert.equal(ensureDependencies(f.root, { run: f.run }), true);
  fs.writeFileSync(
    path.join(f.root, 'scripts/build-tree-sitter-grammars.cjs'),
    '// changed installer',
  );
  assert.equal(ensureDependencies(f.root, { run: f.run }), true);
});

test('failed reinstall removes its receipt and is retried', (t) => {
  const f = fixture(t);
  ensureDependencies(f.root, { run: f.run });
  assert.throws(
    () =>
      ensureDependencies(f.root, {
        force: true,
        run: () => {
          throw new Error('install failed');
        },
      }),
    /install failed/,
  );
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules', markerName)), false);
  assert.equal(ensureDependencies(f.root, { run: f.run }), true);
});

test('changing optional-grammar policy invalidates the core install receipt', (t) => {
  const f = fixture(t);
  const previous = process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS;
  t.after(() => {
    if (previous === undefined) delete process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS;
    else process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS = previous;
  });
  fs.mkdirSync(path.join(f.root, 'scripts'));
  fs.writeFileSync(path.join(f.root, 'scripts/build-tree-sitter-grammars.cjs'), '// fixture');
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
    { cwd: f.root, stdio: 'pipe' },
  );
  process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS = '1';
  assert.equal(ensureDependencies(f.root, { run: f.run }), true);
  assert.equal(ensureDependencies(f.root, { run: f.run }), false);
  delete process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS;
  assert.equal(ensureDependencies(f.root, { run: f.run }), true);
  process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS = '0';
  assert.equal(ensureDependencies(f.root, { run: f.run }), false);
  process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS = '1';
  assert.equal(ensureDependencies(f.root, { run: f.run }), true);
  assert.equal(f.count(), 3);
});

test('cached lifecycle restores real Husky and rebuilds changed sources', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'package.json'), '{}');
  for (const name of ['gitnexus', 'gitnexus-web', 'gitnexus-shared']) {
    fs.mkdirSync(path.join(f.root, name));
    fs.writeFileSync(path.join(f.root, name, 'package.json'), '{}');
    fs.writeFileSync(path.join(f.root, name, 'package-lock.json'), '{}');
  }
  fs.mkdirSync(path.join(f.root, '.husky'));
  fs.writeFileSync(path.join(f.root, '.husky/pre-commit'), 'exit 0\n');
  const global = path.join(f.root, 'gitconfig');
  fs.writeFileSync(global, '');
  const env = {
    ...process.env,
    PATH: `${f.root}:${process.env.PATH}`,
    HUSKY: '',
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GITNEXUS_FORCE_DEPS: '0',
    GITNEXUS_DEV_UI: '0',
  };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
    delete env[key];
  execFileSync('git', ['init', '-q'], { cwd: f.root, env });
  const husky = path.resolve(__dirname, '../node_modules/husky/bin.js');
  fs.writeFileSync(
    path.join(f.root, 'npm'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('10.9.2'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(f.root, 'calls'))}, path.basename(process.cwd()) + ':' + args.join(' ') + '\\n');
if (args[0] === 'ci') fs.mkdirSync('node_modules', { recursive: true });
if (args.join(' ') === 'run prepare') require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(husky)}], { stdio: 'inherit' });
`,
    { mode: 0o755 },
  );
  const invoke = () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'dependencies.cjs'), f.root], {
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  invoke();
  fs.rmSync(path.join(f.root, '.husky/_'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'calls'), '');
  invoke();
  const calls = fs.readFileSync(path.join(f.root, 'calls'), 'utf8');
  assert.doesNotMatch(calls, /:ci/);
  assert.match(calls, /:run prepare/);
  assert.match(calls, /gitnexus:run build/);
  assert.ok(fs.existsSync(path.join(f.root, '.husky/_/pre-commit')));
});
