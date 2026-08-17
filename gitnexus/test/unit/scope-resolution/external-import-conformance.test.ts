/**
 * One property, asserted for EVERY registered `ScopeResolver` (#2953).
 *
 *   A specifier that names something OUTSIDE the repository must not resolve to
 *   a file inside it.
 *
 * This is the property #2953 was filed against. Its violation is not a missing
 * edge but a fabricated one: `@acme/telemetry/nest` resolving to the repo's
 * only path ending in `nest/index.ts` produces an `IMPORTS` edge at full
 * confidence between two files that have no relationship, and `impact` then
 * reports a blast radius into code that cannot be affected. The reporter
 * measured 44 of 74 cross-package edges landing on two such files.
 *
 * The mechanism is shared, which is why this file is: `import-resolvers/
 * utils.ts:suffixResolve` asks "does any file in this repo have a path ending
 * in this specifier?", retrying with each leading segment dropped, and most
 * languages still end their resolution chain there.
 *
 * ## The decoy is the whole test
 *
 * Every case pairs an external specifier with a DECOY — an unrelated in-repo
 * file whose path ends the way the specifier does. Without one, a resolver that
 * simply found nothing would pass while still holding no property at all: the
 * question is not "did it return null" but "did it return null when a tempting
 * wrong answer was sitting in the file set". Each case therefore also asserts
 * the decoy is genuinely reachable, by resolving the spelling that SHOULD find
 * it, so a typo in a fixture cannot manufacture a pass.
 *
 * ## `KNOWN_GAPS` is a work list, not an allowance
 *
 * A language in that map does not hold the property today. The entry records
 * what its resolver currently answers, so the follow-up that fixes it deletes
 * one line and the arm below starts enforcing it. Both arms run for every
 * language either way — a gap that silently closes fails just as loudly as one
 * that opens, because a resolver quietly starting to answer `null` for the
 * paired positive case is a regression wearing the fix's clothes.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedImport } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { SCOPE_RESOLVERS } from '../../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import type { ComposerConfig } from '../../../src/core/ingestion/language-config.js';

/** The `composer.json` PSR-4 map `loadPhpComposerConfig` would have produced. */
const PHP_COMPOSER: ComposerConfig = { psr4: new Map([['App', 'app']]) };
/** The value `loadGoModulePath` produces for a repo with a `go.mod`. */
const GO_MODULE = { modulePath: 'example.com/mod' };
/** What `scanCSharpProject` would report for the C# workspace below — the
 *  in-repo namespace evidence the #1881 suffix-fallback gate reads. */
const CSHARP_NAMESPACES = {
  namespaces: {
    declaredNamespaces: new Set(['App', 'App.Models']),
    rootNamespaces: new Set(['App']),
    truncated: false,
  },
};

interface ConformanceCase {
  /** The workspace, including the decoy. */
  readonly files: readonly string[];
  readonly fromFile: string;
  readonly resolutionConfig: unknown;
  /** A specifier naming something outside the repo. Must resolve to nothing. */
  readonly external: string;
  /**
   * The in-repo file the external specifier is tempting: its path ends the way
   * `external` does, so a suffix matcher lands on it.
   */
  readonly decoy: string;
  /**
   * A specifier that SHOULD reach {@link decoy} — the paired positive proving
   * the decoy is live, so a `null` below is a refusal rather than an empty
   * corpus.
   *
   * Required only for a language that HOLDS the property. For one in
   * {@link KNOWN_GAPS} the gap assertion already resolves `external` TO the
   * decoy, which is that proof — and for several of them no other spelling
   * exists: Swift's `Foundation` and COBOL's `EXTERNAL` name the in-repo
   * directory and copybook as well as the external module, which is precisely
   * why those resolvers cannot tell the two apart.
   */
  readonly reachesDecoy?: string;
  readonly parsedImport?: (targetRaw: string) => ParsedImport | undefined;
}

const PHP_FUNCTION_IMPORT = (targetRaw: string): ParsedImport => ({
  kind: 'named',
  localName: 'imported',
  importedName: 'imported',
  targetRaw,
  importedSymbolKind: 'function',
});

