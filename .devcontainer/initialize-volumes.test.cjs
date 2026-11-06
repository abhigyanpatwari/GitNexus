'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { archiveArgs, snapshotState, HOST_PATHS } = require('./initialize-volumes.cjs');
const { archiveEntries, isWorkspaceExcluded, restoreLinks } = require('./seed-workspace.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn import spaces-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the host tar omits Node and Python dependencies while preserving ignored local files', (t) => {
  const root = temporary(t);
  for (const file of [
    '.git/config',
    '.git/devcontainer-source-volume',
    '.git/refs/heads/node_modules/topic',
    '.env.local',
    '.husky/_/h',
    'gitnexus/node_modules/binary',
    'node_modules/binary',
    'eval/.venv/bin/python',
    'eval/.venv/pyvenv.cfg',
    'eval/.venv-notes/local-file',
    'eval/local-script.py',
    '.worktrees/zig-receivers/gitnexus-shared/node_modules/binary',
    '.worktrees/zig-receivers/gitnexus-shared/src/index.ts',
    '.worktrees/zig-receivers/.husky/_/h',
    '.claude/worktrees/topic/eval/.venv/bin/python',
    '.claude/worktrees/topic/local-edit',
    '.claude/worktrees/topic/.git',
    'file with spaces',
    "file's name",
    '-leading-option',
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'fixture only');
  }
  const entries = [...archiveEntries(root, ['.'], { exclude: isWorkspaceExcluded })];
  const tar = execFileSync('tar', archiveArgs(root, entries, [], { recursive: false }), {
    input: entries.join('\0') + '\0',
  });
  const listing = execFileSync('tar', ['-tf', '-'], { input: tar, encoding: 'utf8' });
  assert.match(listing, /\.git\/config/);
  assert.match(listing, /\.env.local/);
  assert.match(listing, /file with spaces/);
  assert.match(listing, /eval\/\.venv-notes\/local-file/);
  assert.match(listing, /eval\/local-script\.py/);
  assert.match(listing, /\.worktrees\/zig-receivers\/gitnexus-shared\/src\/index\.ts/);
  assert.match(listing, /\.claude\/worktrees\/topic\/local-edit/);
  assert.match(listing, /\.claude\/worktrees\/topic\/\.git/);
  assert.match(listing, /\.git\/refs\/heads\/node_modules\/topic/);
  assert.doesNotMatch(listing, /eval\/\.venv(?:\/|$)/m);
  const workspace = listing
    .split(/\r?\n/)
    .filter((entry) => !entry.startsWith('./.git/'))
    .join('\n');
  assert.doesNotMatch(workspace, /node_modules|devcontainer-source-volume|\.husky\/_/);
});

test('explicit archives restore dangling and directory links without traversing them', (t) => {
  const root = temporary(t);
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const outside = path.join(root, 'outside');
  for (const dir of [source, target, outside]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(outside, 'keep'), 'outside');
  fs.symlinkSync('missing target', path.join(source, 'dangling'));
  fs.symlinkSync(outside, path.join(source, 'directory-link'), 'dir');
  const names = ['-C', "file's name", 'file with spaces'];
  if (process.platform !== 'win32') names.push('line\nbreak');
  for (const name of names) fs.writeFileSync(path.join(source, name), name);
  const links = [];
  const entries = [...archiveEntries(source, ['.'], { links })];
  assert.ok(!entries.some((entry) => /dangling|directory-link/.test(entry)));
  const tar = execFileSync('tar', archiveArgs(source, entries, [], { recursive: false }), {
    input: entries.join('\0') + '\0',
  });
  execFileSync('tar', ['-xf', '-', '-C', target], { input: tar });
  restoreLinks(target, links);
  assert.equal(fs.readlinkSync(path.join(target, 'dangling')), 'missing target');
  assert.equal(fs.readlinkSync(path.join(target, 'directory-link')), outside);
  for (const name of names) assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), name);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside');
});

test('snapshot selection excludes transcripts and Cursor executable hooks', () => {
  assert.ok(HOST_PATHS.includes('.codex/auth.json'));
  assert.ok(HOST_PATHS.includes('.claude/plugins'));
  assert.ok(HOST_PATHS.includes('.config/gh'));
  assert.ok(!HOST_PATHS.some((p) => /sessions|projects|chats|hooks\.json/.test(p)));
});

test('partial snapshot fails closed', (t) => {
  const root = temporary(t);
  assert.equal(snapshotState(root), 'empty');
  fs.writeFileSync(path.join(root, 'partial'), 'keep');
  assert.throws(() => snapshotState(root), /Incomplete snapshot/);
  assert.equal(fs.readFileSync(path.join(root, 'partial'), 'utf8'), 'keep');
});

