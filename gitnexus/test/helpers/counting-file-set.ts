/**
 * A `Set<string>` that counts how many times it is TRAVERSED in full — the one
 * measuring instrument behind every import-target index-reuse guard
 * (`test/unit/scope-resolution/import-target-index-parity.test.ts`,
 * `test/unit/scope-resolution/import-target-index-reuse.contract.test.ts`, and
 * the per-language `test/integration/<lang>-import-index-reuse.test.ts` files).
 *
 * ## Why a counting Set rather than a production build counter
 *
 * Kotlin and Python used to count index BUILDS, through a counter module that
 * shipped in production for no reason but this observation (deleted in #2909).
 * A build count catches the per-import rebuild, but it is blind to a scan added
 * BESIDE a reused index: the cache still hits, the count still reads 1. Counting
 * traversals of the file set instead needs no production surface at all and
 * catches both failures with one number:
 *
 *   - an adapter that copies the set (`new Set(allFilePaths)`) hands a fresh
 *     `WeakMap` key per import, so the count rises to the import count;
 *   - a scan reintroduced next to the index raises the count by one per scan.
 *
 * The second is the case the benchmark provably cannot see: a full workspace
 * scan on 1-in-32 imports passes every timing arm in `bench/import-target/`
 * (measured, see `baselines.json` `_blind_spot`) while this counter reads 14
 * instead of 1.
 *
 * ## Why every traversal entry point is overridden
 *
 * `for…of`, spread and `new Set(x)` go through `[Symbol.iterator]`, but
 * `forEach`, `values`, `keys` and `entries` walk the same elements without
 * touching it. Overriding only `[Symbol.iterator]` would let a reintroduced
 * scan spelled `allFilePaths.forEach(…)` or `[...allFilePaths.values()]` sit
 * under the guard uncounted. `Set.prototype[Symbol.iterator]` and
 * `Set.prototype.values` are the same function object in the spec, but the
 * `super.*` lookups below resolve on `Set.prototype`, not on this subclass, so
 * a single traversal is still counted exactly once.
 *
 * ## What it does NOT see
 *
 * Only traversals of the SET. Once an index has materialized the file list into
 * an array (`WorkspaceFileIndex.normalized` / `.all`, Dart's basename buckets,
 * `PackageDirIndex.filesByDir`), a scan over that array is invisible here.
 * Guarding that would mean either instrumenting production or proxying an index
 * internal; see the header of the parity test for why neither is in place.
 *
 * It is equally blind to the OTHER per-file-set key the orchestrator threads —
 * `ImportResolutionContext.parsedFiles`, the fifth argument of
 * `resolveImportTarget`. PHP's `filesByDirectory` memo (`languages/php/
 * import-target.ts`) is keyed on that array, not on this Set, so defeating it
 * rebuilds a `Map<dirAlias, ParsedFile[]>` per import at O(files × depth)
 * without moving this counter by one. `countedParsedFiles` below is the
 * instrument for that channel.
 *
 * `instanceof Set` still holds, which matters: C#'s `narrowContext` rejects a
 * workspace context whose `allFilePaths` is not a `Set`, so a plain object with
 * a counter would silently resolve nothing and every assertion would pass on
 * `null === null`.
 *
 * `expectDistinctFileSetsGetOwnIndex` below is the one arm of those guards that
 * is identical in every language once the four values that differ are named, so
 * it lives here beside the instrument it reads rather than in each guard. The
 * `ChainMemoArm` section at the bottom applies the same rule to the guards that
 * watch a MEMO instead of a scan count — the two Python importer-chain guards,
 * which this instrument provably cannot see (their headers say why) and which
 * were arm-for-arm the same suite written twice.
 */
import { expect } from 'vitest';
import type { ParsedFile, ParsedImport } from 'gitnexus-shared';
import type { ScopeResolver } from '../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';

export class CountingSet extends Set<string> {
  /** Full traversals of this set, by any entry point. */
  scans = 0;

  override [Symbol.iterator](): SetIterator<string> {
    this.scans++;
    return super[Symbol.iterator]();
  }

  override values(): SetIterator<string> {
    this.scans++;
    return super.values();
  }

  override keys(): SetIterator<string> {
    this.scans++;
    return super.keys();
  }

  override entries(): SetIterator<[string, string]> {
    this.scans++;
    return super.entries();
  }