const CASES: ReadonlyMap<SupportedLanguages, ConformanceCase> = new Map([
  [
    SupportedLanguages.TypeScript,
    {
      files: ['apps/web/src/main.ts', 'packages/inner/src/nest/index.ts', 'apps/web/src/nest.ts'],
      fromFile: 'apps/web/src/main.ts',
      resolutionConfig: undefined,
      external: '@acme/telemetry/nest',
      decoy: 'packages/inner/src/nest/index.ts',
      reachesDecoy: '../../../packages/inner/src/nest',
    },
  ],
  [
    SupportedLanguages.JavaScript,
    {
      files: ['apps/web/src/main.js', 'packages/inner/src/nest/index.js'],
      fromFile: 'apps/web/src/main.js',
      resolutionConfig: undefined,
      external: '@acme/telemetry/nest',
      decoy: 'packages/inner/src/nest/index.js',
      reachesDecoy: '../../../packages/inner/src/nest',
    },
  ],
  [
    SupportedLanguages.Vue,
    {
      files: ['apps/web/src/main.ts', 'packages/inner/src/nest/index.ts'],
      fromFile: 'apps/web/src/main.ts',
      resolutionConfig: undefined,
      external: '@acme/telemetry/nest',
      decoy: 'packages/inner/src/nest/index.ts',
      reachesDecoy: '../../../packages/inner/src/nest',
    },
  ],
  [
    SupportedLanguages.Python,
    {
      // #898's exact shape: `django.apps` beside an unrelated `accounts/apps.py`.
      files: ['accounts/apps.py', 'accounts/models.py', 'billing/models.py'],
      fromFile: 'accounts/models.py',
      resolutionConfig: undefined,
      external: 'django.apps',
      decoy: 'accounts/apps.py',
      reachesDecoy: 'accounts.apps',
    },
  ],
  [
    SupportedLanguages.CSharp,
    {
      // #1881's shape: a BCL using beside a same-named local file.
      files: ['App/Tasks.cs', 'App/Models/User.cs', 'App/Program.cs'],
      fromFile: 'App/Program.cs',
      // The #1881 gate is evidence-driven and fails OPEN without any, so a
      // `undefined` config here would record a gap C# does not have.
      resolutionConfig: CSHARP_NAMESPACES,
      external: 'System.Threading.Tasks',
      decoy: 'App/Tasks.cs',
      reachesDecoy: 'App.Tasks',
    },
  ],
  [
    SupportedLanguages.Java,
    {
      files: [
        'vendor/util/List.java',
        'com/example/model/User.java',
        'src/main/java/com/example/App.java',
      ],
      fromFile: 'src/main/java/com/example/App.java',
      resolutionConfig: undefined,
      external: 'java.util.List',
      decoy: 'vendor/util/List.java',
      reachesDecoy: 'vendor.util.List',
    },
  ],
  [
    SupportedLanguages.Kotlin,
    {
      files: ['src/main/kotlin/vendor/Assert.kt', 'src/main/kotlin/com/example/App.kt'],
      fromFile: 'src/main/kotlin/com/example/App.kt',
      resolutionConfig: undefined,
      external: 'org.junit.Assert',
      decoy: 'src/main/kotlin/vendor/Assert.kt',
      reachesDecoy: 'vendor.Assert',
    },
  ],
  [
    SupportedLanguages.Go,
    {
      files: ['internal/models/user.go', 'main.go'],
      fromFile: 'main.go',
      resolutionConfig: GO_MODULE,
      external: 'github.com/vendor/dep/internal/models',
      decoy: 'internal/models/user.go',
      reachesDecoy: 'example.com/mod/internal/models',
    },
  ],
  [
    SupportedLanguages.Ruby,
    {
      files: ['lib/app/models/user.rb', 'lib/generators.rb', 'lib/main.rb'],
      fromFile: 'lib/main.rb',
      resolutionConfig: undefined,
      external: 'rails/generators',
      decoy: 'lib/generators.rb',
      reachesDecoy: 'generators',
    },
  ],
  [
    SupportedLanguages.Rust,
    {
      files: ['src/de.rs', 'src/models.rs', 'src/main.rs'],
      fromFile: 'src/main.rs',
      resolutionConfig: undefined,
      external: 'serde::de',
      decoy: 'src/de.rs',
      reachesDecoy: 'crate::de',
    },
  ],
  [
    SupportedLanguages.PHP,
    {
      files: ['app/Models/User.php', 'lib/Legacy/Missing.php', 'app/Main.php'],
      fromFile: 'app/Main.php',
      resolutionConfig: PHP_COMPOSER,
      external: 'Vendor\\Ghost\\Missing',
      decoy: 'lib/Legacy/Missing.php',
      reachesDecoy: 'App\\Models\\User',
      parsedImport: PHP_FUNCTION_IMPORT,
    },
  ],
  [
    SupportedLanguages.Dart,
    {
      files: ['lib/http.dart', 'lib/models.dart', 'lib/main.dart'],
      fromFile: 'lib/main.dart',
      resolutionConfig: undefined,
      external: 'package:http/http.dart',
      decoy: 'lib/http.dart',
      reachesDecoy: 'package:app/http.dart',
    },
  ],
  [
    SupportedLanguages.Swift,
    {
      files: [
        'Sources/Foundation/Thing.swift',
        'Sources/Models/User.swift',
        'Sources/App/main.swift',
      ],
      fromFile: 'Sources/App/main.swift',
      resolutionConfig: undefined,
      external: 'Foundation',
      decoy: 'Sources/Foundation/Thing.swift',
      reachesDecoy: 'Models',
    },
  ],
  [
    SupportedLanguages.C,
    {
      files: ['src/stdio.h', 'include/util.h', 'src/main.c'],
      fromFile: 'src/main.c',
      resolutionConfig: undefined,
      external: 'stdio.h',
      decoy: 'src/stdio.h',
      reachesDecoy: 'util.h',
    },
  ],
  [
    SupportedLanguages.CPlusPlus,
    {
      files: ['src/cstdio.h', 'include/util.hpp', 'src/main.cpp'],
      fromFile: 'src/main.cpp',
      resolutionConfig: undefined,
      // `cstdio` with no extension would miss the decoy on spelling alone and
      // post a pass that measures nothing; the header spelling is the real test.
      external: 'cstdio.h',
      decoy: 'src/cstdio.h',
      reachesDecoy: 'util.hpp',
    },
  ],
  [
    SupportedLanguages.Cobol,
    {
      files: ['copybooks/CUSTREC.cpy', 'vendor/EXTERNAL.cpy', 'src/PROG.cbl'],
      fromFile: 'src/PROG.cbl',
      resolutionConfig: undefined,
      external: 'EXTERNAL',
      decoy: 'vendor/EXTERNAL.cpy',
      reachesDecoy: 'CUSTREC',
    },
  ],
  [
    SupportedLanguages.ObjectiveC,
    {
      files: ['Headers/Foundation.h', 'Headers/Widget.h', 'Sources/main.m'],
      fromFile: 'Sources/main.m',
      resolutionConfig: undefined,
      external: 'Foundation',
      decoy: 'Headers/Foundation.h',
      reachesDecoy: 'Foundation.h',
    },
  ],
]);