// A Docker CLI adapter exercises the host orchestration with real tar, Git,
// filesystem copying and imported scripts. It does not emulate Docker mounts
// or establish that a Docker Desktop rebuild works; that requires the host.
function dockerFixture(t) {
  const root = temporary(t);
  const source = path.join(root, 'source');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  for (const dir of [source, home, bin, state]) fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q', source]);
  fs.writeFileSync(path.join(source, 'local-edit'), 'uncommitted');
  fs.symlinkSync('local-edit', path.join(source, 'source-link'));
  fs.mkdirSync(path.join(source, '.worktrees/topic/gitnexus-shared'), { recursive: true });
  fs.symlinkSync(
    '/missing/Linux/dependencies',
    path.join(source, '.worktrees/topic/gitnexus-shared/node_modules'),
  );
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh/test-key'), 'fixture, not a credential');
  fs.symlinkSync('test-key', path.join(home, '.ssh/test-link'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/auth.json'), '{"fixture":true}');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.IMPORT_TEST_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'commands'), JSON.stringify(args) + '\\n');
const map = p => path.join(root, p);
const run = (command, argv, input) => { const r = spawnSync(command, argv, { stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input }); if(r.error) throw r.error; process.exitCode = r.status; };
switch(args[0]) {
  case 'create':
    if (fs.existsSync(map('active'))) process.exit(1);
    fs.writeFileSync(map('active'), 'running');
    for (const mount of args.filter(a => a.startsWith('type=volume,'))) fs.mkdirSync(map(mount.match(/target=([^,]+)/)[1]), { recursive:true });
    fs.mkdirSync(map('/tmp'), {recursive:true}); break;
  case 'start': break;
  case 'rm': fs.rmSync(map('active')); break;
  case 'cp': {
    const dest = map(args[2].split(':').slice(1).join(':'));
    if (args[1] === '-') {
      if (process.env.IMPORT_FAIL_COPY) process.exit(3);
      run('tar', ['-xf', '-', '-C', dest], fs.readFileSync(0));
    } else fs.copyFileSync(args[1], dest);
    break;
  }
  case 'exec':
    if (args[1] === '-i') args.splice(1, 1);
    if (process.env.IMPORT_FAIL_LINKS && args.includes('--restore-links')) process.exit(4);
    run(args[2], args.slice(3).map(a => a.startsWith('/') ? map(a) : a)); break;
  default: throw new Error('Unexpected Docker command');
}
`,
    { mode: 0o755 },
  );
  const run = (mode = 'source', extra = {}) =>
    spawnSync(
      process.execPath,
      [
        '-e',
        `require(process.argv[1]).initialize('fixture', process.argv[2], process.argv[3], process.argv[4]).catch(e => { console.error(e.message); process.exitCode = 1; })`,
        path.join(__dirname, 'initialize-volumes.cjs'),
        mode,
        source,
        home,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          IMPORT_TEST_STATE: state,
          ...extra,
        },
      },
    );
  return { source, home, state, run };
}

test('host import is one-time, uses only native volumes, preserves edits and cleans its helper', (t) => {
  const { source, home, state, run } = dockerFixture(t);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.readFileSync(path.join(state, 'workspace/local-edit'), 'utf8'), 'uncommitted');
  assert.equal(fs.readlinkSync(path.join(state, 'workspace/source-link')), 'local-edit');
  assert.equal(
    fs.existsSync(path.join(state, 'workspace/.worktrees/topic/gitnexus-shared/node_modules')),
    false,
  );
  assert.equal(fs.readlinkSync(path.join(state, 'identity/ssh/test-link')), 'test-key');
  assert.equal(fs.statSync(path.join(state, 'identity/ssh/test-key')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(state, 'active')), false);
  fs.writeFileSync(path.join(state, 'workspace/local-edit'), 'Linux edits');
  fs.rmSync(source, { recursive: true });
  fs.rmSync(home, { recursive: true });
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(path.join(state, 'workspace/local-edit'), 'utf8'), 'Linux edits');
  const commands = fs.readFileSync(path.join(state, 'commands'), 'utf8');
  assert.doesNotMatch(commands, /type=bind|--privileged|SYS_ADMIN/);
  assert.equal(commands.split('\n').filter((line) => line.startsWith('["cp","-"')).length, 3);
});

test('native profile imports config without copying or requiring a host checkout', (t) => {
  const { source, state, run } = dockerFixture(t);
  fs.rmSync(source, { recursive: true });
  const result = run('native');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(state, 'workspace')), false);
  assert.equal(fs.existsSync(path.join(state, 'host/.codex/auth.json')), true);
});

test('a failed copy aborts initialization and never marks the source ready', (t) => {
  const { state, run } = dockerFixture(t);
  const result = run('source', { IMPORT_FAIL_COPY: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(state, 'workspace/.git/devcontainer-source-volume')), false);
  assert.equal(fs.existsSync(path.join(state, 'active')), false);
});

test('an existing importer is never removed by a competing initialization', (t) => {
  const { state, run } = dockerFixture(t);
  fs.writeFileSync(path.join(state, 'active'), 'other importer');
  const result = run();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(state, 'active'), 'utf8'), 'other importer');
  assert.doesNotMatch(fs.readFileSync(path.join(state, 'commands'), 'utf8'), /\["rm"/);
});

test('failed symlink restoration never publishes a successful source marker', (t) => {
  const { state, run } = dockerFixture(t);
  const result = run('source', { IMPORT_FAIL_LINKS: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(state, 'workspace/.git/devcontainer-source-volume')), false);
  assert.equal(fs.existsSync(path.join(state, 'active')), false);
});

test('credential bootstrap preserves existing logins and deliberate logout across rebuilds', (t) => {
  const root = temporary(t);
  const source = path.join(root, 'host-auth');
  const dest = path.join(root, 'auth');
  fs.writeFileSync(source, 'host snapshot');
  const script = fs
    .readFileSync(path.join(__dirname, 'post-create.sh'), 'utf8')
    .match(/^sync_from_host\(\) \{[\s\S]*?^\}/m)[0];
  const run = () =>
    execFileSync('bash', [
      '-eu',
      '-c',
      script + '\nsync_from_host "$1" "$2"',
      'fixture',
      source,
      dest,
    ]);
  run();
  assert.equal(fs.readFileSync(dest, 'utf8'), 'host snapshot');
  fs.writeFileSync(dest, 'refreshed login');
  run();
  assert.equal(fs.readFileSync(dest, 'utf8'), 'refreshed login');
  fs.writeFileSync(path.join(root, '.devcontainer-identity-seeded'), '');
  fs.rmSync(dest);
  run();
  assert.equal(fs.existsSync(dest), false);
});
