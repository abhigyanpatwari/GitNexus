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
 * to filter them; the scoring copy missed `/fixtures/` and `/conftest.`.
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
 * Patterns that mark a path as test code, as lowercase forward-slash
 * substrings/suffixes. The union of both former implementations.
 *
 * Ordered by language for review; matching is order-independent.
 */
const TEST_PATH_SUBSTRINGS: readonly string[] = [
  // JavaScript / TypeScript
  '.test.',
  '.spec.',
  '__tests__/',
  '__mocks__/',
  // Generic test/fixture folders
  '/test/',
  '/tests/',
  '/testing/',
  '/fixtures/',
  '/test/fixtures/',
  '/spec/',
  // Python
  '/test_',
  '/conftest.',
  // Java / Kotlin (Maven + Gradle layout)
  '/src/test/',
  // Swift
  'uitests/',
  // C#
  '.tests/',
  '.test/',
  '.integrationtests/',
  '.unittests/',
  '/testproject/',
  // PHP / Laravel
  '/tests/feature/',
  '/tests/unit/',
];

/** Patterns that mark a path as test code by filename suffix. */
const TEST_PATH_SUFFIXES: readonly string[] = [
  // Python
  '_test.py',
  // Go
  '_test.go',
  // Ruby
  '_spec.rb',
  '_test.rb',
  // Swift
  'tests.swift',
  'test.swift',
  // C#
  'tests.cs',
  'test.cs',
  // PHP
  'test.php',
  'spec.php',
];

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
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  for (const needle of TEST_PATH_SUBSTRINGS) if (p.includes(needle)) return true;
  for (const suffix of TEST_PATH_SUFFIXES) if (p.endsWith(suffix)) return true;
  return false;
}
