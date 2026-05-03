import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import { SupportedLanguages } from 'gitnexus-shared';

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
interface GrammarSource {
  load: () => unknown;
  unavailableNote: string;
  optional?: boolean;
  severity?: 'warn' | 'error';
}

const ISSUES_URL = 'https://github.com/abhigyanpatwari/GitNexus/issues';

const SOURCES: Record<string, GrammarSource> = {
  [SupportedLanguages.JavaScript]: {
    load: () => _require('tree-sitter-javascript'),
    unavailableNote:
      'JavaScript parsing requires `tree-sitter-javascript`. ' +
      'Check that the package and its native binding installed cleanly (`npm ci`).',
  },
  [SupportedLanguages.TypeScript]: {
    load: () => _require('tree-sitter-typescript').typescript,
    unavailableNote:
      'TypeScript parsing requires `tree-sitter-typescript`. ' +
      'Check that the package and its native binding installed cleanly (`npm ci`).',
  },
  [`${SupportedLanguages.TypeScript}:tsx`]: {
    load: () => _require('tree-sitter-typescript').tsx,
    unavailableNote:
      'TSX parsing requires `tree-sitter-typescript` (re-uses the same native binding as TS).',
  },
  [SupportedLanguages.Python]: {
    load: () => _require('tree-sitter-python'),
    unavailableNote:
      'Python parsing requires `tree-sitter-python`. Check the install and native binding.',
  },
  [SupportedLanguages.Java]: {
    load: () => _require('tree-sitter-java'),
    unavailableNote:
      'Java parsing requires `tree-sitter-java`. Check the install and native binding.',
  },
  // tree-sitter-c-sharp declares `type: "module"` with `main: "bindings/node"`
  // (no extension) and no `exports` field, which triggers Node 22's DEP0151
  // deprecation warning on the bare-package import. The explicit subpath
  // bypasses the deprecated ESM main-field resolution. (#1013)
  [SupportedLanguages.CSharp]: {
    load: () => _require('tree-sitter-c-sharp/bindings/node/index.js'),
    unavailableNote:
      'C# parsing requires `tree-sitter-c-sharp/bindings/node/index.js`. ' +
      `If the subpath is missing, see ${ISSUES_URL}/1013.`,
  },
  [SupportedLanguages.CPlusPlus]: {
    load: () => _require('tree-sitter-cpp'),
    unavailableNote:
      'C++ parsing requires `tree-sitter-cpp`. Check the install and native binding.',
  },
  [SupportedLanguages.Go]: {
    load: () => _require('tree-sitter-go'),
    unavailableNote: 'Go parsing requires `tree-sitter-go`. Check the install and native binding.',
  },
  [SupportedLanguages.Rust]: {
    load: () => _require('tree-sitter-rust'),
    unavailableNote:
      'Rust parsing requires `tree-sitter-rust`. Check the install and native binding.',
  },
  [SupportedLanguages.PHP]: {
    load: () => _require('tree-sitter-php').php_only,
    unavailableNote:
      'PHP parsing requires `tree-sitter-php` (the `php_only` export). ' +
      'Check the install and native binding.',
  },
  [SupportedLanguages.Ruby]: {
    load: () => _require('tree-sitter-ruby'),
    unavailableNote:
      'Ruby parsing requires `tree-sitter-ruby`. Check the install and native binding.',
  },
  [SupportedLanguages.Vue]: {
    load: () => _require('tree-sitter-typescript').typescript,
    unavailableNote:
      'Vue parsing piggybacks on `tree-sitter-typescript`. Check the install and native binding.',
  },

  // tree-sitter-c is a required dependency, but its native binding has
  // historically been ABI-incompatible with the bundled tree-sitter@0.21.1
  // runtime on some platforms (#1242, #858). Loading it through the
  // optional machinery turns a would-be segfault into a clean degradation
  // while preserving every other language's analysis. Severity is pinned
  // to `error` because the package is in `dependencies`: a failure here
  // is always an install/platform problem the user needs to see, never an
  // expected "user opted out" condition like Swift/Dart/Kotlin.
  [SupportedLanguages.C]: {
    load: () => _require('tree-sitter-c'),
    optional: true,
    severity: 'error',
    unavailableNote:
      'C parsing disabled: `tree-sitter-c` could not be loaded. ' +
      'This package is in `dependencies` and prebuilds ship for all supported ' +
      'platforms (win32/darwin/linux x64+arm64, Node 18/20/22), so this ' +
      'usually indicates a corrupted install, an unsupported Node version, ' +
      'or a native ABI mismatch with the bundled tree-sitter runtime. ' +
      'Try `npm rebuild tree-sitter-c` or reinstalling, then re-run analyze. ' +
      `If the failure persists, file details at ${ISSUES_URL}/1242.`,
  },

  // optionalDependencies — may be absent on platforms without prebuilds
  // or when users skip optional installs.
  [SupportedLanguages.Swift]: {
    load: () => _require('tree-sitter-swift'),
    optional: true,
    unavailableNote:
      'Swift parsing disabled: vendored `tree-sitter-swift` (under ' +
      '`gitnexus/vendor/tree-sitter-swift`) failed to load. ' +
      'Likely cause: no prebuilt `.node` for this platform/architecture. ' +
      `See ${ISSUES_URL}/1130.`,
  },
  [SupportedLanguages.Dart]: {
    load: () => _require('tree-sitter-dart'),
    optional: true,
    unavailableNote:
      'Dart parsing disabled: vendored `tree-sitter-dart` (under ' +
      '`gitnexus/vendor/tree-sitter-dart`) failed to load. ' +
      'Likely cause: native compile failed at install (missing python3/make/g++). ' +
      `See ${ISSUES_URL}/1125.`,
  },
  [SupportedLanguages.Kotlin]: {
    load: () => _require('tree-sitter-kotlin'),
    optional: true,
    unavailableNote:
      'Kotlin parsing disabled: `tree-sitter-kotlin` is an optionalDependency ' +
      'and is not installed (or its native binding failed to build).',
  },
};

