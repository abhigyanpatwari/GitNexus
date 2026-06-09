#!/usr/bin/env node
/**
 * Publish guard: every vendored tree-sitter grammar must ship a loadable binding.
 *
 * The npm tarball includes gitnexus/vendor/ (package.json `files`). A grammar is
 * "covered" on a platform-arch tuple if EITHER a prebuild ships for it OR the
 * grammar source ships (so the install can source-build it, toolchain
 * permitting). The lean-publish toggle in gitnexus/.npmignore
 * (`vendor/**​/src/parser.c`, commented by default) drops the ~50 MB of generated
 * source to ship prebuilds only — which is safe ONLY once every grammar has all
 * six prebuilds. Excluding the source while any grammar is still missing a
 * prebuild would ship a grammar with NO loadable binding (neither prebuild nor
 * buildable source) → that language is silently dead for users.
 *
 * This guard fails `npm pack` / `npm publish` (wired via `prepack`) if that
 * invariant is violated, so the gated .npmignore exclusions can never be
 * activated early and silently ship a dead grammar.
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

// The single .npmignore line that toggles source exclusion. Keep in exact sync
// with the lean-publish block in gitnexus/.npmignore.
const SOURCE_EXCLUSION_TOGGLE = 'vendor/**/src/parser.c';

function activeIgnorePatterns(npmignoreText) {
  return npmignoreText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

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
 * `{ name, prebuilt: 0..6, hasSource: boolean }`. Returns human-readable problem
 * strings; an empty array means the pack is publish-safe.
 */
function findCoverageProblems({ grammars, sourceExcluded }) {
  const problems = [];
  for (const g of grammars) {
    const shipsSource = g.hasSource && !sourceExcluded;
    if (g.prebuilt < 6 && !shipsSource) {
      const missing = 6 - g.prebuilt;
      problems.push(
        `${g.name}: ${g.prebuilt}/6 prebuilds and source ${
          sourceExcluded ? 'EXCLUDED from the npm tarball' : 'absent'
        } — would ship with no loadable binding on ${missing} platform-arch tuple(s).`,
      );
    }
  }
  return problems;
}

function collectGrammars(vendorDir) {
  if (!fs.existsSync(vendorDir)) return [];
  return fs
    .readdirSync(vendorDir)
    .filter((d) => /^tree-sitter-/.test(d))
    .map((name) => {
      const dir = path.join(vendorDir, name);
      return {
        name,
        prebuilt: countPrebuiltTuples(dir),
        hasSource: fs.existsSync(path.join(dir, 'src', 'parser.c')),
      };
    });
}

function main() {
  const gitnexusRoot = path.join(__dirname, '..');
  const vendorDir = path.join(gitnexusRoot, 'vendor');
  const npmignorePath = path.join(gitnexusRoot, '.npmignore');
  const npmignoreText = fs.existsSync(npmignorePath) ? fs.readFileSync(npmignorePath, 'utf8') : '';
  const sourceExcluded = activeIgnorePatterns(npmignoreText).includes(SOURCE_EXCLUSION_TOGGLE);
  const grammars = collectGrammars(vendorDir);

  if (grammars.length === 0) {
    console.error(`[publish-guard] No vendored tree-sitter grammars found under ${vendorDir}.`);
    process.exit(1);
  }

  const problems = findCoverageProblems({ grammars, sourceExcluded });
  if (problems.length > 0) {
    console.error('[publish-guard] Refusing to publish — a vendored grammar would ship unusable:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nFix: either commit the missing prebuilds (run the build-tree-sitter-prebuilds\n' +
        'workflow) or re-comment the lean-publish source exclusions in gitnexus/.npmignore.',
    );
    process.exit(1);
  }

  const mode = sourceExcluded ? 'prebuilds-only (source excluded)' : 'source + prebuilds';
  console.log(
    `[publish-guard] OK — ${grammars.length} vendored grammar(s) covered; tarball mode: ${mode}.`,
  );
}

if (require.main === module) main();

module.exports = {
  findCoverageProblems,
  activeIgnorePatterns,
  countPrebuiltTuples,
  collectGrammars,
  TUPLES,
  SOURCE_EXCLUSION_TOGGLE,
};
