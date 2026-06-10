#!/usr/bin/env node
/**
 * Publish guard: every vendored tree-sitter grammar must ship a loadable binding.
 *
 * The npm tarball includes gitnexus/vendor/ (package.json `files`). A grammar is
 * "covered" on a platform-arch tuple if EITHER a prebuild ships for it OR the
 * grammar's full source-build set ships (so the install can source-build it,
 * toolchain permitting). A future lean publish — dropping the ~50 MB of generated
 * source to ship prebuilds only — is safe ONLY once every grammar has all six
 * prebuilds; doing it while any grammar still lacks a prebuild would ship a
 * grammar with NO loadable binding (neither prebuild nor buildable source) → that
 * language is silently dead for users.
 *
 * HOW SOURCE INCLUSION IS DECIDED. The `files` allow-list OVERRIDES `.npmignore`
 * for the vendored subtree (verified: an active "vendor/(star-star)/src/parser.c"
 * in .npmignore does NOT drop it from `npm pack`). So `.npmignore` can never
 * exclude vendored source — the ONLY lever is the `files` field. A broad `vendor`
 * ships the whole subtree (source + prebuilds); a lean publish narrows `files` to
 * non-source subpaths. This guard therefore reads `files` directly rather than
 * shelling out to `npm pack` (which, in prepack, would re-enter this guard and,
 * on npm versions that don't honor --ignore-scripts for prepare/prepack, run the
 * full build — slow enough to time out and fragile).
 *
 * Wired via `prepack`, so it fails `npm pack` / `npm publish` if the invariant is
 * violated.
 */
const fs = require('fs');
const path = require('path');

const TUPLES = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];

// Source-build inputs (relative to vendor/<name>/) whose presence makes a grammar
// source-buildable. Per-grammar we only require the ones that exist on disk (e.g.
// tree-sitter-c has no external scanner.c).
const SOURCE_BUILD_REL = [
  'binding.gyp',
  'bindings/node/binding.cc',
  'src/parser.c',
  'src/scanner.c',
  'src/tree_sitter/parser.h',
];

/**
 * Does the package.json `files` allow-list ship the WHOLE vendor subtree (and
 * therefore the vendored grammar source)? A bare `vendor` (optionally with a
 * trailing slash or `/**`/`/*`) includes everything under vendor/. A lean publish
 * replaces that with non-source subpaths, so this returns false and grammars must
 * then rely on prebuilds.
 */
function filesShipsVendorSource(filesField) {
  return (filesField || []).some((f) => {
    const n = String(f)
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .replace(/\/\*\*?$/, '');
    return n === 'vendor';
  });
}

/** The on-disk source-build inputs for a grammar (relative paths). */
function sourceBuildSet(grammarDir) {
  return SOURCE_BUILD_REL.filter((rel) => fs.existsSync(path.join(grammarDir, rel)));
}

/** True when a grammar can be source-built from its vendored files (has gyp + parser). */
function isBuildableFromSource(grammarDir) {
  const set = sourceBuildSet(grammarDir);
  return set.includes('binding.gyp') && set.includes('src/parser.c');
}

/** Count platform-arch tuples with a committed prebuilt .node on disk. */
function countPrebuiltTuples(grammarDir) {
  const pdir = path.join(grammarDir, 'prebuilds');
  let n = 0;
  for (const t of TUPLES) {
    const td = path.join(pdir, t);
    try {
      if (fs.statSync(td).isDirectory() && fs.readdirSync(td).some((f) => f.endsWith('.node'))) {
        n++;
      }
    } catch {
      /* tuple dir absent — not covered */
    }
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
        `${g.name}: ${g.prebuilt}/6 prebuilds and its vendored source is not shipped ` +
          `(the package.json \`files\` field excludes it, or it is not buildable) — would ship ` +
          `with no loadable binding on ${missing} platform-arch tuple(s).`,
      );
    }
  }
  return problems;
}

/**
 * Stray local source-build outputs under `vendor/<name>/build/`. These would
 * ship in the tarball (`files: ["vendor"]` overrides .gitignore/.npmignore) AND
 * shadow the committed prebuilds — `node-gyp-build` resolves `build/Release`
 * BEFORE `prebuilds/`, so a consumer on the publisher's platform would load the
 * stray (possibly stale/wrong) binding instead of the curated prebuild. The
 * build dir is gitignored and only appears if a maintainer source-built locally
 * (e.g. on a no-prebuild platform); refuse to publish it. (#2144 review.)
 */
function findStrayBuildArtifacts(vendorDir) {
  if (!fs.existsSync(vendorDir)) return [];
  return fs
    .readdirSync(vendorDir)
    .filter((d) => /^tree-sitter-/.test(d))
    .filter((d) => fs.existsSync(path.join(vendorDir, d, 'build')))
    .map((d) => `vendor/${d}/build`);
}

function collectGrammars(vendorDir, shipsVendorSource) {
  if (!fs.existsSync(vendorDir)) return [];
  return fs
    .readdirSync(vendorDir)
    .filter((d) => /^tree-sitter-/.test(d))
    .map((name) => {
      const dir = path.join(vendorDir, name);
      return {
        name,
        prebuilt: countPrebuiltTuples(dir),
        // Source ships when `files` includes the vendor subtree AND the grammar
        // actually carries a buildable source set on disk.
        shipsSource: shipsVendorSource && isBuildableFromSource(dir),
      };
    });
}

function main() {
  const gitnexusRoot = path.join(__dirname, '..');
  const vendorDir = path.join(gitnexusRoot, 'vendor');
  const pkg = JSON.parse(fs.readFileSync(path.join(gitnexusRoot, 'package.json'), 'utf8'));
  const shipsVendorSource = filesShipsVendorSource(pkg.files);

  const grammars = collectGrammars(vendorDir, shipsVendorSource);
  if (grammars.length === 0) {
    console.error(`[publish-guard] No vendored tree-sitter grammars found under ${vendorDir}.`);
    process.exit(1);
  }

  const stray = findStrayBuildArtifacts(vendorDir);
  if (stray.length > 0) {
    console.error(
      '[publish-guard] Refusing to publish — stray source-build output under vendor/ would\n' +
        'ship and shadow the committed prebuilds (node-gyp-build loads build/Release before\n' +
        'prebuilds/):',
    );
    for (const s of stray) console.error(`  - ${s}`);
    console.error('\nFix: remove it before packing, e.g. `rm -rf gitnexus/vendor/*/build`.');
    process.exit(1);
  }

  const problems = findCoverageProblems({ grammars });
  if (problems.length > 0) {
    console.error('[publish-guard] Refusing to publish — a vendored grammar would ship unusable:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nFix: either commit the missing prebuilds (run the build-tree-sitter-prebuilds\n' +
        'workflow) or keep the vendored source in the package.json `files` field.',
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
  findStrayBuildArtifacts,
  filesShipsVendorSource,
  isBuildableFromSource,
  sourceBuildSet,
  countPrebuiltTuples,
  collectGrammars,
  TUPLES,
  SOURCE_BUILD_REL,
};
