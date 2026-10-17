'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function verifyGitHooks(root = process.cwd()) {
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
