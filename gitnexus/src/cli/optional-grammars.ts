/**
 * Optional grammar availability check.
 *
 * tree-sitter-dart, -proto, -swift, and -kotlin are vendored under vendor/ and
 * loaded from there by absolute path (NEVER copied into node_modules — see
 * core/tree-sitter/vendored-grammars.ts / #2111). Each ships committed platform
 * prebuilds activated via node-gyp-build. All can be skipped via
 * GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 (postinstall scripts), or can silently
 * soft-fail when no prebuild matches the host platform (and a source build was
 * unavailable / not attempted).
 *
 * Either path produces the same observable: the .node binding is absent
 * at runtime. This helper detects that condition and surfaces a single
 * stderr line per missing grammar so users learn why .dart/.proto/.swift/.kt
 * support is unavailable instead of silently getting a degraded index.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { isGrammarRuntimeSkipped } from '../core/tree-sitter/parser-loader.js';
import { requireVendoredGrammar } from '../core/tree-sitter/vendored-grammars.js';
import { cliWarn } from './cli-message.js';

interface OptionalGrammar {
  /** Display name in warnings */
  name: string;
  /** Vendored grammar package name (directory under vendor/) */
  pkg: string;
  /** File extensions this grammar parses */
  extensions: string[];
  /**
   * SupportedLanguages id, when this grammar backs an ingestion language.
   * Used to ask `isGrammarRuntimeSkipped` whether the grammar was disabled via
   * `GITNEXUS_SKIP_OPTIONAL_GRAMMARS` (vs. genuinely missing). Omitted for
   * `.proto`, which is a gRPC-extractor concern, not a SupportedLanguages.
   */
  language?: SupportedLanguages;
}

const OPTIONAL_GRAMMARS: OptionalGrammar[] = [
  {
    name: 'tree-sitter-dart',
    pkg: 'tree-sitter-dart',
    extensions: ['.dart'],
    language: SupportedLanguages.Dart,
  },
  { name: 'tree-sitter-proto', pkg: 'tree-sitter-proto', extensions: ['.proto'] },
  {
    name: 'tree-sitter-swift',
    pkg: 'tree-sitter-swift',
    extensions: ['.swift'],
    language: SupportedLanguages.Swift,
  },
  {
    name: 'tree-sitter-kotlin',
    pkg: 'tree-sitter-kotlin',
    extensions: ['.kt', '.kts'],
    language: SupportedLanguages.Kotlin,
  },
];

/**
 * The file extensions backed by an optional grammar — the single source for
 * the `analyze` preflight glob (so the glob can't drift from this list).
 */
export function getOptionalGrammarExtensions(): string[] {
  return [...new Set(OPTIONAL_GRAMMARS.flatMap((g) => g.extensions))];
}

export interface MissingGrammar {
  name: string;
  extensions: string[];
  /**
   * `missing` — the native binding could not be loaded (not installed / build
   * soft-failed / no prebuild). `skipped` — the binding is fine but the user
   * disabled it via `GITNEXUS_SKIP_OPTIONAL_GRAMMARS`. Drives the warning text
   * so a deliberate opt-out is not told to reinstall.
   */
  reason: 'missing' | 'skipped';
}

/**
 * Returns the list of optional grammars whose native binding cannot be
 * loaded. Actually `require()`s the package — `require.resolve` would
 * locate the entry path even when the `.node` binding is absent (the
 * package directory exists without a working `.node` binding), giving false
 * negatives for the exact users we want to warn:
 * those who installed with `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` or whose
 * native rebuild soft-failed for missing toolchain.
 *
 * Node's module cache memoizes `require()` for us — calling this multiple
 * times is cheap. The catch distinguishes "missing" (MODULE_NOT_FOUND or
 * the typical node-gyp-build "could not find any binding" pattern) from
 * "broken" (SyntaxError, EACCES, native crash). Broken bindings surface a
 * separate stderr line so users get an actionable message instead of a
 * misleading "reinstall" hint.
 */
export function detectMissingOptionalGrammars(): MissingGrammar[] {
  const missing: MissingGrammar[] = [];
  for (const g of OPTIONAL_GRAMMARS) {
    // Deliberate runtime opt-out comes first: even an installed binding is
    // treated as unavailable, with a `skipped` reason so the warning says so
    // instead of suggesting a reinstall (#2101 review).
    if (g.language !== undefined && isGrammarRuntimeSkipped(g.language)) {
      missing.push({ name: g.name, extensions: g.extensions, reason: 'skipped' });
      continue;
    }
    try {
      requireVendoredGrammar(g.pkg);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      const looksMissing =
        code === 'MODULE_NOT_FOUND' ||
        code === 'ERR_MODULE_NOT_FOUND' ||
        /could not find|no native build|prebuilds/i.test(msg);
      if (!looksMissing) {
        // Present but broken — surface so the user doesn't get a misleading
        // "reinstall" recovery message that wouldn't actually help. cliWarn
        // writes plain text to stderr AND tees a structured logger.warn
        // record; the merged repo-wide ESLint pino-migration rule forbids
        // direct `console.error` in CLI code (only `console.log` is allowed
        // there for tool-data stdout output).
        cliWarn(
          `GitNexus: optional grammar "${g.name}" is installed but failed to load (${msg.slice(0, 200)}). ${g.extensions.join('/')} files will not be parsed.`,
          { grammar: g.name, extensions: g.extensions, error: msg },
        );
      }
      missing.push({ name: g.name, extensions: g.extensions, reason: 'missing' });
    }
  }
  return missing;
}

/**
 * Log a one-line stderr warning for each missing grammar. Safe to call
 * unconditionally — silent if all grammars are present.
 *
 * `relevantExtensions`, if provided, filters the warning to grammars whose
 * extensions appear in the set (e.g. an analyze run can pass the set of
 * extensions actually present in the target repo so users without any
 * .dart/.proto files don't see noise).
 */
export function warnMissingOptionalGrammars(opts?: {
  context?: string;
  relevantExtensions?: ReadonlySet<string>;
}): void {
  const missing = detectMissingOptionalGrammars();
  if (missing.length === 0) return;
  const ctx = opts?.context ? ` [${opts.context}]` : '';
  // Hoist the optional set into a local so the closure below can narrow
  // its type; references to `opts?.relevantExtensions` inside `.some()`
  // lose the outer null-check narrowing and require a non-null assertion.
  const relevantExtensions = opts?.relevantExtensions;
  for (const g of missing) {
    if (relevantExtensions && !g.extensions.some((e) => relevantExtensions.has(e))) {
      continue;
    }
    const exts = g.extensions.join('/');
    const message =
      g.reason === 'skipped'
        ? `GitNexus${ctx}: optional grammar "${g.name}" is disabled via GITNEXUS_SKIP_OPTIONAL_GRAMMARS — ${exts} files will not be parsed. Unset the variable to re-enable.`
        : `GitNexus${ctx}: optional grammar "${g.name}" is unavailable — ${exts} files will not be parsed. Reinstall without GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 (and ensure python3, make, g++) to enable.`;
    cliWarn(message, {
      grammar: g.name,
      extensions: g.extensions,
      reason: g.reason,
      context: opts?.context,
    });
  }
}
