#!/usr/bin/env node
/**
 * Publish guard: every vendored tree-sitter grammar must ship a loadable binding.
 *
 * The npm tarball includes gitnexus/vendor/ (package.json `files`). A grammar is
 * "covered" on a platform-arch tuple if EITHER a prebuild ships for it OR the
 * grammar's full source-build set ships (so the install can source-build it,
 * toolchain permitting). A future lean publish — dropping the ~50 MB of generated
 * source to ship prebuilds only — is safe ONLY once every grammar has all six
 * prebuilds; doing it while any grammar is still missing a prebuild would ship a
 * grammar with NO loadable binding (neither prebuild nor buildable source) → that
 * language is silently dead for users. (Note: the slim must be done by narrowing
 * package.json's `files` field, NOT via .npmignore — `files` overrides .npmignore
 * for the vendored subtree; see gitnexus/.npmignore.)
 *
 * Rather than infer "is source excluded?" from a single .npmignore toggle line
 * (which a partial/out-of-order edit could defeat — exclude binding.gyp but leave
 * parser.c, and the grammar is unbuildable yet still looks "source-shipping"),
 * this guard inspects the EFFECTIVE tarball: `npm pack --dry-run --ignore-scripts
 * --json` (the `--ignore-scripts` avoids re-entering this guard via prepack). A
 * grammar "ships source" only when EVERY one of its on-disk source-build inputs
 * (binding.gyp + binding.cc + parser.c + scanner.c when present + a tree_sitter
 * header) is actually in the packed file list.
 *
 * Wired via `prepack`, so it fails `npm pack` / `npm publish` if the invariant is
 * violated — the gated .npmignore exclusions can never be activated early and
 * silently ship a dead grammar.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TUPLES = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];

// Source-build inputs (tarball-relative within vendor/<name>/) whose presence in
// the pack makes a grammar source-buildable. Per-grammar we only require the ones
// that actually exist on disk (e.g. tree-sitter-c has no external scanner.c).
const SOURCE_BUILD_REL = [
  'binding.gyp',
  'bindings/node/binding.cc',
  'src/parser.c',
  'src/scanner.c',
  'src/tree_sitter/parser.h',
];

/** The on-disk source-build inputs for a grammar, as tarball-relative paths. */
function sourceBuildSet(grammarDir, name) {
  return SOURCE_BUILD_REL.filter((rel) => fs.existsSync(path.join(grammarDir, rel))).map(
    (rel) => `vendor/${name}/${rel}`,
  );
}

/** Count platform-arch tuples whose prebuilt .node is present in the packed set. */
function prebuiltTuplesInPack(name, packedFiles) {
  let n = 0;
  for (const t of TUPLES) {
    const prefix = `vendor/${name}/prebuilds/${t}/`;
    if ([...packedFiles].some((f) => f.startsWith(prefix) && f.endsWith('.node'))) n++;
  }
  return n;
}

/**
 * Pure core (exported for tests). `grammars` is a list of
 * `{ name, prebuilt: 0..6, shipsSource: boolean }`. Returns human-readable
 * problem strings; an empty array means the pack is publish-safe.
 */
function findCoverageProblems({ grammars }) {
  const problems = [];
  for (const g of grammars) {
    if (g.prebuilt < 6 && !g.shipsSource) {
      const missing = 6 - g.prebuilt;
      problems.push(
        `${g.name}: ${g.prebuilt}/6 prebuilds in the tarball and source NOT fully shipped ` +
          `(a source-build input is missing/excluded) — would ship with no loadable binding on ` +
          `${missing} platform-arch tuple(s).`,
      );
    }
  }
  return problems;
}

/** Build the set of tarball-relative paths `npm pack` would include. */
function packFileSet(cwd) {
  const out = execSync('npm pack --dry-run --ignore-scripts --json', {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    // The `--ignore-scripts` FLAG is not reliably honored by `npm pack`'s
    // prepare/prepack lifecycle on every npm version — when it isn't, build.js
    // runs (polluting this --json stdout with `[build] …`) AND, since this guard
    // runs in prepack, the inner pack would re-enter the guard (recursion). The
    // `npm_config_ignore_scripts` env config IS reliable, so set it too.
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  // Defensive: if any lifecycle/build output still precedes the JSON array on
  // stdout (e.g. `[build] …`), parse from the array start (`[` then `{`) rather
  // than the raw stream. `[build]` does NOT match (no `{` after the bracket).
  const start = out.search(/\[\s*\{/);
  const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
  const files = (parsed[0] && parsed[0].files) || [];
  return new Set(files.map((f) => f.path.replace(/\\/g, '/')));
}

function collectGrammars(vendorDir, packedFiles) {
  if (!fs.existsSync(vendorDir)) return [];
  return fs
    .readdirSync(vendorDir)
    .filter((d) => /^tree-sitter-/.test(d))
    .map((name) => {
      const dir = path.join(vendorDir, name);
      const srcSet = sourceBuildSet(dir, name);
      const buildable =
        srcSet.includes(`vendor/${name}/src/parser.c`) &&
        srcSet.includes(`vendor/${name}/binding.gyp`);
      return {
        name,
        prebuilt: prebuiltTuplesInPack(name, packedFiles),
        // Source ships only when the grammar is buildable AND every one of its
        // source-build inputs is actually in the packed file list.
        shipsSource: buildable && srcSet.every((f) => packedFiles.has(f)),
      };
    });
}

function main() {
  const gitnexusRoot = path.join(__dirname, '..');
  const vendorDir = path.join(gitnexusRoot, 'vendor');

  let packedFiles;
  try {
    packedFiles = packFileSet(gitnexusRoot);
  } catch (err) {
    console.error(`[publish-guard] Could not compute the npm pack file list: ${err.message}`);
    process.exit(1);
  }

  const grammars = collectGrammars(vendorDir, packedFiles);
  if (grammars.length === 0) {
    console.error(`[publish-guard] No vendored tree-sitter grammars found under ${vendorDir}.`);
    process.exit(1);
  }

  const problems = findCoverageProblems({ grammars });
  if (problems.length > 0) {
    console.error('[publish-guard] Refusing to publish — a vendored grammar would ship unusable:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nFix: either commit the missing prebuilds (run the build-tree-sitter-prebuilds\n' +
        'workflow) or re-comment the lean-publish source exclusions in gitnexus/.npmignore.',
    );
    process.exit(1);
  }

  const sourceShippers = grammars.filter((g) => g.shipsSource).length;
  console.log(
    `[publish-guard] OK — ${grammars.length} vendored grammar(s) covered ` +
      `(${sourceShippers} shipping source, ${grammars.length - sourceShippers} prebuilds-only).`,
  );
}

if (require.main === module) main();

module.exports = {
  findCoverageProblems,
  prebuiltTuplesInPack,
  sourceBuildSet,
  collectGrammars,
  packFileSet,
  TUPLES,
  SOURCE_BUILD_REL,
};
