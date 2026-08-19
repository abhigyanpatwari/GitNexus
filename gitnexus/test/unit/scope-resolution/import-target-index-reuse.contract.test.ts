/**
 * One property, asserted for EVERY registered `ScopeResolver` (#2909).
 *
 * Import-target resolution must not re-derive its per-pass workspace structures
 * once per import. The per-language guards matching
 * `test/integration/*-import-index-reuse.test.ts` say that once each, with their
 * own corpus, their own expected traversal count and their own header — and
 * there is one only for the languages someone wrote one for, never for the rest,
 * because adding a resolver to `SCOPE_RESOLVERS` is two lines
 * (`pipeline/registry.ts`), neither of which is a test. This file closes that
 * gap without restating its size: the table below is keyed by
 * `SupportedLanguages`, and the inventory arm diffs its keys against
 * `SCOPE_RESOLVERS` so a registered resolver missing from it fails.
 *
 * ## Called the way the ORCHESTRATOR calls, with all five arguments
 *
 * `pipeline/run.ts` passes five: `(targetRaw, fromFile, allFilePaths,
 * resolutionConfig, { parsedFiles, parsedImport })`. This file used to pass
 * four, and a fifth argument that is never supplied is a channel that is never
 * measured — `languages/php/import-target.ts` returns early on `context ===
 * undefined`, so everything behind that guard was ungated for every language in
 * the table. Replacing PHP's `perFileSet` with an identity wrapper, which
 * rebuilds its `Map<dirAlias, ParsedFile[]>` per import at O(files × depth)
 * (197.0 µs → 9976.2 µs per import at 8000 files, depth 6), left every arm of
 * this file green. Both call sites below now pass a `context`, and the fixtures
 * name their `parsedImport` explicitly so no adapter's use of the channel can
 * hide behind an omission.
 *
 * ## Two counters, because there are two per-file-set KEYS
 *
 * `perFileSet` memoizes on object identity, and the orchestrator threads two
 * stable objects per pass: the `allFilePaths` Set and the `parsedFiles` array.
 * A `CountingSet` sees only the first, and the readers of the second touch the
 * Set nowhere while reading it, so `scans` moves by ZERO for anything that goes
 * wrong on that key — measured, with the identity-wrapper mutation above:
 * `scans` 1 and 1, `parsedFileReads` 9 and 603. Hence `countedParsedFiles`
 * (`test/helpers/counting-file-set.ts`), and hence the same comparison asserted
 * twice, once per key.
 *
 * Four registered resolvers read `context` — PHP and Python for declaration
 * filtering, and Java and Kotlin for declared-package indexes. Every other
 * adapter declares three or four parameters and cannot observe a fifth. Which
 * ones those are is not a number to maintain here: the per-language
 * `minimumParsedFileReads` floor in the table IS the record, and it is what a
 * new reader has to change. Every language that reads this key memoizes on it,
 * and the memos fail differently:
 *
 *   - PHP: the `filesByDirectory` memo, `perFileSet`-keyed on the `parsedFiles`
 *     array. Defeat it and every import rebuilds a `Map<dirAlias,
 *     ParsedFile[]>`; the arm reads 603 against 9 (proven by mutation).
 *   - Python: `parsedFileByPath`, keyed the same way, behind
 *     `pythonFileExportsName`. It is built by the FIRST import whose package
 *     probe resolves — one pass over the array — and every later one is a
 *     `Map.get`, so the floor of 1 is that single build and the equality half
 *     is what proves it does not repeat. Before that memo the same call was a
 *     `parsedFiles.find` per resolving import, which is the shape #2901
 *     removed on the file-set key; this arm is why it cannot come back.
 *   - Java and Kotlin: declared-package/module-binding indexes, each built once
 *     from the stable `parsedFiles` identity and reused across all imports.
 *   - Every other language: `0 === 0`, recorded as a floor of 0. A new reader
 *     arrives with that floor already in place and is caught by the equality
 *     half, which needs no per-language knowledge at all.
 *
 * The shared benchmark now exercises the same five-argument production call;
 * this deterministic counter remains the stronger memo-reuse assertion.
 *
 * ## The assertion is a COMPARISON, not a constant
 *
 * `scans(200) === scans(2)`, never `scans === 1`. Per-language counts legitimately
 * differ — C# and Java each build two indexes over the same Set, TypeScript /
 * JavaScript / Vue materialize an array and a copy behind their pass cache, Rust
 * never traverses at all — and a table of expected constants would be one entry
 * per language to get wrong. Comparing two counts against each other
 * needs no per-language knowledge and states the actual property: the traversal
 * count is a function of the FILE SET, not of the import count.
 *
 * ## Paired with non-vacuity, because the comparison alone is trivially true
 *
 * `scans(200) === scans(2)` holds perfectly for a resolver that returns `null`
 * without ever touching the set — which is exactly what an adapter looks like
 * after its context narrowing starts rejecting the workspace (`instanceof Set`
 * for C# and Java, the `has`/iterator duck-type for Swift). So each case also
 * asserts:
 *
 *   - `hitTarget` still resolves to something. This is the same pairing rule the
 *     `test/integration/*-import-index-reuse.test.ts` guards state in their
 *     headers, and the reason `CountingSet` is a real `Set` subclass rather than
 *     a counter object.
 *   - the count clears `minimumScans`, which proves the counting Set is the
 *     object the resolver actually indexed rather than a copy made upstream.
 *
 * ## What it does NOT cover
 *
 * The fixtures are minimal by design — a handful of files and two import
 * spellings per language, enough to reach the index and no more. Output parity,
 * tie-breaks and iteration order are the subject of
 * `import-target-index-parity.test.ts` and the per-language parity tests; the
 * per-language integration guards carry the realistic corpora and the exact
 * expected traversal counts. This file only answers "does the work stay flat in
 * the number of imports", for every resolver `SCOPE_RESOLVERS` registers.
 *
 * Neither counter sees inside a structure once it has been built: a scan over
 * `WorkspaceFileIndex.normalized`, or over a `ParsedFile[]` bucket in PHP's
 * directory index, moves nothing (see `test/helpers/counting-file-set.ts`).
 * That is not hypothetical — JavaScript's adapter had no suffix
 * index at all until #2910, so every JavaScript import ran `suffixResolve`'s
 * linear pass over the materialized `normalizedFileList` (6448.9 µs per import
 * at 2000 files, against 25.0 µs for TypeScript), and the `javascript` case
 * below scored a clean pass throughout: the pass cache WAS reused, so the
 * traversal count read 2 either way. What catches that class of defect is a
 * behaviour or call-count assertion, not a traversal count — see
 * `test/integration/javascript-import-index-reuse.test.ts` and
 * `test/unit/scope-resolution/javascript-import-target-parity.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import type { ParsedFile, ParsedImport, ScopeId, SymbolDefinition } from 'gitnexus-shared';

import { SCOPE_RESOLVERS } from '../../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import type { ScopeResolver } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import {
  clearJavaPackageFacts,
  setJavaPackageFact,
} from '../../../src/core/ingestion/languages/java/package-facts.js';
import {
  clearKotlinPackageFacts,
  setKotlinPackageFact,
} from '../../../src/core/ingestion/languages/kotlin/package-facts.js';
import type { ComposerConfig } from '../../../src/core/ingestion/language-config.js';
import {
  CountingSet,
  countedParsedFiles,
  countedParsedFilesWith,
  pythonNamedImport,
} from '../../helpers/counting-file-set.js';

/**
 * The minimum a language needs for one `resolveImportTarget` call to reach
 * whatever structure it derives from the file set.
 */
