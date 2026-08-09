/**
 * Differential harness for the JavaScript import-target suffix index (#2910).
 *
 * JavaScript's `PassCache` was the TypeScript one minus its `index` field, so
 * `makeJsResolveImportTarget` handed `resolveTsTarget` a context with
 * `index: undefined` and every JavaScript import fell through to
 * `suffixResolve`'s linear `findIndex` — one pass over `normalizedFileList` per
 * path part per extension, and `EXTENSIONS` has ~39 entries. 6448.9 µs per
 * import at 2000 files and 25972.6 µs at 8000, against 25.0 / 27.0 µs for
 * TypeScript over the same corpus; 28.5 / 27.4 µs with the index.
 *
 * Adding the field is NOT a pure hoist. `suffixResolve` answers a different
 * question with an index than without:
 *
 *   - without: `filePath.endsWith('/' + s)`, so only a PROPER suffix matches;
 *   - with:    `index.get(s) || index.getInsensitive(s)`, and `buildSuffixIndex`
 *              indexes `j = 0`, so WHOLE paths match too.
 *
 * This file holds a verbatim copy of the pre-change adapter
 * (`git show HEAD:gitnexus/src/core/ingestion/languages/javascript/import-target.ts`)
 * and pins exactly what that difference does. Two classes of answer move and no
 * others:
 *
 *   A. `null → repo-root file`. A path with no `/` has no proper suffix at all,
 *      so the scan could never reach it: `require('config')` was unresolvable
 *      with `config.js` sitting in the repo root.
 *   B. `file → different file`, always toward a MORE specific match. The scan
 *      skips the whole-path candidate and falls through to a shorter path
 *      suffix or a later extension, where it finds something else:
 *      `import 'app/main'` resolved to `node_modules/dep0/lib/main.js` — the
 *      first `/main.js` in file order — and now resolves to `app/main.js`.
 *
 * Measured over 211 200 old-vs-new pairs (400 generated corpora × 3 importing
 * files × 176 targets) there is no third class: the index never loses a match
 * the scan found, and its answer is never matched at a less specific
 * (path-part, extension) position. Both of those are asserted below as
 * universal properties over this corpus rather than as a count.
 *
 * ## Why the moved answers are JavaScript being fixed, not the index being wrong
 *
 * TypeScript and Vue have run the indexed path since #1918, over an identically
 * built `normalizedFileList` (`allFileList.map(f => f.toLowerCase())`), through
 * the same `resolveTsTarget` — and this adapter's whole stated design is "TS
 * resolver, JS extensions". So the fix makes JavaScript agree with TypeScript,
 * and the arm below asserts that agreement over the entire corpus rather than
 * asserting it in prose. Class B's witness settles the direction: resolving
 * `'app/main'` into `node_modules` was not a behaviour worth preserving.
 *
 * ## The scan counter, and its control
 *
 * The last arm counts entries into `suffixResolve`'s linear branch. That is the
 * instrument this defect needed and did not have: `CountingSet` counts
 * traversals of the SET, and this scan walks the materialized array behind it,
 * which is exactly why the defect shipped under nine index-reuse guards and a
 * sixteen-language contract test. The arm reads the legacy adapter first, so a
 * count of zero is paired with a demonstration that the counter can be nonzero.
 */
import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

import { makeJsResolveImportTarget } from '../../../src/core/ingestion/languages/javascript/import-target.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import {
  resolveTsTarget,
  type TsResolveContext,
} from '../../../src/core/ingestion/languages/typescript/import-target.js';
import { EXTENSIONS } from '../../../src/core/ingestion/import-resolvers/utils.js';

// ─── the linear-fallback counter ─────────────────────────────────────────────
// `suffixResolve` is reached through `import-resolvers/standard.ts`, which
// imports it by a relative specifier that resolves to this same module id.
// Everything else in the module — `buildSuffixIndex`, `EXTENSIONS`,
// `tryResolveWithExtensions` — is passed straight through.

const linearScans = { count: 0 };

