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
 * S-expression query. The query MUST contain a capture named `@value`
 * whose node text is the literal we want to extract (string/template/etc).
 *
 * `TMeta` is the plugin-specific payload the orchestrator receives back
 * when this pattern matches — e.g. for topic extraction it carries the
 * broker name, role, confidence, symbol name.
 */
export interface PatternSpec<TMeta> {
  /** Tree-sitter S-expression. MUST contain a `@value` capture. */
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
 * One match returned by `scanFile`. The orchestrator receives the raw
 * literal text (still including any surrounding quotes) together with
 * the plugin meta, and is responsible for calling `unquoteLiteral` /
 * emitting a domain object (ExtractedContract, Route, ...).
 */
export interface ScanMatch<TMeta> {
  meta: TMeta;
  /** The node captured as `@value` (the literal). */
  valueNode: Parser.SyntaxNode;
  /** Raw text of the captured value node — caller must unquote. */
  valueText: string;
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
 * Parse `content` as source code of the plugin's language and run every
 * compiled pattern against the resulting AST. Returns one `ScanMatch` per
 * matched `@value` capture, carrying the plugin's meta payload.
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
  const out: ScanMatch<TMeta>[] = [];
  let tree: Parser.Tree;
  try {
    parser.setLanguage(plugin.language);
    tree = parser.parse(content);
  } catch {
    return out;
  }

  for (const compiled of plugin.patterns) {
    let matches: Parser.QueryMatch[];
    try {
      matches = compiled.query.matches(tree.rootNode);
    } catch {
      continue;
    }
    for (const match of matches) {
      const valueCapture = match.captures.find((c) => c.name === 'value');
      if (!valueCapture) continue;
      out.push({
        meta: compiled.meta,
        valueNode: valueCapture.node,
        valueText: valueCapture.node.text,
      });
    }
  }

  return out;
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
