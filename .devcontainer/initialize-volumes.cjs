'use strict';
// Host-side importer. Docker's copy API transfers bytes without mounting the host.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { EXCLUDED, validateGitDirectory } = require('./seed-workspace.cjs');

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

function archiveArgs(source, entries, excludes = []) {
  return ['-C', source, ...excludes.map((entry) => `--exclude=./${entry}`), '-cf', '-', ...entries];
}

async function copyArchive(source, entries, destination, excludes = []) {
  if (!entries.length) return;
  // No shell: spaces, apostrophes and Windows drive letters remain literal arguments.
  // Watch both processes: a failed tar must never publish a successful seed marker.
  const archive = spawn('tar', archiveArgs(source, entries, excludes), {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const copy = spawn('docker', ['cp', '-', destination], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = (child, name) =>
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)),
      );
    });
  const pipeDone = new Promise((resolve, reject) => {
    copy.stdin.once('error', reject);
    copy.stdin.once('finish', resolve);
    archive.stdout.once('error', reject);
  });
  archive.stdout.pipe(copy.stdin);
  try {
    await Promise.all([done(archive, 'tar'), done(copy, 'docker cp'), pipeDone]);
  } catch (error) {
    archive.kill();
    copy.kill();
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
    docker(
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
    );
    created = true;
    docker('start', name);
    for (const file of ['initialize-volumes.cjs', 'seed-workspace.cjs'])
      docker('cp', path.join(__dirname, file), `${name}:/tmp/${file}`);
    const run = (script, ...args) => docker('exec', name, 'node', `/tmp/${script}`, ...args);
    if (mode === 'source' && run('seed-workspace.cjs', '--state', '/workspace') === 'empty') {
      validateGitDirectory(path.join(workspace, '.git'));
      console.log('[volumes] Importing the checkout, Git metadata and local work once...');
      docker('exec', name, 'mkdir', '/seed');
      await copyArchive(workspace, ['.'], `${name}:/seed`, [...EXCLUDED]);
      run('seed-workspace.cjs', '/seed', '/workspace');
    }
    // Linux hosts realign the remote UID; Desktop on Windows/macOS keeps node=1000.
    const uid = String(process.platform === 'linux' ? process.getuid() : 1000);
    const gid = String(process.platform === 'linux' ? process.getgid() : 1000);
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
      run('initialize-volumes.cjs', '--snapshot-finish', snapshot.target, uid, gid, state);
    }
    console.log('[volumes] Linux volumes ready. Host files are not synchronized.');
  } finally {
    // Only the disposable helper is removed, never any volume or host file.
    if (created) docker('rm', '-f', name);
  }
}

module.exports = {
  initialize,
  copyArchive,
  archiveArgs,
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