vi.mock('../../../src/core/ingestion/import-resolvers/utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/core/ingestion/import-resolvers/utils.js')>();
  return {
    ...actual,
    suffixResolve: (
      pathParts: string[],
      normalizedFileList: string[],
      allFileList: string[],
      index?: import('../../../src/core/ingestion/import-resolvers/utils.js').SuffixIndex,
    ): string | null => {
      linearScans.count += index === undefined ? 1 : 0;
      return actual.suffixResolve(pathParts, normalizedFileList, allFileList, index);
    },
  };
});

// ─── verbatim pre-change implementation ──────────────────────────────────────
// Copied from `git show HEAD:gitnexus/src/core/ingestion/languages/javascript/
// import-target.ts`. Only the names are prefixed; the body is untouched, and in
// particular the `PassCache` below still has no `index` field and the cache is
// still the single slot the WeakMap replaced.

type LegacyJsResolveContext = TsResolveContext;

type LegacyPassCache = {
  readonly key: ReadonlySet<string>;
  readonly allFilePaths: Set<string>;
  readonly allFileList: readonly string[];
  readonly normalizedFileList: readonly string[];
  readonly resolveCache: Map<string, string | null>;
};

function legacyMakeJsResolveImportTarget(): (
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
) => string | readonly string[] | null {
  let cached: LegacyPassCache | null = null;

  return (targetRaw, fromFile, allFilePaths) => {
    if (cached === null || cached.key !== allFilePaths) {
      const allFileList = Array.from(allFilePaths);
      cached = {
        key: allFilePaths,
        allFilePaths: new Set(allFilePaths),
        allFileList,
        normalizedFileList: allFileList.map((f) => f.toLowerCase()),
        resolveCache: new Map(),
      };
    }

    const ws: LegacyJsResolveContext = {
      fromFile,
      language: SupportedLanguages.JavaScript,
      allFilePaths: cached.allFilePaths,
      allFileList: cached.allFileList,
      normalizedFileList: cached.normalizedFileList,
      resolveCache: cached.resolveCache,
      tsconfigPaths: null,
    };
    return resolveTsTarget(targetRaw, ws);
  };
}

// ─── corpus ──────────────────────────────────────────────────────────────────

/** One differential case. `files` is emitted in the listed order, and that
 *  order is the tie-break under test — nothing here is random. */
interface Case {
  readonly name: string;
  readonly files: readonly string[];
  readonly target: string;
  readonly fromFile: string;
}

const FROM_FILE = 'src/main.js';

/**
 * A deterministic multi-root workspace. Every root carries the same relative
 * layout, so a suffix-keyed lookup and a proper-suffix scan disagree about
 * which root wins; `node_modules/dep0/lib/main.js` exists so a short suffix has
 * somewhere wrong to land; `SRC/Utils/Helper0.JS` differs from
 * `src/utils/helper0.js` only in case; and `config.js`, `index.js`, `mod0.js`
 * sit at the repo root, where no proper suffix can reach them.
 */
function generatedFiles(): string[] {
  const files: string[] = [];
  for (let i = 0; i < 10; i++) {
    files.push(`src/components/Widget${i}.js`);
    files.push(`src/components/widget${i}.jsx`);
    files.push(`vendor/pkg${i % 3}/src/utils/helper${i}.js`);
    files.push(`src/utils/helper${i}.js`);
    files.push(`src/utils/helper${i}/index.js`);
    files.push(`lib/mod${i}.mjs`);
    files.push(`lib/legacy${i}.cjs`);
    files.push(`mod${i}.js`);
    files.push(`node_modules/dep${i}/index.js`);
    files.push(`node_modules/dep${i}/lib/main.js`);
    files.push(`SRC/Utils/Helper${i}.JS`);
    files.push(`packages/app${i}/src/index.js`);
  }
  files.push('config.js');
  files.push('index.js');
  files.push('src/index.js');
  files.push('src/main.js');
  files.push('app/main.js');
  return files;
}

const GENERATED_FILES = generatedFiles();

/**
 * Targets swept across `GENERATED_FILES`: relative hits and misses,
 * extensionless and explicit-extension spellings, `index.js` directories, bare
 * and `node_modules` specifiers, scoped packages, case-differing paths, and
 * plain misses. Most of them miss, which is both the realistic shape and the
 * expensive one — a miss runs the cascade to completion.
 */
