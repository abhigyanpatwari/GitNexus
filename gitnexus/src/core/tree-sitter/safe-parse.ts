import type Parser from 'tree-sitter';

import { logger } from '../logger.js';

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
 * Default per-parse wall-clock budget in milliseconds. A pathological input
 * (deeply nested / quadratic-grammar source) can spin tree-sitter for tens of
 * seconds, stalling the worker that holds it. The pool's per-dispatch idle
 * timeout is 30 s (`DEFAULT_SUB_BATCH_IDLE_TIMEOUT_MS` in
 * `workers/worker-pool.ts`); this budget MUST stay below it so a single bad
 * file is hard-skipped here rather than tripping the slower pool-level
 * retry/respawn machinery. 15 s leaves comfortable headroom.
 *
 * Override via `GITNEXUS_PARSE_TIMEOUT_MS`; `0` disables the budget entirely
 * (unlimited parse time — restore the historical behaviour for debugging).
 */
const DEFAULT_PARSE_TIMEOUT_MS = 15_000;

/**
 * Resolve the per-parse budget in milliseconds from the environment. A
 * non-negative integer overrides the default; `0` disables the timeout.
 * Unparseable / negative values fall back to the default rather than
 * silently disabling the safety net.
 */
function resolveParseTimeoutMs(): number {
  const raw = process.env.GITNEXUS_PARSE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_PARSE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PARSE_TIMEOUT_MS;
  return Math.floor(parsed);
}

/**
 * Minimal surface of the timeout knob we depend on. tree-sitter@0.21.x
 * exposes `setTimeoutMicros(micros)`; the parse returns `null` once the
 * budget is exceeded and the parser must be `reset()` before reuse.
 */
interface TimeoutCapableParser {
  setTimeoutMicros?: (micros: number) => void;
  reset?: () => void;
}

/**
 * Tiny shim around the runtime's parse-interruption knob so the future
 * 0.25/0.26 swap (where `setTimeoutMicros` is removed in favour of
 * `Parser.Options.progressCallback`) is a single-function change.
 *
 * Returns `true` when a budget was armed (caller must clear it afterwards),
 * `false` when the runtime offers no interruption mechanism (older/newer
 * runtimes) so the caller can skip the reset/clear dance.
 *
 * Only the `setTimeoutMicros` branch is implemented today; add the
 * `progressCallback` branch here when the runtime moves to 0.25+.
 */
function armParseBudget(parser: Parser, budgetMs: number): boolean {
  if (budgetMs <= 0) return false;
  const cap = parser as unknown as TimeoutCapableParser;
  if (typeof cap.setTimeoutMicros !== 'function') return false;
  cap.setTimeoutMicros(Math.floor(budgetMs * 1000));
  return true;
}

/**
 * Clear any armed parse budget so it never leaks to the next parse on a
 * reused/singleton parser. Safe to call when nothing was armed.
 */
function clearParseBudget(parser: Parser): void {
  const cap = parser as unknown as TimeoutCapableParser;
  cap.setTimeoutMicros?.(0);
}

/**
 * Reset parser state after a timeout. tree-sitter RESUMES the interrupted
 * parse on the next `parse()` call unless `reset()` is invoked first
 * (tree-sitter `api.h`); skipping this corrupts the next file's tree on the
 * shared singleton.
 */
function resetParser(parser: Parser): void {
  (parser as unknown as TimeoutCapableParser).reset?.();
}

/**
 * Thrown when a parse exceeds its wall-clock budget (see
 * {@link DEFAULT_PARSE_TIMEOUT_MS}). The parser has already been `reset()` and
 * its budget cleared by the time this propagates, so callers may safely reuse
 * the same parser for the next file.
 *
 * Hard-skip contract: a timeout is fatal for the offending file but MUST NOT
 * abort the run. Every caller is responsible for catching this specific error
 * (`instanceof ParseTimeoutError`), skipping that one file (degrade-and-
 * continue), and re-throwing anything else. Catching it generically and
 * swallowing all errors would mask real bugs, so callers match on the type.
 */
export class ParseTimeoutError extends Error {
  readonly budgetMs: number;
  readonly label?: string;

  constructor(budgetMs: number, label?: string) {
    super(
      `tree-sitter parse exceeded its ${budgetMs}ms budget` +
        (label ? ` while parsing ${label}` : '') +
        ' (set GITNEXUS_PARSE_TIMEOUT_MS=0 to disable, or raise the budget)',
    );
    this.name = 'ParseTimeoutError';
    this.budgetMs = budgetMs;
    this.label = label;
  }
}

/**
 * Per-run counter so a corpus full of minor-error files emits a bounded
 * number of degraded-parse logs instead of one per file. The count is
 * reported on the throttled records so operators still see the true scale.
 */
let degradedParseCount = 0;
const DEGRADED_PARSE_LOG_LIMIT = 20;

/**
 * Reset the per-run degraded-parse log throttle. Called at the start of every
 * analysis run (`runFullAnalysis`) so the first-N-then-suppress budget is
 * scoped to a single run rather than to the lifetime of the module (which, on
 * a reused process, would suppress all degraded-parse logs after the first
 * run). Safe to call at any time.
 */
