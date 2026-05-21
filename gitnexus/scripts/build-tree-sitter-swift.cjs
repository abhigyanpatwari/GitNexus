#!/usr/bin/env node
/**
 * Probe tree-sitter-swift prebuild availability at install time.
 *
 * The vendored package ships platform prebuilds; node-gyp-build selects the
 * correct binary at require time. This script calls node-gyp-build once
 * against the materialized package so a missing-prebuild failure surfaces
 * as an install-time warning (with the rest of the gitnexus install
 * succeeding) rather than as a runtime error the first time Swift parsing
 * is requested. The result is discarded — it does not copy, register, or
 * mutate anything; the runtime require() path in parser-loader does the
 * actual load. Running this probe here instead of an npm `install` script
 * on the vendored package preserves the #836 hygiene (no scripts.install
 * inside vendor/).
 */
const fs = require('fs');
const path = require('path');

if (process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS === '1') {
  console.warn('[tree-sitter-swift] Skipping prebuild probe (GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1).');
  process.exit(0);
}

const swiftDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-swift');

try {
  if (!fs.existsSync(path.join(swiftDir, 'bindings', 'node', 'index.js'))) {
    process.exit(0);
  }

  const nodeGypBuild = require('node-gyp-build');
  nodeGypBuild(swiftDir);
} catch (err) {
  console.warn('[tree-sitter-swift] Prebuild probe failed:', err.message);
  console.warn(
    '[tree-sitter-swift] Swift parsing will be unavailable. Non-Swift functionality is unaffected.',
  );
  process.exit(0);
}
