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
 * install still succeeds. This probe surfaces a single, friendly install-time
 * warning when the Kotlin binding is unavailable — whether npm pruned the
 * optional dependency after a toolchain-less build failure (its dir is gone,
 * which is the common case) or the dir survives but the binding won't load —
 * instead of leaving a raw node-gyp error or a first-use runtime failure as the
 * only signal. A deliberate opt-out (`--omit=optional`) stays silent. The probe
 * does not copy, register, or mutate anything; the runtime require() path in
 * parser-loader does the actual load. This probe MUST NEVER throw or exit
 * non-zero — it must never break `gitnexus` install.
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

// `--omit=optional` / `--no-optional` / `.npmrc omit=optional` surface to
// lifecycle scripts as `npm_config_omit` containing `optional` (a comma- or
// space-separated list, e.g. `dev,optional`). That is a deliberate opt-out, so
// an absent package for that reason should stay silent. Any OTHER absence means
// npm attempted the optional dependency's native build and pruned the package
// after it soft-failed (the toolchain-less case) — exactly when the guidance
// below is worth surfacing.
const omitsOptional = /(^|[,\s])optional([,\s]|$)/.test(process.env.npm_config_omit || '');

function warnKotlinUnavailable(err) {
  if (err) {
    console.warn('[tree-sitter-kotlin] Native-binding probe failed:', err.message);
  }
  console.warn(
    '[tree-sitter-kotlin] Kotlin (.kt/.kts) parsing will be unavailable. Non-Kotlin functionality is unaffected.',
  );
  console.warn(
    '[tree-sitter-kotlin] This is expected on hosts without a C/C++ toolchain: tree-sitter-kotlin ships source only (no upstream prebuilt binaries) and compiles via node-gyp at install. Set GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 to skip this probe.',
  );
}

try {
  if (!fs.existsSync(path.join(kotlinDir, 'bindings', 'node', 'index.js'))) {
    // The package never materialized. If the user deliberately omitted optional
    // dependencies, stay silent — they opted out. Otherwise npm pruned the
    // package after its native build soft-failed (no toolchain), and this is the
    // dominant real-world failure case: surface the guidance the raw node-gyp
    // error would otherwise be the only signal of.
    if (!omitsOptional) {
      warnKotlinUnavailable();
    }
    process.exit(0);
  }

  const nodeGypBuild = require('node-gyp-build');
  nodeGypBuild(kotlinDir);
} catch (err) {
  // The package is present but its native binding can't be loaded (e.g. the dir
  // survived with --ignore-scripts, or a partial/ABI-mismatched build).
  warnKotlinUnavailable(err);
  process.exit(0);
}
