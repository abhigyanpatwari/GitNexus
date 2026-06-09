import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard: every tree-sitter grammar GitNexus ships must provide a
 * loadable native binding for EVERY platform-arch we support, on the ABI we
 * support — so a toolchain-less install never silently loses a language.
 *
 * "The ABI we support":
 *   - Node native ABI: engines.node >= 22 → all grammars are N-API
 *     (node-addon-api), i.e. one ABI-stable `.node` per platform-arch loads
 *     across Node majors. We assert each prebuilt binary exports the N-API
 *     entry symbol `napi_register_module_v1` (a node-ABI-pinned binary would
 *     not) — this works cross-platform because the symbol name is an ASCII
 *     string in the binary on linux/macOS/Windows alike.
 *   - tree-sitter language ABI: pinned `tree-sitter@0.21.1` (#1922) — verified
 *     by the load+parse smoke in parser-loader-abi.test.ts.
 *
 * Two cohorts:
 *   1. VENDORED grammars (gitnexus/vendor/tree-sitter-*) — GitNexus owns these
 *      prebuilds (cross-built by .github/workflows/build-tree-sitter-prebuilds.yml;
 *      Swift's were originally upstream-shipped, now rebuilt the same way). Each
 *      one that does NOT also vendor its build source MUST cover all 6 tuples.
 *   2. npm-dependency grammars — upstream owns their prebuilds. We assert 6/6
 *      too, with documented exceptions (see KNOWN_NPM_GAPS).
 */

const TUPLES = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];
const NAPI_SYMBOL = 'napi_register_module_v1';

const GITNEXUS_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VENDOR_DIR = path.join(GITNEXUS_ROOT, 'vendor');
const NODE_MODULES = path.join(GITNEXUS_ROOT, 'node_modules');

/**
 * Known, tracked upstream coverage gaps for npm-dependency grammars. Each entry
 * is the EXACT set of tuples the upstream package omits — the test fails if a
 * grammar drops MORE than its allow-listed gap (a new silent regression) OR if
 * an allow-listed gap is closed upstream (prompting allow-list removal).
 *
 * (tree-sitter-c@0.21.4 ships only 4/6 — no linux-arm64/win32-arm64, #2116 — but
 * it is now VENDORED with GitNexus-built prebuilds for all 6, so it falls under
 * the vendored cohort below, not here.)
 */
const KNOWN_NPM_GAPS: Record<string, string[]> = {};

function isNapiBinary(file: string): boolean {
  return readFileSync(file).includes(NAPI_SYMBOL);
}

function prebuiltTuples(grammarDir: string): { covered: Set<string>; nonNapi: string[] } {
  const pdir = path.join(grammarDir, 'prebuilds');
  const covered = new Set<string>();
  const nonNapi: string[] = [];
  if (!existsSync(pdir)) return { covered, nonNapi };
  for (const tuple of TUPLES) {
    const td = path.join(pdir, tuple);
    if (!existsSync(td) || !statSync(td).isDirectory()) continue;
    const nodes = readdirSync(td).filter((f) => f.endsWith('.node'));
    if (nodes.length === 0) continue;
    covered.add(tuple);
    for (const n of nodes) if (!isNapiBinary(path.join(td, n))) nonNapi.push(`${tuple}/${n}`);
  }
  return { covered, nonNapi };
}

const vendoredGrammars = existsSync(VENDOR_DIR)
  ? readdirSync(VENDOR_DIR).filter((d) => /^tree-sitter-/.test(d))
  : [];

describe('vendored grammar prebuild coverage (toolchain-free on every supported platform)', () => {
  it('discovers the vendored grammars', () => {
    // Sanity: if vendor/ ever empties, the per-grammar assertions would vacuously
    // pass — fail loudly instead.
    expect(vendoredGrammars.length).toBeGreaterThan(0);
  });

  for (const grammar of vendoredGrammars) {
    const grammarDir = path.join(VENDOR_DIR, grammar);
    const { covered, nonNapi } = prebuiltTuples(grammarDir);
    const missing = TUPLES.filter((t) => !covered.has(t));
    // A grammar that vendors its build sources (binding.gyp) can source-build the
    // gaps on any toolchain host (e.g. CI), so an incomplete prebuild set is
    // tolerated for it — the build-tree-sitter-prebuilds workflow fills the
    // prebuilds to make it toolchain-free. Every grammar GitNexus currently
    // vendors carries its source (incl. swift, unified with the rest), so the
    // strict branch below is defensive: a hypothetical prebuild-only grammar (no
    // binding.gyp) MUST ship all six, or it is dead on the missing platform.
    const hasSourceFallback = existsSync(path.join(grammarDir, 'binding.gyp'));

    it(
      hasSourceFallback
        ? `${grammar}: present prebuilds are N-API (source-build fallback covers any gaps)`
        : `${grammar}: ships an N-API prebuild for all 6 platform-arch tuples`,
      () => {
        // Any prebuild that IS present must be a loadable N-API binary — always.
        expect(nonNapi, `${grammar} has non-N-API prebuilds: ${nonNapi.join(', ')}`).toEqual([]);
        if (!hasSourceFallback) {
          // Prebuild-only — run the build-tree-sitter-prebuilds workflow to
          // (re)generate any that are missing.
          expect(
            missing,
            `prebuild-only ${grammar} is missing prebuilds for: ${missing.join(', ') || 'none'} ` +
              `(run the build-tree-sitter-prebuilds workflow)`,
          ).toEqual([]);
        }
      },
    );
  }
});

describe('npm-dependency grammar prebuild coverage', () => {
  const pkg = JSON.parse(readFileSync(path.join(GITNEXUS_ROOT, 'package.json'), 'utf8'));
  const npmGrammars = Object.keys(pkg.dependencies ?? {})
    .filter((d) => /^tree-sitter-/.test(d))
    .sort();

  it('discovers the npm grammar dependencies', () => {
    expect(npmGrammars.length).toBeGreaterThan(0);
  });

  for (const grammar of npmGrammars) {
    const grammarDir = path.join(NODE_MODULES, grammar);

    it(`${grammar}: upstream ships N-API prebuilds for all 6 tuples (minus tracked gaps)`, () => {
      if (!existsSync(grammarDir)) {
        // node_modules must be installed for this check (CI coverage job / local).
        throw new Error(`${grammar} not installed at ${grammarDir} — run npm install`);
      }
      const { covered, nonNapi } = prebuiltTuples(grammarDir);
      const allowedGap = new Set(KNOWN_NPM_GAPS[grammar] ?? []);
      const unexpectedMissing = TUPLES.filter((t) => !covered.has(t) && !allowedGap.has(t));
      const unexpectedlyClosed = [...allowedGap].filter((t) => covered.has(t));

      expect(
        unexpectedMissing,
        `${grammar} is missing prebuilds for: ${unexpectedMissing.join(', ')} ` +
          `(new gap — upstream dropped a platform, or pin a version that ships it)`,
      ).toEqual([]);
      expect(
        unexpectedlyClosed,
        `${grammar} now ships prebuilds for ${unexpectedlyClosed.join(', ')} — ` +
          `remove it from KNOWN_NPM_GAPS (and close the tracking issue)`,
      ).toEqual([]);
      expect(nonNapi, `${grammar} has non-N-API prebuilds: ${nonNapi.join(', ')}`).toEqual([]);
    });
  }
});
