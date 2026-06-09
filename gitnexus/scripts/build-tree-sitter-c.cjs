#!/usr/bin/env node
/**
 * Probe tree-sitter-c prebuild availability at install time.
 *
 * tree-sitter-c is vendored prebuild-only (like swift/kotlin), held at 0.21.4
 * for ABI compatibility with the bundled tree-sitter@0.21.1 runtime (#1242).
 * It is vendored — rather than left as a plain npm dependency — because upstream
 * ships prebuilds for only 4 of 6 platform-archs (#2116) and tree-sitter-c is a
 * REQUIRED grammar whose source build hard-fails `npm install` on a toolchain-less
 * ARM host. GitNexus cross-builds all six prebuilds (build-tree-sitter-prebuilds
 * workflow) and materialize-vendor-grammars.cjs copies them into node_modules/;
 * node-gyp-build selects the right binary at require time.
 *
 * This probe calls node-gyp-build once so a missing/unloadable prebuild surfaces
 * as a single install-time warning rather than a first-use runtime error. It
 * MUST NEVER throw or exit non-zero — it must never break `gitnexus` install.
 */
const fs = require('fs');
const path = require('path');

// No GITNEXUS_SKIP_OPTIONAL_GRAMMARS gate: tree-sitter-c is REQUIRED and always
// materialized (it is not a user-opt-out grammar), so we always verify it.
const cDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-c');

try {
  if (!fs.existsSync(path.join(cDir, 'bindings', 'node', 'index.js'))) {
    process.exit(0);
  }

  const nodeGypBuild = require('node-gyp-build');
  nodeGypBuild(cDir);
} catch (err) {
  console.warn('[tree-sitter-c] Prebuild probe failed:', err.message);
  console.warn(
    '[tree-sitter-c] C parsing will be unavailable (no prebuild matches this platform-arch). Other languages are unaffected.',
  );
  process.exit(0);
}
