#!/usr/bin/env node
/**
 * WORKAROUND: tree-sitter-swift@0.6.0 binding.gyp build failure
 *
 * Background:
 *   tree-sitter-swift@0.6.0's binding.gyp contains an "actions" array that
 *   invokes `tree-sitter generate` to regenerate parser.c from grammar.js.
 *   This is intended for grammar developers, but the published npm package
 *   already ships pre-generated parser files (parser.c, scanner.c), so the
 *   actions are unnecessary for consumers. Since consumers don't have
 *   tree-sitter-cli installed, the actions always fail during `npm install`.
 *
 * Why we can't just upgrade:
 *   tree-sitter-swift@0.7.1 fixes this (removes postinstall, ships prebuilds),
 *   but it requires tree-sitter@^0.22.1. The upstream project pins tree-sitter
 *   to ^0.21.0 and all other grammar packages depend on that version.
 *   Upgrading tree-sitter would be a separate breaking change.
 *
 * How this workaround works:
 *   1. tree-sitter-swift's own postinstall fails (npm warns but continues)
 *   2. This script runs as gitnexus's postinstall
 *   3. It removes the "actions" array from binding.gyp
 *   4. It rebuilds the native binding with the cleaned binding.gyp
 *
 * TODO: Remove this script when tree-sitter is upgraded to ^0.22.x,
 *       which allows using tree-sitter-swift@0.7.1+ directly.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const swiftDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-swift');
const bindingPath = path.join(swiftDir, 'binding.gyp');

try {
  if (!fs.existsSync(bindingPath)) {
    process.exit(0);
  }

  const content = fs.readFileSync(bindingPath, 'utf8');
  let needsRebuild = false;

  if (content.includes('"actions"')) {
    // Strip Python-style comments (#) before JSON parsing
    const cleaned = content.replace(/#[^\n]*/g, '');
    const gyp = JSON.parse(cleaned);

    if (gyp.targets && gyp.targets[0] && gyp.targets[0].actions) {
      delete gyp.targets[0].actions;
      fs.writeFileSync(bindingPath, JSON.stringify(gyp, null, 2) + '\n');
      console.log('[tree-sitter-swift] Patched binding.gyp (removed actions array)');
      needsRebuild = true;
    }
  }

  // Check if native binding exists
  const bindingNode = path.join(swiftDir, 'build', 'Release', 'tree_sitter_swift_binding.node');
  if (!fs.existsSync(bindingNode)) {
    needsRebuild = true;
  }

  if (needsRebuild) {
    console.log('[tree-sitter-swift] Rebuilding native binding...');
    execSync('npx node-gyp rebuild', {
      cwd: swiftDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log('[tree-sitter-swift] Native binding built successfully');
  }
} catch (err) {
  console.warn('[tree-sitter-swift] Could not build native binding:', err.message);
  console.warn('[tree-sitter-swift] You may need to manually run: cd node_modules/tree-sitter-swift && npx node-gyp rebuild');
}