/**
 * Languages that do NOT hold the property yet, with what they answer instead.
 *
 * Each entry is a follow-up, not a decision: the resolver ends its chain in
 * `suffixResolve` and so cannot tell an external module from a path suffix.
 * Fixing one means giving that language its real algorithm the way #2953 gave
 * TypeScript one, then deleting its line here.
 */
const KNOWN_GAPS: ReadonlyMap<SupportedLanguages, string> = new Map<SupportedLanguages, string>([
  [SupportedLanguages.Java, '`java.util.List` -> `vendor/util/List.java`'],
  [SupportedLanguages.Kotlin, '`org.junit.Assert` -> `src/main/kotlin/vendor/Assert.kt`'],
  [SupportedLanguages.Go, '`github.com/vendor/dep/internal/models` -> `internal/models/user.go`'],
  [SupportedLanguages.Ruby, '`rails/generators` -> `lib/generators.rb`'],
  [SupportedLanguages.PHP, '`Vendor\\Ghost\\Missing` -> `lib/Legacy/Missing.php`'],
  [SupportedLanguages.Dart, '`package:http/http.dart` -> `lib/http.dart`'],
  [SupportedLanguages.Swift, '`Foundation` -> `Sources/Foundation/Thing.swift`'],
  [SupportedLanguages.C, '`stdio.h` -> `src/stdio.h`'],
  [SupportedLanguages.CPlusPlus, '`cstdio.h` -> `src/cstdio.h`'],
  [SupportedLanguages.Cobol, '`EXTERNAL` -> `vendor/EXTERNAL.cpy`'],
]);

