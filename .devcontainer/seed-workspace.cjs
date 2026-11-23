'use strict';
// Runs in the temporary importer (state checks, symlink restoration) and, from
// the seed volume, as root in onCreateCommand to commit the stage and repair ownership.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MARKER = '.git/devcontainer-source-volume';
// Seed volume layout: the staged checkout, a marker written after it is
// complete, and this script (copied from the host on every start).
const STAGE_TREE = 'tree';
const STAGE_COMPLETE = 'stage-complete';
const DEPENDENCIES = [
  'node_modules',
  'gitnexus/node_modules',
  'gitnexus-web/node_modules',
  'gitnexus-shared/node_modules',
];
function isWorkspaceExcluded(relative) {
  const parts = relative.split(path.sep);
  const git = parts.indexOf('.git');
  // Ref names can contain node_modules: preserve all Git metadata except our marker.
  if (git !== -1) return parts.slice(git).join('/') === MARKER;
  return (
    parts.includes('node_modules') ||
    parts.includes('.venv') ||
    // Parser caches are regenerable and can dwarf the checkout across worktrees.
    // Keep the graph, embeddings, metadata and runner in the same .gitnexus dir.
    parts.some(
      (part, i) =>
        part === '.gitnexus' &&
        ['parse-cache', 'parse-cache.json', 'parsedfile-cache'].includes(parts[i + 1]),
    ) ||
    parts.some((part, i) => part === '.husky' && parts[i + 1] === '_')
  );
}

function rootType(file) {
  try {
    return fs.statSync(file);
  } catch {
    return fs.lstatSync(file); // Dangling, or a WSL link Windows cannot follow.
  }
}

function* archiveEntries(source, entries, { exclude = () => false, links = [] } = {}) {
  source = fs.realpathSync(source);
  function* visit(relative, type) {
    if (exclude(relative)) return;
    const file = path.join(source, relative);
    // Selected roots follow existing links, like the bind mounts they replace
    // nested links are recorded and restored verbatim.
    type ??= rootType(file);
    const portable = relative.split(path.sep).join('/');
    if (type.isSymbolicLink()) {
      links.push([portable, fs.readlinkSync(file)]);
      return;
    }
    if (!type.isFile() && !type.isDirectory()) return; // Sockets and FIFOs, like tar.
    yield relative === '.' ? '.' : `./${portable}`;
    if (type.isDirectory()) {
      for (const entry of fs.readdirSync(file, { withFileTypes: true }))
        yield* visit(path.join(relative, entry.name), entry);
    }
  }
  for (const entry of entries) yield* visit(path.normalize(entry));
}

function restoreLinks(root, links) {
  root = fs.realpathSync(root);
  if (!Array.isArray(links)) throw new Error('Invalid symlink manifest');
  const seen = new Set();
  const validated = links.map((link) => {
    if (
      !Array.isArray(link) ||
      link.length !== 2 ||
      link.some((s) => typeof s !== 'string' || !s || s.includes('\0'))
    )
      throw new Error('Invalid symlink entry');
    const [relative, target] = link;
    const parts = relative.split('/');
    const file = path.resolve(root, ...parts);
    if (
      parts.some((part) => !part || part === '.' || part === '..') ||
      !file.startsWith(root + path.sep) ||
      seen.has(file)
    )
      throw new Error('Symlink path must be unique and stay inside the archive destination');
    seen.add(file);
    for (let parent = path.dirname(file); parent !== root; parent = path.dirname(parent)) {
      const type = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (type && (!type.isDirectory() || type.isSymbolicLink()))
        throw new Error('Symlink parent must be a directory, not another symlink');
    }
    if (fs.lstatSync(file, { throwIfNoEntry: false }))
      throw new Error('Refusing to replace an existing archive entry with a symlink');
    return [file, target];
  });
  for (const [file] of validated) {
    for (let parent = path.dirname(file); parent !== root; parent = path.dirname(parent))
      if (seen.has(parent)) throw new Error('Symlink entries must not be parents of other entries');
  }
  for (const [file, target] of validated) {
    // Selected snapshot files can be links whose parent has no other archived entries.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file);
  }
}

function isDirectory(file) {
  return fs.existsSync(file) && fs.lstatSync(file).isDirectory();
}

