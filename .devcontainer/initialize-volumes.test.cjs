'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tarStream, snapshotState, HOST_PATHS } = require('./initialize-volumes.cjs');
const {
  archiveEntries,
  commitStaged,
  isWorkspaceExcluded,
  restoreLinks,
} = require('./seed-workspace.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn import spaces-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function tarBuffer(source, entries) {
  const chunks = [];
  for await (const chunk of tarStream(source, entries)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Host-side importer tests run on Linux, macOS and Windows CI. Each gate names
// what a host lacks, so a skip explains itself.
const posixOnly = {
  skip: process.platform === 'win32' && 'needs POSIX tooling: bash, file modes, mkfifo',
};
const canSymlink = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-symlink-probe-'));
  try {
    fs.symlinkSync('target', path.join(dir, 'link'));
    return true;
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
const symlinks = {
  skip: !canSymlink && 'creating symlinks needs Developer Mode or the symlink privilege',
};
// The onCreateCommand commit and snapshot ownership repair run only inside the
// Linux dev container and import helper.
const containerSide = {
  skip: process.platform !== 'linux' && 'runs only inside the Linux dev container and helper',
};
// Python's tarfile reads PAX independently of the host tar. Windows tar.exe
// cannot extract names outside the ANSI code page; Docker's extractor can.
const python = ['python3', 'python'].find(
  (command) => spawnSync(command, ['-c', 'import tarfile'], { stdio: 'ignore' }).status === 0,
);
const pythonTar = { skip: !python && 'needs Python 3 tarfile as an independent PAX reader' };
const READ_TAR = `import json, sys, tarfile
with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
    print(json.dumps({m.name: archive.extractfile(m).read().decode() for m in archive if m.isfile()}))`;

test('the host tar omits dependencies and parser caches while preserving indexes and local files', async (t) => {
  const root = temporary(t);
  for (const file of [
    '.git/config',
    '.git/devcontainer-source-volume',
    '.git/refs/heads/node_modules/topic',
    '.git/refs/heads/.gitnexus/parse-cache/topic',
    '.gitnexus/parse-cache/chunk.v8',
    '.gitnexus/parse-cache.json',
    '.gitnexus/parsedfile-cache/chunk.v8',
    '.gitnexus/lbug',
    '.gitnexus/gitnexus.json',
    '.gitnexus/run.cjs',
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
    '.worktrees/zig-receivers/.gitnexus/parse-cache/chunk.v8',
    '.worktrees/zig-receivers/.gitnexus/parsedfile-cache/chunk.v8',
    '.worktrees/zig-receivers/.gitnexus/lbug',
    '.claude/worktrees/topic/eval/.venv/bin/python',
    '.claude/worktrees/topic/local-edit',
    '.claude/worktrees/topic/.git',
    '.claude/worktrees/topic/.gitnexus/parse-cache.json',
    'src/parse-cache/implementation.cjs',
    '.gitnexus/parse-cache-notes/local-file',
    'file with spaces',
    "file's name",
    '-leading-option',
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'fixture only');
  }
  const entries = [...archiveEntries(root, ['.'], { exclude: isWorkspaceExcluded })];
  const tar = await tarBuffer(root, entries);
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
  assert.match(listing, /\.git\/refs\/heads\/\.gitnexus\/parse-cache\/topic/);
  assert.match(listing, /\.gitnexus\/lbug/);
  assert.match(listing, /\.gitnexus\/gitnexus.json/);
  assert.match(listing, /\.gitnexus\/run.cjs/);
  assert.match(listing, /\.worktrees\/zig-receivers\/\.gitnexus\/lbug/);
  assert.match(listing, /src\/parse-cache\/implementation.cjs/);
  assert.match(listing, /\.gitnexus\/parse-cache-notes\/local-file/);
  assert.doesNotMatch(listing, /eval\/\.venv(?:\/|$)/m);
  const workspace = listing
    .split(/\r?\n/)
    .filter((entry) => !entry.startsWith('./.git/'))
    .join('\n');
  assert.doesNotMatch(workspace, /node_modules|devcontainer-source-volume|\.husky\/_/);
  assert.doesNotMatch(
    workspace,
    /\.gitnexus\/(?:parse-cache(?:\.json)?|parsedfile-cache)(?:\/|$)/m,
  );
});

test('progress reports activity while idle and stops its timer on completion or failure', () => {
  for (const outcome of ['done', 'failed']) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const { startProgress } = require(process.argv[1]);
       const finish = startProgress('Fixture', () => '; 2.0 MiB streamed to Docker', 10);
       setTimeout(() => finish(process.argv[2]), 60);`,
        path.join(__dirname, 'initialize-volumes.cjs'),
        outcome,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Fixture: starting; [\d.]+s elapsed/);
    assert.match(result.stdout, /Fixture: working; [\d.]+s elapsed; 2.0 MiB streamed to Docker/);
    assert.match(result.stdout.trim().split('\n').at(-1), new RegExp(`Fixture: ${outcome};`));
  }
});

test(
  'explicit archives restore dangling and directory links without traversing them',
  symlinks,
  async (t) => {
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
    execFileSync('tar', ['-xpf', '-', '-C', target], { input: await tarBuffer(source, entries) });
    restoreLinks(target, links);
    assert.equal(fs.readlinkSync(path.join(target, 'dangling')), 'missing target');
    assert.equal(fs.readlinkSync(path.join(target, 'directory-link')), outside);
    for (const name of names) assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), name);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside');
  },
);

test(
  'the Node tar stream round-trips UTF-8 and long names and empty files',
  pythonTar,
  async (t) => {
    const source = temporary(t);
    // Over 100 bytes needs a PAX path record; short enough for Windows MAX_PATH.
    const long = `${'nested-directory/'.repeat(3)}${'x'.repeat(60)}.md`;
    const files = {
      'jegyzet-ő.md': 'ő',
      'emoji-🚀/notes.txt': 'rocket',
      [long]: 'long',
      empty: '',
    };
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
      fs.writeFileSync(path.join(source, name), content);
    }
    const entries = [...archiveEntries(source, ['.'])];
    const input = await tarBuffer(source, entries);
    const read = JSON.parse(execFileSync(python, ['-c', READ_TAR], { input, encoding: 'utf8' }));
    for (const [name, content] of Object.entries(files))
      assert.equal(read[`./${name}`], content, name);
  },
);

test('the Node tar stream preserves POSIX modes and omits FIFOs', posixOnly, async (t) => {
  const root = temporary(t);
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'script'), '');
  fs.chmodSync(path.join(source, 'script'), 0o755);
  execFileSync('mkfifo', [path.join(source, 'pipe')]);
  const entries = [...archiveEntries(source, ['.'])];
  execFileSync('tar', ['-xpf', '-', '-C', target], { input: await tarBuffer(source, entries) });
  assert.equal(fs.statSync(path.join(target, 'script')).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(target, 'pipe')), false);
});

test('a file changed while it is streamed fails the import instead of publishing torn bytes', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'live.db'), 'page 1');
  const stream = tarStream(root, ['./live.db']);
  await stream.next(); // Header written with the original size.
  fs.appendFileSync(path.join(root, 'live.db'), ', page 2');
  await assert.rejects(async () => {
    for await (const chunk of stream) assert.ok(chunk);
  }, /live\.db changed during the import/);
});

test('snapshot selection excludes transcripts and Cursor executable hooks', () => {
  assert.ok(HOST_PATHS.includes('.codex/auth.json'));
  assert.ok(HOST_PATHS.includes('.claude/plugins'));
  assert.ok(HOST_PATHS.includes('.config/gh'));
  assert.ok(!HOST_PATHS.some((p) => /sessions|projects|chats|hooks\.json/.test(p)));
});

test('only a marked snapshot is reused; empty and partial ones are refreshed', (t) => {
  const root = temporary(t);
  assert.equal(snapshotState(root), 'stale');
  fs.writeFileSync(path.join(root, 'partial'), 'interrupted copy');
  assert.equal(snapshotState(root), 'stale');
  fs.writeFileSync(path.join(root, '.devcontainer-snapshot-v1'), 'complete');
  assert.equal(snapshotState(root), 'ready');
});

// A Docker CLI adapter exercises the host orchestration with real tar, Git,
// filesystem copying and imported scripts. It does not emulate Docker mounts
// or establish that a Docker Desktop rebuild works; that requires the host.
const DOCKER_ADAPTER = `'use strict';
// Stands in for Docker and the Linux import helper: volumes are directories
// under IMPORT_TEST_STATE, and helper commands run on the host.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.IMPORT_TEST_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'commands'), JSON.stringify(args) + '\\n');
const map = (p) => path.join(root, p);
const run = (command, argv, input) => {
  const r = spawnSync(command, argv, { stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input });
  if (r.error) throw r.error;
  process.exitCode = r.status;
};
// Helper commands are emulated where host tools differ: Windows has no chown,
// and its find and mkdir are different programs.
const helper = {
  find(target, ...flags) {
    if (flags.join(' ') !== '-xdev -mindepth 1 -delete') throw new Error('Unexpected find');
    for (const name of fs.readdirSync(target)) fs.rmSync(path.join(target, name), { recursive: true });
  },
  mkdir: (target) => fs.mkdirSync(target),
  touch: (target) => fs.writeFileSync(target, ''),
  node(script, ...rest) {
    if (rest[0] !== '--snapshot-finish') return run(process.execPath, [script, ...rest]);
    const [, target, , , state] = rest;
    // The helper runs as root; the adapter can only hand files to itself.
    if (process.platform !== 'win32')
      return run(process.execPath, [script, '--snapshot-finish', target, String(process.getuid()), String(process.getgid()), state]);
    if (state === 'fresh') fs.writeFileSync(path.join(target, '.devcontainer-snapshot-v1'), '', { flag: 'wx' });
  },
};
(async () => {
  switch (args[0]) {
    case 'create':
      if (fs.existsSync(map('active'))) process.exit(1);
      fs.writeFileSync(map('active'), 'running');
      for (const mount of args.filter((a) => a.startsWith('type=volume,')))
        fs.mkdirSync(map(mount.match(/target=([^,]+)/)[1]), { recursive: true });
      fs.mkdirSync(map('/tmp'), { recursive: true });
      break;
    case 'start':
      break;
    case 'rm':
      fs.rmSync(map('active'));
      break;
    case 'cp': {
      const dest = map(args[2].split(':').slice(1).join(':'));
      if (args[1] !== '-') {
        fs.copyFileSync(args[1], dest);
        break;
      }
      if (process.env.IMPORT_FAIL_COPY) process.exit(3);
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      if (process.env.IMPORT_SLOW_COPY && args[2].endsWith(':/seed/tree'))
        await new Promise((resolve) => setTimeout(resolve, 5200));
      run('tar', ['-xf', '-', '-C', dest], Buffer.concat(chunks));
      break;
    }
    case 'exec': {
      const [, command, ...rest] = args.slice(args[1] === '-i' ? 2 : 1);
      if (process.env.IMPORT_FAIL_LINKS && rest.includes('--restore-links')) process.exit(4);
      if (!Object.hasOwn(helper, command)) throw new Error('Unexpected helper command ' + command);
      helper[command](...rest.map((a) => (a.startsWith('/') ? map(a) : a)));
      break;
    }
    default:
      throw new Error('Unexpected Docker command');
  }
})();
`;

function dockerFixture(t) {
  const root = temporary(t);
  const source = path.join(root, 'source');
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  for (const dir of [source, home, state]) fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q', source]);
  fs.writeFileSync(path.join(source, 'local-edit'), 'uncommitted');
  fs.symlinkSync('local-edit', path.join(source, 'source-link'));
  fs.mkdirSync(path.join(source, '.worktrees/topic/gitnexus-shared'), { recursive: true });
  fs.mkdirSync(path.join(source, '.worktrees/topic/.gitnexus/parse-cache'), { recursive: true });
  fs.writeFileSync(
    path.join(source, '.worktrees/topic/.gitnexus/parse-cache/chunk.v8'),
    'regenerable',
  );
  fs.writeFileSync(
    path.join(source, '.worktrees/topic/.gitnexus/lbug'),
    'keep graph and embeddings',
  );
  fs.symlinkSync(
    '/missing/Linux/dependencies',
    path.join(source, '.worktrees/topic/gitnexus-shared/node_modules'),
  );
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh/test-key'), 'fixture, not a credential');
  fs.symlinkSync('test-key', path.join(home, '.ssh/test-link'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/auth.json'), '{"fixture":true}');
  // Dotfile managers link selected roots; the snapshot must hold their contents.
  fs.mkdirSync(path.join(home, 'dotfiles/gh'), { recursive: true });
  fs.writeFileSync(path.join(home, 'dotfiles/gh/hosts.yml'), 'fixture: true');
  fs.mkdirSync(path.join(home, '.config'));
  fs.symlinkSync(path.join(home, 'dotfiles/gh'), path.join(home, '.config/gh'), 'dir');
  // A dangling selected root is still selected, so the snapshot keeps the link.
  fs.symlinkSync('missing-claude.json', path.join(home, '.claude.json'));
  // A selected path under a non-directory is skipped, not a failed snapshot.
  fs.writeFileSync(path.join(home, '.cursor'), 'not a directory');
  const adapter = path.join(root, 'docker-adapter.cjs');
  fs.writeFileSync(adapter, DOCKER_ADAPTER);
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
          GITNEXUS_IMPORT_DOCKER: JSON.stringify([process.execPath, adapter]),
          IMPORT_TEST_STATE: state,
          ...extra,
        },
      },
    );
  return { source, home, state, run };
}

test('host import stages through native volumes only and cleans its helper', symlinks, (t) => {
  const { state, run } = dockerFixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  // The host only stages; the source volume stays untouched until onCreate commits.
  assert.deepEqual(fs.readdirSync(path.join(state, 'workspace')), []);
  const tree = path.join(state, 'seed/tree');
  assert.equal(fs.existsSync(path.join(state, 'seed/stage-complete')), true);
  assert.equal(fs.readFileSync(path.join(tree, 'local-edit'), 'utf8'), 'uncommitted');
  assert.equal(fs.readlinkSync(path.join(tree, 'source-link')), 'local-edit');
  assert.equal(fs.existsSync(path.join(tree, '.worktrees/topic/.gitnexus/parse-cache')), false);
  assert.equal(
    fs.readFileSync(path.join(tree, '.worktrees/topic/.gitnexus/lbug'), 'utf8'),
    'keep graph and embeddings',
  );
  assert.equal(
    fs.existsSync(path.join(tree, '.worktrees/topic/gitnexus-shared/node_modules')),
    false,
  );
  assert.equal(fs.readlinkSync(path.join(state, 'identity/ssh/test-link')), 'test-key');
  assert.equal(fs.lstatSync(path.join(state, 'host/.config/gh')).isDirectory(), true);
  assert.equal(
    fs.readFileSync(path.join(state, 'host/.config/gh/hosts.yml'), 'utf8'),
    'fixture: true',
  );
  assert.equal(fs.readlinkSync(path.join(state, 'host/.claude.json')), 'missing-claude.json');
  assert.equal(fs.existsSync(path.join(state, 'active')), false);
  const commands = fs.readFileSync(path.join(state, 'commands'), 'utf8');
  assert.doesNotMatch(commands, /type=bind|--privileged|SYS_ADMIN/);
  assert.equal(commands.split('\n').filter((line) => line.startsWith('["cp","-"')).length, 3);
  assert.match(
    result.stdout,
    /Archive to \/seed\/tree: done; .*entries queued.*MiB streamed to Docker/,
  );
  assert.match(result.stdout, /Finalizing \/host: done/);
  assert.match(result.stdout, /Removing temporary import helper: done/);
});

test(
  'the container commits the stage once, repairs snapshot modes, and later starts keep its edits',
  containerSide,
  (t) => {
    const { source, home, state, run } = dockerFixture(t);
    assert.equal(run().status, 0);
    commitStaged(path.join(state, 'seed'), path.join(state, 'workspace'));
    // Only the host's commit script remains for later container creations.
    assert.deepEqual(fs.readdirSync(path.join(state, 'seed')), ['seed-workspace.cjs']);
    assert.equal(fs.readFileSync(path.join(state, 'workspace/local-edit'), 'utf8'), 'uncommitted');
    assert.equal(fs.readlinkSync(path.join(state, 'workspace/source-link')), 'local-edit');
    assert.equal(fs.statSync(path.join(state, 'identity/ssh/test-key')).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(state, 'workspace/local-edit'), 'Linux edits');
    fs.rmSync(source, { recursive: true });
    fs.rmSync(home, { recursive: true });
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    commitStaged(path.join(state, 'seed'), path.join(state, 'workspace'));
    assert.equal(fs.readFileSync(path.join(state, 'workspace/local-edit'), 'utf8'), 'Linux edits');
  },
);

test(
  'reopening a pre-volume container restages, so the eventual rebuild gets current work',
  symlinks,
  (t) => {
    const { source, home, state, run } = dockerFixture(t);
    assert.equal(run().status, 0); // Old container reopened: stage only, nothing commits.
    fs.writeFileSync(path.join(source, 'local-edit'), 'days of later host work');
    fs.writeFileSync(path.join(home, '.codex/auth.json'), '{"refreshed":true}');
    const rebuild = run();
    assert.equal(rebuild.status, 0, rebuild.stderr);
    assert.equal(fs.existsSync(path.join(state, 'seed/stage-complete')), true);
    assert.equal(
      fs.readFileSync(path.join(state, 'seed/tree/local-edit'), 'utf8'),
      'days of later host work',
    );
    assert.equal(
      fs.readFileSync(path.join(state, 'host/.codex/auth.json'), 'utf8'),
      '{"refreshed":true}',
    );
  },
);

test('archive progress continues while Docker finishes a slow copy', symlinks, (t) => {
  const { run } = dockerFixture(t);
  const result = run('source', { IMPORT_SLOW_COPY: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Archive to \/seed\/tree: working; .*entries queued.*MiB streamed to Docker/,
  );
  assert.match(result.stdout, /Archive to \/seed\/tree: done/);
});

test(
  'native profile imports config without copying or requiring a host checkout',
  symlinks,
  (t) => {
    const { source, state, run } = dockerFixture(t);
    fs.rmSync(source, { recursive: true });
    const result = run('native');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(state, 'workspace')), false);
    assert.equal(fs.existsSync(path.join(state, 'host/.codex/auth.json')), true);
  },
);

test('a failed stage never blocks reopening and can never be committed', symlinks, (t) => {
  const { state, run } = dockerFixture(t);
  const result = run('source', { IMPORT_FAIL_COPY: '1' });
  assert.equal(result.status, 0, result.stderr); // A busy host must not lock out a reopen.
  assert.match(result.stdout, /Archive to \/seed\/tree: failed/);
  assert.match(result.stderr, /Staging the checkout skipped and retried on the next start/);
  assert.deepEqual(fs.readdirSync(path.join(state, 'seed')), ['seed-workspace.cjs']);
  assert.deepEqual(fs.readdirSync(path.join(state, 'host')), []); // Cleared, never marked.
  assert.throws(
    () => commitStaged(path.join(state, 'seed'), path.join(state, 'workspace')),
    /No complete staged checkout/,
  );
  assert.deepEqual(fs.readdirSync(path.join(state, 'workspace')), []);
  assert.equal(fs.existsSync(path.join(state, 'active')), false);
  assert.equal(run().status, 0); // The next start retries and completes.
  assert.equal(fs.existsSync(path.join(state, 'seed/stage-complete')), true);
  assert.equal(fs.readFileSync(path.join(state, 'seed/tree/local-edit'), 'utf8'), 'uncommitted');
});

test('an existing importer is never removed by a competing initialization', symlinks, (t) => {
  const { state, run } = dockerFixture(t);
  fs.writeFileSync(path.join(state, 'active'), 'other importer');
  const result = run();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(state, 'active'), 'utf8'), 'other importer');
  assert.doesNotMatch(fs.readFileSync(path.join(state, 'commands'), 'utf8'), /\["rm"/);
});

test('failed symlink restoration never publishes a complete stage', symlinks, (t) => {
  const { state, run } = dockerFixture(t);
  const result = run('source', { IMPORT_FAIL_LINKS: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(state, 'seed/stage-complete')), false);
  assert.equal(fs.existsSync(path.join(state, 'workspace/.git/devcontainer-source-volume')), false);
  assert.equal(fs.existsSync(path.join(state, 'active')), false);
});

test(
  'credential bootstrap preserves existing logins and deliberate logout across rebuilds',
  posixOnly,
  (t) => {
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
  },
);

test('seed markers stay unpublished until the host snapshot is complete', posixOnly, (t) => {
  const root = temporary(t);
  const snapshotMarker = path.join(root, '.devcontainer-snapshot-v1');
  const dirs = ['claude', 'gh'].map((name) => path.join(root, name));
  for (const dir of dirs) fs.mkdirSync(dir);
  const script = fs
    .readFileSync(path.join(__dirname, 'post-create.sh'), 'utf8')
    .match(/^mark_seeded\(\) \{[\s\S]*?^\}/m)[0];
  const run = () =>
    execFileSync(
      'bash',
      [
        '-eu',
        '-c',
        script + '\nmark_seeded .devcontainer-identity-seeded "$@"',
        'fixture',
        ...dirs,
      ],
      { env: { ...process.env, SNAPSHOT_MARKER: snapshotMarker } },
    );
  const seeded = () =>
    dirs.map((dir) => fs.existsSync(path.join(dir, '.devcontainer-identity-seeded')));
  run();
  assert.deepEqual(seeded(), [false, false]);
  fs.writeFileSync(snapshotMarker, 'complete');
  run();
  assert.deepEqual(seeded(), [true, true]);
});