  override forEach(
    callbackfn: (value: string, value2: string, set: Set<string>) => void,
    thisArg?: unknown,
  ): void {
    this.scans++;
    super.forEach(callbackfn, thisArg);
  }
}

/**
 * The `CountingSet` of the OTHER per-file-set key: the `parsedFiles` array the
 * orchestrator passes as `resolveImportTarget`'s fifth argument
 * (`scope-resolution/pipeline/run.ts`). PHP memoizes `filesByDirectory` on that
 * array's identity and Python reads it in `pythonFileExportsName`, and neither
 * touches the path Set while doing so — so without this the whole `context`
 * channel is unmeasured.
 *
 * ## Element reads, not traversal entry points
 *
 * `CountingSet` can override the five ways a `Set` is walked and be done. An
 * array has no such closed list: `for…of`, `forEach`, `map`, `filter`,
 * `flatMap`, `reduce`, `find`, `some`, `every`, `indexOf` and a bare
 * `for (let i = 0; i < a.length; i++)` all walk the same elements, and the last
 * one goes through no method at all. Overriding a chosen subset would build in
 * exactly the blind spot this instrument exists to remove — PHP's builder is a
 * `for…of` today and one refactor away from an index loop.
 *
 * So the trap is on the read of an own indexed element. Every route above goes
 * through it, including the index loop, and nothing else does: `length`,
 * method lookups and `Symbol.iterator` are not counted. A full pass over N
 * files therefore reads exactly N, and the number is a function of the file
 * count and the number of passes — never of wall time.
 *
 * ## It counts THIS array only
 *
 * Reads of arrays DERIVED from it — the `ParsedFile[]` buckets inside PHP's
 * directory index, the `candidateFiles` list filtered per import — are
 * invisible, and deliberately so. That per-import work is bounded by the
 * candidate set rather than by the workspace, so counting it would make the
 * count grow with the import count for correct code and there would be no
 * property left to assert.
 *
 * The `ParsedFile`s are minimal on purpose: `filePath` is the only field either
 * consumer reads to build its index, and empty `localDefs` keeps both languages
 * on their fallback answer, so the fixture measures the index and changes no
 * resolution result. A test that needs the declaration legs to FIRE wants
 * `php-import-target-parity.test.ts`, which carries defs.
 */
export interface CountedFileList {
  /** Pass as `ImportResolutionContext.parsedFiles`. Stable identity, so it is
   *  a usable `perFileSet` key for the whole run. */
  readonly parsedFiles: readonly ParsedFile[];
  /** Reads of an own indexed element of `parsedFiles`, by any route. */
  readonly reads: () => number;
}

/** Own array indices — `'0'`, `'12'`; not `'length'`, `'-1'` or `'01'`. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * A counted `parsedFiles` workspace for `filePaths`, one minimal `ParsedFile`
 * each, in order. Build a FRESH one per run: the indexes are memoized on the
 * array's identity, so two runs sharing one would have the second read the
 * first's index and report zero.
 */
export function countedParsedFiles(filePaths: readonly string[]): CountedFileList {
  const backing: ParsedFile[] = filePaths.map((filePath) => ({
    filePath,
    moduleScope: `module:${filePath}`,
    scopes: [],
    parsedImports: [],
    localDefs: [],
    referenceSites: [],
  }));
  let reads = 0;
  const counting = new Proxy(backing, {
    get(target, key, receiver): unknown {
      reads += typeof key === 'string' && ARRAY_INDEX.test(key) ? 1 : 0;
      return Reflect.get(target, key, receiver);
    },
  });
  return { parsedFiles: counting, reads: () => reads };
}

/**
 * Everything that differs between the per-language spellings of the
 * distinct-file-set arm. Nothing else about that arm varies, which is why it is
 * a parameter list rather than four copies.
 */