interface ImportTargetFixture {
  /**
   * The whole synthetic workspace. Small on purpose: the count being compared
   * is traversals, not their cost.
   *
   * Also the source of `context.parsedFiles` — one minimal `ParsedFile` per
   * path, built by `countedParsedFiles`. NOT a second fixture field, because
   * the orchestrator derives the path Set FROM the parsed workspace
   * (`new Set(parsedFiles.map((f) => f.filePath))` in `pipeline/run.ts`), so two
   * independent lists here could disagree in a way no real pass can.
   */
  readonly files: readonly string[];
  /** The importing file. */
  readonly fromFile: string;
  /**
   * The resolver's 4th argument. Not optional: the languages that take none
   * pass `undefined` in the open, so no call site hides which adapters read
   * this channel behind an omission.
   */
  readonly resolutionConfig: unknown;
  /**
   * An import that resolves to NOTHING, spelled differently on every call.
   *
   * A miss is the expensive case in every resolver here — it runs the cascade to
   * completion instead of returning on the first hit — and the distinct spelling
   * defeats the per-target `resolveCache` that TypeScript, JavaScript and Vue
   * keep, so the resolution path is really re-entered per import rather than
   * answered from a memo.
   */
  readonly missTarget: (i: number) => string;
  /** An import that MUST resolve. The non-vacuity half of the assertion. */
  readonly hitTarget: string;
  /**
   * The `parsedImport` half of the resolver's 5th argument, for the spelling
   * being resolved. A function of the spelling, not a constant: PHP reaches its
   * `parsedFiles` leg only for `kind: 'named' | 'alias'` carrying an
   * `importedSymbolKind` of `function` or `const`, and Python resolves
   * `parsedImport.targetRaw` in preference to the `targetRaw` argument — so one
   * fixed import would resolve a single spelling 201 times and be answered from
   * the per-target memo that the distinct `missTarget` spellings exist to
   * defeat.
   *
   * `undefined` wherever the adapter ignores `context`; that is a statement
   * about the resolver, made in the open, for the same reason
   * `resolutionConfig` is never omitted.
   */
  readonly parsedImport: (targetRaw: string) => ParsedImport | undefined;
  /**
   * Traversals of one file set that the property permits, as a floor.
   *
   * One for every language that derives an index from the set. ZERO for Rust,
   * which is not an exemption: `resolveRustImportTarget` answers every leg with
   * `allFilePaths.has(candidate)` membership probes and never iterates, so there
   * is no traversal to hoist and nothing for the counter to see. (Rust's one
   * workspace index, `buildRustModuleIndex`, is memoized in
   * `qualified-call.ts::moduleIndexFor` and hangs off `resolveQualifiedFreeCall`
   * — a different hook, not this one.)
   */
  readonly minimumScans: number;
  /**
   * Element reads of one `context.parsedFiles` array that the property permits,
   * as a floor — the `minimumScans` of the second key.
   *
   * ZERO wherever the adapter never reads `context`, and that zero is a fact
   * about the adapter rather than an exemption: the equality half still holds,
   * so a resolver that starts reading `parsedFiles` per import fails here with a
   * floor of 0 in place. ONE for PHP, Java, Kotlin and Python, which proves the leg
   * behind `context` was entered at all — an early `return` on
   * `context === undefined` posts a perfect zero otherwise, which is precisely
   * how every arm of this file passed while measuring nothing on that channel.
   */
  readonly minimumParsedFileReads: number;
  /**
   * Seed whatever per-language fact store the resolver reads alongside
   * `parsedFiles`. Java resolves an import against DECLARED packages (#2953),
   * so without this its `hitTarget` resolves to nothing and every count below
   * would be the count of a resolver doing nothing.
   */
  readonly declare?: () => void;
  /** Optional semantic ParsedFile fixture for declaration-driven resolvers. */
  readonly parsedFile?: (filePath: string) => ParsedFile;
}

