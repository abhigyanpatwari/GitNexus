import { createRequire } from 'node:module';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { requireVendoredGrammar } from './vendored-grammars.js';

const _require = createRequire(import.meta.url);

/**
 * One row per (language, optional variant) describes how to obtain a
 * grammar object suitable for `Parser.setLanguage`.
 *
 *   - `load`             — returns the grammar object (lazy, called on
 *                          first use, then cached).
 *   - `unavailableNote`  — actionable message surfaced *whenever* the
 *                          grammar can't be loaded. Mandatory for every
 *                          row so failures are never silent and never
 *                          generic.
 *   - `optional`         — when true, a load failure does not throw:
 *                          we report the language as unavailable and
 *                          let callers skip files of this language.
 *                          When false (the default), a load failure
 *                          re-throws the original error so the
 *                          pipeline halts loudly.
 *   - `severity`         — log level for failure diagnostics. Defaults
 *                          to `error` for required grammars and `warn`
 *                          for optional ones. Set explicitly to `error`
 *                          on optional rows whose package is listed in
 *                          `dependencies` (not `optionalDependencies`):
 *                          those failures indicate a real install
 *                          problem and should never be hidden behind
 *                          a low-severity warning.
 *
 * Adding or removing a grammar is one entry in this table — there is
 * no second list, no conditional spread, and no per-grammar branch in
 * the resolver.
 */
export interface GrammarSource {
  /** Package payload hashed without evaluating its native loader. */
  packageName: string;
  load: () => unknown;
  unavailableNote: string;
  optional?: boolean;
  severity?: 'warn' | 'error';
  /**
   * When true, this grammar may be disabled at runtime via
   * `GITNEXUS_SKIP_OPTIONAL_GRAMMARS`. Set ONLY on genuinely-optional grammars
   * (optionalDependencies / vendored — swift/dart/kotlin/zig). Required dependencies
   * routed through the optional machinery for ABI safety (e.g. C, which is
   * `optional: true` + `severity: 'error'`) must NOT set this — opting out of a
   * required parser is always an install/platform problem, never a user choice.
   */
  userSkippable?: boolean;
}

const ISSUES_URL = 'https://github.com/abhigyanpatwari/GitNexus/issues';