function generatedTargets(): string[] {
  const targets: string[] = [];
  for (let i = 0; i < 10; i++) {
    targets.push(`./components/Widget${i}`);
    targets.push(`./components/Widget${i}.js`);
    targets.push(`../src/utils/helper${i}`);
    targets.push(`src/utils/helper${i}`);
    targets.push(`utils/helper${i}`);
    targets.push(`helper${i}`);
    targets.push(`mod${i}`);
    targets.push(`lib/mod${i}.mjs`);
    targets.push(`lib/legacy${i}`);
    targets.push(`dep${i}`);
    targets.push(`dep${i}/lib/main`);
    targets.push(`SRC/Utils/Helper${i}`);
    targets.push(`packages/app${i}/src`);
    targets.push(`@scope/pkg${i}`);
    targets.push(`ghost${i}/missing`);
    targets.push(`node_modules/dep${i}`);
  }
  targets.push('config');
  targets.push('index');
  targets.push('src');
  targets.push('src/main');
  targets.push('app/main');
  return targets;
}

const GENERATED_CASES: readonly Case[] = generatedTargets().map((target) => ({
  name: `generated ${target}`,
  files: GENERATED_FILES,
  target,
  fromFile: FROM_FILE,
}));

/** Hand-built cases, one per shape the index could have moved. */
const HAND_CASES: readonly Case[] = [
  // ── relative specifiers: resolved by exact `Set.has`, never reach the index ──
  {
    name: 'relative hit',
    files: ['src/util.js', 'src/main.js'],
    target: './util',
    fromFile: FROM_FILE,
  },
  {
    name: 'relative hit with an explicit extension',
    files: ['src/util.js', 'src/main.js'],
    target: './util.js',
    fromFile: FROM_FILE,
  },
  {
    name: 'relative parent-directory hit',
    files: ['shared/util.js', 'src/main.js'],
    target: '../shared/util',
    fromFile: FROM_FILE,
  },
  {
    name: 'relative miss',
    files: ['src/util.js', 'src/main.js'],
    target: './missing',
    fromFile: FROM_FILE,
  },
  {
    name: 'relative directory index.js',
    files: ['src/util/index.js', 'src/main.js'],
    target: './util',
    fromFile: FROM_FILE,
  },
  {
    name: 'relative ESM specifier written as .js against a .mjs file',
    files: ['src/util.mjs', 'src/main.js'],
    target: './util.js',
    fromFile: FROM_FILE,
  },
  // ── class A: repo-root files, unreachable as a proper suffix ────────────────
  {
    name: 'root-level file by bare specifier',
    files: ['config.js', 'src/main.js'],
    target: 'config',
    fromFile: FROM_FILE,
  },
  {
    name: 'root index.js by bare specifier',
    files: ['index.js', 'src/main.js'],
    target: 'index',
    fromFile: FROM_FILE,
  },
  {
    name: 'root-level file with an explicit extension',
    files: ['config.js', 'src/main.js'],
    target: 'config.js',
    fromFile: FROM_FILE,
  },
  {
    name: 'root-level .mjs by bare specifier',
    files: ['esm.mjs'],
    target: 'esm',
    fromFile: FROM_FILE,
  },
  {
    name: 'root-level .cjs by bare specifier',
    files: ['legacy.cjs'],
    target: 'legacy',
    fromFile: FROM_FILE,
  },
  {
    name: 'root-level .jsx by bare specifier',
    files: ['Btn.jsx'],
    target: 'Btn',
    fromFile: FROM_FILE,
  },
  // ── class B: whole path vs proper suffix ────────────────────────────────────
  {
    name: 'whole-path candidate earlier in file order than a proper-suffix one',
    files: ['src/util.js', 'vendor/src/util.js'],
    target: 'src/util',
    fromFile: FROM_FILE,
  },
  {
    name: 'whole-path candidate later in file order than a proper-suffix one',
    files: ['vendor/src/util.js', 'src/util.js'],
    target: 'src/util',
    fromFile: FROM_FILE,
  },
  {
    name: 'whole-path hit at a long suffix vs proper-suffix hit at a short one',
    files: ['node_modules/dep/lib/main.js', 'app/main.js'],
    target: 'app/main',
    fromFile: FROM_FILE,
  },
  {
    name: 'whole-path hit at a long suffix vs proper-suffix hit at a short one, reversed',
    files: ['app/main.js', 'node_modules/dep/lib/main.js'],
    target: 'app/main',
    fromFile: FROM_FILE,
  },
  {
    name: 'whole path is the only candidate, and a proper suffix of it exists',
    files: ['src/util.js', 'src/main.js'],
    target: 'src/util',
    fromFile: FROM_FILE,
  },
  {
    name: 'whole-path directory index.js',
    files: ['src/util/index.js', 'src/main.js'],
    target: 'src/util',
    fromFile: FROM_FILE,
  },
  {
    name: 'whole-path candidate at an earlier extension than the proper-suffix one',
    files: ['x/U.js', 'U.jsx'],
    target: 'U',
    fromFile: FROM_FILE,
  },
  {
    name: 'whole-path candidate at an earlier extension than the proper-suffix one, reversed',
    files: ['U.jsx', 'x/U.js'],
    target: 'U',
    fromFile: FROM_FILE,
  },
  {
    name: 'root .js outranks a nested .mjs',
    files: ['lib/mod.mjs', 'mod.js'],
    target: 'mod',
    fromFile: FROM_FILE,
  },
  // ── case-differing paths ────────────────────────────────────────────────────
  {
    name: 'case-differing whole path beats a case-exact proper suffix',
    files: ['SRC/Util.js', 'other/src/util.js'],
    target: 'src/util',
    fromFile: FROM_FILE,
  },
  {
    name: 'case-differing proper suffixes only',
    files: ['other/SRC/Util.js', 'zz/deep/src/util.js'],
    target: 'src/util',
    fromFile: FROM_FILE,
  },
  {
    name: 'case-exact file later in order than a case-differing one',
    files: ['a/FOO.js', 'b/Foo.js'],
    target: 'Foo',
    fromFile: FROM_FILE,
  },
  {
    name: 'case-exact file earlier in order than a case-differing one',
    files: ['b/Foo.js', 'a/FOO.js'],
    target: 'Foo',
    fromFile: FROM_FILE,
  },
  // ── bare / node_modules specifiers ──────────────────────────────────────────
  {
    name: 'node_modules package by bare specifier',
    files: ['node_modules/dep/index.js', 'src/main.js'],
    target: 'dep',
    fromFile: FROM_FILE,
  },
  {
    name: 'node_modules deep path',
    files: ['node_modules/dep/lib/main.js', 'src/main.js'],
    target: 'dep/lib/main',
    fromFile: FROM_FILE,
  },
  {
    name: 'scoped package with no file anywhere',
    files: ['src/util.js', 'src/main.js'],
    target: '@scope/pkg',
    fromFile: FROM_FILE,
  },
  {
    name: 'dotted specifier is split on dots',
    files: ['a/b.js', 'src/main.js'],
    target: 'a.b',
    fromFile: FROM_FILE,
  },
  // ── extension coverage ──────────────────────────────────────────────────────
  {
    name: 'nested .mjs by bare specifier',
    files: ['lib/mod.mjs', 'src/main.js'],
    target: 'lib/mod',
    fromFile: FROM_FILE,
  },
  {
    name: 'nested .cjs by bare specifier',
    files: ['lib/legacy.cjs', 'src/main.js'],
    target: 'lib/legacy',
    fromFile: FROM_FILE,
  },
  {
    name: 'nested .jsx by bare specifier',
    files: ['comp/Btn.jsx', 'src/main.js'],
    target: 'comp/Btn',
    fromFile: FROM_FILE,
  },
  // ── degenerate inputs ───────────────────────────────────────────────────────
  { name: 'empty file set', files: [], target: 'anything', fromFile: FROM_FILE },
  { name: 'empty target', files: ['src/util.js'], target: '', fromFile: FROM_FILE },
  {
    name: 'plain miss',
    files: ['src/util.js', 'src/main.js'],
    target: 'nowhere/at/all',
    fromFile: FROM_FILE,
  },
  {
    name: 'importing file is itself at the repo root',
    files: ['config.js', 'main.js'],
    target: 'config',
    fromFile: 'main.js',
  },
];