/** The `composer.json` PSR-4 map `loadPhpComposerConfig` would have produced. */
const PHP_COMPOSER: ComposerConfig = { psr4: new Map([['App', 'app']]) };

/** The value `loadGoModulePath` produces for a repo with a `go.mod`. */
const GO_MODULE = { modulePath: 'example.com/mod' };

/**
 * The `parsedImport` of an adapter that takes three or four parameters and so
 * cannot observe one. Named rather than inlined so a reader scanning the table
 * sees at a glance which languages differ.
 */
const IGNORES_CONTEXT = (): undefined => undefined;

function kotlinParsedFile(filePath: string): ParsedFile {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1, filePath.lastIndexOf('.'));
  const moduleScope = `module:${filePath}` as ScopeId;
  const def: SymbolDefinition = {
    nodeId: `Class:${filePath}:${name}`,
    filePath,
    type: 'Class',
    qualifiedName: name,
  };
  return {
    filePath,
    moduleScope,
    scopes: [
      {
        id: moduleScope,
        parent: null,
        kind: 'Module',
        range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
        filePath,
        bindings: new Map([[name, [{ def, origin: 'local' }]]]),
        ownedDefs: [def],
        imports: [],
        typeBindings: new Map(),
      },
    ],
    parsedImports: [],
    localDefs: [def],
    referenceSites: [],
  };
}

