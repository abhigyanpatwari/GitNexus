import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';

import { logger } from '../logger.js';
import {
  GRAMMAR_SOURCES as SOURCES,
  isGrammarSkipped,
  parseGrammarSkipDirective,
  type GrammarSkipDirective,
  type GrammarSource,
} from './grammar-sources.js';

/**
 * Introspection over the grammar registry for the ABI load-smoke test
 * (`test/unit/parser-loader-abi.test.ts`, #1922). Returns one descriptor per
 * `SOURCES` row — including the `:tsx` variant — so the smoke can assert that
 * EVERY registered grammar loads (required) or "loads OR cleanly reports
 * unavailable" (optional/vendored). Derived from `SOURCES` so adding a grammar
 * automatically widens the smoke's coverage with no second list to maintain.
 */
export interface GrammarSourceDescriptor {
  key: string;
  optional: boolean;
}

export const listGrammarSources = (): GrammarSourceDescriptor[] =>
  Object.entries(SOURCES).map(([key, source]) => ({
    key,
    optional: source.optional === true,
  }));

type LoadResult =
  | { ok: true; grammar: unknown }
  | { ok: false; error: Error; note: string; fatal: boolean; severity: 'warn' | 'error' };

const loadCache = new Map<string, LoadResult>();
const logged = new Set<string>();

/**
 * Runtime opt-out for genuinely-optional grammars (Swift/Dart/Kotlin).
 *
 * `GITNEXUS_SKIP_OPTIONAL_GRAMMARS` has historically been an *install-time*
 * env only — the postinstall build scripts read it to skip building the
 * vendored grammars. There was no way to disable an optional grammar at
 * analyze time, so users on a platform with a broken/partial binding had no
 * escape hatch short of uninstalling the package (#2091, #2093). This honors
 * the same env name at runtime: when set, the named optional grammars report
 * as unavailable and the pipeline skips their files (mirroring a genuinely
 * absent binding) instead of attempting to load them.
 *
 * Accepts `1` / `true` / `all` / `*` (every skippable grammar), or a
 * comma-separated list of language ids and/or package names
 * (e.g. `swift,tree-sitter-dart`). Only grammars flagged `userSkippable` (the
 * genuinely-optional swift/dart/kotlin) can be skipped — required dependencies
 * routed through the optional machinery for ABI safety (C) carry no
 * `userSkippable` and are never skippable here.
 */
// Parsed form of GITNEXUS_SKIP_OPTIONAL_GRAMMARS, resolved lazily ONCE per
// process. The env is set before analyze runs, so re-reading + re-allocating a
// Set on every call was wasted work (and a latent trap for any future per-file
// caller). `vi.resetModules()` gives the unit tests a fresh module — and thus a
// fresh memo — per case, so this stays test-friendly.
//   'all' → every userSkippable grammar; Set → only the named ids
//   (and `tree-sitter-<id>` spellings); null → env unset/empty (nothing).
let _skipDirective: GrammarSkipDirective | undefined;
const skipDirective = (): GrammarSkipDirective => {
  if (_skipDirective !== undefined) return _skipDirective;
  return (_skipDirective = parseGrammarSkipDirective(
    process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS ?? '',
  ));
};

const isRuntimeSkippedGrammar = (key: string, source: GrammarSource): boolean => {
  // Only grammars explicitly flagged user-skippable (swift/dart/kotlin) — never
  // required deps that use the optional machinery for ABI safety (C carries no
  // `userSkippable`).
  if (source.userSkippable !== true) return false;
  return isGrammarSkipped(key, source, skipDirective());
};

const logFailure = (key: string, result: LoadResult): void => {
  if (result.ok === true) return;
  if (logged.has(key)) return;
  logged.add(key);
  const message = `[gitnexus] ${result.note} (${result.error.message})`;

  // Severity routes to the correct pino level. Both go to stderr (pino's
  // default destination), so MCP stdio framing is preserved either way —
  // the level tag drives log filtering, not channel selection.
  if (result.severity === 'error') {
    logger.error(message);
  } else {
    logger.warn(message);
  }
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

  // Runtime opt-out: treat a user-skipped optional grammar exactly like an
  // absent binding (non-fatal unavailable + one warning), without attempting
  // the native load. See `isRuntimeSkippedGrammar`.
  if (isRuntimeSkippedGrammar(key, source)) {
    // Deliberate opt-out: emit an accurate "disabled on purpose" note rather
    // than `source.unavailableNote` (which blames a missing/unbuilt binding and
    // would mislead a user who set the env intentionally — #2101 review).
    const result: LoadResult = {
      ok: false,
      error: new Error('runtime opt-out'),
      note: `${key} parsing disabled via GITNEXUS_SKIP_OPTIONAL_GRAMMARS (unset it to re-enable).`,
      fatal: false,
      severity: 'warn',
    };
    loadCache.set(key, result);
    logFailure(key, result);
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

/**
 * True when `language`'s grammar is being treated as unavailable specifically
 * because of the runtime GITNEXUS_SKIP_OPTIONAL_GRAMMARS opt-out — as opposed
 * to a genuinely-missing/broken native binding. Lets callers surface an
 * accurate "skipped on purpose" message instead of a spurious "npm rebuild"
 * recovery hint. Returns false for required grammars and for an absent env.
 */
export const isGrammarRuntimeSkipped = (
  language: SupportedLanguages,
  filePath?: string,
): boolean => {
  const key = resolveLanguageKey(language, filePath);
  const source = SOURCES[key];
  return source !== undefined && isRuntimeSkippedGrammar(key, source);
};

// Grammars published under a name other than `tree-sitter-<language>`; every other language
// keeps that default in the `npm rebuild` hint.
const REBUILD_PACKAGES: ReadonlyMap<string, string> = new Map([
  [SupportedLanguages.R, '@eagleoutice/tree-sitter-r'],
]);

/** The npm package to name in the `npm rebuild` hint for `language`'s unavailable grammar. */
export const grammarRebuildPackage = (language: string): string =>
  REBUILD_PACKAGES.get(language) ?? `tree-sitter-${language}`;

export const getLanguageGrammar = (
  language: SupportedLanguages,
  filePath?: string,
): Parser.Language => {
  const key = resolveLanguageKey(language, filePath);
  const result = loadGrammar(key);
  if (result.ok === true) return result.grammar as Parser.Language;
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