// ─── runners ─────────────────────────────────────────────────────────────────

type Resolved = string | readonly string[] | null;

/**
 * One legacy adapter and one current adapter per corpus, each over its own copy
 * of the file set — the legacy single-slot cache and the current WeakMap are
 * both keyed on the Set, so sharing one would let each observe the other's
 * work.
 */
interface Runners {
  readonly legacy: (target: string, fromFile: string) => Resolved;
  readonly current: (target: string, fromFile: string) => Resolved;
  readonly typescript: (target: string, fromFile: string) => Resolved;
}

function runnersFor(files: readonly string[]): Runners {
  const legacyAdapter = legacyMakeJsResolveImportTarget();
  const currentAdapter = makeJsResolveImportTarget();
  const legacyFiles = new Set(files);
  const currentFiles = new Set(files);
  const typescriptFiles = new Set(files);
  return {
    legacy: (target, fromFile) => legacyAdapter(target, fromFile, legacyFiles, undefined),
    current: (target, fromFile) => currentAdapter(target, fromFile, currentFiles, undefined),
    typescript: (target, fromFile) =>
      typescriptScopeResolver.resolveImportTarget(target, fromFile, typescriptFiles, undefined),
  };
}

interface Outcome {
  readonly name: string;
  readonly target: string;
  readonly legacy: Resolved;
  readonly current: Resolved;
  readonly typescript: Resolved;
}

