#!/usr/bin/env node
/**
 * Probe tree-sitter-kotlin prebuild availability at install time.
 *
 * Like tree-sitter-swift, the vendored package ships platform prebuilds (under
 * vendor/tree-sitter-kotlin/prebuilds/, materialized into node_modules/ by
 * materialize-vendor-grammars.cjs); node-gyp-build selects the correct binary at
 * require time. Unlike Swift — whose prebuilds are copied from upstream — these
 * are GitNexus-cross-built (upstream tree-sitter-kotlin ships source only) by
 * .github/workflows/build-tree-sitter-prebuilds.yml.
 *
 * This script calls node-gyp-build once against the materialized package so a
 * missing-prebuild failure surfaces as a single install-time warning (with the
 * rest of the gitnexus install succeeding) rather than as a runtime error the
 * first time Kotlin parsing is requested. The result is discarded — the runtime
 * require() path in parser-loader does the actual load. Running the probe here
 * instead of an npm `install` script on the vendored package preserves the #836
 * hygiene (no scripts.install inside vendor/). This probe MUST NEVER throw or
 * exit non-zero — it must never break `gitnexus` install.
 *
 * (This replaces the prior third-party-optionalDependency probe from #2110:
 * Kotlin is now vendored with prebuilds, mirroring Swift.)
 */
const fs = require('fs');
const path = require('path');

if (process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS === '1') {
  console.warn('[tree-sitter-kotlin] Skipping prebuild probe (GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1).');
  process.exit(0);
}

const kotlinDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-kotlin');

try {
  if (!fs.existsSync(path.join(kotlinDir, 'bindings', 'node', 'index.js'))) {
    process.exit(0);
  }

  const nodeGypBuild = require('node-gyp-build');
  nodeGypBuild(kotlinDir);
} catch (err) {
  console.warn('[tree-sitter-kotlin] Prebuild probe failed:', err.message);
  console.warn(
    '[tree-sitter-kotlin] Kotlin (.kt/.kts) parsing will be unavailable (no prebuild matches this platform-arch). Non-Kotlin functionality is unaffected.',
  );
  process.exit(0);
}