export interface DistinctFileSetArm {
  /**
   * The orchestrator adapter under test — `<lang>ScopeResolver
   * .resolveImportTarget`, NOT the language's `resolve<Lang>ImportTarget`. The
   * adapter is the surface the unit parity test cannot reach, and the surface a
   * defensive `new Set(allFilePaths)` copy would break.
   */
  readonly resolveImportTarget: ScopeResolver['resolveImportTarget'];
  /**
   * Builds one workspace. Called twice, and must return a FRESH `CountingSet`
   * each time: the two sets being distinct objects is the whole subject of the
   * arm, since the indexes are memoized on Set identity via a `WeakMap`.
   */
  readonly buildWorkspace: () => CountingSet;
  /** The import spelling to resolve, as it would appear in source. */
  readonly targetRaw: string;
  /** The importing file the target is resolved against. */
  readonly fromFile: string;
  /**
   * The resolver's `resolutionConfig` argument (Go's `{ modulePath }`). Not
   * optional: the languages that take none pass `undefined` in the open, so a
   * call site never hides which adapters read this channel behind an omission.
   */
  readonly resolutionConfig: unknown;
  /**
   * What `targetRaw` must resolve to — a path for the string-returning
   * resolvers, a path list for Go. Never `null`: the pairing rule below exists
   * precisely because an adapter that has stopped resolving anything returns
   * `null` and still posts a perfect scan count, so a `null` expectation would
   * reinstate the hole it closes.
   */
  readonly expected: string | readonly string[];
  /** Traversals of ONE file set that full reuse permits: one per index built. */
  readonly expectedScans: number;
}

/** Resolutions driven against each file set before the counts are read. */
const DISTINCT_FILE_SET_REPEATS = 20;

/**
 * Assert that two independently built file sets each get their own index, built
 * once — no stale reuse of one set's index for the other, and no rebuild per
 * import within either.
 *
 * The repeats are driven bare, following the equivalent arm in
 * `test/unit/scope-resolution/import-target-index-parity.test.ts`: asserting
 * inside the loop restates one bit of information forty times. The two asserted
 * resolutions afterwards are the pairing rule the guards' headers state — a
 * scan count must never be the count of an adapter that resolves nothing.
 */
export function expectDistinctFileSetsGetOwnIndex(arm: DistinctFileSetArm): void {
  const a = arm.buildWorkspace();
  const b = arm.buildWorkspace();

  for (let i = 0; i < DISTINCT_FILE_SET_REPEATS; i++) {
    arm.resolveImportTarget(arm.targetRaw, arm.fromFile, a, arm.resolutionConfig);
    arm.resolveImportTarget(arm.targetRaw, arm.fromFile, b, arm.resolutionConfig);
  }

  expect(arm.resolveImportTarget(arm.targetRaw, arm.fromFile, a, arm.resolutionConfig)).toEqual(
    arm.expected,
  );
  expect(arm.resolveImportTarget(arm.targetRaw, arm.fromFile, b, arm.resolutionConfig)).toEqual(
    arm.expected,
  );

  expect(a.scans).toBe(arm.expectedScans);
  expect(b.scans).toBe(arm.expectedScans);
}

// ─── Python import shapes ────────────────────────────────────────────────────

/**
 * `from <targetRaw> import Widget`. The shape that makes
 * `resolvePythonImportTarget` run the package-attribute probe
 * (`pythonFileExportsName`, the `context.parsedFiles` reader) ahead of the
 * submodule fallback — so it is the shape that re-enters the resolver and pays
 * the importer's chain TWICE, and the shape `pythonImportedSubmoduleTarget`
 * fires for.
 *
 * The default the adapter synthesizes when `context` is absent is a `namespace`
 * import, and that shape never reaches the probe. A guard that means to measure
 * either leg therefore has to pass this one explicitly.
 */
export const pythonNamedImport = (targetRaw: string): ParsedImport => ({
  kind: 'named',
  localName: 'Widget',
  importedName: 'Widget',
  targetRaw,
});

/** `import <targetRaw>` — the single-walk shape, and the adapter's default. */
export const pythonNamespaceImport = (targetRaw: string): ParsedImport => ({
  kind: 'namespace',
  localName: '_',
  importedName: '_',
  targetRaw,
});

/**
 * ONE array per file that uses it, never a fresh `[]` per call:
 * `parsedFileByPath` memoizes on its identity, and a new array per import would
 * mint a `WeakMap` key per import for a channel these guards are not measuring
 * (`countedParsedFiles` above is the instrument for that one). Empty, so
 * `pythonFileExportsName` answers false and the package-vs-submodule precedence
 * never fires — the walk, not the precedence, is what the numbers measure.
 */
export const NO_PARSED_FILES: readonly ParsedFile[] = [];

// ─── the Python importer-chain memo guards ───────────────────────────────────