/** Every case, resolved once. Built lazily and shared: the generated corpus is
 *  one file set across 165 targets, which is the shape a real pass has. */
const OUTCOMES: readonly Outcome[] = (() => {
  const generated = runnersFor(GENERATED_FILES);
  const handOutcomes = HAND_CASES.map((testCase) => {
    const runners = runnersFor(testCase.files);
    return {
      name: testCase.name,
      target: testCase.target,
      legacy: runners.legacy(testCase.target, testCase.fromFile),
      current: runners.current(testCase.target, testCase.fromFile),
      typescript: runners.typescript(testCase.target, testCase.fromFile),
    };
  });
  const generatedOutcomes = GENERATED_CASES.map((testCase) => ({
    name: testCase.name,
    target: testCase.target,
    legacy: generated.legacy(testCase.target, testCase.fromFile),
    current: generated.current(testCase.target, testCase.fromFile),
    typescript: generated.typescript(testCase.target, testCase.fromFile),
  }));
  return [...handOutcomes, ...generatedOutcomes];
})();

const DIVERGENT: readonly Outcome[] = OUTCOMES.filter(
  (outcome) => outcome.legacy !== outcome.current,
);

function describeDivergence(outcome: Outcome): string {
  return `${outcome.name} :: ${JSON.stringify(outcome.legacy)} → ${JSON.stringify(outcome.current)}`;
}

/**
 * Where in `suffixResolve`'s two nested loops a result was matched, as
 * `pathPartIndex:extensionIndex`. Lower is more specific: a longer path suffix,
 * or the same suffix at an earlier extension. Mirrors `resolveImportPath`'s
 * own `pathParts` construction (dots become slashes only when the specifier
 * carries no slash).
 */
