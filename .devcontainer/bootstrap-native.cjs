'use strict';
// Runs from the image before any workspace lifecycle script exists in the
// fresh volume. Never reset or overwrite a populated checkout.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function bootstrap(root, url, ref) {
  if (!url || !ref || ref.startsWith('-')) throw new Error('A clone URL and branch are required');
  fs.mkdirSync(root, { recursive: true });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  git('check-ref-format', '--branch', ref);
  if (!fs.existsSync(path.join(root, '.git'))) git('init');
  let origin;
  try {
    origin = git('remote', 'get-url', 'origin');
  } catch {
    git('remote', 'add', 'origin', url);
    origin = url;
  }
  if (origin !== url) throw new Error('Workspace volume has another origin; refusing to modify it');
  try {
    git('rev-parse', '--verify', 'HEAD');
    return;
  } catch {
    /* Resume an interrupted initial fetch. */
  }
  git('fetch', 'origin', ref);
  git('checkout', '-b', ref, 'FETCH_HEAD');
}

module.exports = { bootstrap };
if (require.main === module) {
  const root = path.resolve(process.argv[2] || '/workspace');
  // Repair UID changes on a reused workspace volume without following symlinks
  // or descending into the separately mounted dependency volumes.
  const uid = String(process.getuid());
  const gid = String(process.getgid());
  execFileSync(
    'sudo',
    [
      '-n',
      'find',
      root,
      '-xdev',
      '(',
      '!',
      '-uid',
      uid,
      '-o',
      '!',
      '-gid',
      gid,
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
  bootstrap(root, process.env.GITNEXUS_CLONE_URL, process.env.GITNEXUS_CLONE_REF);
}