/**
 * What one resolution answered, as the chain-memo arms read it: a path, a path
 * list (the `ScopeResolver` signature allows one), or `null`. The two values
 * the non-vacuity pairing rule counts are `arm.hitResult` and `null`.
 */
export type ChainMemoResult = string | readonly string[] | null;

/**
 * Everything that differs between the two Python importer-chain memo guards:
 * `test/unit/import-resolvers/python-importer-prefixes.test.ts`
 * (`bareImportPrefixesByDir`) and
 * `test/unit/scope-resolution/python/python-importer-ancestors.test.ts`
 * (`ancestorsByDir`).
 *
 * The two memos hold DIFFERENT SEQUENCES under the same key — self included or
 * not, workspace root included or not, empty components kept or dropped; see
 * `importerBarePrefixes`'s header for why neither guard can be deleted in
 * favour of the other. But each guard is the same four arms over the same
 * importer corpus once these four values are named, so the arms live here and
 * each guard supplies its own four.
 */
export interface ChainMemoArm {
  /** The memo under test, read off the pass's per-file-set index. */
  readonly memoOf: (files: ReadonlySet<string>) => ReadonlyMap<string, readonly string[]>;
  /**
   * Drives a production surface `perImporter` times from `fromFile`, with
   * spellings that reach the memo, and answers what each call resolved to.
   * Exactly one call per invocation must answer `arm.hitResult`, and at least
   * one must answer `null`. Must pass `files` THROUGH: both memos are keyed on
   * its identity, so a copy here would measure nothing.
   */
  readonly drive: (
    files: Set<string>,
    fromFile: string,
    perImporter: number,
  ) => readonly ChainMemoResult[];
  /**
   * The verbatim pre-change chain builder, which is the specification: the memo
   * agreeing with it is what makes the change a hoist rather than a behaviour
   * change.
   */
  readonly legacyChain: (fromFile: string) => readonly string[];
  /** What the one must-resolve spelling in `drive` answers, once per importer. */
  readonly hitResult: string;
}

/** Every file that issues an import in the chain-memo arms. */
export const CHAIN_MEMO_IMPORTERS: readonly string[] = [
  'svc/a/one.py',
  'svc/a/two.py',
  'svc/b/one.py',
  'deep/x/y/z/one.py',
  'root.py',
];

/** Four directories for those five importers — `svc/a` holds two of them. */
export const CHAIN_MEMO_IMPORTER_DIRS: readonly string[] = ['svc/a', 'svc/b', 'deep/x/y/z', ''];

/** The directory two importers share, which is where identity is measured. */
const SHARED_DIR = 'svc/a';
const SHARED_DIR_IMPORTERS: readonly string[] = ['svc/a/one.py', 'svc/a/two.py'];

/** Imports one directory issues before its chain's identity is re-read. */
const CHAIN_IDENTITY_REPEATS = 40;

/** A sorted copy, so a key set is compared without depending on fill order. */
export const sortedStrings = (values: Iterable<string>): string[] => [...values].sort();

/**
 * The importer directory both memos are keyed on, derived exactly as the
 * pre-change inline code derived it — `''` for a path with no separator.
 */
const importerDirOf = (fromFile: string): string =>
  fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');

/**
 * The path-shape space an importer chain has to be correct over, as ONE table
 * both guards run: they enumerate the same space and nothing kept the two
 * copies in lockstep.
 *
 * Each `why` names the SHAPE, not what either chain does with it, because the
 * two chains do different things with several of these rows — the bare-prefix
 * chain KEEPS the empty component an absolute path or a doubled separator
 * produces and the ancestor chain drops it, and that difference decides real
 * resolutions. Which is why every arm below compares against the guard's own
 * `legacyChain` rather than against a shared expectation.
 */
export const IMPORTER_PATH_SHAPES: readonly { readonly fromFile: string; readonly why: string }[] =
  [
    { fromFile: 'svc/a/one.py', why: 'a two-component directory' },
    { fromFile: 'deep/x/y/z/one.py', why: 'a four-component directory' },
    { fromFile: 'root.py', why: 'a workspace-root importer' },
    { fromFile: '/abs/svc/a/one.py', why: 'an absolute path (leading empty component)' },
    { fromFile: 'svc//a/one.py', why: 'a doubled separator (empty component)' },
    { fromFile: 'svc\\a\\one.py', why: 'Windows separators' },
    { fromFile: 'trailing/', why: 'a path ending in a separator' },
  ];

