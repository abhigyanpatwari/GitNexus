/**
 * Gate for #2913: Python import resolution must not scale with the importer's
 * path depth.
 *
 * `hasRepoCandidate` and `resolveAbsoluteFromFiles` each rebuilt one ancestor
 * prefix per component of the importer's directory, on EVERY import — a cost
 * proportional to depth (quadratic in characters) on an index that is itself
 * depth-free. `importerAncestors` builds that chain once per importer DIRECTORY
 * and stores it in `PythonFileIndex.ancestorsByDir`, which lives inside the
 * per-file-set value and so dies with the pass.
 *
 * ## Why this is not `CountingSet`
 *
 * `test/helpers/counting-file-set.ts` is the house instrument for every other
 * import-target reuse guard, and it cannot see this one. It counts TRAVERSALS
 * of the file set; the ancestor chain is derived from the `fromFile` STRING and
 * touches the set only through `Set.has`, whose argument and count are byte-for-
 * byte identical before and after the hoist. The same is true of a `has`-call
 * counter: memoizing a string that is then concatenated into the same probe
 * changes no probe. A pure hoist is invisible to any instrument that watches
 * only the resolver's inputs — so this file watches the memo, which is the one
 * place the hoist is observable, and watches it THROUGH the production adapter
 * (`pythonScopeResolver.resolveImportTarget`, the surface the orchestrator
 * calls) rather than through the resolver function the parity test uses.
 *
 * The gate is a COUNT, not a timing budget: `ancestorsByDir.size` after N
 * imports from D directories must be D, for every N. That is exactly "the
 * ancestor-prefix work is O(1) amortized after the first import from a given
 * directory", stated as a number a test can assert. It is paired with a
 * reference-identity assertion, because a memo that stores a FRESH chain on
 * every import posts the same size while doing all of the work again.
 *
 * Nothing ships for this file to read. `getPythonFileIndex` is the pass's own
 * index and `ancestorsByDir` is the memo itself; the export is visibility, not
 * a counter — the surface #2909 deleted was ~30 lines of production code whose
 * only caller was a test. The module barrel (`languages/python/index.ts`) is
 * unchanged, so the index stays out of the package's public API.
 *
 * The `legacy*` helpers below are verbatim copies of the pre-#2913 inline code,
 * in the house style of `import-target-index-parity.test.ts`: they are the
 * specification, and the memo agreeing with them is what makes this a hoist
 * rather than a behaviour change.
 *
 * The four memo arms live in `counting-file-set.ts` beside the other
 * import-target scaffolding, because this guard and the bare-prefix one
 * (`test/unit/import-resolvers/python-importer-prefixes.test.ts`) are the same
 * suite over the same importer corpus once four values are named (the memo, the
 * drive, the legacy builder, the hit). The two CHAINS still differ — this one
 * drops the empty components an absolute path or a doubled separator produces
 * and the other keeps them — so `legacyChain` stays per-guard and the shared
 * path-shape table names shapes rather than expectations.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedImport } from 'gitnexus-shared';
import { pythonScopeResolver } from '../../../../src/core/ingestion/languages/python/scope-resolver.js';
import { getPythonFileIndex } from '../../../../src/core/ingestion/import-resolvers/python-file-index.js';
import {
  IMPORTER_PATH_SHAPES,
  countedParsedFiles,
  expectDistinctFileSetsGetOwnChainMemo,
  expectMemoizedChainMatchesLegacy,
  expectOneChainPerImporterDir,
  expectSameChainObjectReused,
  sortedStrings,
  type ChainMemoArm,
  type ChainMemoResult,
} from '../../../helpers/counting-file-set.js';

const { resolveImportTarget } = pythonScopeResolver;

// ─── verbatim pre-#2913 implementations ──────────────────────────────────────

/** The `ancestorPrefixes` array `hasRepoCandidate` used to build per import. */
function legacyAncestorPrefixes(fromFile: string, leadingSegment: string): string[] {
  const importerDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const dirParts = importerDir ? importerDir.split('/').filter(Boolean) : [];
  const ancestorPrefixes: string[] = [];
  for (let i = dirParts.length; i > 0; i--) {
    ancestorPrefixes.push(`${dirParts.slice(0, i).join('/')}/${leadingSegment}/`);
  }
  return ancestorPrefixes;
}

/** The ancestors `resolveAbsoluteFromFiles`'s walk used to build per import. */
function legacyAncestorChain(fromFile: string): string[] {
  const importerDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const chain: string[] = [];
  const dirParts = importerDir ? importerDir.split('/').filter(Boolean) : [];
  for (let i = dirParts.length; i > 0; i--) {
    chain.push(dirParts.slice(0, i).join('/'));
  }
  return chain;
}

