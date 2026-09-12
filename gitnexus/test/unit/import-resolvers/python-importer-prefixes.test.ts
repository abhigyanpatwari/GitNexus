/**
 * Gate for the single-segment bare-import ancestor walk in
 * `import-resolvers/python.ts`: Python bare-import resolution must not scale
 * with the importer's path depth.
 *
 * #2913 memoized the ancestor chains inside `languages/python/import-target.ts`
 * and left this one behind, because its chain is a DIFFERENT SEQUENCE (self
 * excluded, workspace root included, empty components kept) and no bench arm
 * can reach it — `bench/import-target/measure.mjs` spells every Python import
 * with a dot, and this walk runs only for a spelling with none. So it kept
 * rebuilding `dirParts.slice(0, i).join('/')` per path component per import,
 * and for `from x import y` / `import x as y` it did so TWICE per import:
 * `resolvePythonImportTarget` probes the package with
 * `targetIncludesImportedName` first and, when that misses, falls through to
 * the identical call. Measured on a 400-file corpus, 3200 named single-segment
 * imports: 24 `allFilePaths.has` probes per import at four directory
 * components, the second twelve byte-identical to the first.
 *
 * ## Why this is a count and not a timing budget
 *
 * `test/helpers/counting-file-set.ts` is the house instrument for import-target
 * reuse guards and it cannot see this defect, for the reason the #2913 gate
 * states: the chain is derived from the `fromFile` STRING, and a rebuilt prefix
 * traverses the file set zero extra times and issues the same `has` probes with
 * the same arguments in the same order. A hoist is invisible to any instrument
 * watching the resolver's inputs. So this file watches the memo, which is the
 * one place the hoist is observable.
 *
 * The gate: `prefixMemo(files).size` after N imports from D
 * importer directories must be D, for every N. That is "the prefix work is O(1)
 * amortized after the first import from a given directory", stated as a number.
 * It is paired with a reference-identity assertion, because a memo that stores
 * a FRESH array on every import posts the same size while doing all of the work
 * again, and with a non-vacuity assertion, because a perfect count is equally
 * true of a resolver that stopped resolving anything.
 *
 * Both production surfaces are driven, not the helper: `pythonScopeResolver
 * .resolveImportTarget` (the scope-resolution orchestrator's adapter, the one
 * that pays the walk twice) and `pythonImportStrategy` (the import-resolver
 * pipeline's, via `ImportTargetWorkspace`'s shared `ResolveCtx`). They thread
 * different objects around the same Set, and the memo is keyed on the Set.
 *
 * `legacyPrefixes` is a verbatim copy of the pre-change inline code, in the
 * house style of `python-importer-ancestors.test.ts`: it is the specification,
 * and the memo agreeing with it is what makes this a hoist rather than a
 * behaviour change.
 *
 * The four arms themselves live in `test/helpers/counting-file-set.ts`, beside
 * the other import-target scaffolding: this guard and the #2913 one are the
 * same suite over the same importer corpus once four values are named (the
 * memo, the drive, the legacy builder, the hit), and they were previously
 * written out twice. The two chains still DIFFER — this one keeps the empty
 * components an absolute path or a doubled separator produces, and #2913's
 * drops them — which is why `legacyChain` is per-guard and the shared path-shape
 * table names shapes rather than expectations.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedImport } from 'gitnexus-shared';
import type { ImportResolutionContext } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import { pythonScopeResolver } from '../../../src/core/ingestion/languages/python/scope-resolver.js';
import { resolvePythonImportInternal } from '../../../src/core/ingestion/import-resolvers/python.js';
import { getPythonFileIndex } from '../../../src/core/ingestion/import-resolvers/python-file-index.js';

/** The bare-import prefix memo, which lives inside the shared per-file-set index. */
const prefixMemo = (files: ReadonlySet<string>): ReadonlyMap<string, readonly string[]> =>
  getPythonFileIndex(files).bareImportPrefixesByDir;
import { pythonImportStrategy } from '../../../src/core/ingestion/import-resolvers/configs/python.js';
import { buildSuffixIndex } from '../../../src/core/ingestion/import-resolvers/utils.js';
import type {
  ImportResult,
  ResolveCtx,
} from '../../../src/core/ingestion/import-resolvers/types.js';
import {
  IMPORTER_PATH_SHAPES,
  NO_PARSED_FILES,
  expectDistinctFileSetsGetOwnChainMemo,
  expectMemoizedChainMatchesLegacy,
  expectOneChainPerImporterDir,
  expectSameChainObjectReused,
  pythonNamedImport,
  pythonNamespaceImport,
  type ChainMemoArm,
  type ChainMemoResult,
} from '../../helpers/counting-file-set.js';