export function resetDegradedParseCounter(): void {
  degradedParseCount = 0;
}

/**
 * @internal Test-only alias for {@link resetDegradedParseCounter}, kept so the
 * existing `safe-parse.test.ts` import keeps working. Prefer the public name.
 */
export function _resetDegradedParseCounter(): void {
  resetDegradedParseCounter();
}

/**
 * True when the parsed tree contains any ERROR or MISSING node — i.e. the
 * source did not parse cleanly and tree-sitter applied error recovery.
 * `parse` never throws on bad syntax (it recovers into ERROR/MISSING nodes),
 * so this is the only signal callers have that a tree is degraded.
 */
export function parseHadErrors(tree: Parser.Tree): boolean {
  const root = tree.rootNode;
  if (root == null) return false;
  return root.hasError || root.isMissing;
}

/**
 * Structured diagnostics for a parsed tree. Cheap (reads boolean node
 * properties only); callers that just want a yes/no use {@link parseHadErrors}.
 */
export function getParseDiagnostics(tree: Parser.Tree): {
  hasError: boolean;
  isMissing: boolean;
} {
  const root = tree.rootNode;
  if (root == null) return { hasError: false, isMissing: false };
  return { hasError: root.hasError, isMissing: root.isMissing };
}

/**
 * Parse `sourceText` safely on every platform.
 *
 * This is the single "parse safely" entry point and its contract covers three
 * concerns:
 *
 *  1. **Windows crash workaround.** Inputs longer than 32 767 chars are fed
 *     through the chunked `Parser.Input` callback overload to dodge the
 *     0.21.x string-to-buffer SIGSEGV. See {@link SAFE_PARSE_CHUNK_CHARS}.
 *
 *  2. **Runaway-parse timeout.** A per-parse budget (default 15 s, env
 *     `GITNEXUS_PARSE_TIMEOUT_MS`, `0` disables) is armed before parsing on
 *     both the direct and chunked paths. On timeout the runtime returns
 *     `null`; this function `reset()`s the parser, clears the budget, and
 *     throws {@link ParseTimeoutError}. The budget is always cleared in a
 *     `finally` so it never leaks to the next parse on a reused/singleton
 *     parser (`loadParser()` and the worker both reuse one `Parser`).
 *
 *  3. **Intrinsic error detection.** On a successful parse, a degraded tree
 *     (`rootNode.hasError`) is logged at `debug` level with throttling, then
 *     the tree is **returned anyway** — error recovery is a downgrade, never a
 *     drop. Callers wanting the boolean use {@link parseHadErrors}.
 *
 * @param label optional context (e.g. file path) attached to timeout errors
 *   and degraded-parse logs. Non-breaking trailing param.
 */
export function parseSourceSafe(
  parser: Parser,
  sourceText: string,
  oldTree?: Parser.Tree,
  options?: Parser.Options,
  label?: string,
): Parser.Tree {
  const budgetMs = resolveParseTimeoutMs();
  const armed = armParseBudget(parser, budgetMs);

  let tree: Parser.Tree | null;
  try {
    if (sourceText.length <= DIRECT_PARSE_LIMIT_CHARS) {
      tree = parser.parse(sourceText, oldTree, options);
    } else {
      const input: Parser.Input = (index) => {
        if (index >= sourceText.length) return null;
        return sourceText.slice(index, index + SAFE_PARSE_CHUNK_CHARS);
      };
      tree = parser.parse(input, oldTree, options);
    }
  } finally {
    // Always clear the budget — otherwise it leaks onto the next parse on a
    // reused singleton parser, prematurely killing an innocent file.
    if (armed) clearParseBudget(parser);
  }

  // A `null` return means the runtime hit the budget mid-parse. The parser
  // would otherwise RESUME this parse on the next call, so reset it before
  // surfacing the timeout as a typed throw (callers skip the file).
  if (tree === null) {
    if (armed) resetParser(parser);
    throw new ParseTimeoutError(budgetMs, label);
  }

  // Intrinsic ERROR detection. tree-sitter recovers from bad syntax into
  // ERROR/MISSING nodes rather than throwing, so a clean return can still
  // wrap a degraded tree. Log it (throttled, debug-level so common minor
  // errors don't flood) but DOWNGRADE — never drop — and return the tree.
  //
  // Guard `rootNode` defensively: a real tree-sitter tree always exposes one,
  // but stub parsers in tests (and any future non-standard `Parser.Tree`) may
  // not. A missing root is treated as "no detectable errors" so detection
  // never throws on the parse success path.
  if (tree.rootNode != null && parseHadErrors(tree)) {
    degradedParseCount += 1;
    if (degradedParseCount <= DEGRADED_PARSE_LOG_LIMIT) {
      logger.debug(
        {
          ...(label ? { file: label } : {}),
          rootType: tree.rootNode.type,
          degradedParseCount,
          ...(degradedParseCount === DEGRADED_PARSE_LOG_LIMIT
            ? { note: 'further degraded-parse logs suppressed this run' }
            : {}),
        },
        'tree-sitter parsed with errors (degraded tree)',
      );
    }
  }

  return tree;
}
