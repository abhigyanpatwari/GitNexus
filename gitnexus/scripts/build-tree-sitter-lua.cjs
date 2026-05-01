#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const luaDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-lua');
const bindingGyp = path.join(luaDir, 'binding.gyp');
const bindingNode = path.join(luaDir, 'build', 'Release', 'tree_sitter_lua_binding.node');

try {
  if (!fs.existsSync(bindingGyp) || fs.existsSync(bindingNode)) {
    process.exit(0);
  }

  try {
    require.resolve('node-addon-api');
    require.resolve('node-gyp-build');
  } catch (resolveErr) {
    console.warn(
      '[tree-sitter-lua] Skipping build: hoisted build deps not resolvable (%s).',
      resolveErr.message,
    );
    console.warn(
      '[tree-sitter-lua] Lua parsing will be unavailable. Install without --no-optional and with scripts enabled to build.',
    );
    process.exit(0);
  }

  console.log('[tree-sitter-lua] Building native binding...');
  execSync('npx node-gyp rebuild', {
    cwd: luaDir,
    stdio: 'pipe',
    timeout: 180000,
  });
  console.log('[tree-sitter-lua] Native binding built successfully');
} catch (err) {
  console.warn('[tree-sitter-lua] Could not build native binding:', err.message);
  console.warn(
    '[tree-sitter-lua] Lua parsing will be unavailable. Non-Lua functionality is unaffected.',
  );
  process.exit(0);
}
