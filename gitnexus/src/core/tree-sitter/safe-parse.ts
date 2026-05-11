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
 * Optional per-parse timeout, opt-in via `GITNEXUS_PARSE_TIMEOUT_MICROS`.
 *
 * When unset (default) the parser has no timeout — behaviour is identical to
 * previous versions. When set to a positive integer, `parser.setTimeoutMicros`
 * is applied before each parse so tree-sitter aborts long-running parses
 * cooperatively (returning `null` from `parse()`); this wrapper then converts
 * the `null` into a catchable `ParseTimeoutError`, which existing callers in
 * `call-processor.ts` already handle by skipping the file.
 *
 * Motivation: on large repos the worker-pool idle timeout can fire while
 * tree-sitter is blocked inside a sync `parser.parse()` on a pathological
 * file. The replacement path (`worker.terminate()`) then races the native
 * parser and surfaces as `libc++abi: terminating due to uncaught exception
 * of type Napi::Error`, killing the analysis run. Setting a per-parse
 * timeout slightly below the worker idle timeout lets the parser abort
 * cleanly before the pool tries to terminate it.
 */
const readParseTimeoutMicros = (): number => {
  const raw = process.env.GITNEXUS_PARSE_TIMEOUT_MICROS;
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

export class ParseTimeoutError extends Error {
  constructor(timeoutMicros: number, sourceLength: number) {
    super(
      `tree-sitter parse exceeded GITNEXUS_PARSE_TIMEOUT_MICROS=${timeoutMicros} ` +
        `(source length ${sourceLength} chars).`,
    );
    this.name = 'ParseTimeoutError';
  }
}

const applyAndClearTimeout = <T>(parser: Parser, timeoutMicros: number, run: () => T): T => {
  if (timeoutMicros <= 0) return run();
  parser.setTimeoutMicros(timeoutMicros);
  try {
    return run();
  } finally {
    parser.setTimeoutMicros(0);
  }
};

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
  const timeoutMicros = readParseTimeoutMicros();
  const tree = applyAndClearTimeout(parser, timeoutMicros, () => {
    if (sourceText.length <= DIRECT_PARSE_LIMIT_CHARS) {
      return parser.parse(sourceText, oldTree, options);
    }
    const input: Parser.Input = (index) => {
      if (index >= sourceText.length) return null;
      return sourceText.slice(index, index + SAFE_PARSE_CHUNK_CHARS);
    };
    return parser.parse(input, oldTree, options);
  });
  if (!tree) throw new ParseTimeoutError(timeoutMicros, sourceText.length);
  return tree;
}