export const GRAMMAR_SOURCES: Record<string, GrammarSource> = {
  [SupportedLanguages.JavaScript]: {
    packageName: 'tree-sitter-javascript',
    load() {
      return _require(this.packageName);
    },
    unavailableNote:
      'JavaScript parsing requires `tree-sitter-javascript`. ' +
      'Check that the package and its native binding installed cleanly (`npm ci`).',
  },
  [SupportedLanguages.TypeScript]: {
    packageName: 'tree-sitter-typescript',
    load() {
      return _require(this.packageName).typescript;
    },
    unavailableNote:
      'TypeScript parsing requires `tree-sitter-typescript`. ' +
      'Check that the package and its native binding installed cleanly (`npm ci`).',
  },
  [`${SupportedLanguages.TypeScript}:tsx`]: {
    packageName: 'tree-sitter-typescript',
    load() {
      return _require(this.packageName).tsx;
    },
    unavailableNote:
      'TSX parsing requires `tree-sitter-typescript` (re-uses the same native binding as TS).',
  },
  [SupportedLanguages.Python]: {
    packageName: 'tree-sitter-python',
    load() {
      return _require(this.packageName);
    },
    unavailableNote:
      'Python parsing requires `tree-sitter-python`. Check the install and native binding.',
  },
  [SupportedLanguages.Java]: {
    packageName: 'tree-sitter-java',
    load() {
      return _require(this.packageName);
    },
    unavailableNote:
      'Java parsing requires `tree-sitter-java`. Check the install and native binding.',
  },
  // 0.23.5's ESM wrapper uses top-level await. Load the same native binding
  // directly to preserve the synchronous grammar contract used by providers.
  [SupportedLanguages.CSharp]: {
    packageName: 'tree-sitter-c-sharp',
    load() {
      const root = path.dirname(_require.resolve(`${this.packageName}/package.json`));
      const grammar = _require('node-gyp-build')(root);
      grammar.nodeTypeInfo = _require(path.join(root, 'src/node-types.json'));
      return grammar;
    },
    unavailableNote:
      'C# parsing requires the `tree-sitter-c-sharp` native binding and node-type metadata. ' +
      'Check the install and platform prebuild.',
  },
  [SupportedLanguages.CPlusPlus]: {
    packageName: 'tree-sitter-cpp',
    load() {
      return _require(this.packageName);
    },
    unavailableNote:
      'C++ parsing requires `tree-sitter-cpp`. Check the install and native binding.',
  },
  [SupportedLanguages.ObjectiveC]: {
    packageName: 'tree-sitter-objc',
    load() {
      return requireVendoredGrammar(this.packageName);
    },
    optional: true,
    severity: 'error',
    unavailableNote:
      'Objective-C parsing disabled: vendored `tree-sitter-objc` (under ' +
      '`gitnexus/vendor/tree-sitter-objc`) could not be loaded. GitNexus ships ' +
      'prebuilt binaries for supported macOS/Linux runner architectures; this usually ' +
      'indicates a corrupted install or native ABI mismatch with the bundled ' +
      'tree-sitter@0.25.1 runtime.',
  },
  [SupportedLanguages.Go]: {
    packageName: 'tree-sitter-go',
    load() {
      return _require(this.packageName);
    },
    unavailableNote: 'Go parsing requires `tree-sitter-go`. Check the install and native binding.',
  },
  [SupportedLanguages.Rust]: {
    packageName: 'tree-sitter-rust',
    load() {
      return _require(this.packageName);
    },
    unavailableNote:
      'Rust parsing requires `tree-sitter-rust`. Check the install and native binding.',
  },
  [SupportedLanguages.PHP]: {
    packageName: 'tree-sitter-php',
    load() {
      return _require(this.packageName).php_only;
    },
    unavailableNote:
      'PHP parsing requires `tree-sitter-php` (the `php_only` export). ' +
      'Check the install and native binding.',
  },
  [SupportedLanguages.Ruby]: {
    packageName: 'tree-sitter-ruby',
    load() {
      return _require(this.packageName);
    },
    unavailableNote:
      'Ruby parsing requires `tree-sitter-ruby`. Check the install and native binding.',
  },
  [SupportedLanguages.Vue]: {
    packageName: 'tree-sitter-typescript',
    load() {
      return _require(this.packageName).typescript;
    },
    unavailableNote:
      'Vue parsing piggybacks on `tree-sitter-typescript`. Check the install and native binding.',
  },

  // tree-sitter-c is a core grammar, vendored prebuild-only (under
  // gitnexus/vendor/tree-sitter-c) with GitNexus-built prebuilds for every
  // supported platform-arch — upstream ships only 4/6 (#2116) and C is a
  // required grammar whose source build hard-fails install on a toolchain-less
  // ARM host. Loading through the optional machinery turns a would-be ABI
  // segfault (#1242, #858) into a clean degradation while preserving every
  // other language's analysis. Severity stays `error` because C is not a
  // user-opt-out grammar like Swift/Dart/Kotlin: a failure here is always an
  // install/platform problem the user needs to see.
  [SupportedLanguages.C]: {
    packageName: 'tree-sitter-c',
    load() {
      return requireVendoredGrammar(this.packageName);
    },
    optional: true,
    severity: 'error',
    unavailableNote:
      'C parsing disabled: vendored `tree-sitter-c` (under ' +
      '`gitnexus/vendor/tree-sitter-c`) could not be loaded. GitNexus ships ' +
      'prebuilt binaries for all supported platforms (win32/darwin/linux ' +
      'x64+arm64, N-API), so this usually indicates a corrupted install or a ' +
      'native ABI mismatch with the bundled tree-sitter@0.25.1 runtime. ' +
      'Try reinstalling, then re-run analyze. ' +
      `If the failure persists, file details at ${ISSUES_URL}/1242.`,
  },

  // optionalDependencies — may be absent on platforms without prebuilds
  // or when users skip optional installs.
  [SupportedLanguages.Swift]: {
    packageName: 'tree-sitter-swift',
    load() {
      return requireVendoredGrammar(this.packageName);
    },
    optional: true,
    userSkippable: true,
    unavailableNote:
      'Swift parsing disabled: vendored `tree-sitter-swift` (under ' +
      '`gitnexus/vendor/tree-sitter-swift`) failed to load. ' +
      'Likely cause: no prebuilt `.node` for this platform/architecture. ' +
      `See ${ISSUES_URL}/1130.`,
  },
  [SupportedLanguages.Dart]: {
    packageName: 'tree-sitter-dart',
    load() {
      return requireVendoredGrammar(this.packageName);
    },
    optional: true,
    userSkippable: true,
    unavailableNote:
      'Dart parsing disabled: vendored `tree-sitter-dart` (under ' +
      '`gitnexus/vendor/tree-sitter-dart`) failed to load. ' +
      'Likely cause: native compile failed at install (missing python3/make/g++). ' +
      `See ${ISSUES_URL}/1125.`,
  },
  [SupportedLanguages.Kotlin]: {
    packageName: 'tree-sitter-kotlin',
    load() {
      return requireVendoredGrammar(this.packageName);
    },
    optional: true,
    userSkippable: true,
    unavailableNote:
      'Kotlin parsing disabled: vendored `tree-sitter-kotlin` (under ' +
      '`gitnexus/vendor/tree-sitter-kotlin`) failed to load. ' +
      'Likely cause: no prebuilt `.node` for this platform/architecture. ' +
      `See ${ISSUES_URL}/2107.`,
  },
  [SupportedLanguages.Zig]: {
    packageName: 'tree-sitter-zig',
    load() {
      return requireVendoredGrammar(this.packageName);
    },
    optional: true,
    userSkippable: true,
    unavailableNote:
      'Zig parsing disabled: vendored `tree-sitter-zig` (under ' +
      '`gitnexus/vendor/tree-sitter-zig`) failed to load. ' +
      'Likely cause: no prebuilt `.node` for this platform/architecture.',
  },
};