/**
 * `use function Vendor\Ghost\missing;` — the one PHP import shape that reaches
 * `filesByDirectory`. A `type` import (the default for `use X;`) returns before
 * the `parsedFiles` leg, so the class-style spelling the other arms use would
 * leave `parsedFileReads` at 0.
 */
const PHP_FUNCTION_IMPORT = (targetRaw: string): ParsedImport => ({
  kind: 'named',
  localName: 'imported',
  importedName: 'imported',
  targetRaw,
  importedSymbolKind: 'function',
});

/**
 * `from <targetRaw> import Widget` — a named import, which is what makes
 * `resolvePythonImportTarget` run the package-attribute probe
 * (`pythonFileExportsName`, the `context.parsedFiles` reader) ahead of the
 * submodule fallback. The default the adapter synthesizes when `context` is
 * absent is a `namespace` import, and that shape never reaches the probe.
 */
const FIXTURES: ReadonlyMap<SupportedLanguages, ImportTargetFixture> = new Map<
  SupportedLanguages,
  ImportTargetFixture
>([
  [
    SupportedLanguages.Python,
    {
      // `realpkg/__init__.py` makes the package real, so `hasRepoCandidate`
      // passes and the miss reaches `resolveAbsoluteFromFiles` — both index
      // consumers, not just the gate.
      files: ['pkg/sub/mod.py', 'realpkg/__init__.py', 'realpkg/widget.py', 'app/main.py'],
      fromFile: 'app/main.py',
      resolutionConfig: undefined,
      missTarget: (i) => `realpkg.ghost${i}`,
      hitTarget: 'realpkg.widget',
      parsedImport: pythonNamedImport,
      minimumScans: 1,
      // The one build of `parsedFileByPath`, triggered by the single import
      // whose package probe resolves — the misses never get that far, and
      // every later resolver is a `Map.get` rather than another pass.
      minimumParsedFileReads: 1,
    },
  ],
  [
    SupportedLanguages.CSharp,
    {
      // No `.csproj` in the config, which is the leg that reads both the shared
      // workspace index and the namespace-directory index.
      files: ['App/Models/User.cs', 'App/Services/Service.cs', 'App/Program.cs'],
      fromFile: 'App/Program.cs',
      resolutionConfig: undefined,
      missTarget: (i) => `Vendor${i}.Ghost.Deep.Missing`,
      hitTarget: 'App.Models.User',
      parsedImport: IGNORES_CONTEXT,
      minimumScans: 1,
      minimumParsedFileReads: 0,
    },
  ],
  [
    SupportedLanguages.Go,
    {
      files: ['internal/models/user.go', 'internal/models/user_test.go', 'main.go'],
      fromFile: 'main.go',
      resolutionConfig: GO_MODULE,
      // Third-party: misses the module leg and runs the whole GOPATH suffix
      // cascade, which used to cost one full scan per path segment.
      missTarget: (i) => `github.com/vendor/dep${i}/sub`,
      hitTarget: 'example.com/mod/internal/models',
      parsedImport: IGNORES_CONTEXT,
      minimumScans: 1,
      minimumParsedFileReads: 0,
    },
  ],
  [
    SupportedLanguages.Java,
    {
      files: ['com/example/model/User.java', 'src/main/java/com/example/App.java'],
      fromFile: 'src/main/java/com/example/App.java',
      resolutionConfig: undefined,
      // A four-segment miss, which is what every JDK and third-party import is.
      // Since #2953 that is a lookup miss rather than a scan: no package named
      // `vendor<i>.ghost.deep` is declared, so there is nothing to search.
      missTarget: (i) => `vendor${i}.ghost.deep.Missing`,
      hitTarget: 'com.example.model.User',
      parsedImport: IGNORES_CONTEXT,
      declare: () => {
        clearJavaPackageFacts();
        setJavaPackageFact('com/example/model/User.java', {
          status: 'known',
          packageName: 'com.example.model',
        });
        setJavaPackageFact('src/main/java/com/example/App.java', {
          status: 'known',
          packageName: 'com.example',
        });
      },
      // Java reads the DECLARATIONS, not the file set: the package index is
      // built from `context.parsedFiles`, so the file-set counter stays at zero
      // and the parsed-file counter is where this property is now measured.
      minimumScans: 0,
      minimumParsedFileReads: 1,
    },
  ],
  [
    SupportedLanguages.C,
    {
      // `resolutionConfig` is the header set from `loadResolutionConfig`. Left
      // undefined so the resolver indexes THIS set: with headers present the
      // adapter hands the resolver a memoized union instead, and the union's
      // own scan is the only one this counter would see.
      files: ['include/util.h', 'src/helper.h', 'src/main.c'],
      fromFile: 'src/main.c',
      resolutionConfig: undefined,
      missTarget: (i) => `ghost${i}.h`,
      hitTarget: 'util.h',
      parsedImport: IGNORES_CONTEXT,
      minimumScans: 1,
      minimumParsedFileReads: 0,
    },
  ],
  [
    SupportedLanguages.CPlusPlus,
    {
      // Same accounting as C: `resolveCppImportTarget` delegates to the C
      // resolver's basename index, keyed on the same Set.
      files: ['include/util.hpp', 'src/helper.hpp', 'src/main.cpp'],
      fromFile: 'src/main.cpp',
      resolutionConfig: undefined,
      missTarget: (i) => `ghost${i}.hpp`,
      hitTarget: 'util.hpp',
      parsedImport: IGNORES_CONTEXT,
      minimumScans: 1,
      minimumParsedFileReads: 0,
    },
  ],
  [
    SupportedLanguages.PHP,
    {
      files: ['app/Models/User.php', 'lib/Legacy/Helper.php', 'app/Main.php'],
      fromFile: 'app/Main.php',
      resolutionConfig: PHP_COMPOSER,
      // Deliberately matches NO PSR-4 prefix. `resolvePhpImportInternal` runs
      // its namespace-directory fallback scan unconditionally when
      // `getFilesInDir` comes back empty, so a miss UNDER `App\` — say
      // `App\Legacy\Ghost`, whose directory does not exist — costs one
      // traversal per import: swapping this fixture onto that spelling posts
      // 201 traversals for 200 imports against 3 for two (measured). The
      // residual is real and is out of this file's reach — it lives in
      // `import-resolvers/php.ts`, which the #2901 hoist does not touch — so it
      // is pinned by name in `php-import-target-parity.test.ts` and this
      // fixture takes the leg that IS indexed rather than restating it.
      missTarget: (i) => `Vendor${i}\\Ghost\\Missing`,
      hitTarget: 'App\\Models\\User',
      parsedImport: PHP_FUNCTION_IMPORT,
      minimumScans: 1,
      // `filesByDirectory`'s one pass over the parsed workspace, memoized on it.
      minimumParsedFileReads: 1,
    },
  ],
  [
    SupportedLanguages.Rust,
    {
      files: ['src/lib.rs', 'src/models.rs', 'src/main.rs'],
      fromFile: 'src/main.rs',
      resolutionConfig: undefined,
      missTarget: (i) => `ghost${i}::deep::Missing`,
      hitTarget: 'crate::models',
      parsedImport: IGNORES_CONTEXT,
      // See `minimumScans` on the interface: membership probes only.
      minimumScans: 0,
      minimumParsedFileReads: 0,
    },
  ],
  [
    SupportedLanguages.Kotlin,
    {
      files: [
        'lib/src/main/kotlin/com/example/widget/Widget.kt',
        'common/src/main/kotlin/com/example/common/Util.kt',
      ],
      fromFile: 'common/src/main/kotlin/com/example/common/Util.kt',
      resolutionConfig: undefined,
      missTarget: (i) => `org.ghost${i}.deep.Missing`,
      // Under a module source root, so this resolves by path suffix rather than
      // by a workspace-rooted exact match.
      hitTarget: 'com.example.widget.Widget',
      parsedImport: IGNORES_CONTEXT,
      declare: () => {
        clearKotlinPackageFacts();
        setKotlinPackageFact('lib/src/main/kotlin/com/example/widget/Widget.kt', {
          status: 'known',
          packageName: 'com.example.widget',
        });
        setKotlinPackageFact('common/src/main/kotlin/com/example/common/Util.kt', {
          status: 'known',
          packageName: 'com.example.common',
        });
      },
      parsedFile: kotlinParsedFile,
      // Kotlin reads declarations from parsedFiles, not path shape.
      minimumScans: 0,
      minimumParsedFileReads: 1,
    },
  ],
  [
    SupportedLanguages.Ruby,
    {
      files: ['lib/app/models/user.rb', 'lib/util.rb', 'lib/main.rb'],
      fromFile: 'lib/main.rb',
      resolutionConfig: undefined,
      // A bare `require`, not a `require_relative`: the relative leg answers
      // from `Set.has` and never reaches the index.
      missTarget: (i) => `gem${i}/missing`,
      hitTarget: 'app/models/user',
      parsedImport: IGNORES_CONTEXT,
      minimumScans: 1,
      minimumParsedFileReads: 0,
    },
  ],
  [
    SupportedLanguages.Cobol,
    {
      files: ['copybooks/CUSTREC.cpy', 'src/PAYROLL.cbl', 'src/PROG.cbl'],
      fromFile: 'src/PROG.cbl',
      resolutionConfig: undefined,
      // Vendor and system copybooks live outside the repo, so the common case
      // misses both tiers — two full scans per `COPY` before the index.
      missTarget: (i) => `VENDOR${i}`,
      hitTarget: 'CUSTREC',
      parsedImport: IGNORES_CONTEXT,
      minimumScans: 1,
      minimumParsedFileReads: 0,
    },
  ],
  [
    SupportedLanguages.Swift,
    {
      files: ['Sources/Models/User.swift', 'Sources/App/main.swift'],
      fromFile: 'Sources/App/main.swift',
      resolutionConfig: undefined,
      missTarget: (i) => `Ghost${i}`,
      hitTarget: 'Models',
      parsedImport: IGNORES_CONTEXT,
      minimumScans: 1,
      minimumParsedFileReads: 0,
    },
  ],
  [
    SupportedLanguages.Dart,
    {
      files: ['lib/models.dart', 'tool/generate.dart', 'lib/main.dart'],
      fromFile: 'lib/main.dart',
      resolutionConfig: undefined,
      // An external package: both `lib/<rel>` and bare `<rel>` miss, which is
      // the two-scan case.
      missTarget: (i) => `package:vendor${i}/ghost.dart`,
      hitTarget: 'package:app/models.dart',
      parsedImport: IGNORES_CONTEXT,
      minimumScans: 1,
      minimumParsedFileReads: 0,
    },
  ],
]);

