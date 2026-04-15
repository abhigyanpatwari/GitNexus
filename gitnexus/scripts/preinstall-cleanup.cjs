#!/usr/bin/env node
/**
 * Preinstall cleanup script.
 *
 * When upgrading gitnexus globally (`npm install -g gitnexus@<new>`),
 * npm may fail with ENOTEMPTY because it cannot cleanly remove the
 * `node_modules/` and `build/` directories that a *previous*
 * installation's `file:` dependency resolution created inside
 * `vendor/tree-sitter-proto/`.
 *
 * This script runs as a `preinstall` hook — before npm resolves
 * dependencies — and removes those leftover directories so npm can
 * proceed without errors.
 *
 * See: https://github.com/abhigyanpatwari/GitNexus/issues/836
 */
const fs = require('fs');
const path = require('path');

const vendorDirs = [
  path.join(__dirname, '..', 'vendor', 'tree-sitter-proto', 'node_modules'),
  path.join(__dirname, '..', 'vendor', 'tree-sitter-proto', 'build'),
];

for (const dir of vendorDirs) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    // Best-effort cleanup — warn but don't fail the install.
    console.warn(`[preinstall] Could not remove ${dir}:`, err.message);
  }
}
