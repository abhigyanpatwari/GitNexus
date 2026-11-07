'use strict';
// Host-side importer. Docker's copy API transfers bytes without mounting the host.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {
  archiveEntries,
  isWorkspaceExcluded,
  validateGitDirectory,
} = require('./seed-workspace.cjs');

const SNAPSHOT_MARKER = '.devcontainer-snapshot-v1';
const HOST_PATHS = [
  '.claude.json',
  ...[
    '.credentials.json',
    '.claude.json',
    'settings.json',
    'skills',
    'agents',
    'memory',
    'commands',
    'plugins',
  ].map((p) => `.claude/${p}`),
  ...['auth.json', 'config.toml', 'plugins', 'prompts', 'memories', 'skills'].map(
    (p) => `.codex/${p}`,
  ),
  ...['cli-config.json', 'mcp.json', 'rules', 'commands', 'agents', 'skills', 'plugins'].map(
    (p) => `.cursor/${p}`,
  ),
  '.config/gh',
  '.claude-mem',
];
const IDENTITIES = {
  ssh: '.ssh',
  docker: '.docker',
  aws: '.aws',
  azure: '.azure',
  git: '.config/git',
};

function snapshotState(root) {
  const marker = path.join(root, SNAPSHOT_MARKER);
  if (fs.existsSync(marker) && fs.lstatSync(marker).isFile()) return 'ready';
  if (fs.readdirSync(root).length)
    throw new Error(
      `Incomplete snapshot at ${root}; inspect its volume before retrying. No files were replaced.`,
    );
  return 'empty';
}

function finishSnapshot(root, uid, gid, complete) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0)
    throw new Error('Invalid snapshot owner');
  const owner = fs.statSync(root);
  if (complete || owner.uid !== uid || owner.gid !== gid) {
    // Never follow host symlinks, including links whose target exists in the helper.
    execFileSync('find', [root, '-xdev', '-type', 'd', '-exec', 'chmod', '700', '{}', '+']);
    execFileSync('find', [root, '-xdev', '-type', 'f', '-exec', 'chmod', 'u+rw,go-rwx', '{}', '+']);
    execFileSync('find', [root, '-xdev', '-exec', 'chown', '-h', `${uid}:${gid}`, '{}', '+']);
  }
  if (complete) {
    fs.writeFileSync(
      path.join(root, SNAPSHOT_MARKER),
      'One-time host snapshot. Host edits are not synchronized.\n',
      { flag: 'wx', mode: 0o600 },
    );
    fs.chownSync(path.join(root, SNAPSHOT_MARKER), uid, gid);
  }
}

// Names arrive NUL-delimited on stdin. Only selected roots can be links (-h).
function archiveArgs(source) {
  return ['-C', source, '-h', '-cf', '-', '--no-recursion', '--null', '-T', '-'];
}

function assertUnchanged(files) {
  for (const [file, size, mtimeMs] of files) {
    const now = fs.statSync(file, { throwIfNoEntry: false });
    // bsdtar (macOS, Windows) pads or truncates a changing file and exits 0.
    if (now?.size !== size || now.mtimeMs !== mtimeMs)
      throw new Error(`${file} changed during the import; stop host writers and retry`);
  }
}

function startProgress(label, details = () => '', intervalMs = 5000) {
  const started = performance.now();
  const report = (status) => {
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`[volumes] ${label}: ${status}; ${elapsed}s elapsed${details()}`);
  };
  report('starting');
  const timer = setInterval(() => report('working'), intervalMs);
  return (status) => {
    clearInterval(timer);
    report(status);
  };
}