/**
 * The six that hold it, and what earns each one.
 *
 * Not a list to maintain by hand — it is derived below — but worth reading
 * once, because the three mechanisms are different and only one of them
 * generalizes:
 *
 *   - TypeScript / JavaScript / Vue resolve against declared config only and
 *     have no suffix fallback at all (#2953). This is the shape the ten above
 *     need.
 *   - Python (#898) and C# (#1881) kept the fallback and put a gate in front of
 *     it, keyed on whether the specifier's leading segment names anything
 *     in-repo. Cheaper, and it holds — but it is a filter on a guess rather
 *     than a resolution rule, so it answers "probably not external" instead of
 *     "here is what the language says this means".
 *   - Rust holds it for a spelling reason: `::` is not `/` or `.`, so
 *     `serde::de` never decomposes into a path suffix that could match
 *     `src/de.rs`. The decoy-reachability arm proves the file IS reachable via
 *     `crate::de`, so this is a real pass — but it is contingent on the
 *     separator, not on Rust knowing what a crate is.
 */

function resolveWith(
  language: SupportedLanguages,
  testCase: ConformanceCase,
  targetRaw: string,
): string | readonly string[] | null {
  const resolver = SCOPE_RESOLVERS.get(language)!;
  const files = new Set(testCase.files);
  return resolver.resolveImportTarget(
    targetRaw,
    testCase.fromFile,
    files,
    testCase.resolutionConfig,
    {
      parsedFiles: [],
      parsedImport: testCase.parsedImport?.(targetRaw),
    },
  );
}

/** Every file an answer names, whatever shape the resolver used. */
function filesOf(answer: string | readonly string[] | null): readonly string[] {
  if (answer === null) return [];
  return typeof answer === 'string' ? [answer] : answer;
}

describe('external imports never resolve into the repository (#2953)', () => {
  it('covers every registered scope resolver', () => {
    // A new language lands here before it lands anywhere else: it either gets a
    // case or an explicit gap entry, and both are edits someone has to justify.
    expect([...CASES.keys()].sort()).toEqual([...SCOPE_RESOLVERS.keys()].sort());
  });

  it.each([...CASES.keys()].filter((language) => !KNOWN_GAPS.has(language)))(
    '%s: the decoy is reachable, so the arm below means something',
    (language) => {
      const testCase = CASES.get(language)!;
      const reached = filesOf(resolveWith(language, testCase, testCase.reachesDecoy!));

      // The DECOY specifically, not merely something. Asserting non-empty let a
      // case pair `reachesDecoy` with a different file than `decoy` and still
      // pass, which proves the resolver can reach SOME file and says nothing
      // about whether the tempting wrong answer below was ever reachable.
      expect(
        reached,
        `${language}: '${testCase.reachesDecoy}' did not reach the decoy '${testCase.decoy}', so this workspace proves nothing about '${testCase.external}'`,
      ).toContain(testCase.decoy);
    },
  );

  it.each([...CASES.keys()])('%s: an external specifier resolves to nothing', (language) => {
    const testCase = CASES.get(language)!;
    const resolved = filesOf(resolveWith(language, testCase, testCase.external));
    const gap = KNOWN_GAPS.get(language);

    if (gap !== undefined) {
      // The gap is asserted, not skipped, and asserted as the RECORDED answer
      // rather than as "something": a resolver returning an unrelated in-repo
      // file would otherwise keep the entry green while the map's description
      // of what it does went stale. A language that starts holding the property
      // fails here too, which is how the entry gets deleted deliberately.
      expect(
        resolved,
        `${language}: KNOWN_GAPS records '${testCase.external}' resolving to '${testCase.decoy}', but it resolved to ${JSON.stringify(resolved)} — update the entry or delete it`,
      ).toEqual([testCase.decoy]);
      return;
    }

    expect(
      resolved,
      `${language}: '${testCase.external}' names nothing in this repo, but resolved to ${JSON.stringify(resolved)}`,
    ).toEqual([]);
  });
});