/** The forward, no-early-exit `dirPrefixes` build. */
function legacyDirPrefixes(files: readonly string[]): Set<string> {
  const dirPrefixes = new Set<string>();
  for (const raw of files) {
    const norm = raw.replace(/\\/g, '/');
    if (!norm.endsWith('.py')) continue;
    const lastSlash = norm.lastIndexOf('/');
    for (let i = 0; i <= lastSlash; i++) {
      if (norm[i] === '/') dirPrefixes.add(norm.slice(0, i + 1));
    }
  }
  return dirPrefixes;
}

/**
 * The specification of `nestedDirNames`, read off the legacy prefix set: the
 * name of every directory prefix that has a NON-EMPTY parent, which is exactly
 * the set of `${ancestor}/${segment}/` shapes the old ancestor loop could ever
 * match. A segment outside it made the old loop run to completion and answer
 * false; the new code answers false without running it.
 */
function specNestedDirNames(dirPrefixes: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  for (const prefix of dirPrefixes) {
    const dir = prefix.slice(0, -1);
    const slash = dir.lastIndexOf('/');
    if (slash > 0) names.add(dir.slice(slash + 1));
  }
  return names;
}

// ─── the workspace the adapter is driven against ─────────────────────────────

/**
 * `outer/nested/` is what makes `nested` a NESTED directory name without making
 * `nested/` a root prefix, so `hasRepoCandidate('nested')` has to reach the
 * ancestor walk instead of answering from check (1) or (2). `one.py` repeats
 * across three directories so the `outer.one` spelling reaches
 * `resolveAbsoluteFromFiles`'s walk too — both memo call sites, one corpus.
 */
const WORKSPACE: readonly string[] = [
  'outer/nested/mod.py',
  'svc/a/one.py',
  'svc/a/two.py',
  'svc/b/one.py',
  'deep/x/y/z/one.py',
  'root.py',
];

/**
 * One import that must resolve, so a memo count is never the count of an
 * adapter that has stopped resolving anything (the pairing rule every guard in
 * this family states). `outer/` is a root directory prefix, so the gate passes
 * on check (2) and the direct workspace-root hit answers it.
 */
const HIT_TARGET = 'outer.nested.mod';
const HIT_RESULT = 'outer/nested/mod.py';

/**
 * Drives the ORCHESTRATOR ADAPTER `perImporter` times from `fromFile`, with two
 * spellings that between them enter the memo from both call sites:
 *   - `nested.ghost{i}` — reaches `hasRepoCandidate`'s ancestor walk and misses.
 *     Spelled differently every iteration, so nothing upstream can answer it
 *     from a per-target memo.
 *   - `outer.one` — passes the gate on check (2) (`outer/` is a root directory
 *     prefix), misses the direct workspace-root hit, and reaches
 *     `resolveAbsoluteFromFiles`'s ancestor walk. NOT varied per iteration:
 *     `one.py` has to be a real basename somewhere or the walk is skipped
 *     before it starts, and the Python chain keeps no per-target cache, so a
 *     repeated spelling really is re-resolved.
 * …then the one spelling that must resolve.
 */
function driveImporter(
  files: Set<string>,
  fromFile: string,
  perImporter: number,
): ChainMemoResult[] {
  const out: ChainMemoResult[] = [];
  for (let i = 0; i < perImporter; i++) {
    out.push(resolveImportTarget(`nested.ghost${i}`, fromFile, files, undefined, undefined));
    out.push(resolveImportTarget('outer.one', fromFile, files, undefined, undefined));
  }
  out.push(resolveImportTarget(HIT_TARGET, fromFile, files, undefined, undefined));
  return out;
}

const ancestorArm: ChainMemoArm = {
  memoOf: (files) => getPythonFileIndex(files).ancestorsByDir,
  drive: driveImporter,
  legacyChain: legacyAncestorChain,
  hitResult: HIT_RESULT,
};

