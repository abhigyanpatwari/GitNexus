/**
 * The git arguments `detect_changes` itself runs, for tests that shell out to
 * the same diff the tool would.
 *
 * `buildDetectChangesDiffArgs` returns `null` for the one case no test here
 * drives — `compare` with no base ref — and a `null` reaching `execFileSync`
 * fails as a bare `TypeError` several frames from the test that caused it.
 * Both consumers (`detect-changes-eol`, `detect-changes-hunk-scale`) had
 * written the same three-line unwrap; this one names the scope in the message.
 *
 * The null-returning behaviour itself is asserted directly, on the real
 * function, in `test/unit/detect-changes-eol.test.ts`.
 */

import { buildDetectChangesDiffArgs } from '../../src/mcp/local/local-backend.js';

/** `buildDetectChangesDiffArgs`, refusing the null instead of passing it on. */
export function diffArgsFor(scope: string, baseRef?: string): string[] {
  const args = buildDetectChangesDiffArgs(scope, baseRef);
  if (!args) throw new Error(`scope "${scope}" must produce git diff arguments`);
  return args;
}