/**
 * Registered resolvers exempted from the property, each citing the issue that
 * explains why.
 *
 * It was EMPTY until #2953, and that emptiness was a result rather than a
 * starting state: every resolver in `SCOPE_RESOLVERS` either memoized its index
 * on the `allFilePaths` Set identity or never traversed the Set at all (#2872,
 * #2877, #2878, #2879, #2880, #2901, #2902, #2908 closed the last of them).
 *
 * The three entries it now carries are a different KIND of exemption, and the
 * distinction is the reason this comment is worth reading. They are not "this
 * resolver is allowed to re-scan": TypeScript, JavaScript and Vue stopped
 * deriving anything from the file set at all, so there is no per-pass structure
 * for the property to be about. `Set.has` against a candidate the config named
 * is O(1) and independent of workspace size, which is the outcome the
 * per-import-scan ban existed to secure.
 *
 * The mechanism stays because it is the point — a language must not be able to
 * opt out by quietly not appearing in `FIXTURES`. An entry must cite an issue
 * (`#NNNN`), and the key list is pinned exactly, so both adding one and letting
 * one rot are visible, reviewed edits rather than lines in a table nobody
 * reads.
 */
const KNOWN_UNINDEXED: ReadonlyMap<SupportedLanguages, string> = new Map<
  SupportedLanguages,
  string
