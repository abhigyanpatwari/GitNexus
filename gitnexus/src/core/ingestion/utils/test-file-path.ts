/**
 * Test-file path classification — the single source of truth.
 *
 * WHY THIS MODULE EXISTS
 *
 * Two independent copies of this predicate existed and had drifted apart:
 *
 *   - `core/ingestion/entry-point-scoring.ts` `isTestFile`  — excludes test
 *     files from process entry-point detection.
 *   - `mcp/local/local-backend.ts` `isTestFilePath`         — backs the
 *     `includeTests` flag on `impact` / `trace` / `context`.
 *
 * They answered "is this a test file?" differently, so the same path could be a
 * test in one code path and not the other. The MCP copy recognized no C#, Java,
 * or Swift test convention at all, meaning `includeTests: false` silently failed
 * to filter them; the scoring copy missed `/test/fixtures/` and `/conftest.`.
 *
 * The duplication was not gratuitous: `entry-point-scoring.ts` imports the
 * language-provider registry, and #2802 deliberately cut that closure out of MCP
 * server startup. Importing it back into `local-backend.ts` would reintroduce
 * that cost. So the shared predicate lives here instead, with NO imports — pure
 * string matching — and both callers delegate to it.
 *
 * Keep it dependency-free. Anything imported here lands in MCP startup.
 */

/**
 * Lowercase forward-slash path substrings. Directory needles include a leading
 * slash so they match path components (callers slash-prefix relative paths
 * first). Ordered by language for review; matching is order-independent.
 */
const TEST_PATH_SUBSTRINGS: readonly string[] = [
  // JavaScript / TypeScript
  '.test.',
  '.spec.',
  '__tests__/',
  '__mocks__/',
  // Generic test folders (slash-anchored so `fruitests/` is not a hit)
  '/test/',
  '/tests/',
  '/testing/',
  '/test/fixtures/',
  '/tests/fixtures/',
  '/spec/fixtures/',
  '/spec/',
  // Python
  '/test_',
  '/conftest.',
  // Java / Kotlin (Maven + Gradle layout)
  '/src/test/',
  // Swift
  '/uitests/',
  // C#
  '.tests/',
  '.test/',
  '.integrationtests/',
  '.unittests/',
  '/testproject/',
  // PHP / Laravel (also covered by `/tests/` after slash-prefix)
  '/tests/feature/',
  '/tests/unit/',
];

/**
 * Case-insensitive filename suffixes that already include a delimiter
 * (`_test.py`, not `test.py`).
 */
const TEST_PATH_DELIMITED_SUFFIXES: readonly string[] = [
  '_test.py',
  '_test.go',
  '_spec.rb',
  '_test.rb',
];

/**
 * Case-sensitive filename suffixes for languages whose test convention is a
 * `Test`/`Tests`/`Spec` token. Matching these after `toLowerCase()` would also
 * accept production names such as `Contest.swift` and `Latest.php`.
 */
const TEST_PATH_CASED_SUFFIXES: readonly string[] = [
  'Tests.swift',
  'Test.swift',
  'Tests.cs',
  'Test.cs',
  'Test.php',
  'Spec.php',
];

function slashPrefixedForwardSlashes(filePath: string): string {
  const withForward = filePath.replace(/\\/g, '/');
  return withForward.startsWith('/') ? withForward : `/${withForward}`;
}

/**
 * Is this path test code?
 *
 * Callers use it for two purposes that must agree: excluding tests from
 * entry-point detection, and honoring `includeTests: false` on the read tools.
 * A path classified differently by the two produces results that contradict
 * each other, which is why there is exactly one implementation.
 *
 * Accepts nullish input so call sites reading an optional `filePath` do not each
 * need their own guard; absent paths are not test paths.
 */
export function isTestFilePath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const slashed = slashPrefixedForwardSlashes(filePath);
  const lower = slashed.toLowerCase();
  for (const needle of TEST_PATH_SUBSTRINGS) if (lower.includes(needle)) return true;
  if (TEST_PATH_DELIMITED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  const basename = slashed.slice(slashed.lastIndexOf('/') + 1);
  return TEST_PATH_CASED_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}