function childDone(child, name) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited ${signal || code}`)),
    );
  });
}

async function runWithProgress(label, args, input) {
  const finish = startProgress(label);
  const child = spawn('docker', args, {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
  });
  try {
    const done = childDone(child, label);
    const written =
      input === undefined ? Promise.resolve() : pipeline(Readable.from([input]), child.stdin);
    await Promise.all([done, written]);
    finish('done');
  } catch (error) {
    child.kill();
    finish('failed');
    throw error;
  }
}

async function copyArchive(source, entries, destination, excludes = [], exclude = () => false) {
  if (!entries.length) return;
  // No shell: spaces, apostrophes and Windows drive letters remain literal arguments.
  // Watch both processes: a failed tar must never publish a successful seed marker.
  const links = [];
  const files = [];
  let queued = 0;
  let bytes = 0;
  let skipped = 0;
  const finish = startProgress(
    `Archive to ${destination.slice(destination.indexOf(':') + 1)}`,
    () =>
      `; ${queued} entries queued, ${links.length} symlinks, ${skipped} excluded paths; ${(bytes / 1024 ** 2).toFixed(1)} MiB streamed to Docker`,
  );
  const listing = archiveEntries(source, entries, {
    links,
    files,
    exclude: (relative) => {
      const omit = excludes.includes(relative.split(path.sep).join('/')) || exclude(relative);
      if (omit) skipped++;
      return omit;
    },
  });
  const archive = spawn('tar', archiveArgs(source), {
    stdio: ['pipe', 'pipe', 'inherit'],
    // macOS tar otherwise adds AppleDouble ._* entries for extended attributes.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const copy = spawn('docker', ['cp', '-', destination], { stdio: ['pipe', 'inherit', 'inherit'] });
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    const inputDone = pipeline(
      Readable.from(
        (function* () {
          for (const entry of listing) {
            queued++;
            yield `${entry}\0`;
          }
        })(),
      ),
      archive.stdin,
    );
    await Promise.all([
      childDone(archive, 'tar'),
      childDone(copy, 'docker cp'),
      pipeline(archive.stdout, meter, copy.stdin),
      inputDone,
    ]);
    assertUnchanged(files);
    if (links.length) {
      const separator = destination.indexOf(':');
      await runWithProgress(
        'Restoring symlinks',
        [
          'exec',
          '-i',
          destination.slice(0, separator),
          'node',
          '/tmp/seed-workspace.cjs',
          '--restore-links',
          destination.slice(separator + 1),
        ],
        JSON.stringify(links),
      );
    }
    finish('done');
  } catch (error) {
    archive.kill();
    copy.kill();
    finish('failed');
    throw error;
  }
}

async function initialize(
  id,
  mode = 'source',
  workspace = path.resolve(__dirname, '..'),
  home = os.homedir(),
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(id || '') || !['source', 'native'].includes(mode))
    throw new Error('Usage: initialize-volumes.cjs DEVCONTAINER_ID [source|native]');
  const docker = (...args) =>
    execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const image = fs
    .readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8')
    .match(/^FROM (\S+)$/m)?.[1];
  if (!image || !image.includes('@sha256:'))
    throw new Error('A digest-pinned importer image is required');
  const snapshots = [
    { volume: `gitnexus-host-snapshot-${id}`, target: '/host', source: home, entries: HOST_PATHS },
    ...Object.entries(IDENTITIES).map(([name, dir]) => ({
      volume: `gitnexus-${name}-snapshot-${id}`,
      target: `/identity/${name}`,
      source: path.join(home, dir),
      entries: ['.'],
    })),
  ];
  const mounts = snapshots.map(
    (s) => `type=volume,source=${s.volume},target=${s.target},volume-nocopy`,
  );
  if (mode === 'source')
    mounts.push(`type=volume,source=gitnexus-source-${id},target=/workspace,volume-nocopy`);
  // A stable name serializes imports. Never remove someone else's running importer.
  const name = `gitnexus-import-${id}`;
  let created = false;
  try {
    await runWithProgress('Preparing import helper', [
      'create',
      '--name',
      name,
      '--user',
      '0',
      '--network',
      'none',
      ...mounts.flatMap((m) => ['--mount', m]),
      '--entrypoint',
      'sleep',
      image,
      'infinity',
    ]);
    created = true;
    await runWithProgress('Starting import helper', ['start', name]);
    for (const file of ['initialize-volumes.cjs', 'seed-workspace.cjs'])
      docker('cp', path.join(__dirname, file), `${name}:/tmp/${file}`);
    const run = (script, ...args) => docker('exec', name, 'node', `/tmp/${script}`, ...args);
    if (mode === 'source' && run('seed-workspace.cjs', '--state', '/workspace') === 'empty') {
      validateGitDirectory(path.join(workspace, '.git'));
      console.log(
        '[volumes] Importing the checkout, Git metadata and local work once; skipping dependencies and regenerable parser caches.',
      );
      console.log(
        '[volumes] Docker needs space for both the temporary import and the source volume.',
      );
      docker('exec', name, 'mkdir', '/seed');
      // Windows tar stats WSL links before applying --exclude. Enumerate in Node
      // and disable tar recursion so it never encounters skipped dependencies.
      await copyArchive(workspace, ['.'], `${name}:/seed`, [], isWorkspaceExcluded);
      await runWithProgress('Copying into the source volume and normalizing Git', [
        'exec',
        name,
        'node',
        '/tmp/seed-workspace.cjs',
        '/seed',
        '/workspace',
      ]);
    }
    // Linux hosts realign the remote UID; Desktop on Windows/macOS keeps node=1000.
    // updateRemoteUserUID skips root hosts (UID 0 already exists), so node stays 1000.
    const realign = process.platform === 'linux' && process.getuid() !== 0;
    const uid = String(realign ? process.getuid() : 1000);
    const gid = String(realign ? process.getgid() : 1000);
    if (mode === 'source') {
      // Lifecycle commands need to enter /workspace before sudo can repair
      // restrictive descendants. Make that root accessible before startup.
      docker('exec', name, 'chown', `${uid}:${gid}`, '/workspace');
      docker('exec', name, 'chmod', 'u+rwx', '/workspace');
    }
    for (const snapshot of snapshots) {
      const state = run('initialize-volumes.cjs', '--snapshot-state', snapshot.target);
      if (state === 'empty') {
        const entries = snapshot.entries.filter((entry) =>
          fs.existsSync(path.join(snapshot.source, entry)),
        );
        console.log(`[volumes] Creating ${snapshot.volume}`);
        await copyArchive(snapshot.source, entries, `${name}:${snapshot.target}`, [
          SNAPSHOT_MARKER,
        ]);
      }
      await runWithProgress(`Finalizing ${snapshot.target}`, [
        'exec',
        name,
        'node',
        '/tmp/initialize-volumes.cjs',
        '--snapshot-finish',
        snapshot.target,
        uid,
        gid,
        state,
      ]);
    }
    console.log('[volumes] Linux volumes ready. Host files are not synchronized.');
  } finally {
    // Only the disposable helper is removed, never any volume or host file.
    if (created) await runWithProgress('Removing temporary import helper', ['rm', '-f', name]);
  }
}

module.exports = {
  initialize,
  copyArchive,
  archiveArgs,
  assertUnchanged,
  startProgress,
  snapshotState,
  finishSnapshot,
  HOST_PATHS,
  IDENTITIES,
};
if (require.main === module) {
  (async () => {
    if (process.argv[2] === '--snapshot-state') console.log(snapshotState(process.argv[3]));
    else if (process.argv[2] === '--snapshot-finish')
      finishSnapshot(
        process.argv[3],
        Number(process.argv[4]),
        Number(process.argv[5]),
        process.argv[6] === 'empty',
      );
    else await initialize(process.argv[2], process.argv[3]);
  })().catch((error) => {
    console.error(`[volumes] ${error.message}`);
    process.exitCode = 1;
  });
}
