#!/usr/bin/env node
/**
 * Activate the vendored tree-sitter native bindings IN PLACE under `vendor/`.
 * One registry-driven script replaces the former per-grammar
 * build-tree-sitter-<name>.cjs files (they were ~95% identical).
 *
 * The grammars (tree-sitter-c/dart/proto/swift/kotlin) are loaded from
 * `vendor/<name>/` by absolute path at runtime (see
 * src/core/tree-sitter/vendored-grammars.ts) and are NEVER copied into
 * node_modules — an undeclared package under node_modules is "extraneous" to
 * every subsequent npm/npx reify, which prunes/relocates it (Windows
 * `EPERM: …, symlink` + a silent grammar deletion on the 2nd run; #2111/#1728).
 *
 * For each grammar the resolution order is identical:
 *   1. If the vendored source is absent (no binding.gyp) or the binding is
 *      already built, do nothing.
 *   2. Prefer a committed prebuild for this platform-arch (toolchain-free) via
 *      node-gyp-build — `vendor/<name>/prebuilds/` ships all six tuples, so on a
 *      supported platform this returns immediately and writes nothing.
 *   3. Otherwise source-build from the vendored grammar source (binding.gyp +
 *      src/) into `vendor/<name>/build/` (gitignored) so parsing still works on
 *      a toolchain host that lacks a matching prebuild.
 *
 * HARD INVARIANT: this runs in `gitnexus`'s postinstall, so it MUST NEVER throw
 * or exit non-zero — a failure for any single grammar must not break the install.
 *
 * Opt-out: GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 (strict '1') skips the OPTIONAL
 * grammars only. tree-sitter-c is REQUIRED (it backstops upstream's 4/6 ARM
 * prebuild gap, #2116) and is always built.
 *
 * Usage:
 *   node build-tree-sitter-grammars.cjs            # all grammars (postinstall)
 *   node build-tree-sitter-grammars.cjs swift c    # only the named grammars
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Registry. `display`/`ext` drive the human-readable warnings; `required`
// grammars ignore the opt-out gate. Insertion order == build order (c first).
const GRAMMARS = {
  c: { required: true, display: 'C', ext: '.c' },
  dart: { required: false, display: 'Dart', ext: '.dart' },
  proto: { required: false, display: 'Proto', ext: '.proto' },
  swift: { required: false, display: 'Swift', ext: '.swift' },
  kotlin: { required: false, display: 'Kotlin', ext: '.kt/.kts' },
};

const skipOptional = process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS === '1';

function buildGrammar(short) {
  const cfg = GRAMMARS[short];
  const tag = `[tree-sitter-${short}]`;

  if (!cfg.required && skipOptional) {
    console.warn(
      `${tag} Skipping build (GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1). ${cfg.display} parsing will be unavailable until reinstalled without the env var.`,
    );
    return;
  }

  const dir = path.join(__dirname, '..', 'vendor', `tree-sitter-${short}`);
  const bindingGyp = path.join(dir, 'binding.gyp');
  const bindingNode = path.join(dir, 'build', 'Release', `tree_sitter_${short}_binding.node`);

  try {
    // Not materialized (no source), or already built — nothing to do.
    if (!fs.existsSync(bindingGyp) || fs.existsSync(bindingNode)) {
      return;
    }

    // Prefer a committed prebuild for this platform-arch (no toolchain needed).
    try {
      require('node-gyp-build').path(dir);
      return;
    } catch {
      // No matching prebuild — fall through to the source build below.
    }

    // The hoisted build deps must be resolvable to source-build.
    try {
      require.resolve('node-addon-api');
      require.resolve('node-gyp-build');
    } catch (resolveErr) {
      console.warn(
        `${tag} Skipping build: hoisted build deps not resolvable (${resolveErr.message}).`,
      );
      console.warn(
        `${tag} ${cfg.display} parsing will be unavailable until a prebuild or toolchain is present.`,
      );
      return;
    }

    console.log(`${tag} No prebuild for this platform — building native binding from source...`);
    execSync('npx node-gyp rebuild', { cwd: dir, stdio: 'pipe', timeout: 180000 });
    console.log(`${tag} Native binding built successfully`);
  } catch (err) {
    console.warn(`${tag} Could not build native binding:`, err.message);
    console.warn(
      `${tag} ${cfg.display} (${cfg.ext}) parsing will be unavailable. Non-${cfg.display} functionality is unaffected.`,
    );
  }
}

function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const targets = args.length > 0 ? args : Object.keys(GRAMMARS);
  for (const short of targets) {
    if (!GRAMMARS[short]) {
      console.warn(`[tree-sitter] Unknown grammar '${short}' — skipping.`);
      continue;
    }
    // Defensive: never let an unexpected throw escape and fail the install.
    try {
      buildGrammar(short);
    } catch (err) {
      console.warn(`[tree-sitter-${short}] Unexpected build error (ignored): ${err.message}`);
    }
  }
  // Hard guarantee: postinstall must never exit non-zero.
  process.exit(0);
}

if (require.main === module) main();

module.exports = { GRAMMARS, buildGrammar };