function repairOwnership(target, uid = process.getuid(), gid = process.getgid()) {
  // Docker volumes can share a device, so -xdev alone cannot exclude dependencies.
  const prune = DEPENDENCIES.flatMap((entry, index) => [
    ...(index ? ['-o'] : []),
    '-path',
    path.join(target, entry),
  ]);
  execFileSync(
    process.getuid() === 0 ? 'find' : 'sudo',
    [
      ...(process.getuid() === 0 ? [] : ['-n', 'find']),
      target,
      '-xdev',
      '(',
      ...prune,
      ')',
      '-prune',
      '-o',
      '(',
      '!',
      '-uid',
      String(uid),
      '-o',
      '!',
      '-gid',
      String(gid),
      ')',
      '-exec',
      'chown',
      '-h',
      `${uid}:${gid}`,
      '{}',
      '+',
    ],
    { stdio: 'inherit' },
  );
}

function validateGitDirectory(gitDir, checkLocks = true) {
  if (!isDirectory(gitDir))
    throw new Error('Seed from a full Git checkout, not a linked worktree or symlinked .git');
  for (const config of ['config', 'config.worktree', 'commondir']) {
    const file = path.join(gitDir, config);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile())
      throw new Error('Git configuration must be a regular file, not a symlink');
  }
  const commonDir = path.join(gitDir, 'commondir');
  if (
    (fs.existsSync(commonDir) && fs.readFileSync(commonDir, 'utf8').trim() !== '.') ||
    !isDirectory(path.join(gitDir, 'objects')) ||
    fs.existsSync(path.join(gitDir, 'objects/info/alternates'))
  )
    throw new Error('The seed checkout must have its own Git object database; commondir must be .');
  for (const lock of ['index.lock', 'HEAD.lock', 'shallow.lock', 'packed-refs.lock']) {
    if (checkLocks && fs.existsSync(path.join(gitDir, lock)))
      throw new Error('A Git operation is active in the host checkout; retry after it finishes');
  }
}

function git(root, ...args) {
  return execFileSync(
    'git',
    ['-c', `safe.directory=${root}`, '-c', 'core.fsmonitor=false', '-C', root, ...args],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    },
  );
}

// A Windows core.worktree must not affect any later Git read of the checkout.
function detachWorktreeConfig(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile()) throw new Error('Git config must not be a symlink');
  const unset = spawnSync('git', ['config', '--file', file, '--unset-all', 'core.worktree']);
  if (unset.error || ![0, 5].includes(unset.status))
    throw new Error('Could not detach the copied Git configuration from its host path');
}

