#!/usr/bin/env node
/**
 * Build tree-sitter-proto native binding.
 *
 * Why this script exists:
 *   tree-sitter-proto is vendored under gitnexus/vendor/tree-sitter-proto/
 *   and declared as a `file:` optionalDependency. Previously, the vendored
 *   package had its own `dependencies` and `install` script, which caused
 *   npm to create `vendor/tree-sitter-proto/node_modules/` and
 *   `vendor/tree-sitter-proto/build/` during install. Those directories
 *   blocked `rmdir` on global-install upgrade, producing:
 *
 *     ENOTEMPTY: directory not empty, rmdir
 *       '.../gitnexus/vendor/tree-sitter-proto/node_modules/node-addon-api'
 *
 *   (See https://github.com/abhigyanpatwari/GitNexus/issues/836.)
 *
 *   We stripped `dependencies` and the `install` script from the vendored
 *   package.json, hoisted `node-addon-api` and `node-gyp-build` into
 *   gitnexus's own optionalDependencies, and moved native compilation here.
 *
 * What this does:
 *   Runs `npx node-gyp rebuild` inside `node_modules/tree-sitter-proto/`
 *   (which npm creates as a copy of vendor/tree-sitter-proto/ when
 *   resolving the file: dep). Build output lands in
 *   `node_modules/tree-sitter-proto/build/Release/tree_sitter_proto_binding.node`
 *   — under npm-managed territory, safe on upgrade.
 *
 *   Mirrors the tree-sitter-dart build helper. Best-effort: if any
 *   precondition fails (optional dep absent, no toolchain, --ignore-scripts),
 *   warn and exit 0 so gitnexus install still succeeds.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const protoDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-proto');
const bindingGyp = path.join(protoDir, 'binding.gyp');
const bindingNode = path.join(protoDir, 'build', 'Release', 'tree_sitter_proto_binding.node');

try {
  if (!fs.existsSync(bindingGyp)) {
    // tree-sitter-proto is an optionalDependency; absent when install
    // skipped optional deps or the file: dep was not resolved.
    process.exit(0);
  }

  // Skip if the native binding already exists (idempotent re-run).
  if (fs.existsSync(bindingNode)) {
    process.exit(0);
  }

  // Pre-flight: the hoisted build deps must be resolvable.
  try {
    require.resolve('node-addon-api');
    require.resolve('node-gyp-build');
  } catch (resolveErr) {
    console.warn(
      '[tree-sitter-proto] Skipping build: hoisted build deps not resolvable (%s).',
      resolveErr.message,
    );
    console.warn(
      '[tree-sitter-proto] Proto parsing will be unavailable. Install without --no-optional and with scripts enabled to build.',
    );
    process.exit(0);
  }

  console.log('[tree-sitter-proto] Building native binding...');
  execSync('npx node-gyp rebuild', {
    cwd: protoDir,
    stdio: 'pipe',
    timeout: 180000,
  });
  console.log('[tree-sitter-proto] Native binding built successfully');
} catch (err) {
  console.warn('[tree-sitter-proto] Could not build native binding:', err.message);
  console.warn(
    '[tree-sitter-proto] Proto (.proto) parsing will be unavailable. Non-proto gitnexus functionality is unaffected.',
  );
  // Exit 0: optionalDependency failures must not fail the gitnexus install.
  process.exit(0);
}