>([
  // The three Node-family resolvers build no per-pass structure because #2953
  // removed the thing one was for. They used to derive a `SuffixIndex` plus two
  // file-list arrays from `allFilePaths` so `suffixResolve` could ask "does any
  // file's path end in this specifier?" — a question real module resolution
  // never asks. Every candidate now comes from a declared source (a real path,
  // a tsconfig mapping, a package manifest) and is checked with a single
  // `Set.has`, so there is nothing derived from the file set to reuse and no
  // per-import cost for this property to catch.
  //
  // Exempt from THIS property, not from the guard behind it: `Set.has` is O(1)
  // and independent of workspace size, which is the outcome the per-import scan
  // ban existed to secure. `languages/typescript/module-resolution.ts` is where
  // that now has to stay true.
  [
    SupportedLanguages.TypeScript,
    'resolves against declared config only (#2953) — no per-pass index to reuse',
  ],
  [
    SupportedLanguages.JavaScript,
    'resolves against declared config only (#2953) — no per-pass index to reuse',
  ],
  [
    SupportedLanguages.Vue,
    'resolves against declared config only (#2953) — no per-pass index to reuse',
  ],
]);

interface ContractCase {
  readonly language: SupportedLanguages;
  readonly resolver: ScopeResolver;
  readonly fixture: ImportTargetFixture;
}