function normalizeGit(root) {
  const gitDir = path.join(root, '.git');
  validateGitDirectory(gitDir);
  for (const config of ['config', 'config.worktree'])
    detachWorktreeConfig(path.join(gitDir, config));
  const commonDirIs = (checkout) =>
    fs.realpathSync(
      git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
    ) === gitDir;
  if (!commonDirIs(root))
    throw new Error('The copied Git common directory is outside the source volume');

  const probe = fs.mkdtempSync(path.join(gitDir, 'filesystem-probe-'));
  let flags;
  try {
    const file = path.join(probe, 'probe');
    fs.writeFileSync(file, 'probe');
    fs.chmodSync(file, 0o644);
    const before = fs.statSync(file).mode;
    fs.chmodSync(file, 0o755);
    let symlinks = false;
    try {
      fs.symlinkSync('probe', path.join(probe, 'link'));
      symlinks = fs.lstatSync(path.join(probe, 'link')).isSymbolicLink();
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    }
    flags = {
      'core.ignorecase': fs.existsSync(path.join(probe, 'PROBE')),
      'core.filemode': (before & 0o111) !== (fs.statSync(file).mode & 0o111),
      'core.symlinks': symlinks,
    };
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }

  const checkouts = [root];
  const registrations = path.join(gitDir, 'worktrees');
  const pathParts = (file) =>
    fs
      .readFileSync(file, 'utf8')
      .trim()
      .split(/[\\/]+/);
  // The copy of a nested worktree whose .git file names this registration.
  const copiedWorktree = (dir, entry) => {
    if (!dir.startsWith(root + path.sep) || !isDirectory(dir)) return false;
    if (fs.realpathSync(dir) !== dir) return false;
    const file = path.join(dir, '.git');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return false;
    return pathParts(file).slice(-3).join('/') === `.git/worktrees/${entry}`;
  };
  if (isDirectory(registrations)) {
    for (const entry of fs.readdirSync(registrations)) {
      const pointer = path.join(registrations, entry, 'gitdir');
      if (!fs.existsSync(pointer) || !fs.lstatSync(pointer).isFile()) continue;
      // Pointers hold host paths (C:/..., /Users/...). Match the longest suffix
      // that exists in the copy, then relink both sides like `git worktree repair`.
      const parts = pathParts(pointer);
      const checkout = parts
        .map((_, i) => path.join(root, ...parts.slice(i, -1)))
        .find((dir) => copiedWorktree(dir, entry));
      if (!checkout) continue; // External worktrees stay registered but unrepaired.
      fs.writeFileSync(pointer, `${path.join(checkout, '.git')}\n`);
      fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${path.join(registrations, entry)}\n`);
      detachWorktreeConfig(path.join(registrations, entry, 'config.worktree'));
      if (commonDirIs(checkout)) checkouts.push(checkout);
    }
  }
  // Read each old setting before changing the common config used by worktrees.
  const old = checkouts.map((checkout) => {
    const get = (key) => {
      try {
        return git(checkout, 'config', '--bool', '--get', key).trim() !== 'false';
      } catch (error) {
        if (error.status === 1) return true;
        throw error;
      }
    };
    return { checkout, filemode: get('core.filemode'), symlinks: get('core.symlinks') };
  });
  for (const { checkout, filemode, symlinks } of old) {
    if (!filemode || !symlinks) {
      for (const record of git(checkout, 'ls-files', '--stage', '-z').split('\0')) {
        if (!record) continue;
        const tab = record.indexOf('\t');
        const [mode, oid, stage] = record.slice(0, tab).split(' ');
        if (stage !== '0') continue; // Preserve unresolved conflicts verbatim.
        const file = path.resolve(checkout, record.slice(tab + 1));
        if (!file.startsWith(checkout + path.sep) || !fs.existsSync(file)) continue;
        const stat = fs.lstatSync(file);
        // Never follow a replaced directory/symlink into other user files.
        if (!stat.isFile() || fs.realpathSync(file) !== file) continue;
        if (!filemode && flags['core.filemode'] && ['100644', '100755'].includes(mode)) {
          const execute = mode === '100755' ? (stat.mode & 0o444) >> 2 : 0;
          fs.chmodSync(file, (stat.mode & 0o777 & ~0o111) | execute);
        }
        if (!symlinks && flags['core.symlinks'] && mode === '120000') {
          const link = execFileSync('git', [
            '-c',
            `safe.directory=${checkout}`,
            '-C',
            checkout,
            'cat-file',
            'blob',
            oid,
          ]);
          if (fs.readFileSync(file).equals(link)) {
            // Build the link alongside the file before atomically replacing it.
            const temporary = fs.mkdtempSync(path.join(path.dirname(file), '.gitnexus-link-'));
            try {
              fs.symlinkSync(link, path.join(temporary, 'link'));
              fs.renameSync(path.join(temporary, 'link'), file);
            } finally {
              fs.rmSync(temporary, { recursive: true, force: true });
            }
          }
          // Edited placeholder files stay regular files, preserving their bytes.
        }
      }
    }
    const directory = git(checkout, 'rev-parse', '--absolute-git-dir').trim();
    for (const config of [
      checkout === root ? path.join(gitDir, 'config') : null,
      path.join(directory, 'config.worktree'),
    ]) {
      if (!config || !fs.existsSync(config)) continue;
      if (!fs.lstatSync(config).isFile()) throw new Error('Git config must not be a symlink');
      for (const [key, value] of Object.entries(flags))
        execFileSync('git', ['config', '--file', config, key, String(value)], { stdio: 'pipe' });
    }
  }
}

// initializeCommand runs on every start, so it only stages. Committing here,
// in onCreateCommand, happens once per container creation and only accepts a
// stage whose completion marker was written after the copy finished.
function commitStaged(seed, target) {
  if (workspaceState(target) === 'empty') {
    if (!fs.lstatSync(path.join(seed, STAGE_COMPLETE), { throwIfNoEntry: false })?.isFile())
      throw new Error(
        'No complete staged checkout. The initializeCommand output explains why, usually a host ' +
          'process writing during the copy or an active Git operation. Stop host writers, then ' +
          'run Rebuild Container.',
      );
    seedWorkspace(path.join(seed, STAGE_TREE), target);
  }
  for (const name of [STAGE_COMPLETE, STAGE_TREE])
    fs.rmSync(path.join(seed, name), { recursive: true, force: true });
}

function prepareWorkspace(target, seed, uid, gid) {
  if (process.getuid() !== 0) throw new Error('Workspace preparation must run through sudo');
  commitStaged(seed, target);
  target = fs.realpathSync(target);
  validateGitDirectory(path.join(target, '.git'), false);
  if (!fs.lstatSync(path.join(target, MARKER)).isFile())
    throw new Error('Source volume is not initialized');
  // Root can inspect a 0700 .git from a previous UID; never mistake EACCES for ENOENT.
  repairOwnership(target, uid, gid);
}

function workspaceState(target) {
  target = fs.realpathSync(target);
  const marker = path.join(target, MARKER);
  if (fs.existsSync(marker)) {
    if (!isDirectory(path.join(target, '.git')) || !fs.lstatSync(marker).isFile())
      throw new Error('Invalid source-volume marker; inspect the volume before continuing');
    validateGitDirectory(path.join(target, '.git'), false);
    return 'ready';
  }
  // Docker creates the four dependency mounts and their parents before this
  // hook. Accept only those directories; never merge into an interrupted copy
  // or an unrecognized checkout. Do not descend into the dependency volumes.
  const parents = new Set(DEPENDENCIES.map((entry) => path.dirname(entry)));
  function checkEmpty(relative) {
    for (const name of fs.readdirSync(path.join(target, relative))) {
      const entry = path.join(relative, name);
      if (isDirectory(path.join(target, entry))) {
        if (DEPENDENCIES.includes(entry)) continue;
        if (parents.has(entry)) {
          checkEmpty(entry);
          continue;
        }
      }
      throw new Error(
        `Uninitialized source volume contains ${entry}. No files were replaced. ` +
          'Inspect and preserve its contents before retrying.',
      );
    }
  }
  checkEmpty('');
  return 'empty';
}

function assertSeparate(source, target) {
  if (
    source === target ||
    source.startsWith(target + path.sep) ||
    target.startsWith(source + path.sep)
  )
    throw new Error('Source and destination must be separate directories');
}

function seedWorkspace(source, target) {
  source = path.resolve(source);
  target = fs.realpathSync(target);
  assertSeparate(source, target);
  if (workspaceState(target) === 'ready') {
    console.log('[workspace] Reusing source volume; host files were not copied.');
    return false;
  }
  source = fs.realpathSync(source);
  assertSeparate(source, target);
  validateGitDirectory(path.join(source, '.git'));

  console.log('[workspace] Copying the staged checkout once, including Git and local changes...');
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    force: false,
    errorOnExist: true,
    filter: (file) => !isWorkspaceExcluded(path.relative(source, file)),
  });
  normalizeGit(target);
  const checkout = git(target, 'rev-parse', '--show-toplevel').trim();
  if (fs.realpathSync(checkout) !== target)
    throw new Error('The copied repository still points outside the workspace volume');
  fs.writeFileSync(
    path.join(target, MARKER),
    'Source volume initialized. Do not overwrite it with host files.\n',
    {
      flag: 'wx',
    },
  );
  console.log('[workspace] Ready. Edit /workspace in VS Code; the host copy is not synchronized.');
  return true;
}

module.exports = {
  seedWorkspace,
  commitStaged,
  validateGitDirectory,
  isWorkspaceExcluded,
  archiveEntries,
  restoreLinks,
  STAGE_COMPLETE,
  STAGE_TREE,
};
if (require.main === module) {
  try {
    if (process.argv[2] === '--restore-links') {
      restoreLinks(process.argv[3], JSON.parse(fs.readFileSync(0, 'utf8')));
    } else if (process.argv[2] === '--state') {
      console.log(workspaceState(process.argv[3]));
    } else if (process.argv[2] === '--prepare') {
      const uid = process.env.SUDO_UID;
      const gid = process.env.SUDO_GID;
      if (!/^\d+$/.test(uid || '') || !/^\d+$/.test(gid || ''))
        throw new Error('Run workspace preparation with sudo from the remote user');
      if (!process.argv[3] || !process.argv[4])
        throw new Error('Usage: seed-workspace.cjs --prepare TARGET SEED');
      prepareWorkspace(process.argv[3], process.argv[4], Number(uid), Number(gid));
    } else {
      throw new Error('Usage: seed-workspace.cjs --prepare TARGET SEED');
    }
  } catch (error) {
    console.error(`[workspace] ${error.message}`);
    process.exitCode = 1;
  }
}