type LoadResult =
  | { ok: true; grammar: unknown }
  | { ok: false; error: Error; note: string; fatal: boolean; severity: 'warn' | 'error' };

const loadCache = new Map<string, LoadResult>();
const logged = new Set<string>();

const logFailure = (key: string, result: LoadResult): void => {
  if (result.ok === true) return;
  if (logged.has(key)) return;
  logged.add(key);
  const message = `[gitnexus] ${result.note} (${result.error.message})`;

  if (result.severity === 'error') console.error(message);
  else console.warn(message);
};

export const resolveLanguageKey = (language: SupportedLanguages, filePath?: string): string =>
  language === SupportedLanguages.TypeScript && filePath?.endsWith('.tsx')
    ? `${language}:tsx`
    : language;

const loadGrammar = (key: string): LoadResult => {
  const cached = loadCache.get(key);
  if (cached) return cached;

  const source = SOURCES[key];
  if (!source) {
    const result: LoadResult = {
      ok: false,
      error: new Error(`Unsupported language: ${key}`),
      note: `No grammar registered for language key \`${key}\`. Add a row to SOURCES.`,
      fatal: true,
      severity: 'error',
    };
    loadCache.set(key, result);
    return result;
  }

  let result: LoadResult;
  try {
    result = { ok: true, grammar: source.load() };
  } catch (err) {
    const fatal = !source.optional;
    result = {
      ok: false,
      error: err as Error,
      note: source.unavailableNote,
      fatal,
      severity: source.severity ?? (fatal ? 'error' : 'warn'),
    };
  }
  loadCache.set(key, result);
  if (result.ok === false) logFailure(key, result);
  return result;
};

export const isLanguageAvailable = (language: SupportedLanguages, filePath?: string): boolean =>
  loadGrammar(resolveLanguageKey(language, filePath)).ok;

export const getLanguageGrammar = (language: SupportedLanguages, filePath?: string): unknown => {
  const key = resolveLanguageKey(language, filePath);
  const result = loadGrammar(key);
  if (result.ok === true) return result.grammar;
  // Fatal failures throw the original underlying error (preserving stack)
  // after the note has been logged. Optional failures fall through to the
  // standard "Unsupported language" message that callers already handle.
  if (result.fatal) throw result.error;
  throw new Error(`Unsupported language: ${language}`);
};

let sharedParser: Parser | null = null;

export const loadParser = async (): Promise<Parser> => (sharedParser ??= new Parser());

export const loadLanguage = async (
  language: SupportedLanguages,
  filePath?: string,
): Promise<void> => {
  const parser = await loadParser();
  parser.setLanguage(getLanguageGrammar(language, filePath));
};

export const createParserForLanguage = async (
  language: SupportedLanguages,
  filePath?: string,
): Promise<Parser> => {
  const parser = new Parser();
  parser.setLanguage(getLanguageGrammar(language, filePath));
  return parser;
};
