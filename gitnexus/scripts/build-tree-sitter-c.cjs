#!/usr/bin/env node
/**
 * Activate the tree-sitter-c native binding after materialize-vendor-grammars.cjs.
 *
 * tree-sitter-c is a REQUIRED grammar, vendored at 0.21.4 for ABI compatibility
 * with the bundled tree-sitter@0.21.1 runtime (#1242). It is vendored — not left
 * a plain npm dependency — because upstream ships prebuilds for only 4 of 6
 * platform-archs (#2116), and a required dep with no matching prebuild
 * hard-fails `npm install` on toolchain-less ARM before any gitnexus script runs.
 *
 * Resolution order: prefer a committed prebuild (toolchain-free, the goal once
 * the build-tree-sitter-prebuilds workflow has populated all six); otherwise
 * build from the vendored source (binding.gyp + src/) so C parsing still works
 * on any host with a toolchain — e.g. CI, where the prebuilds may not yet be
 * vendored. No GITNEXUS_SKIP gate: C is required, not a user-opt-out grammar.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-c');
const bindingGyp = path.join(cDir, 'binding.gyp');
const bindingNode = path.join(cDir, 'build', 'Release', 'tree_sitter_c_binding.node');

try {
  if (!fs.existsSync(bindingGyp) || fs.existsSync(bindingNode)) {
    process.exit(0);
  }

  // Prefer a committed prebuild for this platform-arch (no toolchain needed).
  try {
    require('node-gyp-build').path(cDir);
    process.exit(0);
  } catch {
    // No matching prebuild — fall through to the source build below.
  }

  try {
    require.resolve('node-addon-api');
    require.resolve('node-gyp-build');
  } catch (resolveErr) {
    console.warn(
      '[tree-sitter-c] Skipping build: hoisted build deps not resolvable (%s).',
      resolveErr.message,
    );
    console.warn(
      '[tree-sitter-c] C parsing will be unavailable until a prebuild or toolchain is present.',
    );
    process.exit(0);
  }

  console.log(
    '[tree-sitter-c] No prebuild for this platform — building native binding from source...',
  );
  execSync('npx node-gyp rebuild', { cwd: cDir, stdio: 'pipe', timeout: 180000 });
  console.log('[tree-sitter-c] Native binding built successfully');
} catch (err) {
  console.warn('[tree-sitter-c] Could not build native binding:', err.message);
  console.warn('[tree-sitter-c] C parsing will be unavailable. Other languages are unaffected.');
  process.exit(0);
}