const { resolveImportTarget } = pythonScopeResolver;

// ─── verbatim pre-change implementation ──────────────────────────────────────

/** The prefix sequence the inline walk materialized on every import. */
function legacyPrefixes(currentFile: string): string[] {
  const importerDir = currentFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const prefixes: string[] = [];
  const dirParts = importerDir.split('/');
  for (let i = dirParts.length - 1; i >= 0; i--) {
    const ancestorDir = dirParts.slice(0, i).join('/');
    prefixes.push(ancestorDir ? `${ancestorDir}/` : '');
  }
  return prefixes;
}

// ─── surfaces ────────────────────────────────────────────────────────────────

/**
 * A `ResolveCtx` for the import-resolver pipeline surface. `allFilePaths` is
 * the caller's Set passed THROUGH — the memo is keyed on its identity, so a
 * copy here would measure nothing.
 */
function makeResolveCtx(allFilePaths: Set<string>): ResolveCtx {
  const allFileList = [...allFilePaths];
  const normalizedFileList = allFileList.map((file) => file.replace(/\\/g, '/'));
  return {
    allFilePaths,
    allFileList,
    normalizedFileList,
    index: buildSuffixIndex(normalizedFileList, allFileList),
    resolveCache: new Map<string, string | null>(),
    configs: {
      tsconfigPaths: null,
      goModule: null,
      composerConfig: null,
      swiftPackageConfig: null,
      csharpConfigs: [],
    },
  };
}

const ctxFor = (parsedImport: ParsedImport): ImportResolutionContext => ({
  parsedFiles: NO_PARSED_FILES,
  parsedImport,
});

/**
 * An `ImportResult` as the arms read it: the resolved path, or `null` for a
 * miss. A stop-the-chain result carrying no files joins to `''`, which is
 * neither the hit nor a miss — the same distinction the pre-collapse arm drew
 * with `value?.kind === 'files' && value.files.join() === HIT_RESULT`.
 */
const resolvedPath = (result: ImportResult): ChainMemoResult =>
  result === null ? null : result.files.join();

// ─── the workspace the surfaces are driven against ───────────────────────────

/**
 * `shared.py` sits at the workspace root, which is the LAST step of the walk,
 * so every importer below reaches it only by running the chain to the end —
 * the most expensive path, and the one the memo has to keep correct.
 *
 * `elsewhere/deep/probe.py` makes `probe` a segment that SURVIVES
 * `pythonSegmentAbsent` (a file with that basename exists) while sitting in no
 * importer's ancestry, so the walk runs to completion and misses. That
 * combination is what a memo-filling miss looks like now: a segment the
 * workspace has never heard of is retired in two Map lookups and never reaches
 * the walk at all, which is the point of the early-out and the reason a
 * `ghost{i}` spelling can no longer drive this memo.
 */
const WORKSPACE: readonly string[] = [
  'svc/a/one.py',
  'svc/a/two.py',
  'svc/b/one.py',
  'svc/common.py',
  'deep/x/y/z/one.py',
  'elsewhere/deep/probe.py',
  'shared.py',
  'root.py',
];

const HIT_TARGET = 'shared';
const HIT_RESULT = 'shared.py';

/** Survives the absence proof, then walks the whole chain and misses — the
 *  dotted tier's suffix fallback picks it up as `elsewhere/deep/probe.py`. */
const WALK_TARGET = 'probe';
/** Provably absent: retired before the walk, so it never touches the memo. */
const ABSENT_TARGET = 'ghostmod';

/**
 * The spelling sequence BOTH surfaces are driven with, `perImporter` rounds of
 * it plus the one spelling that must resolve: one target that walks the whole
 * chain and misses, one that the absence proof retires before the walk, and one
 * that hits at the workspace root. No spelling is varied per round — the Python
 * chain keeps no per-target cache, so a repeated target really is re-resolved.
 *
 * `resolve` is the only thing that differs between the orchestrator adapter and
 * the import-resolver pipeline; everything about the sequence is shared, which
 * is why the two used to be the same loop written twice.
 */
function drive<T>(
  fromFile: string,
  perImporter: number,
  resolve: (targetRaw: string, fromFile: string) => T,
): T[] {
  const out: T[] = [];
  for (let i = 0; i < perImporter; i++) {
    for (const target of [WALK_TARGET, ABSENT_TARGET]) out.push(resolve(target, fromFile));
  }
  out.push(resolve(HIT_TARGET, fromFile));
  return out;
}