describe('Python importer-ancestor memo (#2913)', () => {
  it.each([
    { perImporter: 1, label: 'one import per importer' },
    { perImporter: 40, label: 'forty imports per importer' },
  ])('holds one chain per importer DIRECTORY, not per import — $label', ({ perImporter }) => {
    expectOneChainPerImporterDir(ancestorArm, new Set(WORKSPACE), perImporter);
  });

  it('reuses the SAME chain object, rather than rebuilding and re-storing it', () => {
    expectSameChainObjectReused(ancestorArm, new Set(WORKSPACE));
  });

  it.each(IMPORTER_PATH_SHAPES)(
    'memoizes the chain the pre-#2913 code built — $why',
    ({ fromFile }) => {
      const chain = expectMemoizedChainMatchesLegacy(ancestorArm, new Set(WORKSPACE), fromFile);

      // Both consumers' chains, from the one memo: `resolveAbsoluteFromFiles`
      // walked these directories, `hasRepoCandidate` walked the same directories
      // with `/<segment>/` appended.
      expect(chain.map((ancestor) => `${ancestor}/nested/`)).toEqual(
        legacyAncestorPrefixes(fromFile, 'nested'),
      );
    },
  );

  it.each([
    { why: 'relative paths sharing directories', files: WORKSPACE },
    { why: 'absolute paths', files: ['/repo/pkg/__init__.py', '/repo/vendor/pkg/thing.py'] },
    { why: 'a doubled separator', files: ['a//b/x.py', 'a//b/y.py'] },
    { why: 'Windows separators', files: ['a\\b\\x.py', 'a\\b\\c\\y.py'] },
    { why: 'root-level files only', files: ['x.py', 'y.py'] },
    { why: 'a polyglot corpus', files: ['a/b/x.py', 'a/b/x.ts', 'c/d/e/f/g/h.py', 'c/d/n.go'] },
    { why: 'one deep directory, many files', files: ['a/b/c/d/e/1.py', 'a/b/c/d/e/2.py'] },
  ])('builds the same prefix set as the pre-#2913 forward scan — $why', ({ files }) => {
    const index = getPythonFileIndex(new Set(files));
    const legacy = legacyDirPrefixes(files);

    // The build now walks separators from the deepest outward and stops at
    // the first prefix already present. Skipping the rest is only sound
    // because a prefix is always stored with all of its own ancestors.
    expect(sortedStrings(index.dirPrefixes)).toEqual(sortedStrings(legacy));
    expect(sortedStrings(index.nestedDirNames)).toEqual(sortedStrings(specNestedDirNames(legacy)));
  });

  /**
   * The same defect on the OTHER collection the orchestrator threads.
   * `pythonFileExportsName` opened with `parsedFiles.find(...)`, an O(files)
   * scan run for every import whose package probe resolves — which on a repo
   * where `from pkg import X` usually resolves is most imports.
   *
   * `import-target-index-reuse.contract.test.ts` measures this channel for
   * every language, but its Python fixture has exactly ONE resolving import, so
   * its equality arm passes whether the scan is memoized or not. This arm is
   * the one that bites: every import resolves through the probe, so a per-import
   * `find` makes the read count grow with the import count.
   */
  it.each([
    { imports: 2, label: 'two imports' },
    { imports: 200, label: 'two hundred imports' },
  ])('reads the parsed workspace once per PASS, not once per import — $label', ({ imports }) => {
    const modules = Array.from({ length: 30 }, (_, i) => `pkg/m${i}.py`);
    const paths = ['pkg/__init__.py', ...modules, 'app/main.py'];
    const workspace = countedParsedFiles(paths);
    const files = new Set(paths);
    const resolved: ChainMemoResult[] = [];

    for (let i = 0; i < imports; i++) {
      const targetRaw = `pkg.m${i % modules.length}`;
      const parsedImport: ParsedImport = {
        kind: 'named',
        localName: 'Widget',
        importedName: 'Widget',
        targetRaw,
      };
      resolved.push(
        resolveImportTarget(targetRaw, 'app/main.py', files, undefined, {
          parsedFiles: workspace.parsedFiles,
          parsedImport,
        }),
      );
    }

    // One pass over the parsed workspace, whatever the import count. A `find`
    // per import reads 32 for two imports and thousands for two hundred.
    expect(workspace.reads()).toBe(paths.length);
    // ...and the leg was really entered, so the count is not a perfect zero
    // posted by a resolver that returned early.
    expect(workspace.reads()).toBeGreaterThan(0);
    expect(resolved[0]).toBe('pkg/m0.py');
    expect(resolved[resolved.length - 1]).toBe(`pkg/m${(imports - 1) % modules.length}.py`);
  });

  it('gives a distinct file set its own memo (no leak across passes)', () => {
    const a = new Set(WORKSPACE);
    const b = new Set(WORKSPACE);

    expectDistinctFileSetsGetOwnChainMemo(ancestorArm, a, b, 2);

    // The whole per-file-set index, not only the memo inside it: the WeakMap is
    // keyed on the Set, so two Sets can never share one index.
    expect(getPythonFileIndex(a)).not.toBe(getPythonFileIndex(b));
  });
});
