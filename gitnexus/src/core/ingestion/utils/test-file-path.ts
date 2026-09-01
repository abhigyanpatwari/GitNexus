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
 * slash so they match path components after the caller slash-prefixes relative
 * paths. `/test/` already covers Maven `src/test` and `/test/fixtures/`;
 * `/tests/` covers Laravel `tests/Feature` and `/tests/fixtures/`.
 */
const TEST_PATH_SUBSTRINGS: readonly string[] = [
  '.test.',
  '.spec.',
  '__tests__/',
  '__mocks__/',
  '/test/',
  '/tests/',
  '/testing/',
  '/spec/',
  '/test_',
  '/conftest.',
  '/uitests/',
  '.tests/',
  '.test/',
  '.integrationtests/',
  '.unittests/',
  '/testproject/',
];

/** Case-insensitive suffixes that already include a delimiter (`_test.py`, not `test.py`). */
const TEST_PATH_DELIMITED_SUFFIXES: readonly string[] = [
  '_test.py',
  '_test.go',
  '_spec.rb',
  '_test.rb',
];

/**
 * Case-sensitive `Test`/`Tests`/`Spec` suffixes. Lowercasing first would also
 * match production names such as `Contest.swift` and `Latest.php`.
 */
const TEST_PATH_CASED_SUFFIXES: readonly string[] = [
  'Tests.swift',
  'Test.swift',
  'Tests.cs',
  'Test.cs',
  'Test.php',
  'Spec.php',
];

/** Absent / empty paths are not test paths. */
export function isTestFilePath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const slashed = filePath.replace(/\\/g, '/');
  const prefixed = slashed.startsWith('/') ? slashed : `/${slashed}`;
  const lower = prefixed.toLowerCase();
  if (TEST_PATH_SUBSTRINGS.some((needle) => lower.includes(needle))) return true;
  if (TEST_PATH_DELIMITED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  const basename = prefixed.slice(prefixed.lastIndexOf('/') + 1);
  return TEST_PATH_CASED_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}