/** The ORCHESTRATOR ADAPTER — the surface that pays the walk twice. */
const adapterArm = (mkImport: (targetRaw: string) => ParsedImport): ChainMemoArm => ({
  memoOf: prefixMemo,
  drive: (files, fromFile, perImporter) =>
    drive(fromFile, perImporter, (target, from) =>
      resolveImportTarget(target, from, files, undefined, ctxFor(mkImport(target))),
    ),
  legacyChain: legacyPrefixes,
  hitResult: HIT_RESULT,
});

/**
 * The import-resolver pipeline surface. One `ResolveCtx` per drive rather than
 * one for the run, on purpose: everything the strategy reads off it is derived
 * from the same Set (and `pythonImportStrategy` only ever WRITES
 * `resolveCache`), so a fresh ctx around the same Set is exactly the "different
 * objects, same Set" case the memo has to survive.
 */
const strategyArm: ChainMemoArm = {
  memoOf: prefixMemo,
  drive: (files, fromFile, perImporter) => {
    const ctx = makeResolveCtx(files);
    return drive(fromFile, perImporter, (target, from) =>
      resolvedPath(pythonImportStrategy(target, from, ctx)),
    );
  },
  legacyChain: legacyPrefixes,
  hitResult: HIT_RESULT,
};

describe('Python bare-import prefix memo', () => {
  it.each([
    { perImporter: 1, kind: 'namespace', mkImport: pythonNamespaceImport },
    { perImporter: 40, kind: 'namespace', mkImport: pythonNamespaceImport },
    { perImporter: 1, kind: 'named', mkImport: pythonNamedImport },
    { perImporter: 40, kind: 'named', mkImport: pythonNamedImport },
  ])(
    'holds one chain per importer DIRECTORY, not per import — $perImporter x $kind',
    ({ perImporter, mkImport }) => {
      expectOneChainPerImporterDir(adapterArm(mkImport), new Set(WORKSPACE), perImporter);
    },
  );

  it.each([
    { perImporter: 1, label: 'one import per importer' },
    { perImporter: 40, label: 'forty imports per importer' },
  ])(
    'holds one chain per importer DIRECTORY on the import-resolver surface too — $label',
    ({ perImporter }) => {
      expectOneChainPerImporterDir(strategyArm, new Set(WORKSPACE), perImporter);
    },
  );

  it('reuses the SAME chain object, rather than rebuilding and re-storing it', () => {
    expectSameChainObjectReused(adapterArm(pythonNamedImport), new Set(WORKSPACE));
  });

  it.each(IMPORTER_PATH_SHAPES)(
    'memoizes the chain the pre-change code built — $why',
    ({ fromFile }) => {
      expectMemoizedChainMatchesLegacy(
        adapterArm(pythonNamespaceImport),
        new Set(WORKSPACE),
        fromFile,
      );
    },
  );

  it.each([
    { perImporter: 2, label: 'two imports per importer' },
    { perImporter: 20, label: 'twenty imports per importer' },
  ])(
    'gives a distinct file set its own memo (no leak across passes) — $label',
    ({ perImporter }) => {
      expectDistinctFileSetsGetOwnChainMemo(
        adapterArm(pythonNamedImport),
        new Set(WORKSPACE),
        new Set(WORKSPACE),
        perImporter,
      );
    },
  );

  /**
   * The memo is filled from the importers a pass actually resolves against, so
   * it is bounded by DIRECTORIES THAT IMPORT — never by the file count and
   * never by the repo's directory count, which is the bound #2649 asks for.
   */
  it.each([
    { dirs: 4, importsPerDir: 1 },
    { dirs: 4, importsPerDir: 50 },
    { dirs: 30, importsPerDir: 7 },
  ])(
    'is bounded by importing directories, not by files or imports — $dirs dirs x $importsPerDir',
    ({ dirs, importsPerDir }) => {
      const paths: string[] = [];
      for (let d = 0; d < dirs; d++) {
        for (let f = 0; f < 25; f++) paths.push(`pkg${d}/nest/file${f}.py`);
      }
      paths.push('shared.py');
      const files = new Set(paths);
      const resolved: ChainMemoResult[] = [];

      for (let d = 0; d < dirs; d++) {
        for (let i = 0; i < importsPerDir; i++) {
          resolved.push(
            resolveImportTarget(
              HIT_TARGET,
              `pkg${d}/nest/file0.py`,
              files,
              undefined,
              ctxFor(pythonNamedImport(HIT_TARGET)),
            ),
          );
        }
      }

      expect(prefixMemo(files).size).toBe(dirs);
      expect(resolved.filter((value) => value === HIT_RESULT)).toHaveLength(dirs * importsPerDir);
    },
  );
});

