import Parser from 'tree-sitter';

/**
 * Shared, language-agnostic tree-sitter scanning utilities used by group
 * extractors (topic, http, grpc, ...).
 *
 * Design goals:
 *  - The top-level extractors must not import any tree-sitter grammar.
 *  - Per-language plugins own their grammar import, their query sources,
 *    and the mapping from capture → meta.
 *  - This module provides the plumbing: compile queries once per plugin,
 *    parse a file with a given grammar, run all patterns, and return the
 *    captured `string_literal`-style nodes together with the plugin's meta.
 */

/**
 * One pattern owned by a language plugin. Each pattern owns a tree-sitter
 * S-expression query. Plugins can freely choose which capture names to
 * use — the scanner exposes every capture in the returned `captures`
 * map and does not privilege any particular name.
 *
 * `TMeta` is the plugin-specific payload the orchestrator receives back
 * when this pattern matches — e.g. for topic extraction it carries the
 * broker name, role, confidence, symbol name.
 */
export interface PatternSpec<TMeta> {
  /** Tree-sitter S-expression. */
  query: string;
  /** Plugin-specific payload returned on every match. */
  meta: TMeta;
}

/**
 * A set of patterns owned by one language plugin, bound to a specific
 * tree-sitter grammar.
 *
 * `language` is typed as `unknown` because tree-sitter's TypeScript
 * declarations use `any` for the grammar object, and the grammar modules
 * export different shapes (plain grammar vs. namespace with `typescript`
 * / `tsx` members). Callers pass the concrete grammar object; this
 * module forwards it to `parser.setLanguage` / `new Parser.Query`.
 */
export interface LanguagePatterns<TMeta> {
  /** Human-readable plugin name for diagnostics. */
  name: string;
  /** tree-sitter grammar object. */
  language: unknown;
  /** Patterns authored against `language`. */
  patterns: PatternSpec<TMeta>[];
}

/**
 * Compiled form of a `LanguagePatterns` bundle. Queries are compiled
 * eagerly at module load time so a broken grammar/query pair fails
 * loudly the first time the plugin is imported, instead of silently
 * at scan time when no contract is produced.
 */
export interface CompiledPatterns<TMeta> {
  name: string;
  language: unknown;
  patterns: CompiledPattern<TMeta>[];
}

export interface CompiledPattern<TMeta> {
  query: Parser.Query;
  meta: TMeta;
}

/**
 * Map from capture name → syntax node. Every named capture the query
 * binds is exposed as an entry. If a query captures the same name more
 * than once (unusual), the first occurrence wins — plugins that need
 * all occurrences should use distinct capture names or fall back to
 * `match.captures` array directly by iterating `query.matches()`
 * themselves.
 */
export type CaptureMap = Record<string, Parser.SyntaxNode>;

/**
 * One match returned by `scanFile` / `runCompiledPatterns`. The caller
 * receives the full capture map plus the plugin meta, and is
 * responsible for turning it into a domain object.
 */
export interface ScanMatch<TMeta> {
  meta: TMeta;
  captures: CaptureMap;
}

/**
 * Compile a LanguagePatterns bundle. Call this once per plugin, at
 * module load time, and export the result. Throws if any pattern
 * fails to compile against the grammar — that's a bug in the plugin
 * author's query, not a runtime condition.
 */
export function compilePatterns<TMeta>(bundle: LanguagePatterns<TMeta>): CompiledPatterns<TMeta> {
  const compiled: CompiledPattern<TMeta>[] = [];
  for (const spec of bundle.patterns) {
    try {
      const query = new Parser.Query(bundle.language, spec.query);
      compiled.push({ query, meta: spec.meta });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[tree-sitter-scanner] Failed to compile pattern in ${bundle.name}: ${message}\n` +
          `Query source:\n${spec.query}`,
      );
    }
  }
  return { name: bundle.name, language: bundle.language, patterns: compiled };
}

/**
 * Run every compiled pattern in `plugin` against an already-parsed
 * tree. Use this when a plugin needs multiple query bundles against
 * the same file (e.g. one query for class-level prefixes and another
 * for method-level annotations) and wants to avoid re-parsing.
 */
export function runCompiledPatterns<TMeta>(
  plugin: CompiledPatterns<TMeta>,
  tree: Parser.Tree,
): ScanMatch<TMeta>[] {
  const out: ScanMatch<TMeta>[] = [];
  for (const compiled of plugin.patterns) {
    let matches: Parser.QueryMatch[];
    try {
      matches = compiled.query.matches(tree.rootNode);
    } catch {
      continue;
    }
    for (const match of matches) {
      const captures: CaptureMap = {};
      for (const cap of match.captures) {
        if (!(cap.name in captures)) captures[cap.name] = cap.node;
      }
      out.push({ meta: compiled.meta, captures });
    }
  }
  return out;
}

/**
 * Parse `content` with the plugin's grammar and run every compiled
 * pattern against the AST. Returns one `ScanMatch` per matched query
 * occurrence, carrying the plugin's meta payload.
 *
 * Errors are swallowed at the file level (malformed file must not abort
 * the whole extract). Individual pattern failures are swallowed too so
 * a single unusable query doesn't block the rest of the plugin.
 */
export function scanFile<TMeta>(
  parser: Parser,
  plugin: CompiledPatterns<TMeta>,
  content: string,
): ScanMatch<TMeta>[] {
  let tree: Parser.Tree;
  try {
    parser.setLanguage(plugin.language);
    tree = parser.parse(content);
  } catch {
    return [];
  }
  return runCompiledPatterns(plugin, tree);
}

/**
 * Strip enclosing quotes from a tree-sitter string literal node's text.
 * Handles single / double / template quotes, Python triple-quoted strings,
 * and Go raw string literals (backticks).
 *
 * Returns null for empty/nullish input so callers can uniformly skip
 * captures whose value is missing.
 */
export function unquoteLiteral(raw: string): string | null {
  if (!raw) return null;

  // Python triple-quoted
  if (
    (raw.startsWith('"""') && raw.endsWith('"""')) ||
    (raw.startsWith("'''") && raw.endsWith("'''"))
  ) {
    return raw.slice(3, -3);
  }

  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' || first === "'" || first === '`') && last === first && raw.length >= 2) {
    return raw.slice(1, -1);
  }

  // Some grammars expose the string content without quotes already (e.g.
  // Python `string_content` child). Return as-is.
  return raw;
}
