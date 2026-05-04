#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dartDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-dart');
const bindingGyp = path.join(dartDir, 'binding.gyp');
const bindingNode = path.join(dartDir, 'build', 'Release', 'tree_sitter_dart_binding.node');

try {
  if (!fs.existsSync(bindingGyp) || fs.existsSync(bindingNode)) {
    process.exit(0);
  }

  try {
    require.resolve('node-addon-api');
    require.resolve('node-gyp-build');
  } catch (resolveErr) {
    console.warn(
      '[tree-sitter-dart] Skipping build: hoisted build deps not resolvable (%s).',
      resolveErr.message,
    );
    console.warn(
      '[tree-sitter-dart] Dart parsing will be unavailable. Install without --no-optional and with scripts enabled to build.',
    );
    process.exit(0);
  }

  console.log('[tree-sitter-dart] Building native binding...');
  execSync('npx node-gyp rebuild', {
    cwd: dartDir,
    stdio: 'pipe',
    timeout: 180000,
  });
  console.log('[tree-sitter-dart] Native binding built successfully');
} catch (err) {
  console.warn('[tree-sitter-dart] Could not build native binding:', err.message);
  console.warn(
    '[tree-sitter-dart] Dart parsing will be unavailable. Non-Dart functionality is unaffected.',
  );
  process.exit(0);
}
