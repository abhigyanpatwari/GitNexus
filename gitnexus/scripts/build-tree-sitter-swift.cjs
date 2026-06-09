#!/usr/bin/env node
/**
 * Activate the tree-sitter-swift native binding after materialize-vendor-grammars.cjs.
 *
 * Swift is vendored. Unlike its historical prebuild-only form, the grammar
 * source (parser.c/scanner.c/binding.gyp + src/) is now ALSO vendored, so this
 * script mirrors Dart/Proto/Kotlin/C exactly: prefer a committed prebuild for
 * this platform-arch (toolchain-free); otherwise build from the vendored source
 * so Swift parsing still works on any host with a toolchain — e.g. CI, where the
 * GitNexus-cross-built prebuilds may not yet be vendored. The committed
 * prebuilds for every platform-arch are produced by
 * .github/workflows/build-tree-sitter-prebuilds.yml.
 *
 * MUST NEVER throw or exit non-zero — it must never break `gitnexus` install.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Opt-out: Swift is optional, so the env var skips its build entirely (also
// skipped at materialize). Strict `=== '1'` only.
if (process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS === '1') {
  console.warn(
    '[tree-sitter-swift] Skipping build (GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1). Swift parsing will be unavailable until reinstalled without the env var.',
  );
  process.exit(0);
}

const swiftDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-swift');
const bindingGyp = path.join(swiftDir, 'binding.gyp');
const bindingNode = path.join(swiftDir, 'build', 'Release', 'tree_sitter_swift_binding.node');

try {
  if (!fs.existsSync(bindingGyp) || fs.existsSync(bindingNode)) {
    process.exit(0);
  }

  // Prefer a committed prebuild for this platform-arch (no toolchain needed).
  try {
    require('node-gyp-build').path(swiftDir);
    process.exit(0);
  } catch {
    // No matching prebuild — fall through to the source build below.
  }

  try {
    require.resolve('node-addon-api');
    require.resolve('node-gyp-build');
  } catch (resolveErr) {
    console.warn(
      '[tree-sitter-swift] Skipping build: hoisted build deps not resolvable (%s).',
      resolveErr.message,
    );
    console.warn(
      '[tree-sitter-swift] Swift parsing will be unavailable until a prebuild or toolchain is present.',
    );
    process.exit(0);
  }

  console.log(
    '[tree-sitter-swift] No prebuild for this platform — building native binding from source...',
  );
  execSync('npx node-gyp rebuild', { cwd: swiftDir, stdio: 'pipe', timeout: 180000 });
  console.log('[tree-sitter-swift] Native binding built successfully');
} catch (err) {
  console.warn('[tree-sitter-swift] Could not build native binding:', err.message);
  console.warn(
    '[tree-sitter-swift] Swift (.swift) parsing will be unavailable. Non-Swift functionality is unaffected.',
  );
  process.exit(0);
}
