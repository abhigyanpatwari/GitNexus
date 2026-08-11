/**
 * Cypher predicates for matching a graph row's `filePath` against a path the
 * caller supplied.
 *
 * `filePath` is stored repo-relative, and callers arrive with anything from a
 * full repo-relative path to a bare basename to a directory fragment. The
 * matching rule is therefore a CHOICE, and it was being made per call site by
 * copying whichever idiom the neighbouring query used — `= $p`, a bare
 * `ENDS WITH $p`, or `CONTAINS $p`. A bare `ENDS WITH` is a plain string
 * suffix, so a diff touching `lib/a.ts` matched an indexed `src/mylib/a.ts`
 * (#2915 review): a file the caller never named.
 *
 * Naming the modes puts that choice in the caller's hands explicitly:
 *   - `exact`      — the value IS the indexed path.
 *   - `pathSuffix` — a trailing run of whole path SEGMENTS (`a/b.ts` matches
 *                    `src/a/b.ts`, never `src/mya/b.ts`).
 *   - `fragment`   — any substring, for a user-supplied hint where a directory
 *                    fragment such as `src/mcp` should match. Deliberately
 *                    loose; do not use it for a path the caller stated exactly.
 */
export type PathMatchMode = 'exact' | 'pathSuffix' | 'fragment';

/**
 * Build the WHERE fragment and the parameters for one path match.
 *
 * `property` is the row property to test (`n.filePath`), `prefix` names the
 * parameters so several matches can share one query without colliding. The
 * `pathSuffix` mode needs two parameters — the exact value and the
 * separator-anchored suffix — because the anchored form alone cannot match a
 * row whose stored path IS the caller's path.
 */
export function pathMatch(
  property: string,
  filePath: string,
  mode: PathMatchMode,
  prefix = 'path',
): { clause: string; params: Record<string, string> } {
  switch (mode) {
    case 'exact':
      return { clause: `${property} = $${prefix}`, params: { [prefix]: filePath } };
    case 'fragment':
      return { clause: `${property} CONTAINS $${prefix}`, params: { [prefix]: filePath } };
    case 'pathSuffix':
      return {
        clause: `(${property} = $${prefix} OR ${property} ENDS WITH $${prefix}Suffix)`,
        params: { [prefix]: filePath, [`${prefix}Suffix`]: pathSuffixOf(filePath) },
      };
  }
}

/**
 * The separator-anchored form of `filePath`, for a `pathSuffix` match whose
 * candidates arrive as a bound list (an `UNWIND` of `{path, suffix}` structs)
 * rather than as query text.
 */
export function pathSuffixOf(filePath: string): string {
  return `/${filePath}`;
}
