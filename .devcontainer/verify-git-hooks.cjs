'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function verifyGitHooks(root = process.cwd()) {
  root = path.resolve(root);
  if (process.env.HUSKY === '0') throw new Error('HUSKY=0 disables pre-commit hooks.');

  const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (path.resolve(root, hooksPath) !== path.join(root, '.husky', '_')) {
    throw new Error('core.hooksPath must point to .husky/_.');
  }

  for (const [file, mode] of [
    ['.husky/pre-commit', fs.constants.R_OK],
    ['.husky/_/h', fs.constants.R_OK],
    ['.husky/_/pre-commit', fs.constants.R_OK | fs.constants.X_OK],
  ]) {
    const target = path.join(root, file);
    if (!fs.statSync(target).isFile()) throw new Error(`${file} must be a file.`);
    fs.accessSync(target, mode);
  }

  // Exercise the installed Husky helper, including its init.sh, against a
  // temporary sentinel hook. Never run the real pre-commit or touch the index.
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-probe-'));
  try {
    const token = randomUUID();
    fs.mkdirSync(path.join(probe, '_'));
    fs.writeFileSync(path.join(probe, 'pre-commit'), `printf '%s\\n' '${token}'\n`);
    const output = execFileSync(
      'sh',
      ['-c', '. "$1"', path.join(probe, '_/pre-commit'), path.join(root, '.husky/_/h')],
      { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (!output.includes(token)) {
      throw new Error('Husky startup configuration disables or skips pre-commit hooks.');
    }
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

module.exports = { verifyGitHooks };

if (require.main === module) {
  try {
    verifyGitHooks();
    console.log('[install-deps] Husky pre-commit hook is installed and enabled');
  } catch (error) {
    console.error(`[install-deps] Husky verification failed: ${error.message}`);
    console.error('Run npm run prepare at the repository root and keep HUSKY enabled.');
    process.exitCode = 1;
  }
}
