#!/usr/bin/env node
/**
 * Prepare the tested native parser bundle for npm pack/publish.
 *
 * A dependency's npm overrides do not apply in a consumer project. Several
 * ABI-compatible grammars still advertise older runtime peers, so bundling
 * alone leaves an invalid dependency tree. Admit only the runtime version we
 * tested, in only the audited manifests below. Sources and binaries are intact.
 */
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME = '0.25.1';
const AUDITED_PEERS = new Map([
  ['tree-sitter-c@0.23.6', '^0.22.1'],
  ['tree-sitter-cpp@0.23.4', '^0.21.1'],
  ['tree-sitter-java@0.23.5', '^0.21.1'],
  ['tree-sitter-php@0.24.2', '^0.22.4'],
  ['tree-sitter-ruby@0.23.1', '^0.21.1'],
  ['tree-sitter-rust@0.24.0', '^0.22.1'],
  ['tree-sitter-javascript@0.23.1', '^0.21.1'],
  ['tree-sitter-typescript@0.23.2', '^0.21.0'],
]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function prepareTreeSitterBundle(packageRoot = path.resolve(__dirname, '..')) {
  const modulesRoot = path.join(packageRoot, 'node_modules');
  const manifest = readJson(path.join(packageRoot, 'package.json'));
  if (manifest.dependencies['tree-sitter'] !== RUNTIME) {
    throw new Error(`Tree-sitter bundle is only validated for runtime ${RUNTIME}`);
  }
  const grammars = Object.keys(manifest.dependencies).filter(
    (name) => name === 'tree-sitter' || name.startsWith('tree-sitter-'),
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
  function visit(modules) {
    if (!fs.existsSync(modules)) return;
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(modules, entry.name);
      if (entry.name.startsWith('@')) {
        visit(dir);
        continue;
      }
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const pkg = readJson(file);
        const original = AUDITED_PEERS.get(`${pkg.name}@${pkg.version}`);
        if (original) {
          const peer = `${original} || ${RUNTIME}`;
          if (![original, peer].includes(pkg.peerDependencies?.['tree-sitter'])) {
            throw new Error(`Unexpected tree-sitter peer metadata for ${pkg.name}@${pkg.version}`);
          }
          pkg.peerDependencies['tree-sitter'] = peer;
          patches.push({ file, pkg });
        }
      }
      visit(path.join(dir, 'node_modules'));
    }
  }
  visit(modulesRoot);
  const identities = new Set(patches.map(({ pkg }) => `${pkg.name}@${pkg.version}`));
  if (patches.length !== AUDITED_PEERS.size || identities.size !== AUDITED_PEERS.size) {
    throw new Error('Tree-sitter dependency layout changed; revalidate the audited peer manifests');
  }

  // Validate the complete set before writing, so dependency drift cannot leave
  // a partially prepared bundle behind. Repeated pack operations are idempotent.
  for (const { file, pkg } of patches) {
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  }
  return patches.map(({ pkg }) => `${pkg.name}@${pkg.version}`);
}

if (require.main === module) {
  const prepared = prepareTreeSitterBundle();
  console.log(
    `[tree-sitter-bundle] Validated runtime ${RUNTIME}; prepared ${prepared.length} peer manifests.`,
  );
}

module.exports = { prepareTreeSitterBundle };
