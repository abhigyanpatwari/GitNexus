#!/usr/bin/env node
/**
 * Activate the tree-sitter-kotlin native binding after materialize-vendor-grammars.cjs.
 *
 * Kotlin is vendored (upstream ships source only; GitNexus cross-builds the
 * prebuilds via .github/workflows/build-tree-sitter-prebuilds.yml). Resolution
 * order, mirroring Dart/Proto/C: prefer a committed prebuild for this
 * platform-arch (toolchain-free); otherwise build from the vendored source so
 * Kotlin parsing still works on any host with a toolchain — e.g. CI, where the
 * prebuilds may not yet be vendored.
 *
 * MUST NEVER throw or exit non-zero — it must never break `gitnexus` install.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Opt-out: Kotlin is optional, so the env var skips its build entirely (also
// skipped at materialize). Strict `=== '1'` only.
if (process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS === '1') {
  console.warn(
    '[tree-sitter-kotlin] Skipping build (GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1). Kotlin parsing will be unavailable until reinstalled without the env var.',
  );
  process.exit(0);
}

const kotlinDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-kotlin');
const bindingGyp = path.join(kotlinDir, 'binding.gyp');
const bindingNode = path.join(kotlinDir, 'build', 'Release', 'tree_sitter_kotlin_binding.node');

try {
  if (!fs.existsSync(bindingGyp) || fs.existsSync(bindingNode)) {
    process.exit(0);
  }

  // Prefer a committed prebuild for this platform-arch (no toolchain needed).
  try {
    require('node-gyp-build').path(kotlinDir);
    process.exit(0);
  } catch {
    // No matching prebuild — fall through to the source build below.
  }

  try {
    require.resolve('node-addon-api');
    require.resolve('node-gyp-build');
  } catch (resolveErr) {
    console.warn(
      '[tree-sitter-kotlin] Skipping build: hoisted build deps not resolvable (%s).',
      resolveErr.message,
    );
    console.warn(
      '[tree-sitter-kotlin] Kotlin parsing will be unavailable until a prebuild or toolchain is present.',
    );
    process.exit(0);
  }

  console.log(
    '[tree-sitter-kotlin] No prebuild for this platform — building native binding from source...',
  );
  execSync('npx node-gyp rebuild', { cwd: kotlinDir, stdio: 'pipe', timeout: 180000 });
  console.log('[tree-sitter-kotlin] Native binding built successfully');
} catch (err) {
  console.warn('[tree-sitter-kotlin] Could not build native binding:', err.message);
  console.warn(
    '[tree-sitter-kotlin] Kotlin (.kt/.kts) parsing will be unavailable. Non-Kotlin functionality is unaffected.',
  );
  process.exit(0);
}
