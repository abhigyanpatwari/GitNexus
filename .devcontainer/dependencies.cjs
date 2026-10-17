'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const markerName = '.gitnexus-devcontainer-install.json';
const nativeInputs = [
  'vendor',
  'scripts/build-tree-sitter-grammars.cjs',
  'scripts/prepare-tree-sitter-bundle.cjs',
];

function fingerprint(directory, runtime = process) {
  const hash = crypto.createHash('sha256');
  hash.update(
    JSON.stringify([
      2,
      runtime.version,
      runtime.versions.modules,
      runtime.platform,
      runtime.arch,
      runtime.npmVersion,
    ]),
  );
  for (const file of ['package.json', 'package-lock.json']) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(directory, file)));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  for (const dependency of Object.values({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    if (typeof dependency !== 'string' || !dependency.startsWith('file:')) continue;
    const sibling = path.resolve(directory, dependency.slice(5), 'package.json');
    hash.update(fs.readFileSync(sibling));
  }
  if (fs.existsSync(path.join(directory, 'scripts/build-tree-sitter-grammars.cjs'))) {
    // Blob IDs cover committed native inputs; the diff covers local tracked
    // edits. Do not read npm credential files or hash large unchanged prebuilds.
    for (const args of [
      ['ls-files', '-s', '--', ...nativeInputs],
      ['diff', 'HEAD', '--', ...nativeInputs],
    ]) {
      hash.update(execFileSync('git', args, { cwd: directory, maxBuffer: 32 * 1024 * 1024 }));
    }
  }
  return hash.digest('hex');
}

function ensureDependencies(directory, { run = runNpm, force = false, runtime = process } = {}) {
  const expected = fingerprint(directory, runtime);
  const marker = path.join(directory, 'node_modules', markerName);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  const packages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    /* First or interrupted install. */
  }
  const present = packages.every((name) =>
    fs.existsSync(path.join(directory, 'node_modules', name, 'package.json')),
  );
  if (!force && present && saved?.fingerprint === expected) {
    console.log(
      `[install-deps] ${path.basename(directory)} dependencies unchanged; reusing volume`,
    );
    return false;
  }
  // Invalidate before installing: a failed attempt must never leave a reusable receipt.
  fs.rmSync(marker, { force: true });
  run(directory, ['ci']);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  const temporary = `${marker}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ fingerprint: fingerprint(directory, runtime) }));
  fs.renameSync(temporary, marker);
  return true;
}

function runNpm(directory, args) {
  execFileSync('npm', args, { cwd: directory, stdio: 'inherit' });
}

function timed(label, action) {
  const start = performance.now();
  try {
    return action();
  } finally {
    console.log(`[install-deps] ${label}: ${((performance.now() - start) / 1000).toFixed(2)}s`);
  }
}

module.exports = { fingerprint, ensureDependencies, markerName };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || '/workspace');
  const runtime = {
    version: process.version,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  };
  const ensure = (directory) =>
    timed(`dependencies ${path.basename(directory)}`, () =>
      ensureDependencies(directory, { force: process.env.GITNEXUS_FORCE_DEPS === '1', runtime }),
    );
  ensure(root);
  // Always restore and verify hooks, including the cached-install path.
  runNpm(root, ['run', 'prepare']);
  require('./verify-git-hooks.cjs').verifyGitHooks(root);
  console.log('[install-deps] Husky hooks verified');
  const shared = path.join(root, 'gitnexus-shared');
  ensure(shared);
  timed('shared build', () => runNpm(shared, ['run', 'build']));
  const web = path.join(root, 'gitnexus-web');
  ensure(web);
  const core = path.join(root, 'gitnexus');
  // A fresh npm ci already builds via prepare. A reused install still needs
  // source compilation, even when manifests and lockfiles have not changed.
  if (!ensure(core)) timed('CLI source build', () => runNpm(core, ['run', 'build']));
  if (process.env.GITNEXUS_DEV_UI === '1') {
    timed('Chromium provisioning', () =>
      execFileSync(path.join(web, 'node_modules/.bin/playwright'), ['install', 'chromium'], {
        cwd: web,
        stdio: 'inherit',
      }),
    );
  }
}
