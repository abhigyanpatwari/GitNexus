import type Parser from 'tree-sitter';

/**
 * tree-sitter 0.21.x's Node native binding crashes (SIGSEGV) on Windows when
 * `parser.parse(string, …)` is handed a JS string longer than 32 767 chars.
 * The crash happens inside the binding's V8 string-to-buffer conversion and
 * cannot be intercepted from JavaScript. The callback (`Parser.Input`) overload
 * pulls source in fixed-size chunks via repeated callback invocations and
 * bypasses that conversion path entirely.
 *
 * Chunk size is comfortably below the boundary; any value < 32 767 works.
 */
const SAFE_PARSE_CHUNK_CHARS = 16 * 1024;

/**
 * Files at or below this length skip the callback machinery and use the
 * direct string overload — the bug only manifests above the int16 boundary,
 * so small inputs save the cost of N callback invocations per parse.
 */
const DIRECT_PARSE_LIMIT_CHARS = 16 * 1024;

/**
 * Parse `sourceText` safely on every platform. See {@link SAFE_PARSE_CHUNK_CHARS}
 * for the underlying tree-sitter binding bug this works around.
 */
export function parseSourceSafe(
  parser: Parser,
  sourceText: string,
  oldTree?: Parser.Tree,
  options?: Parser.Options,
): Parser.Tree {
  if (sourceText.length <= DIRECT_PARSE_LIMIT_CHARS) {
    return parser.parse(sourceText, oldTree, options);
  }
  const input: Parser.Input = (index) => {
    if (index >= sourceText.length) return null;
    return sourceText.slice(index, index + SAFE_PARSE_CHUNK_CHARS);
  };
  return parser.parse(input, oldTree, options);
}
