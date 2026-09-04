import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const _require = createRequire(import.meta.url);

/**
 * Absolute path to the vendored grammar tree (`<pkg>/vendor`).
 *
 * This module compiles to `<pkg>/dist/core/tree-sitter/vendored-grammars.js`
 * and runs from `<pkg>/src/core/tree-sitter/...` under tsx in dev — both sit
 * three directories below the package root, and the build (`tsc`) never bundles,
 * so `import.meta.url` resolves the same way in both. `vendor/` ships in the
 * published package via package.json `files`.
 */
export const VENDOR_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'vendor',
);

/**
 * The tree-sitter grammars GitNexus vendors inside its own package (NOT npm
 * dependencies). Kept in one place so consumers (runtime loaders, the CLI
 * availability probe, and the test grammar-introspection helper) agree on which
 * grammars resolve from `vendor/` rather than `node_modules`.
 */
export const VENDORED_GRAMMAR_PACKAGES: ReadonlySet<string> = new Set([
  'tree-sitter-c',
  'tree-sitter-dart',
  'tree-sitter-proto',
  'tree-sitter-swift',
  'tree-sitter-kotlin',
]);

/** Absolute directory of a vendored grammar package under `vendor/`. */
export const vendoredGrammarDir = (packageName: string): string =>
  path.join(VENDOR_ROOT, packageName);

/**
 * Load a vendored tree-sitter grammar by its absolute path under `vendor/`.
 *
 * GitNexus vendors five grammars (c/dart/proto/swift/kotlin) inside its own
 * package under `vendor/`, each shipping committed per-platform prebuilds. They
 * are deliberately NOT npm dependencies and must NEVER be copied into
 * `node_modules`: an undeclared package under `node_modules` is "extraneous" to
 * every subsequent `npm`/`npx` arborist reify, which prunes or relocates it.
 * That is the root cause of #2111 / #1728 — on Windows the relocation throws
 * `EPERM: operation not permitted, symlink` (errno -4048) during the npx-cache
 * reify Antigravity triggers when it launches the MCP server, and on every OS
 * the second run silently deletes the materialized grammars.
 *
 * Resolving the grammar by absolute path runs its own `bindings/node` entry,
 * which calls `node-gyp-build(<grammarDir>)` and loads
 * `vendor/<name>/prebuilds/<platform>-<arch>/…` directly — no build, no write,
 * no `node_modules` copy. (`node-gyp-build` itself IS an npm dependency and
 * resolves normally from the grammar directory.)
 */
export const requireVendoredGrammar = (packageName: string): unknown => {
  // Fail loudly on a name that isn't actually vendored — a typo or a list that
  // drifted out of sync (VENDORED_GRAMMAR_PACKAGES vs the CLI probe vs the build
  // registry) would otherwise surface as a confusing absolute-path require miss.
  if (!VENDORED_GRAMMAR_PACKAGES.has(packageName)) {
    throw new Error(
      `'${packageName}' is not a vendored grammar (expected one of: ${[...VENDORED_GRAMMAR_PACKAGES].join(', ')}).`,
    );
  }
  return _require(vendoredGrammarDir(packageName));
};
