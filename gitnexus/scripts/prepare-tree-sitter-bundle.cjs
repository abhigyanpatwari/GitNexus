#!/usr/bin/env node
/**
 * Prepare the tested native parser dependencies for installation and publication.
 *
 * A dependency's npm overrides do not apply in a consumer project. Several
 * ABI-compatible grammars still advertise older runtime peers, so bundling
 * alone leaves an invalid dependency tree. Admit only the runtime version we
 * tested, in only the audited manifests below. Five audited upstream Linux
 * ARM64 binaries are repaired before packing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isArm64NapiSharedObject } = require('./arm64-prebuild.cjs');

const RUNTIME = '0.25.1';
// Upstream metadata is an input to validate, never the peer range we ship.
const AUDITED_PEERS = new Map([
  ['@eagleoutice/tree-sitter-r@1.1.2', '^0.21.0'],
  ['tree-sitter-c@0.23.6', '^0.22.1'],
  ['tree-sitter-cpp@0.23.4', '^0.21.1'],
  ['tree-sitter-java@0.23.5', '^0.21.1'],
  ['tree-sitter-php@0.24.2', '^0.22.4'],
  ['tree-sitter-ruby@0.23.1', '^0.21.1'],
  ['tree-sitter-rust@0.24.0', '^0.22.1'],
  ['tree-sitter-javascript@0.23.1', '^0.21.1'],
  ['tree-sitter-typescript@0.23.2', '^0.21.0'],
]);
// These npm releases put x86-64 bytes in their linux-arm64 prebuild directory.
// Keep the replacement set explicit: upstream upgrades require a new audit.
const ARM64_REPAIRS = new Set([
  'tree-sitter-cpp@0.23.4',
  'tree-sitter-java@0.23.5',
  'tree-sitter-ruby@0.23.1',
  'tree-sitter-javascript@0.23.1',
  'tree-sitter-typescript@0.23.2',
]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function readArm64Repairs(packageRoot) {
  const root = path.join(packageRoot, 'prebuilds', 'bundled');
  const manifest = readJson(path.join(root, 'manifest.json'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.tuple !== 'linux-arm64' ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length !== ARM64_REPAIRS.size
  ) {
    throw new Error('Invalid bundled ARM64 prebuild manifest');
  }
  const repairs = new Map();
  for (const entry of manifest.packages) {
    const identity = `${entry.name}@${entry.version}`;
    const expectedFile = `${identity}/linux-arm64/${entry.name}.node`;
    if (!ARM64_REPAIRS.has(identity) || repairs.has(identity) || entry.file !== expectedFile) {
      throw new Error(`Unexpected bundled ARM64 prebuild identity: ${identity}`);
    }
    const bytes = fs.readFileSync(path.join(root, entry.file));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Bundled ARM64 prebuild checksum mismatch: ${identity}`);
    }
    if (!isArm64NapiSharedObject(bytes)) {
      throw new Error(`Bundled prebuild is not an AArch64 N-API shared object: ${identity}`);
    }
    repairs.set(identity, bytes);
  }
  return repairs;
}

function prepareTreeSitterBundle(
  packageRoot = path.resolve(__dirname, '..'),
  { forPublication = false } = {},
) {
  const modulesRoot = path.join(packageRoot, 'node_modules');
  const manifest = readJson(path.join(packageRoot, 'package.json'));
  if (manifest.dependencies['tree-sitter'] !== RUNTIME) {
    throw new Error(`Tree-sitter bundle is only validated for runtime ${RUNTIME}`);
  }
  // A grammar is recognised by its package basename, so a scoped package such as
  // @eagleoutice/tree-sitter-r is held to the same bundling and pinning rules.
  const grammars = Object.keys(manifest.dependencies).filter(
    (name) => name === 'tree-sitter' || name.split('/').pop().startsWith('tree-sitter-'),
  );
  for (const name of grammars) {
    if (
      !Array.isArray(manifest.bundleDependencies) ||
      !manifest.bundleDependencies.includes(name)
    ) {
      throw new Error(`${name} must be bundled; consumers do not inherit npm overrides`);
    }
    const installed = readJson(path.join(modulesRoot, name, 'package.json'));
    if (installed.version !== manifest.dependencies[name]) {
      throw new Error(`${name}: installed version differs from the exact package.json pin`);
    }
  }

  const patches = [];
  const visited = new Set();
  function visit(modules) {
    if (!fs.existsSync(modules)) return;
    modules = fs.realpathSync(modules);
    if (visited.has(modules)) return;
    visited.add(modules);
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const dir = path.join(modules, entry.name);
      if (
        !entry.isDirectory() &&
        (!entry.isSymbolicLink() || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
      ) {
        continue;
      }
      if (entry.name.startsWith('@')) {
        visit(dir);
        continue;
      }
      const realDir = fs.realpathSync(dir);
      if (visited.has(realDir)) continue;
      visited.add(realDir);
      const file = path.join(realDir, 'package.json');
      if (fs.existsSync(file)) {
        const pkg = readJson(file);
        const original = AUDITED_PEERS.get(`${pkg.name}@${pkg.version}`);
        if (original) {
          // Also accept bundles prepared before peers were pinned exactly, so
          // an existing checkout can migrate through ordinary npm install.
          const accepted = [original, `${original} || ${RUNTIME}`, RUNTIME];
          if (!accepted.includes(pkg.peerDependencies?.['tree-sitter'])) {
            throw new Error(`Unexpected tree-sitter peer metadata for ${pkg.name}@${pkg.version}`);
          }
          pkg.peerDependencies['tree-sitter'] = RUNTIME;
          patches.push({ file, pkg });
        }
      }
      visit(path.join(realDir, 'node_modules'));
      // pnpm links packages into node_modules but places their dependencies
      // beside the real package. Follow that container without traversing the
      // entire virtual store; realpaths deduplicate aliases and break cycles.
      let parent = path.dirname(realDir);
      if (path.basename(parent).startsWith('@')) parent = path.dirname(parent);
      if (path.basename(parent) === 'node_modules') visit(parent);
    }
  }
  visit(modulesRoot);
  const identities = new Set(patches.map(({ pkg }) => `${pkg.name}@${pkg.version}`));
  if (patches.length !== AUDITED_PEERS.size || identities.size !== AUDITED_PEERS.size) {
    throw new Error('Tree-sitter dependency layout changed; revalidate the audited peer manifests');
  }

  const repairs = readArm64Repairs(packageRoot);
  const binaries = [];
  const shadows = [];
  for (const { pkg, file } of patches) {
    const dir = path.dirname(file);
    const bytes = repairs.get(`${pkg.name}@${pkg.version}`);
    if (!bytes) continue;
    const target = path.join(dir, 'prebuilds', 'linux-arm64', `${pkg.name}.node`);
    // A changed upstream layout needs review rather than creating a second
    // candidate that node-gyp-build may not select.
    const candidates = fs
      .readdirSync(path.dirname(target))
      .filter((name) => name.endsWith('.node'));
    if (candidates.length !== 1 || candidates[0] !== path.basename(target)) {
      throw new Error(`Unexpected ARM64 prebuild layout for ${pkg.name}@${pkg.version}`);
    }
    binaries.push({ target, bytes });
    if (forPublication) {
      // node-gyp-build prefers local build outputs over prebuilds, even when
      // those outputs were compiled on the publisher's other architecture.
      // Preserve legitimate consumer source builds during ordinary postinstall.
      for (const mode of ['Release', 'Debug']) {
        const build = path.join(dir, 'build', mode);
        if (fs.existsSync(build)) {
          for (const name of fs.readdirSync(build)) {
            if (name.endsWith('.node')) shadows.push(path.join(build, name));
          }
        }
      }
    }
  }

  // Validate the complete set before writing, so dependency drift cannot leave
  // a partially prepared bundle behind. Repeated pack operations are idempotent.
  for (const { file, pkg } of patches) {
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  }
  for (const { target, bytes } of binaries) {
    if (!fs.readFileSync(target).equals(bytes)) fs.writeFileSync(target, bytes);
  }
  for (const file of shadows) fs.unlinkSync(file);
  return patches.map(({ pkg }) => `${pkg.name}@${pkg.version}`);
}

if (require.main === module) {
  const prepared = prepareTreeSitterBundle(undefined, {
    forPublication: process.argv.includes('--for-publication'),
  });
  console.log(
    `[tree-sitter-bundle] Validated runtime ${RUNTIME}; prepared ${prepared.length} peer manifests.`,
  );
}

module.exports = { prepareTreeSitterBundle };
