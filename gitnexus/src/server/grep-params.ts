/**
 * Query-parameter parsing for GET /api/grep.
 *
 * Extracted from api.ts so the contract is unit-testable without pulling
 * Express + the LadybugDB native adapter into the test run (same rationale
 * as the #2790 helper extraction).
 *
 * Contract fix (Patch 12): the grep tool schema in gitnexus-web has always
 * promised regex search with an optional path-substring filter and
 * case-sensitivity control, but the handler used to escapeRegExp() every
 * pattern into a literal substring — an agent asking for "sign|Sign" got
 * zero hits and concluded the code didn't exist, and the schema's own
 * example ("console\.log") could never match. This restores the promised
 * semantics. The literal-only era was accidentally ReDoS-immune; that
 * immunity is knowingly traded back for the promised contract, with the
 * bounded mitigations below. IMPORTANT — what these mitigations do NOT
 * cover: a single catastrophic-backtracking regex.test() blocks the Node
 * event loop synchronously and the wall-clock budget (checked between
 * files, never inside a test) cannot interrupt it; a pattern like
 * (a+)+$ against a 35-char line measurably exceeds 120s. During that
 * window the whole server (all routes + SSE) is unresponsive. Accepted
 * because: local serve binds loopback by default, hosted deploys gate
 * /api/grep behind the edge token (see SECURITY.md), the pattern cap
 * bounds construction cost, line-by-line matching bounds per-test input
 * length, and the result cap bounds total work. The proper fix — running
 * the scan in a worker_threads worker with terminate() on timeout, or an
 * optional re2 dependency — is deliberately out of scope here.
 *   - pattern length cap (200 chars, unchanged from the literal-only era)
 *   - line-by-line matching (each regex.test call sees one source line)
 *   - a wall-clock budget the handler enforces between files
 *   - result cap unchanged (limit, max 200)
 *   - literal=1 opt-out restores the old escaped-substring immunity
 */
import { assertString, escapeRegExp, BadRequestError } from './validation.js';

/** Hard cap on pattern length — unchanged from the literal-only era. */
export const GREP_PATTERN_MAX_LENGTH = 200;

/** Wall-clock budget for one /api/grep call, enforced between files. */
export const GREP_TIME_BUDGET_MS = 5_000;

export const GREP_DEFAULT_LIMIT = 50;
export const GREP_MAX_LIMIT = 200;

export interface ParsedGrepQuery {
  regex: RegExp;
  /** Lowercased path substring; '' disables path filtering. */
  fileFilter: string;
  limit: number;
}

const isFlagTrue = (value: unknown, name: string): boolean => {
  const s = assertString(value ?? '', name).toLowerCase();
  return s === '1' || s === 'true';
};

/**
 * Parse /api/grep query parameters into a ready-to-use regex + filters.
 * Throws BadRequestError (mapped to HTTP 400 by statusFromError) on
 * missing/over-long patterns or invalid regex syntax.
 */
export function parseGrepQuery(query: Record<string, unknown>): ParsedGrepQuery {
  const pattern = assertString(query.pattern, 'pattern');
  if (pattern.length === 0) {
    throw new BadRequestError('Missing "pattern" query parameter');
  }
  if (pattern.length > GREP_PATTERN_MAX_LENGTH) {
    throw new BadRequestError(`Pattern too long (max ${GREP_PATTERN_MAX_LENGTH} characters)`);
  }

  // Regex semantics by default — what the tool schema always promised.
  // literal=1 opts back into the escaped-substring behaviour of the
  // literal-only era for callers that want it verbatim.
  const effectivePattern = isFlagTrue(query.literal, 'literal') ? escapeRegExp(pattern) : pattern;
  const caseSensitive = isFlagTrue(query.caseSensitive, 'caseSensitive');

  let regex: RegExp;
  try {
    // Deliberately no 'g' flag: the handler tests line-by-line and a
    // stateful lastIndex across lines would skip matches (the old handler
    // had to reset it manually). No 'm' either: each test receives a
    // single line, so ^/$ already anchor at string boundaries — 'm'
    // would be a no-op.
    //
    // CodeQL js/regular-expression-injection — `effectivePattern` is the
    // caller-supplied query unless `literal=1` escaped it. Intentional:
    // the web grep tool contract is real regex. Residual ReDoS (one
    // blocking `regex.test`) is documented in SECURITY.md; loopback
    // default + hosted edge token bound who can send a pattern.
    // lgtm[js/regular-expression-injection]
    // codeql[js/regular-expression-injection]
    regex = new RegExp(effectivePattern, caseSensitive ? '' : 'i');
  } catch {
    throw new BadRequestError('Invalid regex pattern');
  }

  // Path-substring filter, case-insensitive ("Controller.java", "src/api").
  const fileFilter = assertString(query.fileFilter ?? '', 'fileFilter').toLowerCase();

  const parsedLimit = Number(query.limit ?? GREP_DEFAULT_LIMIT);
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(GREP_MAX_LIMIT, Math.trunc(parsedLimit)))
    : GREP_DEFAULT_LIMIT;

  return { regex, fileFilter, limit };
}