const CASES: readonly ContractCase[] = [...SCOPE_RESOLVERS.entries()].flatMap(
  ([language, resolver]) => {
    const fixture = FIXTURES.get(language);
    return fixture === undefined ? [] : [{ language, resolver, fixture }];
  },
);

/** Imports driven in the baseline run — the smallest count above one. */
const BASELINE_IMPORTS = 2;
/** Imports driven in the comparison run. A per-import scan shows up as a 100x. */
const MANY_IMPORTS = 200;

interface ImportRun {
  /** Full traversals of the run's own file set. */
  readonly scans: number;
  /** Element reads of the run's own `context.parsedFiles` array. */
  readonly parsedFileReads: number;
  /** What `hitTarget` resolved to, read after the misses. */
  readonly hit: string | readonly string[] | null;
}

/**
 * Drive `importCount` missing imports and then one resolvable import through
 * the orchestrator ADAPTER — `<lang>ScopeResolver.resolveImportTarget`, the
 * surface a defensive `new Set(allFilePaths)` copy breaks and the per-language
 * unit parity tests never cross.
 *
 * Five arguments, the shape `pipeline/run.ts` uses. One `context` object for
 * the whole run, because that is what the orchestrator threads: it builds
 * `parsedFiles` once per pass, so the array identity PHP's `filesByDirectory`
 * memoizes on is stable across every import. Rebuilding it here would hand each
 * import a fresh key and turn the fixture itself into the defect.
 *
 * Fresh instruments per run, for the same reason on both keys: the indexes hang
 * off object identity, so two runs sharing a Set or a `parsedFiles` array would
 * have the second read the first's index and report zero.
 */
