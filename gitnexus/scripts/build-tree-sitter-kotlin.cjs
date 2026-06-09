#!/usr/bin/env node
/**
 * Probe tree-sitter-kotlin native-binding availability at install time.
 *
 * Unlike Dart/Proto/Swift (vendored under vendor/ and materialized into
 * node_modules/ at postinstall), tree-sitter-kotlin is a third-party npm
 * `optionalDependency`. It ships SOURCE ONLY — no upstream `prebuilds/` dir —
 * and its own `install` script runs `node-gyp-build`, which compiles the
 * native binding from source via node-gyp. On a host without a C/C++ toolchain
 * that build soft-fails: npm skips the optional dependency and the `gitnexus`
 * install still succeeds. This probe calls node-gyp-build once against the
 * materialized package so a missing/failed binding surfaces as a single
 * install-time warning (the rest of the gitnexus install succeeding) rather
 * than as a raw node-gyp error or a runtime failure the first time Kotlin
 * parsing is requested. The result is discarded — it does not copy, register,
 * or mutate anything; the runtime require() path in parser-loader does the
 * actual load. This probe MUST NEVER throw or exit non-zero — it must never
 * break `gitnexus` install.
 */
const fs = require('fs');
const path = require('path');

if (process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS === '1') {
  console.warn(
    '[tree-sitter-kotlin] Skipping native-binding probe (GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1).',
  );
  process.exit(0);
}

const kotlinDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-kotlin');

try {
  // npm skipped the optional dependency (e.g. --no-optional, or the native
  // build soft-failed and npm pruned it) — nothing materialized to probe.
  if (!fs.existsSync(path.join(kotlinDir, 'bindings', 'node', 'index.js'))) {
    process.exit(0);
  }

  const nodeGypBuild = require('node-gyp-build');
  nodeGypBuild(kotlinDir);
} catch (err) {
  console.warn('[tree-sitter-kotlin] Native-binding probe failed:', err.message);
  console.warn(
    '[tree-sitter-kotlin] Kotlin (.kt/.kts) parsing will be unavailable. Non-Kotlin functionality is unaffected.',
  );
  console.warn(
    '[tree-sitter-kotlin] This is expected on hosts without a C/C++ toolchain: tree-sitter-kotlin ships source only (no upstream prebuilt binaries) and compiles via node-gyp at install. Set GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 to skip this probe.',
  );
  process.exit(0);
}
