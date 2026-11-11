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
  STAGE_COMPLETE,
  STAGE_TREE,
} = require('./seed-workspace.cjs');

const SNAPSHOT_MARKER = '.devcontainer-snapshot-v1';
// Tests replace the Docker CLI with a Node adapter (JSON argv). Windows spawn
// resolves only .exe/.com files, so a script on PATH cannot stand in for docker.
const [DOCKER, ...DOCKER_ARGS] = JSON.parse(process.env.GITNEXUS_IMPORT_DOCKER || '["docker"]');
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
  return fs.existsSync(marker) && fs.lstatSync(marker).isFile() ? 'ready' : 'stale';
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

// Docker's copy API takes a tar stream, written here as ustar with PAX records
// for long or non-ASCII names. Host tar is avoided: Windows tar reads file lists
// in the ANSI code page, macOS tar adds AppleDouble ._* entries, and both pad or
// truncate a file that changes while it is read.
const MAX_OCTAL_SIZE = 0o77777777777;
const tarPadding = (size) => Buffer.alloc((512 - (size % 512)) % 512);

function tarHeader(name, type, size, mode, mtime) {
  const block = Buffer.alloc(512);
  // Width - 1 octal digits; the zero-filled last byte terminates each field.
  const octal = (offset, width, value) =>
    block.write(value.toString(8).padStart(width - 1, '0'), offset, width - 1, 'ascii');
  block.write(name.replace(/[^ -~]/g, '_').slice(-100), 0, 100, 'ascii'); // PAX holds the real name.
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, mtime);
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\x0000', 257, 8, 'ascii');
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(body);
  let length = bytes + 1;
  while (String(length).length + bytes !== length) length = String(length).length + bytes;
  return `${length}${body}`;
}