function matchPosition(result: string, target: string): readonly [number, number] {
  const pathLike = target.includes('/') ? target : target.replace(/\./g, '/');
  const parts = pathLike.split('/').filter(Boolean);
  const lower = result.toLowerCase();
  const positions = parts.flatMap((_part, i) => {
    const suffix = parts.slice(i).join('/').toLowerCase();
    return EXTENSIONS.flatMap((ext, e) => {
      const candidate = suffix + ext.toLowerCase();
      const matches = lower === candidate || lower.endsWith(`/${candidate}`);
      return matches ? [[i, e] as const] : [];
    });
  });
  return positions[0] ?? [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
}

/**
 * Class A — a repo-root file, which has no proper suffix and so was
 * unreachable through this leg at all. Every line goes `null → <root file>`,
 * and the arm below enforces that shape rather than trusting the grouping.
 */
const CLASS_A_DIVERGENCES: readonly string[] = [
  'root-level file by bare specifier :: null → "config.js"',
  'root index.js by bare specifier :: null → "index.js"',
  'root-level .mjs by bare specifier :: null → "esm.mjs"',
  'root-level .cjs by bare specifier :: null → "legacy.cjs"',
  'root-level .jsx by bare specifier :: null → "Btn.jsx"',
  'importing file is itself at the repo root :: null → "config.js"',
  'generated config :: null → "config.js"',
];

/**
 * Class B — the scan skipped the whole-path candidate and landed on a shorter
 * path suffix or a later extension instead. Every line moves from one file to
 * another, toward the more specific match; `never answers at a less specific
 * path-part / extension position` is the property behind that claim.
 *
 * `generated src/main` and `generated app/main` are the witnesses that settle
 * the direction: both used to resolve into `node_modules`, because
 * `node_modules/dep0/lib/main.js` is the first file in the corpus ending in
 * `/main.js` and the scan never tried the two-segment suffix as a whole path.
 */
const CLASS_B_DIVERGENCES: readonly string[] = [
  'whole-path candidate earlier in file order than a proper-suffix one :: "vendor/src/util.js" → "src/util.js"',
  'whole-path hit at a long suffix vs proper-suffix hit at a short one :: "node_modules/dep/lib/main.js" → "app/main.js"',
  'whole-path candidate at an earlier extension than the proper-suffix one :: "x/U.js" → "U.jsx"',
  'whole-path candidate at an earlier extension than the proper-suffix one, reversed :: "x/U.js" → "U.jsx"',
  'root .js outranks a nested .mjs :: "lib/mod.mjs" → "mod.js"',
  'case-differing whole path beats a case-exact proper suffix :: "other/src/util.js" → "SRC/Util.js"',
  'generated src/main :: "node_modules/dep0/lib/main.js" → "src/main.js"',
  'generated app/main :: "node_modules/dep0/lib/main.js" → "app/main.js"',
  'generated mod0 :: "lib/mod0.mjs" → "mod0.js"',
  'generated mod1 :: "lib/mod1.mjs" → "mod1.js"',
  'generated mod2 :: "lib/mod2.mjs" → "mod2.js"',
  'generated mod3 :: "lib/mod3.mjs" → "mod3.js"',
  'generated mod4 :: "lib/mod4.mjs" → "mod4.js"',
  'generated mod5 :: "lib/mod5.mjs" → "mod5.js"',
  'generated mod6 :: "lib/mod6.mjs" → "mod6.js"',
  'generated mod7 :: "lib/mod7.mjs" → "mod7.js"',
  'generated mod8 :: "lib/mod8.mjs" → "mod8.js"',
  'generated mod9 :: "lib/mod9.mjs" → "mod9.js"',
];

/**
 * The divergences this corpus produces, pinned old → new. A future edit that
 * moves a DIFFERENT answer — or stops moving one of these — fails here rather
 * than quietly shipping.
 */
const EXPECTED_DIVERGENCES: readonly string[] = [...CLASS_A_DIVERGENCES, ...CLASS_B_DIVERGENCES];

// ─── the differential ────────────────────────────────────────────────────────

describe('JavaScript import-target parity with the pre-index adapter (#2910)', () => {
  it('agrees with the pre-index adapter on every case outside the pinned set', () => {
    const pinned = new Set(EXPECTED_DIVERGENCES);
    const unexpected = DIVERGENT.map(describeDivergence).filter(
      (description) => !pinned.has(description),
    );

    expect(unexpected).toEqual([]);
  });

  it('moves exactly the pinned answers, and still moves all of them', () => {
    expect(DIVERGENT.map(describeDivergence).sort()).toEqual([...EXPECTED_DIVERGENCES].sort());
  });

  it('never loses a match the scan found', () => {
    const lost = OUTCOMES.filter(
      (outcome) => outcome.legacy !== null && outcome.current === null,
    ).map(describeDivergence);

    expect(lost).toEqual([]);
  });

  it('never answers at a less specific path-part / extension position', () => {
    const lessSpecific = DIVERGENT.filter(
      (outcome) => typeof outcome.legacy === 'string' && typeof outcome.current === 'string',
    )
      .map((outcome) => ({
        outcome,
        was: matchPosition(String(outcome.legacy), outcome.target),
        now: matchPosition(String(outcome.current), outcome.target),
      }))
      .filter(({ was, now }) => now[0] > was[0] || (now[0] === was[0] && now[1] > was[1]))
      .map(({ outcome, was, now }) => `${describeDivergence(outcome)} (${was} → ${now})`);

    expect(lessSpecific).toEqual([]);
  });

  it('answers identically to the TypeScript adapter over the whole corpus', () => {
    const disagreements = OUTCOMES.filter((outcome) => outcome.current !== outcome.typescript).map(
      (outcome) =>
        `${outcome.name} :: js=${JSON.stringify(outcome.current)} ts=${JSON.stringify(outcome.typescript)}`,
    );

    expect(disagreements).toEqual([]);
  });

  it('both classes are witnessed, and each line has its class’s shape', () => {
    // Class A is `null → <a repo-root file>`: no slash in the new answer, which
    // is the whole reason the scan could not reach it.
    const misfiledA = CLASS_A_DIVERGENCES.filter((line) => !/ :: null → "[^/"]+"$/.test(line));
    // Class B moves between two files; neither side is null.
    const misfiledB = CLASS_B_DIVERGENCES.filter((line) => line.includes('null'));

    expect(misfiledA).toEqual([]);
    expect(misfiledB).toEqual([]);
    expect(CLASS_A_DIVERGENCES.length).toBeGreaterThan(0);
    expect(CLASS_B_DIVERGENCES.length).toBeGreaterThan(0);
  });

  it('resolves real JavaScript imports (the differential is not vacuous)', () => {
    const resolveImportTarget = makeJsResolveImportTarget();
    const files = new Set([
      'src/main.js',
      'src/util.js',
      'src/components/Widget.jsx',
      'src/models/index.js',
      'lib/esm.mjs',
      'lib/legacy.cjs',
      'node_modules/dep/index.js',
    ]);

    expect(resolveImportTarget('./util', FROM_FILE, files, undefined)).toBe('src/util.js');
    expect(resolveImportTarget('./util.js', FROM_FILE, files, undefined)).toBe('src/util.js');
    expect(resolveImportTarget('./components/Widget', FROM_FILE, files, undefined)).toBe(
      'src/components/Widget.jsx',
    );
    expect(resolveImportTarget('./models', FROM_FILE, files, undefined)).toBe(
      'src/models/index.js',
    );
    expect(resolveImportTarget('lib/esm', FROM_FILE, files, undefined)).toBe('lib/esm.mjs');
    expect(resolveImportTarget('lib/legacy', FROM_FILE, files, undefined)).toBe('lib/legacy.cjs');
    expect(resolveImportTarget('./nowhere', FROM_FILE, files, undefined)).toBeNull();
    expect(resolveImportTarget('@scope/absent', FROM_FILE, files, undefined)).toBeNull();
  });
});

// ─── the guard the defect needed ─────────────────────────────────────────────

describe('JavaScript import resolution never enters the linear suffix scan (#2910)', () => {
  /**
   * The control runs first and on purpose. `CountingSet` cannot see this defect
   * — the scan walks the array the index materialized, not the Set — so an
   * assertion of zero is worth nothing unless the same instrument is shown
   * reading nonzero against the adapter that had the bug.
   */
  it('the pre-index adapter scans linearly once per bare specifier; the current one never does', () => {
    const files = new Set(GENERATED_FILES);
    const bareTargets = generatedTargets().filter((target) => !target.startsWith('.'));

    const legacyAdapter = legacyMakeJsResolveImportTarget();
    linearScans.count = 0;
    bareTargets.forEach((target) => legacyAdapter(target, FROM_FILE, files, undefined));
    const legacyEntries = linearScans.count;

    const currentAdapter = makeJsResolveImportTarget();
    linearScans.count = 0;
    bareTargets.forEach((target) => currentAdapter(target, FROM_FILE, new Set(files), undefined));
    const currentEntries = linearScans.count;

    expect(legacyEntries).toBe(bareTargets.length);
    expect(currentEntries).toBe(0);
  });
});