/**
 * Absolute expectations for the walk itself. `test/unit/suffix-index-ambiguity
 * .test.ts` covers the proximity tier and the suffix fallback around it; the
 * ANCESTOR tier — the thing issue #417 added and the thing this change touches
 * — had no absolute coverage at all, in particular none for the two path shapes
 * where its chain differs from `ancestorsByDir`'s: absolute paths and doubled
 * separators, both of which a `filter(Boolean)` would send to the wrong files.
 */
describe('Python bare-import ancestor walk — resolution', () => {
  it.each([
    {
      why: 'the importer own directory wins over every ancestor',
      files: ['app/svc/user.py', 'app/user.py', 'user.py', 'app/svc/auth.py'],
      fromFile: 'app/svc/auth.py',
      expected: 'app/svc/user.py',
    },
    {
      why: 'a same-directory package beats a same-directory module (PEP 451 §4)',
      files: ['app/svc/user/__init__.py', 'app/svc/user.py', 'app/svc/auth.py'],
      fromFile: 'app/svc/auth.py',
      expected: 'app/svc/user/__init__.py',
    },
    {
      why: 'the CLOSEST ancestor wins (#417)',
      files: ['app/user.py', 'user.py', 'app/svc/auth.py'],
      fromFile: 'app/svc/auth.py',
      expected: 'app/user.py',
    },
    {
      why: 'a package beats a module at the same ancestor step',
      files: ['app/user/__init__.py', 'app/user.py', 'app/svc/auth.py'],
      fromFile: 'app/svc/auth.py',
      expected: 'app/user/__init__.py',
    },
    {
      why: 'the workspace root is the last step of the walk',
      files: ['user.py', 'app/svc/auth.py'],
      fromFile: 'app/svc/auth.py',
      expected: 'user.py',
    },
    {
      why: 'a root-level importer walks the root and nothing else',
      files: ['user.py', 'auth.py'],
      fromFile: 'auth.py',
      expected: 'user.py',
    },
    {
      why: 'an absolute workspace keeps the leading empty component',
      files: ['/repo/app/user.py', '/repo/app/svc/auth.py'],
      fromFile: '/repo/app/svc/auth.py',
      expected: '/repo/app/user.py',
    },
    {
      why: 'a doubled separator keeps the empty component',
      files: ['a//user.py', 'a//b/auth.py'],
      fromFile: 'a//b/auth.py',
      expected: 'a//user.py',
    },
    {
      why: 'Windows separators in the importer normalize before the walk',
      files: ['app/user.py', 'app/svc/auth.py'],
      fromFile: 'app\\svc\\auth.py',
      expected: 'app/user.py',
    },
  ])('$why', ({ files, fromFile, expected }) => {
    const set = new Set(files);
    // The helper, the scope-resolution adapter and the import-resolver
    // strategy must agree: all three reach the same walk.
    expect(resolvePythonImportInternal(fromFile, 'user', set)).toBe(expected);
    expect(
      resolveImportTarget('user', fromFile, set, undefined, ctxFor(pythonNamespaceImport('user'))),
    ).toBe(expected);
    expect(pythonImportStrategy('user', fromFile, makeResolveCtx(set))).toEqual({
      kind: 'files',
      files: [expected],
    });
  });

  it.each([
    {
      why: 'a module outside the importer ancestry is not an ancestor hit (#417)',
      files: ['other/branch/user.py', 'app/svc/auth.py'],
      fromFile: 'app/svc/auth.py',
    },
    {
      why: 'a namespace package (no __init__.py) has no file to resolve to',
      files: ['app/user/model.py', 'app/svc/auth.py'],
      fromFile: 'app/svc/auth.py',
    },
    {
      why: 'a sibling directory of the importer is not an ancestor',
      files: ['app/other/user.py', 'app/svc/auth.py'],
      fromFile: 'app/svc/auth.py',
    },
    {
      why: 'an absolute workspace does not answer a de-rooted prefix',
      files: ['repo/app/user.py', '/repo/app/svc/auth.py'],
      fromFile: '/repo/app/svc/auth.py',
    },
  ])('returns null and lets the caller fall through — $why', ({ files, fromFile }) => {
    expect(resolvePythonImportInternal(fromFile, 'user', new Set(files))).toBeNull();
  });
});