function driveImports(
  resolver: ScopeResolver,
  fixture: ImportTargetFixture,
  importCount: number,
): ImportRun {
  fixture.declare?.();
  const files = new CountingSet(fixture.files);
  const workspace = fixture.parsedFile
    ? countedParsedFilesWith(fixture.files, fixture.parsedFile)
    : countedParsedFiles(fixture.files);
  const contextFor = (targetRaw: string) => ({
    parsedFiles: workspace.parsedFiles,
    parsedImport: fixture.parsedImport(targetRaw),
  });

  for (let i = 0; i < importCount; i++) {
    const target = fixture.missTarget(i);
    resolver.resolveImportTarget(
      target,
      fixture.fromFile,
      files,
      fixture.resolutionConfig,
      contextFor(target),
    );
  }

  const hit = resolver.resolveImportTarget(
    fixture.hitTarget,
    fixture.fromFile,
    files,
    fixture.resolutionConfig,
    contextFor(fixture.hitTarget),
  );
  return { scans: files.scans, parsedFileReads: workspace.reads(), hit };
}

describe('import-target index reuse — the contract every registered resolver holds', () => {
  it.each(CASES)(
    '$language traverses the file set no more times for many imports than for two',
    ({ language, resolver, fixture }) => {
      const few = driveImports(resolver, fixture, BASELINE_IMPORTS);
      const many = driveImports(resolver, fixture, MANY_IMPORTS);

      // The property. A per-import scan makes `many` ~100x `few`; a scan
      // reintroduced beside a reused index moves both by the same constant and
      // is caught instead by the per-language guards' exact counts.
      expect(
        many.scans,
        `${language}: ${MANY_IMPORTS} imports cost ${many.scans} traversals, ${BASELINE_IMPORTS} cost ${few.scans} — the file set is being re-read per import`,
      ).toBe(few.scans);

      // The same property on the other per-file-set key. PHP's
      // `filesByDirectory` and Python's `pythonFileExportsName` read
      // `context.parsedFiles` and never touch the Set, so the arm above is
      // blind to both — measured, not assumed: defeating PHP's `perFileSet`
      // leaves `scans` unmoved and takes this count from 9 to 603.
      expect(
        many.parsedFileReads,
        `${language}: ${MANY_IMPORTS} imports read context.parsedFiles ${many.parsedFileReads} times, ${BASELINE_IMPORTS} read it ${few.parsedFileReads} — the parsed workspace is being re-derived per import`,
      ).toBe(few.parsedFileReads);

      // Non-vacuity, one arm per thing the counts could be measuring nothing
      // about. Without them a resolver that resolves nothing, or a leg that is
      // never entered, posts a perfect score.
      expect(
        many.scans,
        `${language}: the counting file set was never reached — is the adapter copying it?`,
      ).toBeGreaterThanOrEqual(fixture.minimumScans);
      expect(
        many.parsedFileReads,
        `${language}: context.parsedFiles was never read — did the leg behind it stop being entered?`,
      ).toBeGreaterThanOrEqual(fixture.minimumParsedFileReads);
      expect(
        many.hit,
        `${language}: '${fixture.hitTarget}' no longer resolves, so the counts above measure nothing`,
      ).not.toBeNull();
    },
  );

  it('covers every registered scope resolver', () => {
    const registered = [...SCOPE_RESOLVERS.keys()].sort();
    const accountedFor = [...FIXTURES.keys(), ...KNOWN_UNINDEXED.keys()].sort();

    // A new language in `pipeline/registry.ts` lands here first: it is either
    // given a fixture in `FIXTURES` or an entry in `KNOWN_UNINDEXED`, and both
    // are edits someone has to justify.
    expect(accountedFor).toEqual(registered);
  });

  it('exempts only the Node family, and makes every exemption cite an issue', () => {
    for (const [language, reason] of KNOWN_UNINDEXED) {
      expect(reason, `${language}'s exemption must cite an open issue`).toMatch(/#\d+/);
    }

    // Pinned as a list rather than a count. The exemption is not "this resolver
    // is allowed to be slow" — it is "this resolver derives nothing from the
    // file set, so there is no per-pass structure for the property to be about"
    // (#2953). A fourth language appearing here is a claim someone has to make
    // deliberately, and the likeliest reason for it is an adapter that quietly
    // stopped building the index it still needs.
    expect([...KNOWN_UNINDEXED.keys()].sort()).toEqual(
      [SupportedLanguages.TypeScript, SupportedLanguages.JavaScript, SupportedLanguages.Vue].sort(),
    );
  });
});
