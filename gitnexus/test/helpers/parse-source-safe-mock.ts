import { vi } from 'vitest';
import type * as SafeParseModule from '../../src/core/tree-sitter/safe-parse.js';

/**
 * Build a vitest mock module for `gitnexus/src/core/tree-sitter/safe-parse.ts`
 * that spies on `parseSourceSafe` while still delegating to the real
 * implementation.
 *
 * Background: tests that feed >32 767-char inputs through extractors,
 * chunkers, or any parse caller need to assert the call routed through
 * `parseSourceSafe` rather than `parser.parse(string, ...)` directly. A
 * direct call SIGSEGVs on Windows for inputs that size; on Linux/macOS it
 * succeeds, so a "no throw" assertion alone silently passes with the
 * bypass reintroduced. The spy assertion is what actually catches the
 * regression.
 *
 * Why the test still has to call `vi.mock` with a literal path: vitest's
 * hoister static-analyzes the first argument of `vi.mock`, and the path
 * varies by directory depth across test files. Everything else — the
 * `vi.importActual` round-trip, the spy installation, and the merged
 * module shape — lives here.
 *
 * Why the test still has to dynamic-`import()` this helper inside the
 * `vi.mock` factory: `vi.mock` is hoisted above static imports, so the
 * factory closure cannot reference statically-imported helpers (they are
 * uninitialized at hoist time). The factory body, however, is async and
 * runs only when the mocked module is first consumed — by which point
 * the helper resolves cleanly via dynamic `import()`.
 *
 * Usage:
 *
 *   const { parseSourceSafeSpy } = vi.hoisted(() => ({ parseSourceSafeSpy: vi.fn() }));
 *
 *   vi.mock('../../../src/core/tree-sitter/safe-parse.js', async () => {
 *     const { buildSafeParseMock } = await import('../../helpers/parse-source-safe-mock.js');
 *     return buildSafeParseMock(parseSourceSafeSpy);
 *   });
 *
 *   it('routes large input through parseSourceSafe', async () => {
 *     parseSourceSafeSpy.mockClear();
 *     // ... call extractor with >40 000-char input ...
 *     expect(parseSourceSafeSpy).toHaveBeenCalled();
 *   });
 */
export async function buildSafeParseMock(
  spy: ReturnType<typeof vi.fn>,
): Promise<typeof SafeParseModule> {
  const actual = await vi.importActual<typeof SafeParseModule>(
    '../../src/core/tree-sitter/safe-parse.js',
  );
  spy.mockImplementation(actual.parseSourceSafe);
  return { ...actual, parseSourceSafe: spy };
}
