/**
 * One property, asserted for EVERY registered `ScopeResolver` (#2909).
 *
 * Import-target resolution must not traverse the workspace file set once per
 * import. Twelve per-language guards in `test/integration/*-import-index-reuse.test.ts`
 * say that twelve times, each with its own corpus, its own expected traversal
 * count and its own header. None of them says it for the four languages with no
 * guard at all — and adding a resolver to `SCOPE_RESOLVERS` is two lines
 * (`pipeline/registry.ts`), neither of which is a test. This file closes that:
 * the table below is keyed by `SupportedLanguages` and the inventory arm fails
 * when a registered resolver is missing from it.
 *
 * ## The assertion is a COMPARISON, not a constant
 *
 * `scans(200) === scans(2)`, never `scans === 1`. Per-language counts legitimately
 * differ — C# and Java each build two indexes over the same Set, TypeScript /
 * JavaScript / Vue materialize an array and a copy behind their pass cache, Rust
 * never traverses at all — and a table of sixteen expected constants would be a
 * table of sixteen things to get wrong. Comparing two counts against each other
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
 *     nine integration guards state in their headers, and the reason
 *     `CountingSet` is a real `Set` subclass rather than a counter object.
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
 * the number of imports", for all sixteen.
 *
 * Only traversals of the SET are visible here (see `test/helpers/counting-file-set.ts`):
 * once an index has materialized the paths into an array, a scan over that array
 * moves nothing. That is not hypothetical — JavaScript's adapter had no suffix
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

import { SCOPE_RESOLVERS } from '../../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import type { ScopeResolver } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import type { ComposerConfig } from '../../../src/core/ingestion/language-config.js';
import { CountingSet } from '../../helpers/counting-file-set.js';

/**
 * The minimum a language needs for one `resolveImportTarget` call to reach
 * whatever structure it derives from the file set.
 */
interface ImportTargetFixture {
  /** The whole synthetic workspace. Small on purpose: the count being compared
   *  is traversals, not their cost. */
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
}

/** The `composer.json` PSR-4 map `loadPhpComposerConfig` would have produced. */
const PHP_COMPOSER: ComposerConfig = { psr4: new Map([['App', 'app']]) };

/** The value `loadGoModulePath` produces for a repo with a `go.mod`. */
const GO_MODULE = { modulePath: 'example.com/mod' };

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
      minimumScans: 1,
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
      minimumScans: 1,
    },
  ],
  [
    SupportedLanguages.TypeScript,
    {
      files: ['src/util.ts', 'src/models/user.ts', 'src/main.ts'],
      fromFile: 'src/main.ts',
      resolutionConfig: undefined,
      missTarget: (i) => `./ghost${i}`,
      hitTarget: './util',
      minimumScans: 1,
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
      minimumScans: 1,
    },
  ],
  [
    SupportedLanguages.Java,
    {
      files: ['com/example/model/User.java', 'src/main/java/com/example/App.java'],
      fromFile: 'src/main/java/com/example/App.java',
      resolutionConfig: undefined,
      // Four segments and no hit: the progressive-stripping loop runs to the
      // end, which is what every JDK and third-party import does.
      missTarget: (i) => `vendor${i}.ghost.deep.Missing`,
      hitTarget: 'com.example.model.User',
      minimumScans: 1,
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
      minimumScans: 1,
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
      minimumScans: 1,
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
      minimumScans: 1,
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
      // See `minimumScans` on the interface: membership probes only.
      minimumScans: 0,
    },
  ],
  [
    SupportedLanguages.JavaScript,
    {
      files: ['src/util.js', 'src/models/user.js', 'src/main.js'],
      fromFile: 'src/main.js',
      resolutionConfig: undefined,
      missTarget: (i) => `./ghost${i}`,
      hitTarget: './util',
      minimumScans: 1,
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
      minimumScans: 1,
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
      minimumScans: 1,
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
      minimumScans: 1,
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
      minimumScans: 1,
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
      minimumScans: 1,
    },
  ],
  [
    SupportedLanguages.Vue,
    {
      files: ['src/components/Widget.vue', 'src/util.ts', 'src/App.vue'],
      fromFile: 'src/App.vue',
      resolutionConfig: undefined,
      missTarget: (i) => `./ghost${i}.vue`,
      hitTarget: './components/Widget.vue',
      minimumScans: 1,
    },
  ],
]);

/**
 * Registered resolvers exempted from the property, each with the open issue
 * that will remove the exemption.
 *
 * EMPTY, and that is the result rather than the starting state: all sixteen
 * registered resolvers either memoize their index on the `allFilePaths` Set
 * identity or never traverse the Set at all (#2872, #2877, #2878, #2879, #2880,
 * #2901, #2902, #2908 closed the last of them). The map stays because the
 * mechanism is the point — a seventeenth language must not be able to opt out
 * of the property by quietly not appearing in `FIXTURES`. An entry here must
 * cite an open issue (`#NNNN`); the arm below enforces the citation, and the
 * pinned empty key list means adding one is a visible, reviewed edit rather
 * than a line in a table nobody reads.
 */
const KNOWN_UNINDEXED: ReadonlyMap<SupportedLanguages, string> = new Map<
  SupportedLanguages,
  string
>();

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
  /** What `hitTarget` resolved to, read after the misses. */
  readonly hit: string | readonly string[] | null;
}

/**
 * Drive `importCount` missing imports and then one resolvable import through
 * the orchestrator ADAPTER — `<lang>ScopeResolver.resolveImportTarget`, the
 * surface a defensive `new Set(allFilePaths)` copy breaks and the per-language
 * unit parity tests never cross.
 *
 * A fresh `CountingSet` per run: the indexes are keyed on Set identity, so two
 * runs sharing one set would have the second read the first's index and report
 * zero.
 */
function driveImports(
  resolver: ScopeResolver,
  fixture: ImportTargetFixture,
  importCount: number,
): ImportRun {
  const files = new CountingSet(fixture.files);

  for (let i = 0; i < importCount; i++) {
    resolver.resolveImportTarget(
      fixture.missTarget(i),
      fixture.fromFile,
      files,
      fixture.resolutionConfig,
    );
  }

  const hit = resolver.resolveImportTarget(
    fixture.hitTarget,
    fixture.fromFile,
    files,
    fixture.resolutionConfig,
  );
  return { scans: files.scans, hit };
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

      // Non-vacuity, both halves. Without them a resolver that resolves nothing
      // posts a perfect score.
      expect(
        many.scans,
        `${language}: the counting file set was never reached — is the adapter copying it?`,
      ).toBeGreaterThanOrEqual(fixture.minimumScans);
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

  it('exempts nothing, and would make an exemption cite an issue', () => {
    for (const [language, reason] of KNOWN_UNINDEXED) {
      expect(reason, `${language}'s exemption must cite an open issue`).toMatch(/#\d+/);
    }

    expect([...KNOWN_UNINDEXED.keys()]).toEqual([]);
  });
});