/**
 * The gate: N imports from five importers over four directories leave FOUR
 * entries, for every N. That is "the chain work is O(1) amortized after the
 * first import from a given directory", stated as a number. A chain rebuilt per
 * import cannot be memoized at all (size 0); a chain keyed on the importing
 * FILE reads five.
 *
 * Paired with the non-vacuity assertions every guard in this family states: a
 * perfect memo count is equally true of an adapter that resolves nothing.
 */
export function expectOneChainPerImporterDir(
  arm: ChainMemoArm,
  files: Set<string>,
  perImporter: number,
): void {
  const resolved: ChainMemoResult[] = [];
  for (const fromFile of CHAIN_MEMO_IMPORTERS) {
    resolved.push(...arm.drive(files, fromFile, perImporter));
  }

  expect(arm.memoOf(files).size).toBe(CHAIN_MEMO_IMPORTER_DIRS.length);
  expect(sortedStrings(arm.memoOf(files).keys())).toEqual(sortedStrings(CHAIN_MEMO_IMPORTER_DIRS));

  expect(resolved.filter((value) => value === arm.hitResult)).toHaveLength(
    CHAIN_MEMO_IMPORTERS.length,
  );
  expect(resolved.filter((value) => value === null).length).toBeGreaterThan(0);
}

/**
 * The stored-object arm: a memo that stores a FRESH chain on every import posts
 * a perfect size while doing all of the work again, so the size gate above is
 * paired with reference identity across many later imports from the same
 * directory — issued from BOTH files in it, so a chain keyed on the importing
 * file would be replaced rather than reused.
 *
 * Contents are asserted FIRST: `toBe` against an absent entry would pass on
 * `undefined === undefined` if the memo were deleted outright.
 */
export function expectSameChainObjectReused(arm: ChainMemoArm, files: Set<string>): void {
  const [firstImporter] = SHARED_DIR_IMPORTERS;
  arm.drive(files, firstImporter, 1);
  const first = arm.memoOf(files).get(SHARED_DIR);
  expect(first).toEqual(arm.legacyChain(firstImporter));

  for (const fromFile of SHARED_DIR_IMPORTERS) {
    arm.drive(files, fromFile, CHAIN_IDENTITY_REPEATS);
  }

  expect(arm.memoOf(files).get(SHARED_DIR)).toBe(first);
}

/**
 * The legacy-equality arm for one path shape: what the memo stored under
 * `fromFile`'s directory is what the pre-change inline code built for it.
 *
 * Returns the memoized chain, so a guard whose memo feeds a SECOND consumer can
 * go on to assert that consumer's derived form of it.
 */
export function expectMemoizedChainMatchesLegacy(
  arm: ChainMemoArm,
  files: Set<string>,
  fromFile: string,
): readonly string[] {
  arm.drive(files, fromFile, 1);

  const chain = arm.memoOf(files).get(importerDirOf(fromFile));
  expect(chain).toEqual(arm.legacyChain(fromFile));
  return chain ?? [];
}

/**
 * The distinct-file-set arm: two independently built file sets each get their
 * own memo — equal in content, never the same object, neither leaking into the
 * other. The two are driven interleaved, so a memo keyed on anything but the
 * Set's identity shows up here as a SHARED entry rather than as a stale one.
 */
export function expectDistinctFileSetsGetOwnChainMemo(
  arm: ChainMemoArm,
  a: Set<string>,
  b: Set<string>,
  perImporter: number,
): void {
  for (const fromFile of CHAIN_MEMO_IMPORTERS) {
    arm.drive(a, fromFile, perImporter);
    arm.drive(b, fromFile, perImporter);
  }

  const memoA = arm.memoOf(a);
  const memoB = arm.memoOf(b);

  expect(memoA).not.toBe(memoB);
  expect(memoA.get(SHARED_DIR)).not.toBe(memoB.get(SHARED_DIR));
  expect(memoA.get(SHARED_DIR)).toEqual(memoB.get(SHARED_DIR));
  expect(memoA.size).toBe(CHAIN_MEMO_IMPORTER_DIRS.length);
  expect(memoB.size).toBe(CHAIN_MEMO_IMPORTER_DIRS.length);
}