async function* tarStream(source, names) {
  for (const name of names) {
    const file = path.join(source, name);
    const before = fs.statSync(file, { throwIfNoEntry: false });
    const directory = before?.isDirectory();
    if (!directory && !before?.isFile())
      throw new Error(`${file} changed during the import; stop host writers and retry`);
    // Windows reports 0666/0777 modes; normalizeGit restores tracked executable bits.
    const mode = process.platform === 'win32' ? (directory ? 0o755 : 0o644) : before.mode & 0o777;
    const mtime = Math.max(0, Math.floor(before.mtimeMs / 1000));
    const size = directory ? 0 : before.size;
    const entry = directory ? `${name}/` : name;
    const records = [];
    if (!/^[ -~]{1,100}$/.test(entry)) records.push(paxRecord('path', entry));
    if (size > MAX_OCTAL_SIZE) records.push(paxRecord('size', String(size)));
    if (records.length) {
      const body = Buffer.from(records.join(''));
      yield tarHeader('PaxHeader', 'x', body.length, 0o644, mtime);
      yield body;
      yield tarPadding(body.length);
    }
    yield tarHeader(entry, directory ? '5' : '0', size > MAX_OCTAL_SIZE ? 0 : size, mode, mtime);
    if (directory) continue;
    let read = 0;
    // Reading a small file whole is ~10x faster than opening a stream for it.
    const chunks =
      size <= 1 << 20
        ? [fs.readFileSync(file)]
        : fs.createReadStream(file, { highWaterMark: 1 << 20 });
    for await (const chunk of chunks) {
      read += chunk.length;
      if (read > size) break;
      yield chunk;
    }
    const after = fs.statSync(file, { throwIfNoEntry: false });
    if (read !== size || after?.size !== size || after.mtimeMs !== before.mtimeMs)
      throw new Error(`${file} changed during the import; stop host writers and retry`);
    yield tarPadding(size);
  }
  yield Buffer.alloc(1024);
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
  const child = spawn(DOCKER, [...DOCKER_ARGS, ...args], {
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

async function copyArchive(source, entries, destination, exclude = () => false) {
  if (!entries.length) return;
  const links = [];
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
    exclude: (relative) => {
      const omit = exclude(relative);
      if (omit) skipped++;
      return omit;
    },
  });
  const copy = spawn(DOCKER, [...DOCKER_ARGS, 'cp', '-', destination], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    const names = (function* () {
      for (const entry of listing) {
        queued++;
        yield entry;
      }
    })();
    await Promise.all([
      childDone(copy, 'docker cp'),
      pipeline(Readable.from(tarStream(fs.realpathSync(source), names)), meter, copy.stdin),
    ]);
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
    execFileSync(DOCKER, [...DOCKER_ARGS, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
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
  // The host never writes the workspace volume; it only fills the staging volume.
  if (mode === 'source')
    mounts.push(
      `type=volume,source=gitnexus-source-${id},target=/workspace,volume-nocopy,readonly`,
      `type=volume,source=gitnexus-seed-${id},target=/seed,volume-nocopy`,
    );
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
    const clear = (target) =>
      docker('exec', name, 'find', target, '-xdev', '-mindepth', '1', '-delete');
    // Stages and snapshot retakes are best-effort: initializeCommand also runs
    // when an existing container is reopened, and a busy host must not lock it
    // out. A failure clears its target; the next start retries it.
    const attempt = async (label, target, work) => {
      try {
        await work();
        return true;
      } catch (error) {
        clear(target);
        console.warn(`[volumes] ${label} skipped and retried on the next start: ${error.message}`);
        return false;
      }
    };
    // The host only stages. onCreateCommand commits a complete stage once per
    // container creation, so reopening an older container just refreshes it.
    const staging =
      mode === 'source' && run('seed-workspace.cjs', '--state', '/workspace') === 'empty';
    if (staging)
      await attempt('Staging the checkout', '/seed', async () => {
        console.log(
          '[volumes] Staging the checkout, Git metadata and local work; skipping dependencies and regenerable parser caches. Container creation copies it into the source volume once.',
        );
        clear('/seed'); // Removes the completion marker before anything else.
        validateGitDirectory(path.join(workspace, '.git'));
        docker('exec', name, 'mkdir', `/seed/${STAGE_TREE}`);
        await copyArchive(workspace, ['.'], `${name}:/seed/${STAGE_TREE}`, isWorkspaceExcluded);
        docker('exec', name, 'touch', `/seed/${STAGE_COMPLETE}`); // Written last.
      });
    // onCreateCommand runs this host copy, so it matches devcontainer.json and
    // works with any image, including prebuilt ones.
    if (mode === 'source')
      docker('cp', path.join(__dirname, 'seed-workspace.cjs'), `${name}:/seed/seed-workspace.cjs`);
    // Linux hosts realign the remote UID; Desktop on Windows/macOS keeps node=1000.
    // updateRemoteUserUID skips root hosts (UID 0 already exists), so node stays 1000.
    const realign = process.platform === 'linux' && process.getuid() !== 0;
    const uid = String(realign ? process.getuid() : 1000);
    const gid = String(realign ? process.getgid() : 1000);
    for (const snapshot of snapshots) {
      // Snapshots are read-only host copies, so replacing one is always safe.
      // Refresh partial ones, and all of them until the workspace is committed.
      const fresh =
        staging || run('initialize-volumes.cjs', '--snapshot-state', snapshot.target) !== 'ready';
      const copied =
        fresh &&
        (await attempt(`Snapshot ${snapshot.volume}`, snapshot.target, async () => {
          clear(snapshot.target);
          // lstat keeps dangling links; the archiver records any root it cannot follow.
          // Like existsSync, a path under a non-directory is just absent.
          const entries = snapshot.entries.filter((entry) => {
            try {
              return Boolean(fs.lstatSync(path.join(snapshot.source, entry)));
            } catch {
              return false;
            }
          });
          console.log(`[volumes] Creating ${snapshot.volume}`);
          await copyArchive(
            snapshot.source,
            entries,
            `${name}:${snapshot.target}`,
            (relative) => relative === SNAPSHOT_MARKER,
          );
        }));
      if (fresh && !copied) continue; // Never mark a cleared snapshot complete.
      await runWithProgress(`Finalizing ${snapshot.target}`, [
        'exec',
        name,
        'node',
        '/tmp/initialize-volumes.cjs',
        '--snapshot-finish',
        snapshot.target,
        uid,
        gid,
        fresh ? 'fresh' : 'kept',
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
  tarStream,
  startProgress,
  snapshotState,
  HOST_PATHS,
};
if (require.main === module) {
  (async () => {
    if (process.argv[2] === '--snapshot-state') console.log(snapshotState(process.argv[3]));
    else if (process.argv[2] === '--snapshot-finish')
      finishSnapshot(
        process.argv[3],
        Number(process.argv[4]),
        Number(process.argv[5]),
        process.argv[6] === 'fresh',
      );
    else await initialize(process.argv[2], process.argv[3]);
  })().catch((error) => {
    console.error(`[volumes] ${error.message}`);
    process.exitCode = 1;
  });
}
